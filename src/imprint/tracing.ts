import { AsyncLocalStorage } from 'node:async_hooks';

type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
type Attributes = Record<string, AttributeValue>;
export interface Span {
  setStatus(status: { code: number; message?: string }): void;
  setAttributes(attributes: Attributes): void;
  recordException(exception: { name?: string; message?: string; stack?: string }): void;
  end(): void;
}

const SpanStatusCode = {
  OK: 1,
  ERROR: 2,
} as const;

interface TraceApi {
  getTracer(name: string): {
    startActiveSpan<T>(
      name: string,
      options: { attributes?: Attributes },
      fn: (span: Span) => Promise<T> | T,
    ): Promise<T>;
    startSpan(name: string, options: { attributes?: Attributes }): Span;
  };
  wrapSpanContext(context: { traceId: string; spanId: string; traceFlags: number }): Span;
}

type TraceKind = 'CHAIN' | 'AGENT' | 'LLM' | 'TOOL' | 'RETRIEVER' | 'EMBEDDING' | 'RERANKER';
type TraceAttributes = Record<string, unknown>;
type TraceLlmMessage = { role?: string; content?: string };
type TraceProvider = { shutdown(): Promise<void> };

const MimeType = {
  TEXT: 'text/plain',
  JSON: 'application/json',
} as const;

const SemanticConventions = {
  INPUT_VALUE: 'input.value',
  INPUT_MIME_TYPE: 'input.mime_type',
  OUTPUT_VALUE: 'output.value',
  OUTPUT_MIME_TYPE: 'output.mime_type',
  OPENINFERENCE_SPAN_KIND: 'openinference.span.kind',
  LLM_TOKEN_COUNT_PROMPT: 'llm.token_count.prompt',
  LLM_TOKEN_COUNT_COMPLETION: 'llm.token_count.completion',
  LLM_TOKEN_COUNT_TOTAL: 'llm.token_count.total',
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ: 'llm.token_count.prompt_details.cache_read',
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE: 'llm.token_count.prompt_details.cache_write',
  LLM_COST_PROMPT: 'llm.cost.prompt',
  LLM_COST_COMPLETION: 'llm.cost.completion',
  LLM_COST_TOTAL: 'llm.cost.total',
  LLM_COST_PROMPT_DETAILS_CACHE_READ: 'llm.cost.prompt_details.cache_read',
  LLM_COST_PROMPT_DETAILS_CACHE_WRITE: 'llm.cost.prompt_details.cache_write',
  LLM_COST_INPUT: 'llm.cost.prompt_details.input',
  LLM_FINISH_REASON: 'llm.invocation.finish_reason',
} as const;

interface PhoenixOtelModule {
  register(opts: {
    projectName: string;
    url?: string;
    apiKey?: string;
    batch?: boolean;
  }): TraceProvider;
}

interface OpenTelemetryApiModule {
  trace: TraceApi;
}

// ---------------------------------------------------------------------------
// Cost accumulator — rolls up LLM costs from child spans to a parent span.
// ---------------------------------------------------------------------------
interface CostAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  completionCost: number;
}

const costAccumulatorStorage = new AsyncLocalStorage<CostAccumulator>();

function getActiveCostAccumulator(): CostAccumulator | undefined {
  return costAccumulatorStorage.getStore();
}

let provider: TraceProvider | null = null;
let traceApi: TraceApi | null = null;
let attemptedInit = false;
let suppressInit = false;
const NOOP_SPAN: Span = {
  setStatus: () => {},
  setAttributes: () => {},
  recordException: () => {},
  end: () => {},
};

export function suppressTracingInit(): void {
  suppressInit = true;
}
const DEFAULT_TRACE_IO_MAX_CHARS = 50_000;
const DEFAULT_TRACE_ERROR_MAX_CHARS = 2000;
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

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

