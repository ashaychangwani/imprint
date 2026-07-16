import {
  MimeType,
  type NodeTracerProvider,
  type OpenInferenceSpanKind,
  SemanticConventions,
  SpanStatusCode,
  getLLMAttributes,
  register,
  trace,
} from '@arizeai/phoenix-otel';
import type { AttributeValue, Attributes, Span } from '@opentelemetry/api';

type TraceKind = OpenInferenceSpanKind | `${OpenInferenceSpanKind}`;
type TraceAttributes = Record<string, unknown>;
type TraceLlmMessage = { role?: string; content?: string };

let provider: NodeTracerProvider | null = null;
let attemptedInit = false;
let suppressInit = false;
const NOOP_SPAN: Span = trace.wrapSpanContext({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0,
});

export function suppressTracingInit(): void {
  suppressInit = true;
}
const DEFAULT_TRACE_IO_MAX_CHARS = 50_000;
const DEFAULT_TRACE_ERROR_MAX_CHARS = 2000;

function isTracingEnabled(): boolean {
  return (
    isTruthy(process.env.IMPRINT_TRACE) ||
    isTruthy(process.env.IMPRINT_TRACING) ||
    isTruthy(process.env.OPENINFERENCE_TRACE) ||
    !!process.env.PHOENIX_COLLECTOR_ENDPOINT ||
    !!process.env.PHOENIX_HOST
  );
}

function validateTracingUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      process.stderr.write(
        `[imprint] warning: ignoring tracing endpoint with unsupported protocol: ${raw}\n`,
      );
      return undefined;
    }
    return raw;
  } catch {
    process.stderr.write(`[imprint] warning: ignoring invalid tracing endpoint URL: ${raw}\n`);
    return undefined;
  }
}

function ensureTracingInitialized(): void {
  if (attemptedInit || suppressInit || !isTracingEnabled()) return;
  attemptedInit = true;
  const legacyCostEnv = legacyTraceCostEnvNames();
  if (legacyCostEnv.length > 0) {
    process.stderr.write(
      `[imprint] warning: ${legacyCostEnv.join(', ')} ${legacyCostEnv.length === 1 ? 'is' : 'are'} no longer used; configure model pricing in Phoenix under Settings → Models\n`,
    );
  }
  // The OTEL SDK default is 128 attributes per span. getLLMAttributes() flattens
  // each input message into ~2+ attributes (role, content, tool_calls…), so a
  // 60-message conversation exceeds the cap and silently drops later attributes
  // including token_count and finish_reason. Bump to 1000 to avoid this.
  if (!process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT) {
    process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = '1000';
  }
  const url = validateTracingUrl(
    process.env.PHOENIX_COLLECTOR_ENDPOINT ?? process.env.PHOENIX_HOST,
  );
  provider = register({
    projectName: process.env.IMPRINT_TRACE_PROJECT ?? 'imprint',
    url,
    apiKey: process.env.PHOENIX_API_KEY,
    batch: traceBatchEnabled(process.env.IMPRINT_TRACE_BATCH),
  });
}

export function traceBatchEnabled(value: string | undefined): boolean {
  return value === undefined ? true : isTruthy(value);
}

/** Legacy local-pricing variables retained only to produce an upgrade warning. */
export function legacyTraceCostEnvNames(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        /^IMPRINT_TRACE_(?:INPUT|PROMPT|OUTPUT|COMPLETION)_USD_PER_1M$/.test(name) ||
        /^IMPRINT_TRACE_COST_.+_(?:INPUT|PROMPT|OUTPUT|COMPLETION)_USD_PER_1M$/.test(name),
    )
    .filter((name) => env[name] !== undefined && env[name] !== '')
    .sort();
}

export function traceLlmIoEnabled(): boolean {
  if (process.env.IMPRINT_TRACE_LLM_IO !== undefined)
    return isTruthy(process.env.IMPRINT_TRACE_LLM_IO);
  if (process.env.IMPRINT_TRACE_IO !== undefined) return isTruthy(process.env.IMPRINT_TRACE_IO);
  if (process.env.IMPRINT_TRACE_FULL !== undefined) return isTruthy(process.env.IMPRINT_TRACE_FULL);
  return isTracingEnabled();
}

export function traceToolIoEnabled(): boolean {
  if (process.env.IMPRINT_TRACE_TOOL_IO !== undefined)
    return isTruthy(process.env.IMPRINT_TRACE_TOOL_IO);
  if (process.env.IMPRINT_TRACE_IO !== undefined) return isTruthy(process.env.IMPRINT_TRACE_IO);
  if (process.env.IMPRINT_TRACE_FULL !== undefined) return isTruthy(process.env.IMPRINT_TRACE_FULL);
  return isTracingEnabled();
}

