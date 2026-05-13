import {
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

let provider: NodeTracerProvider | null = null;
let attemptedInit = false;

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
    batch: isTruthy(process.env.IMPRINT_TRACE_BATCH),
  });
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
  stopReason?: string | null;
}): Attributes {
  const prompt = opts.inputTokens ?? undefined;
  const completion = opts.outputTokens ?? undefined;
  return {
    ...getLLMAttributes({
      provider: openInferenceProvider(opts.provider),
      system: opts.provider,
      modelName: opts.model,
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
    ...(opts.stopReason ? { [SemanticConventions.LLM_FINISH_REASON]: opts.stopReason } : {}),
    'imprint.llm.provider': opts.provider,
  };
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

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
