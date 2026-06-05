#!/usr/bin/env bun
/**
 * Analyze Phoenix traces for compile/audit agent performance + cost.
 *
 * Cost is read from the `llm.cost.*` attributes the app already emits on its
 * spans (the single source of truth in src/imprint/tracing.ts) — this script
 * does NOT recompute cost from a private rate table, so it can never drift from
 * the app's pricing or miss a newly added model. Root spans (`cli.teach`,
 * `cli.audit`) carry a rolled-up `llm.cost.total` from tracedWithCostRollup;
 * this script reads from non-root spans to avoid double-counting against
 * the leaf LLM/agent spans that feed the rollup.
 *
 * Usage: bun run scripts/analyze-phoenix.ts [--trace-id <id>] [--last <N>] [--kind teach|audit|all]
 */

const PHOENIX_URL = process.env.PHOENIX_URL ?? 'http://localhost:6006';
const PROJECT_ID = 'UHJvamVjdDoy'; // imprint project

/** Root span names this script knows how to summarize. */
const ROOT_KINDS: Record<string, string[]> = {
  teach: ['cli.teach'],
  audit: ['cli.audit'],
  all: ['cli.teach', 'cli.audit'],
};

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

async function getRecentTraces(limit: number, rootNames: string[]) {
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
  return data.node.spans.edges.map((e) => e.node).filter((s) => rootNames.includes(s.name));
}

