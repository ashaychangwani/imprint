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
const DEFAULT_TRACE_IO_MAX_CHARS = 50_000;

function isTracingEnabled(): boolean {
  return (
    isTruthy(process.env.IMPRINT_TRACE) ||
    isTruthy(process.env.IMPRINT_TRACING) ||
    isTruthy(process.env.OPENINFERENCE_TRACE) ||
    !!process.env.PHOENIX_COLLECTOR_ENDPOINT ||
    !!process.env.PHOENIX_HOST
  );
}

function ensureTracingInitialized(): void {
  if (attemptedInit || !isTracingEnabled()) return;
  attemptedInit = true;
  provider = register({
    projectName: process.env.IMPRINT_TRACE_PROJECT ?? 'imprint',
    url: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? process.env.PHOENIX_HOST,
    apiKey: process.env.PHOENIX_API_KEY,
    batch: traceBatchEnabled(process.env.IMPRINT_TRACE_BATCH),
  });
}

export function traceBatchEnabled(value: string | undefined): boolean {
  return value === undefined ? true : isTruthy(value);
}

export function traceLlmIoEnabled(): boolean {
  return (
    isTruthy(process.env.IMPRINT_TRACE_LLM_IO) ||
    isTruthy(process.env.IMPRINT_TRACE_IO) ||
    isTruthy(process.env.IMPRINT_TRACE_FULL)
  );
}

export function traceToolIoEnabled(): boolean {
  return (
    isTruthy(process.env.IMPRINT_TRACE_TOOL_IO) ||
    isTruthy(process.env.IMPRINT_TRACE_IO) ||
    isTruthy(process.env.IMPRINT_TRACE_FULL)
  );
}

export function traceIoMaxChars(value = process.env.IMPRINT_TRACE_IO_MAX_CHARS): number {
  if (value === undefined || value === '') return DEFAULT_TRACE_IO_MAX_CHARS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TRACE_IO_MAX_CHARS;
  const truncated = Math.trunc(parsed);
  return truncated < 0 ? DEFAULT_TRACE_IO_MAX_CHARS : truncated;
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
    return { tokens: providerTokens, source: 'provider' };
  }
  if (fallbackText !== undefined) {
    return { tokens: estimateTokensFromText(fallbackText), source: 'estimated' };
  }
  return { source: 'missing' };
}

export function traceLlmCostRates(
  providerName: string,
  modelName?: string,
): { inputUsdPer1M: number; outputUsdPer1M: number } | null {
  const inputUsdPer1M = envNumber(rateEnvNames(providerName, modelName, 'INPUT'));
  const outputUsdPer1M = envNumber(rateEnvNames(providerName, modelName, 'OUTPUT'));
  if (inputUsdPer1M === null || outputUsdPer1M === null) return null;
  return { inputUsdPer1M, outputUsdPer1M };
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

export function llmSpanAttributes(opts: {
  provider: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
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
          inputUsdPer1M: costRates.inputUsdPer1M,
          outputUsdPer1M: costRates.outputUsdPer1M,
        })
      : {};
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
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

function openInferenceProvider(provider: string): string {
  if (provider === 'codex-cli') return 'openai';
  if (provider === 'claude-cli' || provider === 'anthropic-api') return 'anthropic';
  if (provider === 'vertex') return 'google';
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
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}): Attributes {
  const prompt =
    opts.inputTokens === undefined
      ? undefined
      : (opts.inputTokens / 1_000_000) * opts.inputUsdPer1M;
  const completion =
    opts.outputTokens === undefined
      ? undefined
      : (opts.outputTokens / 1_000_000) * opts.outputUsdPer1M;
  const total = (prompt ?? 0) + (completion ?? 0);
  return {
    ...(prompt !== undefined ? { [SemanticConventions.LLM_COST_PROMPT]: prompt } : {}),
    ...(completion !== undefined ? { [SemanticConventions.LLM_COST_COMPLETION]: completion } : {}),
    [SemanticConventions.LLM_COST_TOTAL]: total,
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
