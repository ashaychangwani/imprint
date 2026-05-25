#!/usr/bin/env bun
/**
 * Analyze Phoenix traces for compile agent performance.
 * Usage: bun run scripts/analyze-phoenix.ts [--trace-id <id>] [--last <N>]
 */

const PHOENIX_URL = process.env.PHOENIX_URL ?? 'http://localhost:6006';
const PROJECT_ID = 'UHJvamVjdDoy'; // imprint project

async function gql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${PHOENIX_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await resp.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data;
}

interface SpanNode {
  name: string;
  latencyMs: number;
  statusCode: string;
  startTime: string;
  endTime: string;
  tokenCountTotal: number | null;
  tokenCountPrompt: number | null;
  tokenCountCompletion: number | null;
  context: { traceId: string; spanId: string };
  parentId: string | null;
  attributes: string;
  numChildSpans: number;
}

async function getRecentTeachTraces(limit: number) {
  const data = (await gql(`{
    node(id: "${PROJECT_ID}") {
      ... on Project {
        spans(first: ${limit}, sort: { col: startTime, dir: desc }, rootSpansOnly: true) {
          edges { node {
            name latencyMs statusCode startTime endTime
            context { traceId spanId }
            tokenCountTotal tokenCountPrompt tokenCountCompletion
          } }
        }
      }
    }
  }`)) as { node: { spans: { edges: Array<{ node: SpanNode }> } } };
  return data.node.spans.edges.map((e) => e.node).filter((s) => s.name === 'cli.teach');
}