export function traceIoMaxChars(value = process.env.IMPRINT_TRACE_IO_MAX_CHARS): number {
  if (value === undefined || value === '') return DEFAULT_TRACE_IO_MAX_CHARS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) < 0) {
    process.stderr.write(
      `[imprint] warning: IMPRINT_TRACE_IO_MAX_CHARS="${value}" is not a valid non-negative integer, using default ${DEFAULT_TRACE_IO_MAX_CHARS}\n`,
    );
    return DEFAULT_TRACE_IO_MAX_CHARS;
  }
  return Math.trunc(parsed);
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function resolveTraceTokenCount(
  providerTokens: number | null | undefined,
  fallbackText: string | undefined,
): { tokens?: number; source: 'provider' | 'estimated' | 'missing' } {
  if (typeof providerTokens === 'number' && Number.isFinite(providerTokens)) {
    // Sanity check: CLI providers sometimes report impossibly low counts
    // (e.g. 6 tokens for a 50K-char prompt). Prefer estimation in that case.
    if (fallbackText !== undefined && providerTokens > 0) {
      const estimated = estimateTokensFromText(fallbackText);
      if (estimated > 0 && providerTokens < estimated / 10) {
        return { tokens: estimated, source: 'estimated' };
      }
    }
    return { tokens: providerTokens, source: 'provider' };
  }
  if (fallbackText !== undefined) {
    return { tokens: estimateTokensFromText(fallbackText), source: 'estimated' };
  }
  return { source: 'missing' };
}

/**
 * Total prompt tokens = uncached input + cache reads + cache writes.
 *
 * Providers (Anthropic API and the claude CLI alike) report `usage.input_tokens`
 * as the *uncached* portion only — the cached bulk lives in the separate cache
 * counts. `llm.token_count.prompt` must reflect the whole prompt so Phoenix can
 * combine it with the detailed cache token counts and calculate cost server-side.
 * Returns null when the uncached count itself is unknown.
 */
export function totalPromptTokens(
  uncachedInputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): number | null {
  if (uncachedInputTokens == null) return null;
  return uncachedInputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
}

export function traceInputOutputAttributes(
  direction: 'input' | 'output',
  value: string,
  mimeType: string = MimeType.TEXT,
  prefix: string = direction,
): Attributes {
  const captured = captureTraceText(value);
  const valueKey =
    direction === 'input' ? SemanticConventions.INPUT_VALUE : SemanticConventions.OUTPUT_VALUE;
  const mimeKey =
    direction === 'input'
      ? SemanticConventions.INPUT_MIME_TYPE
      : SemanticConventions.OUTPUT_MIME_TYPE;
  return {
    [valueKey]: captured.text,
    [mimeKey]: mimeType,
    [`imprint.trace.${prefix}.chars`]: captured.originalChars,
    [`imprint.trace.${prefix}.truncated`]: captured.truncated,
    ...(captured.maxChars === null
      ? {}
      : { [`imprint.trace.${prefix}.max_chars`]: captured.maxChars }),
  };
}

export function traceJsonInputOutputAttributes(
  direction: 'input' | 'output',
  value: unknown,
  prefix: string = direction,
): Attributes {
  return traceInputOutputAttributes(direction, stringifyTraceValue(value), MimeType.JSON, prefix);
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  const activeProvider = provider;
  provider = null;
  await activeProvider.shutdown();
}