async function ensureTracingInitialized(): Promise<void> {
  if (attemptedInit || suppressInit || !isTracingEnabled()) return;
  attemptedInit = true;
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
  try {
    const otel = (await import('@opentelemetry/api')) as OpenTelemetryApiModule;
    traceApi = otel.trace;
    const phoenix = (await import('@arizeai/phoenix-otel')) as PhoenixOtelModule;
    provider = phoenix.register({
      projectName: process.env.IMPRINT_TRACE_PROJECT ?? 'imprint',
      url,
      apiKey: process.env.PHOENIX_API_KEY,
      batch: traceBatchEnabled(process.env.IMPRINT_TRACE_BATCH),
    });
  } catch (err) {
    process.stderr.write(
      `[imprint] warning: tracing requested but telemetry packages could not be loaded; continuing without export (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

export function traceBatchEnabled(value: string | undefined): boolean {
  return value === undefined ? true : isTruthy(value);
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
 * counts. `llmCostAttributes` expects `inputTokens` to be the TOTAL (it
 * re-derives uncached by subtracting the cache split), and `llm.token_count.prompt`
 * should likewise reflect the whole prompt. So every capture boundary normalizes
 * here instead of feeding the bare uncached count (which billed the cached bulk
 * at the full input rate, or mislabeled the token count). Returns null when the
 * uncached count itself is unknown.
 */
export function totalPromptTokens(
  uncachedInputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): number | null {
  if (uncachedInputTokens == null) return null;
  return uncachedInputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
}

const DEFAULT_MODEL_RATES: Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }> = {
  'claude-opus-4-8': { inputUsdPer1M: 5, outputUsdPer1M: 25 },
  'claude-opus-4-7': { inputUsdPer1M: 5, outputUsdPer1M: 25 },
  'claude-opus-4-6': { inputUsdPer1M: 5, outputUsdPer1M: 25 },
  'claude-opus-4-5': { inputUsdPer1M: 5, outputUsdPer1M: 25 },
  'claude-opus-4-1': { inputUsdPer1M: 15, outputUsdPer1M: 75 },
  'claude-sonnet-4-6': { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  'claude-sonnet-4-5': { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  'claude-haiku-4-5': { inputUsdPer1M: 1, outputUsdPer1M: 5 },
};

export function traceLlmCostRates(
  providerName: string,
  modelName?: string,
): { inputUsdPer1M: number; outputUsdPer1M: number } | null {
  const inputUsdPer1M = envNumber(rateEnvNames(providerName, modelName, 'INPUT'));
  const outputUsdPer1M = envNumber(rateEnvNames(providerName, modelName, 'OUTPUT'));
  if (inputUsdPer1M !== null && outputUsdPer1M !== null) {
    return { inputUsdPer1M, outputUsdPer1M };
  }
  if (modelName) {
    const defaultRate = DEFAULT_MODEL_RATES[modelName];
    if (defaultRate) return defaultRate;
  }
  return null;
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
  await ensureTracingInitialized();
  const tracer = traceApi?.getTracer('imprint');
  if (!tracer) return await fn(NOOP_SPAN);
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

/**
 * Like `traced`, but accumulates `llm.cost.*` from all descendant LLM spans
 * and sets the rolled-up totals on the parent span when `fn` completes.
 * Use on root spans (`cli.teach`, `cli.audit`) so Phoenix shows the full cost.
 */
export async function tracedWithCostRollup<T>(
  name: string,
  kind: TraceKind,
  attributes: TraceAttributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const acc: CostAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    completionCost: 0,
  };

  const applyCostRollup = (span: Span): void => {
    const promptCost = acc.uncachedInputCost + acc.cacheReadCost + acc.cacheWriteCost;
    const totalCost = promptCost + acc.completionCost;
    if (totalCost === 0 && acc.inputTokens === 0 && acc.outputTokens === 0) return;
    setSpanAttributes(span, {
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: acc.inputTokens,
      [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: acc.outputTokens,
      [SemanticConventions.LLM_TOKEN_COUNT_TOTAL]: acc.inputTokens + acc.outputTokens,
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: acc.cacheReadTokens,
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: acc.cacheWriteTokens,
      [SemanticConventions.LLM_COST_PROMPT]: promptCost,
      [SemanticConventions.LLM_COST_COMPLETION]: acc.completionCost,
      [SemanticConventions.LLM_COST_TOTAL]: totalCost,
      [SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_READ]: acc.cacheReadCost,
      [SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_WRITE]: acc.cacheWriteCost,
      [SemanticConventions.LLM_COST_INPUT]: acc.uncachedInputCost,
      'imprint.llm.cost_estimated': true,
    });
  };

  return costAccumulatorStorage.run(acc, () =>
    traced(name, kind, attributes, async (span) => {
      try {
        return await fn(span);
      } finally {
        applyCostRollup(span);
      }
    }),
  );
}

export function startTraceSpan(
  name: string,
  kind: TraceKind,
  attributes?: TraceAttributes,
): Span | null {
  if (!isTracingEnabled()) return null;
  ensureTracingInitialized().catch((err) => {
    process.stderr.write(
      `[imprint] warning: failed to initialize tracing (${err instanceof Error ? err.message : String(err)})\n`,
    );
  });
  const tracer = traceApi?.getTracer('imprint');
  if (!tracer) return null;
  return tracer.startSpan(name, {
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

export function llmSpanAttributes(opts: {
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
}): Attributes {
  const prompt = opts.inputTokens ?? undefined;
  const completion = opts.outputTokens ?? undefined;
  const costRates = traceLlmCostRates(opts.provider, opts.model);
  const cost =
    costRates && (prompt !== undefined || completion !== undefined)
      ? llmCostAttributes({
          inputTokens: prompt,
          outputTokens: completion,
          cacheReadTokens: opts.cacheReadTokens ?? undefined,
          cacheWriteTokens: opts.cacheWriteTokens ?? undefined,
          inputUsdPer1M: costRates.inputUsdPer1M,
          outputUsdPer1M: costRates.outputUsdPer1M,
        })
      : {};
  return {
    ...localLlmAttributes({
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
    ...cost,
    ...(opts.stopReason ? { [SemanticConventions.LLM_FINISH_REASON]: opts.stopReason } : {}),
    'imprint.llm.provider': opts.provider,
    ...(opts.tokenCountsEstimated !== undefined
      ? { 'imprint.llm.tokens_estimated': opts.tokenCountsEstimated }
      : {}),
    ...(opts.inputTokenSource ? { 'imprint.llm.input_tokens_source': opts.inputTokenSource } : {}),
    ...(opts.outputTokenSource
      ? { 'imprint.llm.output_tokens_source': opts.outputTokenSource }
      : {}),
    ...(costRates
      ? {
          'imprint.llm.cost.input_usd_per_1m': costRates.inputUsdPer1M,
          'imprint.llm.cost.output_usd_per_1m': costRates.outputUsdPer1M,
        }
      : {}),
  };
}

function localLlmAttributes(opts: {
  provider: string;
  system: string;
  modelName?: string;
  invocationParameters?: Record<string, unknown>;
  inputMessages?: TraceLlmMessage[];
  outputMessages?: TraceLlmMessage[];
  tokenCount?: { prompt?: number; completion?: number; total?: number };
}): Attributes {
  const attrs: Attributes = {
    'llm.provider': opts.provider,
    'llm.system': opts.system,
  };
  if (opts.modelName) attrs['llm.model_name'] = opts.modelName;
  if (opts.invocationParameters) {
    attrs['llm.invocation_parameters'] = JSON.stringify(opts.invocationParameters);
  }
  if (opts.tokenCount?.prompt !== undefined) {
    attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT] = opts.tokenCount.prompt;
  }
  if (opts.tokenCount?.completion !== undefined) {
    attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION] = opts.tokenCount.completion;
  }
  if (opts.tokenCount?.total !== undefined) {
    attrs[SemanticConventions.LLM_TOKEN_COUNT_TOTAL] = opts.tokenCount.total;
  }
  for (const [prefix, messages] of [
    ['input', opts.inputMessages],
    ['output', opts.outputMessages],
  ] as const) {
    messages?.forEach((message, index) => {
      if (message.role !== undefined) {
        attrs[`llm.${prefix}_messages.${index}.message.role`] = message.role;
      }
      if (message.content !== undefined) {
        attrs[`llm.${prefix}_messages.${index}.message.content`] = message.content;
      }
    });
  }
  return attrs;
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

function llmCostAttributes(opts: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}): Attributes {
  const cacheRead = opts.cacheReadTokens ?? 0;
  const cacheWrite = opts.cacheWriteTokens ?? 0;
  const hasCacheBreakdown = cacheRead > 0 || cacheWrite > 0;
  const uncachedInput =
    opts.inputTokens === undefined
      ? undefined
      : hasCacheBreakdown
        ? Math.max(0, opts.inputTokens - cacheRead - cacheWrite)
        : opts.inputTokens;

  let uncachedInputCost: number | undefined;
  let cacheReadCost = 0;
  let cacheWriteCost = 0;
  if (uncachedInput !== undefined) {
    if (hasCacheBreakdown) {
      uncachedInputCost = (uncachedInput / 1_000_000) * opts.inputUsdPer1M;
      cacheReadCost = (cacheRead / 1_000_000) * opts.inputUsdPer1M * CACHE_READ_MULTIPLIER;
      cacheWriteCost = (cacheWrite / 1_000_000) * opts.inputUsdPer1M * CACHE_WRITE_MULTIPLIER;
    } else {
      uncachedInputCost = (uncachedInput / 1_000_000) * opts.inputUsdPer1M;
    }
  }

  const prompt =
    uncachedInputCost === undefined
      ? undefined
      : uncachedInputCost + cacheReadCost + cacheWriteCost;
  const completion =
    opts.outputTokens === undefined
      ? undefined
      : (opts.outputTokens / 1_000_000) * opts.outputUsdPer1M;
  const total = (prompt ?? 0) + (completion ?? 0);

  // Roll up into the nearest ancestor tracedWithCostRollup, if any.
  const acc = getActiveCostAccumulator();
  if (acc) {
    acc.inputTokens += opts.inputTokens ?? 0;
    acc.outputTokens += opts.outputTokens ?? 0;
    acc.cacheReadTokens += cacheRead;
    acc.cacheWriteTokens += cacheWrite;
    acc.uncachedInputCost += uncachedInputCost ?? 0;
    acc.cacheReadCost += cacheReadCost;
    acc.cacheWriteCost += cacheWriteCost;
    acc.completionCost += completion ?? 0;
  }

  return {
    ...(prompt !== undefined ? { [SemanticConventions.LLM_COST_PROMPT]: prompt } : {}),
    ...(completion !== undefined ? { [SemanticConventions.LLM_COST_COMPLETION]: completion } : {}),
    [SemanticConventions.LLM_COST_TOTAL]: total,
    ...(hasCacheBreakdown
      ? {
          [SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_READ]: cacheReadCost,
          [SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_WRITE]: cacheWriteCost,
          [SemanticConventions.LLM_COST_INPUT]: uncachedInputCost,
          [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: cacheRead,
          [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: cacheWrite,
        }
      : {}),
    'imprint.llm.cost_estimated': true,
  };
}

function rateEnvNames(
  providerName: string,
  modelName: string | undefined,
  side: 'INPUT' | 'OUTPUT',
): string[] {
  const providerKey = envKey(providerName);
  const modelKey = modelName ? envKey(modelName) : undefined;
  const aliases = side === 'INPUT' ? ['INPUT', 'PROMPT'] : ['OUTPUT', 'COMPLETION'];
  const names: string[] = [];
  for (const alias of aliases) {
    if (providerKey && modelKey) {
      names.push(`IMPRINT_TRACE_COST_${providerKey}_${modelKey}_${alias}_USD_PER_1M`);
    }
    if (modelKey) names.push(`IMPRINT_TRACE_COST_${modelKey}_${alias}_USD_PER_1M`);
    if (providerKey) names.push(`IMPRINT_TRACE_COST_${providerKey}_${alias}_USD_PER_1M`);
    names.push(`IMPRINT_TRACE_${alias}_USD_PER_1M`);
  }
  return names;
}

function envKey(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function envNumber(names: string[]): number | null {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
