#!/usr/bin/env bun
/**
 * Analyze Phoenix traces for compile/audit agent performance + cost.
 *
 * Cost is read from Phoenix's server-calculated `costSummary`. Imprint emits
 * OpenInference model/provider/token attributes and Phoenix owns model pricing,
 * cache discounts, and trace-level rollups.
 *
 * Usage: bun run scripts/analyze-phoenix.ts [--trace-id <id>] [--last <N>] [--kind teach|audit|all]
 */

const PHOENIX_URL = process.env.PHOENIX_URL ?? 'http://localhost:6006';
const PROJECT_ID = 'UHJvamVjdDoy'; // imprint project
const TRACE_SPAN_PAGE_SIZE = 500;
const COST_POLL_ATTEMPTS = 4;
const COST_POLL_INTERVAL_MS = 2000;

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
    throw new Error(phoenixGraphqlErrorMessage(json.errors.map((error) => error.message)));
  }
  return json.data;
}

export function phoenixGraphqlErrorMessage(messages: string[]): string {
  if (messages.some((message) => /cannot query field ['"]?costSummary/i.test(message))) {
    return 'Phoenix cost analysis requires Phoenix 11.4 or newer because this server does not expose GraphQL costSummary. Upgrade arize-phoenix, restart Phoenix, and retry.';
  }
  return `GraphQL error: ${messages.join(', ')}`;
}

export interface SpanNode {
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
  costSummary: CostSummary | null;
  /** Local analyzer state after a bounded wait; never returned by Phoenix. */
  costResolution?: 'unknown';
}

export interface CostSummary {
  prompt: { cost: number | null; tokens: number | null };
  completion: { cost: number | null; tokens: number | null };
  total: { cost: number | null; tokens: number | null };
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

interface SpanPage {
  spans: SpanNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Collect every trace span page so cost completeness is never inferred from a prefix. */
export async function collectSpanPages(
  fetchPage: (after: string | null) => Promise<SpanPage>,
): Promise<SpanNode[]> {
  const spans: SpanNode[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  while (true) {
    const page = await fetchPage(after);
    spans.push(...page.spans);
    if (!page.hasNextPage) return spans;
    if (!page.endCursor || seenCursors.has(page.endCursor)) {
      throw new Error('Phoenix returned an invalid or repeated span-page cursor.');
    }
    seenCursors.add(page.endCursor);
    after = page.endCursor;
  }
}

async function getTraceSpans(traceId: string): Promise<SpanNode[]> {
  return await collectSpanPages(async (after) => {
    const data = (await gql(
      `query TraceSpans($after: String) {
        node(id: "${PROJECT_ID}") {
          ... on Project {
            spans(first: ${TRACE_SPAN_PAGE_SIZE}, after: $after, sort: { col: startTime, dir: asc }, filterCondition: "trace_id == '${traceId}'") {
              edges { node {
                name latencyMs statusCode startTime endTime
                context { traceId spanId }
                parentId
                tokenCountTotal tokenCountPrompt tokenCountCompletion
                costSummary {
                  prompt { cost tokens }
                  completion { cost tokens }
                  total { cost tokens }
                }
                attributes
                numChildSpans
              } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { after },
    )) as {
      node: {
        spans: {
          edges: Array<{ node: SpanNode }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    return {
      spans: data.node.spans.edges.map((edge) => edge.node),
      ...data.node.spans.pageInfo,
    };
  });
}

async function getTraceCost(traceId: string): Promise<number | null> {
  const data = (await gql(`{
    node(id: "${PROJECT_ID}") {
      ... on Project {
        trace(traceId: "${traceId}") {
          costSummary { total { cost } }
        }
      }
    }
  }`)) as { node: { trace: { costSummary: CostSummary } | null } };
  return data.node.trace?.costSummary.total.cost ?? null;
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

/** Phoenix-calculated cost (USD) for one span, or null when unpriced. */
function spanCostTotal(span: SpanNode): number | null {
  return span.costSummary?.total.cost ?? null;
}

export interface PhoenixCostAvailability {
  status: 'priced' | 'partial' | 'unpriced' | 'pending' | 'unknown' | 'no-usage';
  cost: number | null;
  unpricedModels: string[];
  pendingModels: string[];
  unknownModels: string[];
}

function isLlmUsageSpan(span: SpanNode): boolean {
  const attrs = parseAttrs(span.attributes);
  const kind = attrStr(attrs, 'openinference.span.kind');
  const tokens = span.tokenCountTotal ?? attrNum(attrs, 'llm.token_count.total') ?? 0;
  return kind === 'LLM' && tokens > 0;
}

function spanModel(span: SpanNode): string {
  const attrs = parseAttrs(span.attributes);
  return attrStr(attrs, 'llm.model_name') ?? attrStr(attrs, 'imprint.model') ?? 'unknown model';
}

/** Preserve whether Phoenix priced every LLM usage span; never coerce unknown cost to zero. */
export function summarizePhoenixCost(
  spans: SpanNode[],
  traceCost: number | null = null,
): PhoenixCostAvailability {
  const usageSpans = spans.filter(isLlmUsageSpan);
  if (usageSpans.length === 0) {
    return {
      status: 'no-usage',
      cost: null,
      unpricedModels: [],
      pendingModels: [],
      unknownModels: [],
    };
  }
  const pending = usageSpans.filter(
    (span) => span.costSummary == null && span.costResolution !== 'unknown',
  );
  const unknown = usageSpans.filter((span) => span.costResolution === 'unknown');
  const unpriced = usageSpans.filter(
    (span) => span.costSummary != null && spanCostTotal(span) == null,
  );
  const priced = usageSpans.filter((span) => spanCostTotal(span) != null);
  const pricedCost = priced.reduce((sum, span) => sum + (spanCostTotal(span) ?? 0), 0);
  // Span costs and the trace rollup settle asynchronously. Never let a stale
  // zero/partial trace rollup erase cost already materialized on child spans.
  const availableCost = traceCost == null ? pricedCost : Math.max(traceCost, pricedCost);
  const unpricedModels = [...new Set(unpriced.map(spanModel))].sort();
  const pendingModels = [...new Set(pending.map(spanModel))].sort();
  const unknownModels = [...new Set(unknown.map(spanModel))].sort();
  if (pending.length > 0) {
    return { status: 'pending', cost: null, unpricedModels, pendingModels, unknownModels };
  }
  if (unknown.length > 0 && priced.length === 0) {
    return { status: 'unknown', cost: null, unpricedModels, pendingModels: [], unknownModels };
  }
  if (unpriced.length === usageSpans.length) {
    return {
      status: 'unpriced',
      cost: null,
      unpricedModels,
      pendingModels: [],
      unknownModels: [],
    };
  }
  if (unpriced.length > 0 || unknown.length > 0) {
    return {
      status: 'partial',
      cost: availableCost,
      unpricedModels,
      pendingModels: [],
      unknownModels,
    };
  }
  return {
    status: 'priced',
    cost: availableCost,
    unpricedModels: [],
    pendingModels: [],
    unknownModels: [],
  };
}

export function formatPhoenixCost(summary: PhoenixCostAvailability): string {
  if (summary.status === 'pending') {
    return `unknown (cost pending: ${summary.pendingModels.join(', ')})`;
  }
  if (summary.status === 'unpriced') {
    return `unpriced (${summary.unpricedModels.join(', ')})`;
  }
  if (summary.status === 'unknown') {
    const details = [
      ...(summary.unpricedModels.length > 0
        ? [`unpriced: ${summary.unpricedModels.join(', ')}`]
        : []),
      `unpriced or cost pending: ${summary.unknownModels.join(', ')}`,
    ];
    return `unknown (${details.join('; ')})`;
  }
  if (summary.status === 'partial') {
    const details = [
      ...(summary.unpricedModels.length > 0
        ? [`unpriced: ${summary.unpricedModels.join(', ')}`]
        : []),
      ...(summary.unknownModels.length > 0
        ? [`unpriced or cost pending: ${summary.unknownModels.join(', ')}`]
        : []),
    ];
    return `${formatCost(summary.cost ?? 0)} (partial; ${details.join('; ')})`;
  }
  if (summary.status === 'no-usage') return 'unknown (no LLM usage)';
  return formatCost(summary.cost ?? 0);
}

function hasPendingLlmCost(spans: SpanNode[]): boolean {
  return spans.some((span) => isLlmUsageSpan(span) && span.costSummary == null);
}

/**
 * Phoenix 11.4–11.7 leaves costSummary null forever for unmatched models.
 * After the polling budget expires, null remains intrinsically ambiguous: an
 * older Phoenix may have no row for an unmatched model, or a busy calculator
 * may still be processing it. Mark that distinction explicitly instead of
 * coercing it to either unpriced or zero.
 */
export function classifyUnresolvedCostsAsUnknown(spans: SpanNode[]): SpanNode[] {
  return spans.map((span) => {
    if (!isLlmUsageSpan(span) || span.costSummary != null) return span;
    return { ...span, costResolution: 'unknown' };
  });
}

async function getTraceSpansAfterCostSettle(traceId: string): Promise<SpanNode[]> {
  let spans: SpanNode[] = [];
  for (let attempt = 1; attempt <= COST_POLL_ATTEMPTS; attempt++) {
    spans = await getTraceSpans(traceId);
    if (!hasPendingLlmCost(spans)) return spans;
    if (attempt === COST_POLL_ATTEMPTS) return classifyUnresolvedCostsAsUnknown(spans);
    await new Promise((resolve) => setTimeout(resolve, COST_POLL_INTERVAL_MS));
  }
  return spans;
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

function printAuditSummary(span: SpanNode, allSpans: SpanNode[]): void {
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
  const phoenixCost = summarizePhoenixCost([span, ...descendantsOf(allSpans, span.context.spanId)]);

  console.log('\nAudit:');
  console.log(
    `  ${timedOut ? '⏱ ' : ''}${verdict.toUpperCase()} | score ${score == null ? 'n/a' : `${score.toFixed(1)}%`} (${correct} correct / ${broken} broken) | graded ${graded} across ${toolCount ?? '?'} tool(s)`,
  );
  console.log(
    `  excluded: ${infra} infra, ${badParams} bad_params | turns: ${turns ?? '?'} | duration: ${formatDuration(span.latencyMs)}${timedOut ? ' (KILLED at deadline)' : ''}`,
  );
  const costBits: string[] = [];
  if (costUsd != null) costBits.push(`reported ${formatCost(costUsd)}`);
  costBits.push(`Phoenix ${formatPhoenixCost(phoenixCost)}`);
  console.log(`  cost: ${costBits.join(', ')}`);
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

  const subtreeCost = summarizePhoenixCost([span, ...descendantsOf(allSpans, span.context.spanId)]);

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
  console.log(`    Cost: ${formatPhoenixCost(subtreeCost)}`);

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

function spanToolName(span: SpanNode): string {
  return attrStr(parseAttrs(span.attributes), 'imprint.tool_name') ?? '(unknown)';
}

function spanStartMs(span: SpanNode): number {
  const ms = Date.parse(span.startTime);
  return Number.isFinite(ms) ? ms : 0;
}

function spanEndMs(span: SpanNode): number {
  const ms = Date.parse(span.endTime);
  return Number.isFinite(ms) ? ms : spanStartMs(span) + span.latencyMs;
}

function maxConcurrentSpans(spans: SpanNode[]): number {
  const events: Array<{ at: number; delta: number }> = [];
  for (const span of spans) {
    events.push({ at: spanStartMs(span), delta: 1 });
    events.push({ at: spanEndMs(span), delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.delta;
    max = Math.max(max, active);
  }
  return max;
}

function printCompileCriticalPath(compileSpans: SpanNode[]): void {
  const totalToolMs = compileSpans.reduce((sum, span) => sum + span.latencyMs, 0);
  const firstStart = Math.min(...compileSpans.map(spanStartMs));
  const lastEnd = Math.max(...compileSpans.map(spanEndMs));
  const wallMs =
    Number.isFinite(firstStart) && Number.isFinite(lastEnd) && lastEnd > firstStart
      ? lastEnd - firstStart
      : Math.max(...compileSpans.map((span) => span.latencyMs));
  const effectiveConcurrency = wallMs > 0 ? totalToolMs / wallMs : 1;
  const sorted = [...compileSpans].sort((a, b) => b.latencyMs - a.latencyMs);

  console.log('\nCompile critical path:');
  console.log(
    `  Tool wall time: ${formatDuration(wallMs)} | summed tool time: ${formatDuration(totalToolMs)} | effective concurrency: ${effectiveConcurrency.toFixed(2)}x | max observed concurrency: ${maxConcurrentSpans(compileSpans)}x`,
  );
  console.log('  Slowest tools:');
  for (const span of sorted.slice(0, 5)) {
    const share = wallMs > 0 ? (span.latencyMs / wallMs) * 100 : 0;
    console.log(
      `    ${spanToolName(span)}: ${formatDuration(span.latencyMs)} (${share.toFixed(0)}% of compile wall) [${span.statusCode}]`,
    );
  }
}

async function analyzeTrace(traceId: string) {
  const spans = await getTraceSpansAfterCostSettle(traceId);
  const root = spans.find((s) => !s.parentId);
  const traceCost = await getTraceCost(traceId);
  const costAvailability = summarizePhoenixCost(spans, traceCost);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Trace: ${traceId}`);
  console.log(
    `Root: ${root?.name ?? '?'} | Duration: ${formatDuration(root?.latencyMs ?? 0)} | Status: ${root?.statusCode ?? '?'} | Total cost: ${formatPhoenixCost(costAvailability)}`,
  );
  console.log(`Started: ${root?.startTime ?? '?'}`);
  console.log(`${'─'.repeat(80)}`);

  // Audit traces: summarize the audit.session span.
  const auditSpan = spans.find((s) => s.name === 'audit.session');
  if (auditSpan) printAuditSummary(auditSpan, spans);

  // Compile traces: per-tool compile breakdown.
  const compileSpans = spans.filter((s) => s.name === 'compile.generate');
  if (compileSpans.length > 0) {
    printCompileCriticalPath(compileSpans);
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

async function main(args: string[]): Promise<void> {
  const traceIdIdx = args.indexOf('--trace-id');
  const lastIdx = args.indexOf('--last');
  const kindIdx = args.indexOf('--kind');
  const kind = (kindIdx >= 0 ? args[kindIdx + 1] : undefined) ?? 'all';
  const rootNames = ROOT_KINDS[kind] ?? ROOT_KINDS.all ?? ['cli.teach', 'cli.audit'];

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
}

if (import.meta.main) await main(process.argv.slice(2));
