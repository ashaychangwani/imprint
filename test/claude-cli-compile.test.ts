import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { DATA_COMPILE_TOOL_NAMES } from '../src/imprint/claude-cli-compile.ts';
import { isTransientProviderCapacityError } from '../src/imprint/provider-retry.ts';
import { parseClaudeTerminalOutput } from '../src/imprint/provider-terminal.ts';

const interruption = (event: Record<string, unknown>) =>
  parseClaudeTerminalOutput(JSON.stringify(event)).interruption;

describe('Claude data-compile tool access', () => {
  it('includes the evidence tools named by the compile prompt', () => {
    expect(DATA_COMPILE_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'search_requests',
        'read_event',
        'diff_request_for_event',
        'compare_rendered_requests',
        'probe_api',
      ]),
    );
    const prompt = readFileSync(
      pathJoin(import.meta.dir, '..', 'prompts', 'compile-agent.md'),
      'utf8',
    );
    for (const tool of DATA_COMPILE_TOOL_NAMES) {
      expect(prompt).toContain(`| \`${tool}\` |`);
    }
  });
});

describe('Claude terminal provider facts', () => {
  it('requires structured capacity provenance instead of bare target-site status text', () => {
    for (const status of [429, 503, 529]) {
      expect(
        interruption({
          type: 'result',
          is_error: true,
          errors: [`target-site live verification returned HTTP ${status}`],
        }),
      ).toBeUndefined();
    }
    expect(
      interruption({
        type: 'result',
        is_error: true,
        api_error_status: 529,
        errors: ['provider overloaded'],
      }),
    ).toBe('capacity_or_overload');
  });

  it('uses errors-only capacity facts and lets deterministic contradictions win', () => {
    expect(
      interruption({
        type: 'result',
        is_error: true,
        errors: ['529 provider overloaded'],
      }),
    ).toBe('capacity_or_overload');
    expect(
      interruption({
        type: 'result',
        is_error: true,
        result:
          'I am unable to respond to this request because it appears to violate our Usage Policy.',
        errors: ['invalid API key'],
      }),
    ).toBeUndefined();
    expect(
      interruption({
        type: 'result',
        is_error: true,
        api_error_status: 429,
        errors: ['insufficient_quota'],
      }),
    ).toBeUndefined();
  });

  it('preserves the exact safety interruption without inventing a 529', () => {
    const parsed = parseClaudeTerminalOutput(
      JSON.stringify({
        type: 'result',
        is_error: true,
        errors: [
          'I am unable to respond to this request because it appears to violate our Usage Policy.',
        ],
      }),
    );
    expect(parsed.providerError?.statuses).toEqual([]);
    expect(parsed.interruption).toBe('transient_safety_filter');
    expect(isTransientProviderCapacityError(parsed.providerError)).toBe(true);
  });

  it('does not let result text hide terminal deterministic errors', () => {
    const parsed = parseClaudeTerminalOutput(
      JSON.stringify({
        type: 'result',
        result: '{"looks":"successful"}',
        errors: ['invalid API key'],
      }),
    );
    expect(parsed.providerError).toBeDefined();
    expect(parsed.text).toBeUndefined();
    expect(parsed.interruption).toBeUndefined();
  });

  it('treats stringified nested error JSON as diagnostic-only', () => {
    const parsed = parseClaudeTerminalOutput(
      JSON.stringify({
        type: 'result',
        is_error: true,
        error: JSON.stringify({ status: 529, code: 'overloaded_error' }),
      }),
    );
    expect(parsed.providerError).toBeDefined();
    expect(parsed.providerError?.statuses).toEqual([]);
    expect(parsed.providerError?.codes).toEqual([]);
    expect(parsed.interruption).toBeUndefined();
  });
});
