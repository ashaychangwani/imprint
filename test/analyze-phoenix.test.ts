import { describe, expect, it } from 'bun:test';
import {
  type SpanNode,
  classifyUnresolvedCostsAsUnknown,
  collectSpanPages,
  formatPhoenixCost,
  phoenixGraphqlErrorMessage,
  summarizePhoenixCost,
} from '../scripts/analyze-phoenix.ts';

function llmSpan(model: string, cost: number | null, tokens = 100): SpanNode {
  return {
    name: 'llm.usage',
    latencyMs: 0,
    statusCode: 'OK',
    startTime: '2026-07-16T00:00:00.000Z',
    endTime: '2026-07-16T00:00:00.000Z',
    tokenCountTotal: tokens,
    tokenCountPrompt: tokens,
    tokenCountCompletion: 0,
    context: { traceId: 'trace', spanId: model },
    parentId: 'root',
    attributes: JSON.stringify({
      'openinference.span.kind': 'LLM',
      'llm.model_name': model,
      'llm.token_count.total': tokens,
    }),
    numChildSpans: 0,
    costSummary: {
      prompt: { cost, tokens },
      completion: { cost: cost == null ? null : 0, tokens: 0 },
      total: { cost, tokens },
    },
  };
}

describe('Phoenix cost availability', () => {
  it('reports an entirely unknown model as unpriced rather than free', () => {
    const summary = summarizePhoenixCost([llmSpan('gpt-new', null)], 0);

    expect(summary).toEqual({
      status: 'unpriced',
      cost: null,
      unpricedModels: ['gpt-new'],
      pendingModels: [],
      unknownModels: [],
    });
    expect(formatPhoenixCost(summary)).toBe('unpriced (gpt-new)');
  });

  it('labels a mixed-model total as partial and names every unpriced model', () => {
    const summary = summarizePhoenixCost(
      [llmSpan('priced-model', 1.25), llmSpan('unknown-model', null)],
      0,
    );

    expect(summary.status).toBe('partial');
    expect(summary.cost).toBe(1.25);
    expect(summary.unpricedModels).toEqual(['unknown-model']);
    expect(formatPhoenixCost(summary)).toBe('$1.25 (partial; unpriced: unknown-model)');
  });

  it('distinguishes a trace with no LLM usage from a zero-priced model', () => {
    const summary = summarizePhoenixCost([], null);

    expect(summary.status).toBe('no-usage');
    expect(formatPhoenixCost(summary)).toBe('unknown (no LLM usage)');
  });

  it('does not call an asynchronously pending Phoenix cost unpriced', () => {
    const pending = { ...llmSpan('gpt-priced', null), costSummary: null };
    const summary = summarizePhoenixCost([pending], null);

    expect(summary.status).toBe('pending');
    expect(formatPhoenixCost(summary)).toBe('unknown (cost pending: gpt-priced)');
  });

  it('reports a legacy null summary as unknown after polling is exhausted', () => {
    const unresolved = { ...llmSpan('gpt-new', null), costSummary: null };
    const [settled] = classifyUnresolvedCostsAsUnknown([unresolved]);
    const summary = summarizePhoenixCost(settled ? [settled] : [], null);

    expect(summary.status).toBe('unknown');
    expect(formatPhoenixCost(summary)).toBe('unknown (unpriced or cost pending: gpt-new)');
  });

  it('preserves the priced subtotal when a legacy null summary is unresolved', () => {
    const unresolved = { ...llmSpan('gpt-new', null), costSummary: null };
    const settled = classifyUnresolvedCostsAsUnknown([llmSpan('priced-model', 1.25), unresolved]);
    const summary = summarizePhoenixCost(settled, 0);

    expect(summary.status).toBe('partial');
    expect(formatPhoenixCost(summary)).toBe('$1.25 (partial; unpriced or cost pending: gpt-new)');
  });

  it('includes an unpriced LLM usage span from a later Phoenix page', async () => {
    const cursors: Array<string | null> = [];
    const spans = await collectSpanPages(async (after) => {
      cursors.push(after);
      return after == null
        ? {
            spans: [llmSpan('priced-model', 1.25)],
            hasNextPage: true,
            endCursor: 'page-2',
          }
        : {
            spans: [llmSpan('unknown-model', null)],
            hasNextPage: false,
            endCursor: null,
          };
    });

    expect(cursors).toEqual([null, 'page-2']);
    expect(summarizePhoenixCost(spans, 1.25).status).toBe('partial');
  });
});

describe('Phoenix GraphQL compatibility diagnostics', () => {
  it('turns a missing costSummary field into an actionable upgrade message', () => {
    expect(phoenixGraphqlErrorMessage(['Cannot query field "costSummary" on type "Trace".'])).toBe(
      'Phoenix cost analysis requires Phoenix 11.4 or newer because this server does not expose GraphQL costSummary. Upgrade arize-phoenix, restart Phoenix, and retry.',
    );
  });
});