async function getTraceSpans(traceId: string): Promise<SpanNode[]> {
  const data = (await gql(`{
    node(id: "${PROJECT_ID}") {
      ... on Project {
        spans(first: 500, sort: { col: startTime, dir: asc }, filterCondition: "trace_id == '${traceId}'") {
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

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
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

function attrNum(parsed: Record<string, unknown>, key: string): number | null {
  const v = resolveAttr(parsed, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function attrStr(parsed: Record<string, unknown>, key: string): string | null {
  const v = resolveAttr(parsed, key);
  return typeof v === 'string' ? v : null;
}

/** Total emitted cost (USD) for one span, or null if it carries none. */
function spanCostTotal(span: SpanNode): number | null {
  return attrNum(parseAttrs(span.attributes), 'llm.cost.total');
}

/** Sum emitted `llm.cost.total` across non-root spans. Root spans now carry a
 *  rolled-up total from tracedWithCostRollup, so they must be excluded to avoid
 *  double-counting against the leaf LLM/agent spans that feed the rollup. */
function sumCostTotal(spans: SpanNode[]): number {
  let total = 0;
  for (const s of spans) {
    if (!s.parentId) continue;
    const c = spanCostTotal(s);
    if (c != null) total += c;
  }
  return total;
}

/** All descendant spans of `rootSpanId` (transitive children). */
function descendantsOf(spans: SpanNode[], rootSpanId: string): SpanNode[] {
  const byParent = new Map<string, SpanNode[]>();
  for (const s of spans) {
    if (!s.parentId) continue;
    const arr = byParent.get(s.parentId) ?? [];
    arr.push(s);
    byParent.set(s.parentId, arr);
  }
  const out: SpanNode[] = [];
  // `visited` guards against a malformed/cyclic parent graph in the trace data
  // (OpenTelemetry shouldn't produce one, but the spans come from an external DB).
  const visited = new Set<string>([rootSpanId]);
  const stack = [...(byParent.get(rootSpanId) ?? [])];
  while (stack.length > 0) {
    const s = stack.pop();
    if (!s) break;
    if (visited.has(s.context.spanId)) continue;
    visited.add(s.context.spanId);
    out.push(s);
    const kids = byParent.get(s.context.spanId);
    if (kids) stack.push(...kids);
  }
  return out;
}

function printAuditSummary(span: SpanNode): void {
  const a = parseAttrs(span.attributes);
  const verdict = attrStr(a, 'imprint.audit.verdict') ?? '?';
  const score = attrNum(a, 'imprint.audit.score');
  const correct = attrNum(a, 'imprint.audit.correct') ?? 0;
  const broken = attrNum(a, 'imprint.audit.broken') ?? 0;
  const graded = attrNum(a, 'imprint.audit.graded') ?? 0;
  const infra = attrNum(a, 'imprint.audit.infra') ?? 0;
  const badParams = attrNum(a, 'imprint.audit.bad_params') ?? 0;
  const toolCount = attrNum(a, 'imprint.audit.tool_count');
  const turns = attrNum(a, 'imprint.audit.turns');
  const timedOut = resolveAttr(a, 'imprint.audit.timed_out') === true;
  const costUsd = attrNum(a, 'imprint.audit.cost_usd');
  const estCost = spanCostTotal(span);

  console.log('\nAudit:');
  console.log(
    `  ${timedOut ? '⏱ ' : ''}${verdict.toUpperCase()} | score ${score == null ? 'n/a' : `${score.toFixed(1)}%`} (${correct} correct / ${broken} broken) | graded ${graded} across ${toolCount ?? '?'} tool(s)`,
  );
  console.log(
    `  excluded: ${infra} infra, ${badParams} bad_params | turns: ${turns ?? '?'} | duration: ${formatDuration(span.latencyMs)}${timedOut ? ' (KILLED at deadline)' : ''}`,
  );
  const costBits: string[] = [];
  if (costUsd != null) costBits.push(`reported ${formatCost(costUsd)}`);
  if (estCost != null) costBits.push(`estimated ${formatCost(estCost)}`);
  if (costBits.length > 0) console.log(`  cost: ${costBits.join(', ')}`);
}

function printCompileSpan(span: SpanNode, allSpans: SpanNode[]): void {
  const a = parseAttrs(span.attributes);
  const toolName = attrStr(a, 'imprint.tool_name') ?? '(unknown)';
  const turns = attrNum(a, 'imprint.compile.turns');
  const outcome = attrStr(a, 'imprint.compile.outcome');
  const status = span.statusCode === 'OK' ? '✓' : '✗';

  const inputTokens = attrNum(a, 'imprint.compile.input_tokens');
  const outputTokens = attrNum(a, 'imprint.compile.output_tokens');
  const cacheRead = attrNum(a, 'imprint.compile.cache_read_input_tokens');
  const cacheCreate = attrNum(a, 'imprint.compile.cache_creation_input_tokens');

  // Cost lives on the child compile.claude_cli_agent span(s), not this wrapper —
  // sum the emitted cost across this span and its whole subtree.
  const subtreeCost = sumCostTotal([span, ...descendantsOf(allSpans, span.context.spanId)]);

  console.log(`  ${status} ${toolName}`);
  console.log(
    `    Duration: ${formatDuration(span.latencyMs)} | Turns: ${turns ?? '?'} | Outcome: ${outcome ?? '?'}`,
  );
  if (cacheRead != null || cacheCreate != null) {
    console.log(
      `    Tokens: ${(cacheRead ?? 0).toLocaleString()} cache_read, ${(cacheCreate ?? 0).toLocaleString()} cache_create, ${(outputTokens ?? 0).toLocaleString()} output`,
    );
  } else {
    console.log(`    Tokens: ${inputTokens ?? '?'} input, ${outputTokens ?? '?'} output`);
  }
  console.log(`    Cost: ${formatCost(subtreeCost)}`);

  // Child spans → tool-call breakdown.
  const children = allSpans.filter((s) => s.parentId === span.context.spanId);
  if (children.length > 0) {
    const byName = new Map<string, { count: number; totalMs: number; maxMs: number }>();
    for (const child of children) {
      const existing = byName.get(child.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
      existing.count++;
      existing.totalMs += child.latencyMs;
      existing.maxMs = Math.max(existing.maxMs, child.latencyMs);
      byName.set(child.name, existing);
    }
    const sorted = [...byName.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    console.log(`    Child spans (${children.length}):`);
    for (const [name, stats] of sorted.slice(0, 10)) {
      console.log(
        `      ${name}: ${stats.count}x, total ${formatDuration(stats.totalMs)}, max ${formatDuration(stats.maxMs)}`,
      );
    }

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

async function analyzeTrace(traceId: string) {
  const spans = await getTraceSpans(traceId);
  const root = spans.find((s) => !s.parentId);
  const rootCost = root ? spanCostTotal(root) : null;
  const traceCost = rootCost ?? sumCostTotal(spans);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Trace: ${traceId}`);
  console.log(
    `Root: ${root?.name ?? '?'} | Duration: ${formatDuration(root?.latencyMs ?? 0)} | Status: ${root?.statusCode ?? '?'} | Total cost: ${formatCost(traceCost)}`,
  );
  console.log(`Started: ${root?.startTime ?? '?'}`);
  console.log(`${'─'.repeat(80)}`);

  // Audit traces: summarize the audit.session span.
  const auditSpan = spans.find((s) => s.name === 'audit.session');
  if (auditSpan) printAuditSummary(auditSpan);

  // Compile traces: per-tool compile breakdown.
  const compileSpans = spans.filter((s) => s.name === 'compile.generate');
  if (compileSpans.length > 0) {
    console.log(`\nCompile spans (${compileSpans.length}):\n`);
    for (const span of compileSpans) printCompileSpan(span, spans);
  } else if (!auditSpan) {
    console.log('  No compile.generate or audit.session spans found in this trace.');
  }

  // Other pipeline spans (with their emitted cost, when any).
  const otherSpans = spans.filter(
    (s) =>
      s.name === 'compile.triage_requests' ||
      s.name === 'compile.playbook' ||
      s.name === 'teach.detect_tool_candidates' ||
      s.name === 'teach.plan_prereqs' ||
      s.name === 'teach.replay_and_diff',
  );
  if (otherSpans.length > 0) {
    console.log('Other pipeline spans:');
    for (const s of otherSpans) {
      const toolName = attrStr(parseAttrs(s.attributes), 'imprint.tool_name');
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
const kindIdx = args.indexOf('--kind');
const kind = (kindIdx >= 0 ? args[kindIdx + 1] : undefined) ?? 'all';
const rootNames = ROOT_KINDS[kind] ?? ROOT_KINDS.all;

if (traceIdIdx >= 0 && args[traceIdIdx + 1]) {
  await analyzeTrace(args[traceIdIdx + 1] as string);
} else {
  const limit = lastIdx >= 0 ? Number.parseInt(args[lastIdx + 1] ?? '5', 10) : 5;
  const traces = await getRecentTraces(limit + 15, rootNames);
  const shown = traces.slice(0, limit);
  console.log(
    `Found ${traces.length} recent ${kind} trace(s) (${rootNames.join(', ')}); showing last ${shown.length}:\n`,
  );
  for (const trace of shown) {
    await analyzeTrace(trace.context.traceId);
  }
}