async function getTraceSpans(traceId: string): Promise<SpanNode[]> {
  const data = (await gql(`{
    node(id: "${PROJECT_ID}") {
      ... on Project {
        spans(first: 200, sort: { col: startTime, dir: asc }, filterCondition: "trace_id == '${traceId}'") {
          edges { node {
            name latencyMs statusCode startTime endTime
            context { traceId spanId }
            parentId
            tokenCountTotal tokenCountPrompt tokenCountCompletion
            attributes
            numChildSpans
          } }
        }
      }
    }
  }`)) as { node: { spans: { edges: Array<{ node: SpanNode }> } } };
  return data.node.spans.edges.map((e) => e.node);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function resolveAttr(parsed: Record<string, unknown>, dottedKey: string): unknown {
  const flat = parsed[dottedKey];
  if (flat !== undefined) return flat;
  const parts = dottedKey.split('.');
  let current: unknown = parsed;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

function parseAttrs(attrs: string): Record<string, unknown> {
  try {
    return JSON.parse(attrs);
  } catch {
    return {};
  }
}

function extractToolName(attrs: string): string | null {
  const parsed = parseAttrs(attrs);
  return (resolveAttr(parsed, 'imprint.tool_name') as string) ?? null;
}

function extractTurns(attrs: string): number | null {
  const parsed = parseAttrs(attrs);
  return (resolveAttr(parsed, 'imprint.compile.turns') as number) ?? null;
}

function extractOutcome(attrs: string): string | null {
  const parsed = parseAttrs(attrs);
  return (resolveAttr(parsed, 'imprint.compile.outcome') as string) ?? null;
}

function extractModelName(attrs: string): string | null {
  const parsed = parseAttrs(attrs);
  return (resolveAttr(parsed, 'llm.model_name') as string) ?? null;
}

const MODEL_RATES: Record<string, { cacheRead: number; cacheWrite: number; input: number; output: number }> = {
  'claude-opus-4-7': { cacheRead: 0.50, cacheWrite: 6.25, input: 5, output: 25 },
  'claude-opus-4-6': { cacheRead: 0.50, cacheWrite: 6.25, input: 5, output: 25 },
  'claude-opus-4-5': { cacheRead: 0.50, cacheWrite: 6.25, input: 5, output: 25 },
  'claude-opus-4-1': { cacheRead: 1.50, cacheWrite: 18.75, input: 15, output: 75 },
  'claude-sonnet-4-6': { cacheRead: 0.30, cacheWrite: 3.75, input: 3, output: 15 },
  'claude-sonnet-4-5': { cacheRead: 0.30, cacheWrite: 3.75, input: 3, output: 15 },
  'claude-haiku-4-5': { cacheRead: 0.10, cacheWrite: 1.25, input: 1, output: 5 },
};
const DEFAULT_RATES = MODEL_RATES['claude-sonnet-4-6'];

async function analyzeTrace(traceId: string) {
  const spans = await getTraceSpans(traceId);
  const root = spans.find((s) => !s.parentId);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Trace: ${traceId}`);
  console.log(
    `Root: ${root?.name ?? '?'} | Duration: ${formatDuration(root?.latencyMs ?? 0)} | Status: ${root?.statusCode ?? '?'}`,
  );
  console.log(`Started: ${root?.startTime ?? '?'}`);
  console.log(`${'─'.repeat(80)}`);

  // Find compile.generate spans
  const compileSpans = spans.filter((s) => s.name === 'compile.generate');
  if (compileSpans.length === 0) {
    console.log('  No compile.generate spans found in this trace.');
    return;
  }

  console.log(`\nCompile spans (${compileSpans.length}):\n`);

  for (const span of compileSpans) {
    const toolName = extractToolName(span.attributes) ?? '(unknown)';
    const turns = extractTurns(span.attributes);
    const outcome = extractOutcome(span.attributes);
    const status = span.statusCode === 'OK' ? '✓' : '✗';

    const parsed = parseAttrs(span.attributes);
    const inputTokens = resolveAttr(parsed, 'imprint.compile.input_tokens') as number | null;
    const outputTokens = resolveAttr(parsed, 'imprint.compile.output_tokens') as number | null;
    const cacheRead = resolveAttr(parsed, 'imprint.compile.cache_read_input_tokens') as number | null;
    const cacheCreate = resolveAttr(parsed, 'imprint.compile.cache_creation_input_tokens') as number | null;
    const modelName = extractModelName(span.attributes);
    const rates = (modelName && MODEL_RATES[modelName]) || DEFAULT_RATES;

    const costParts: string[] = [];
    if (cacheRead) costParts.push(`cache_read=$${(cacheRead * rates.cacheRead / 1e6).toFixed(2)}`);
    if (cacheCreate) costParts.push(`cache_create=$${(cacheCreate * rates.cacheWrite / 1e6).toFixed(2)}`);
    if (outputTokens) costParts.push(`output=$${(outputTokens * rates.output / 1e6).toFixed(2)}`);
    const totalCost = (cacheRead ?? 0) * rates.cacheRead / 1e6 + (cacheCreate ?? 0) * rates.cacheWrite / 1e6 + (outputTokens ?? 0) * rates.output / 1e6;

    console.log(`  ${status} ${toolName} [${modelName ?? '?'}]`);
    console.log(
      `    Duration: ${formatDuration(span.latencyMs)} | Turns: ${turns ?? '?'} | Outcome: ${outcome ?? '?'}`,
    );
    if (cacheRead || cacheCreate) {
      console.log(
        `    Tokens: ${(cacheRead ?? 0).toLocaleString()} cache_read, ${(cacheCreate ?? 0).toLocaleString()} cache_create, ${(outputTokens ?? 0).toLocaleString()} output`,
      );
      console.log(
        `    Cost: $${totalCost.toFixed(2)} (${costParts.join(', ')})`,
      );
    } else {
      console.log(
        `    Tokens: ${inputTokens ?? '?'} input, ${outputTokens ?? '?'} output`,
      );
    }

    // Get child spans to analyze tool call breakdown
    const children = spans.filter((s) => s.parentId === span.context.spanId);
    if (children.length > 0) {
      // Group children by name
      const byName = new Map<string, { count: number; totalMs: number; maxMs: number }>();
      for (const child of children) {
        const existing = byName.get(child.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
        existing.count++;
        existing.totalMs += child.latencyMs;
        existing.maxMs = Math.max(existing.maxMs, child.latencyMs);
        byName.set(child.name, existing);
      }

      // Sort by total time
      const sorted = [...byName.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
      console.log(`    Child spans (${children.length}):`);
      for (const [name, stats] of sorted.slice(0, 10)) {
        console.log(
          `      ${name}: ${stats.count}x, total ${formatDuration(stats.totalMs)}, max ${formatDuration(stats.maxMs)}`,
        );
      }

      // Find the slowest individual children
      const slowest = [...children].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 5);
      if (slowest[0] && slowest[0].latencyMs > 10000) {
        console.log('    Slowest individual spans:');
        for (const s of slowest) {
          if (s.latencyMs < 5000) break;
          console.log(
            `      ${s.name}: ${formatDuration(s.latencyMs)} (tokens: ${s.tokenCountCompletion ?? '?'} out)`,
          );
        }
      }
    }
    console.log('');
  }

  // Also show triage and playbook spans
  const otherSpans = spans.filter(
    (s) =>
      s.name === 'compile.triage_requests' ||
      s.name === 'compile.playbook' ||
      s.name === 'teach.detect_tool_candidates' ||
      s.name === 'teach.replay_and_diff',
  );
  if (otherSpans.length > 0) {
    console.log('Other pipeline spans:');
    for (const s of otherSpans) {
      const toolName = extractToolName(s.attributes);
      console.log(
        `  ${s.name}${toolName ? ` (${toolName})` : ''}: ${formatDuration(s.latencyMs)} [${s.statusCode}]`,
      );
    }
  }
}

// Main
const args = process.argv.slice(2);
const traceIdIdx = args.indexOf('--trace-id');
const lastIdx = args.indexOf('--last');

if (traceIdIdx >= 0 && args[traceIdIdx + 1]) {
  await analyzeTrace(args[traceIdIdx + 1]);
} else {
  const limit = lastIdx >= 0 ? Number.parseInt(args[lastIdx + 1] ?? '5', 10) : 5;
  const traces = await getRecentTeachTraces(limit + 5);
  console.log(
    `Found ${traces.length} recent teach traces (showing last ${Math.min(limit, traces.length)}):\n`,
  );

  for (const trace of traces.slice(0, limit)) {
    await analyzeTrace(trace.context.traceId);
  }
}