export async function traced<T>(
  name: string,
  kind: TraceKind,
  attributes: TraceAttributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  if (!isTracingEnabled()) {
    return await fn(NOOP_SPAN);
  }
  ensureTracingInitialized();
  const tracer = trace.getTracer('imprint');
  return await tracer.startActiveSpan(
    name,
    { attributes: openInferenceAttributes(kind, attributes) },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        recordSpanError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export function startTraceSpan(
  name: string,
  kind: TraceKind,
  attributes?: TraceAttributes,
): Span | null {
  if (!isTracingEnabled()) return null;
  ensureTracingInitialized();
  return trace.getTracer('imprint').startSpan(name, {
    attributes: openInferenceAttributes(kind, attributes),
  });
}

export function setSpanAttributes(
  span: Span | null | undefined,
  attributes: TraceAttributes,
): void {
  if (!span) return;
  span.setAttributes(cleanAttributes(attributes));
}

export function endTraceSpan(span: Span | null | undefined, err?: unknown): void {
  if (!span) return;
  if (err) {
    recordSpanError(span, err);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

interface LlmSpanAttributeOptions {
  provider: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  tokenCountsEstimated?: boolean;
  inputTokenSource?: string;
  outputTokenSource?: string;
  stopReason?: string | null;
  inputMessages?: TraceLlmMessage[];
  outputMessages?: TraceLlmMessage[];
  inputValue?: string;
  outputValue?: string;
  inputMimeType?: string;
  outputMimeType?: string;
  invocationParameters?: Record<string, unknown>;
}

export function llmSpanAttributes(opts: LlmSpanAttributeOptions): Attributes {
  const prompt = opts.inputTokens ?? undefined;
  const completion = opts.outputTokens ?? undefined;
  const cacheRead = opts.cacheReadTokens ?? undefined;
  const cacheWrite = opts.cacheWriteTokens ?? undefined;
  return {
    ...getLLMAttributes({
      provider: openInferenceProvider(opts.provider),
      system: opts.provider,
      modelName: opts.model,
      invocationParameters: opts.invocationParameters,
      inputMessages: opts.inputMessages,
      outputMessages: opts.outputMessages,
      tokenCount:
        prompt === undefined && completion === undefined
          ? undefined
          : {
              prompt,
              completion,
              total:
                prompt === undefined && completion === undefined
                  ? undefined
                  : (prompt ?? 0) + (completion ?? 0),
            },
    }),
    ...(opts.inputValue
      ? traceInputOutputAttributes('input', opts.inputValue, opts.inputMimeType ?? MimeType.TEXT)
      : {}),
    ...(opts.outputValue
      ? traceInputOutputAttributes('output', opts.outputValue, opts.outputMimeType ?? MimeType.TEXT)
      : {}),
    ...(cacheRead !== undefined
      ? { [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: cacheRead }
      : {}),
    ...(cacheWrite !== undefined
      ? { [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: cacheWrite }
      : {}),
    ...(opts.stopReason ? { [SemanticConventions.LLM_FINISH_REASON]: opts.stopReason } : {}),
    'imprint.llm.provider': opts.provider,
    ...(opts.tokenCountsEstimated !== undefined
      ? { 'imprint.llm.tokens_estimated': opts.tokenCountsEstimated }
      : {}),
    ...(opts.inputTokenSource ? { 'imprint.llm.input_tokens_source': opts.inputTokenSource } : {}),
    ...(opts.outputTokenSource
      ? { 'imprint.llm.output_tokens_source': opts.outputTokenSource }
      : {}),
  };
}

/**
 * Record aggregate token usage reported by an external agent CLI without
 * misclassifying the surrounding tool-driving workflow as one LLM invocation.
 * The zero-duration child is deliberately marked as an aggregate usage carrier:
 * Phoenix can price it, while workflow latency remains on the parent AGENT span.
 */
export function recordLlmUsageSpan(
  name: string,
  opts: LlmSpanAttributeOptions,
  attributes: TraceAttributes = {},
): void {
  const hasUsage =
    (opts.inputTokens ?? 0) > 0 ||
    (opts.outputTokens ?? 0) > 0 ||
    (opts.cacheReadTokens ?? 0) > 0 ||
    (opts.cacheWriteTokens ?? 0) > 0;
  if (!hasUsage) return;
  const span = startTraceSpan(name, 'LLM', {
    ...attributes,
    'imprint.llm.usage_aggregate': true,
    ...llmSpanAttributes(opts),
  });
  endTraceSpan(span);
}

export function traceLlmMessages(messages: TraceLlmMessage[]): TraceLlmMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content === undefined ? undefined : captureTraceText(message.content).text,
  }));
}

function openInferenceAttributes(kind: TraceKind, attributes?: TraceAttributes): Attributes {
  return cleanAttributes({
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: kind,
    ...attributes,
  });
}

function cleanAttributes(attributes: TraceAttributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const cleaned = cleanAttributeValue(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function cleanAttributeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return value;
    if (value.every((v) => typeof v === 'number')) return value;
    if (value.every((v) => typeof v === 'boolean')) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

function recordSpanError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const message = sanitizeTraceErrorMessage(error.message);
  const stack = error.stack ? sanitizeTraceErrorMessage(error.stack) : undefined;
  span.recordException({
    name: error.name,
    message,
    stack,
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export function sanitizeTraceErrorMessage(
  message: string,
  maxChars = DEFAULT_TRACE_ERROR_MAX_CHARS,
): string {
  if (message.length <= maxChars) return message;
  if (maxChars <= 0) return `...[truncated ${message.length} chars]`;
  return `${message.slice(0, maxChars)}\n...[truncated ${message.length - maxChars} chars]`;
}

function openInferenceProvider(provider: string): string {
  if (provider === 'codex-cli') return 'openai';
  if (provider === 'claude-cli' || provider === 'anthropic-api') return 'anthropic';
  return provider;
}

function captureTraceText(text: string): {
  text: string;
  originalChars: number;
  truncated: boolean;
  maxChars: number | null;
} {
  const maxChars = traceIoMaxChars();
  if (text.length <= maxChars) {
    return {
      text,
      originalChars: text.length,
      truncated: false,
      maxChars,
    };
  }
  if (maxChars === 0) {
    return {
      text: `...[truncated ${text.length} chars]`,
      originalChars: text.length,
      truncated: true,
      maxChars,
    };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
    originalChars: text.length,
    truncated: true,
    maxChars,
  };
}

function stringifyTraceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
