/** Pure adapters from mechanical execution evidence to bounded receipt facts. */
import type { ArtifactRequestProvenance, ChainEdge } from './master-teach-plan.ts';
import { ArtifactRequestProvenanceListSchema } from './master-teach-plan.ts';
import { type ReceiptFact, ReceiptFactSchema } from './master-teach-prompt-projections.ts';
import { compareRecordedRequest } from './recording-request.ts';
import type { CapturedRequest, ToolResult, WorkflowRequest } from './types.ts';

type FactualCheckStatus = ReceiptFact['status'];

interface FactualCheckInput {
  status: FactualCheckStatus;
  facts: ReceiptFact[];
}

type RecordedComparableRequest = Pick<
  CapturedRequest,
  'seq' | 'method' | 'url' | 'headers' | 'body'
>;
type ArtifactComparableRequest = Pick<
  WorkflowRequest,
  'recordingRequestSeq' | 'method' | 'url' | 'headers' | 'body'
>;

interface AcceptedRequestComparisonInput {
  provenance: readonly ArtifactRequestProvenance[];
  recordedRequests: readonly RecordedComparableRequest[];
  artifactRequests: readonly ArtifactComparableRequest[];
  /** A host failure observed before comparing this artifact request. */
  hostError?: {
    artifactRequestIndex: number;
    error: unknown;
  };
}

const COMPARISON_FIELDS = ['headers', 'method', 'originPath', 'url', 'body'] as const;

function summarizeFacts(facts: readonly ReceiptFact[]): FactualCheckStatus {
  if (facts.some(({ status }) => status === 'failed')) return 'failed';
  if (facts.some(({ status }) => status === 'not_checked')) return 'not_checked';
  if (facts.some(({ status }) => status === 'passed')) return 'passed';
  return 'not_applicable';
}

function checkedRequestBytes(
  request: Pick<ArtifactComparableRequest, 'method' | 'url' | 'headers' | 'body'>,
  recorded?: RecordedComparableRequest,
): number {
  const recordedHeaders = new Map(
    Object.entries(recorded?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const headers = Object.entries(request.headers)
    .map(([name, value]) => [
      name.toLowerCase(),
      recorded ? (recordedHeaders.get(name.toLowerCase()) ?? '') : value,
    ])
    .sort(([left], [right]) => (left ?? '').localeCompare(right ?? ''));
  const value = JSON.stringify({
    method: recorded?.method.toUpperCase() ?? request.method.toUpperCase(),
    url: recorded?.url ?? request.url,
    headers,
    body: recorded?.body ?? request.body ?? '',
  });
  return Buffer.byteLength(value, 'utf8');
}

function hostErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 250) || 'host operation failed';
}

function comparisonFact(
  provenance: ArtifactRequestProvenance,
  status: 'not_checked',
  remainingComparisons: number,
): ReceiptFact;
function comparisonFact(
  provenance: ArtifactRequestProvenance,
  status: 'passed' | 'failed',
  remainingComparisons: number,
  lengths: {
    expectedBytes: number;
    actualBytes: number;
    firstMismatchByte?: number;
  },
): ReceiptFact;
function comparisonFact(
  provenance: ArtifactRequestProvenance,
  status: 'passed' | 'failed' | 'not_checked',
  remainingComparisons: number,
  lengths?: {
    expectedBytes: number;
    actualBytes: number;
    firstMismatchByte?: number;
  },
): ReceiptFact {
  return ReceiptFactSchema.parse({
    kind: 'request_comparison',
    subject: `request.${provenance.artifactRequestIndex}`,
    status,
    artifactRequestIndex: provenance.artifactRequestIndex,
    recordingSeq: provenance.recordingRequestSeq,
    ...(lengths ?? {}),
    remainingComparisons,
  });
}

function parsedAcceptedProvenance(
  input: readonly ArtifactRequestProvenance[],
): ArtifactRequestProvenance[] {
  const parsed = ArtifactRequestProvenanceListSchema.safeParse(input);
  if (!parsed.success) throw new Error('accepted request provenance is invalid');
  if (parsed.data.length === 0) {
    throw new Error('request comparison requires at least one accepted request');
  }
  return parsed.data;
}

/**
 * Record that an API replay could not inspect any request bytes. This keeps one
 * value-free fact per accepted request, so `not_checked` and host failures stay
 * distinct from both passes and byte mismatches.
 */
export function acceptedRequestNotCheckedCheck(input: {
  provenance: readonly ArtifactRequestProvenance[];
  hostError?: unknown;
}): FactualCheckInput {
  const provenance = parsedAcceptedProvenance(input.provenance);
  const facts = provenance.map((accepted) =>
    comparisonFact(accepted, 'not_checked', provenance.length - accepted.artifactRequestIndex - 1),
  );
  if (input.hostError !== undefined) {
    facts.push(
      ReceiptFactSchema.parse({
        kind: 'host_error',
        subject: 'request.host',
        status: 'failed',
        hostError: hostErrorMessage(input.hostError),
      }),
    );
  }
  return { status: summarizeFacts(facts), facts };
}

/**
 * API replay is sufficient either when its factual check passed, or when every
 * accepted request is explicitly unchecked because the exact recorded public
 * parameter baseline was unavailable. Host and comparison failures are never
 * accepted by this gate.
 */
export function apiReplayProofSatisfied(facts: readonly ReceiptFact[]): boolean {
  const passed =
    facts.every(({ status }) => status === 'passed' || status === 'not_applicable') &&
    facts.some(({ status }) => status === 'passed');
  if (passed) return true;
  return (
    facts.length > 0 &&
    facts.every(({ kind, status }) => kind === 'request_comparison' && status === 'not_checked')
  );
}

/**
 * Publication gate for an API replay. An unchecked replay is acceptable only
 * when the bound implementation plan explicitly records that its baseline
 * parameter values were unavailable.
 */
export function implementationBoundApiReplayProofSatisfied(
  facts: readonly ReceiptFact[],
  replayParameterValueOrigin: 'recorded_baseline' | 'unavailable' | undefined,
): boolean {
  const passed =
    facts.every(({ status }) => status === 'passed' || status === 'not_applicable') &&
    facts.some(({ status }) => status === 'passed');
  if (passed) return true;
  return replayParameterValueOrigin === 'unavailable' && apiReplayProofSatisfied(facts);
}

function preflightAcceptedRequests(
  provenance: readonly ArtifactRequestProvenance[],
  artifactRequests: readonly ArtifactComparableRequest[],
  recordedRequests: readonly RecordedComparableRequest[],
): {
  artifacts: ArtifactComparableRequest[];
  recordedBySeq: Map<number, RecordedComparableRequest>;
} {
  if (artifactRequests.length !== provenance.length) {
    throw new Error('artifact requests do not match accepted provenance');
  }
  const artifacts: ArtifactComparableRequest[] = [];
  for (const accepted of provenance) {
    const entry = ownDataDescriptor(artifactRequests, String(accepted.artifactRequestIndex))?.value;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('artifact requests do not match accepted provenance');
    }
    const recordingRequestSeq = ownDataDescriptor(entry, 'recordingRequestSeq');
    if (!recordingRequestSeq || recordingRequestSeq.value !== accepted.recordingRequestSeq) {
      throw new Error('artifact requests do not match accepted provenance');
    }
    artifacts.push(entry as ArtifactComparableRequest);
  }

  const recordedBySeq = new Map<number, RecordedComparableRequest>();
  for (let index = 0; index < recordedRequests.length; index++) {
    const entry = ownDataDescriptor(recordedRequests, String(index))?.value;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('recorded requests do not match accepted provenance');
    }
    const seq = ownDataDescriptor(entry, 'seq')?.value;
    if (!Number.isInteger(seq) || (seq as number) < 0 || recordedBySeq.has(seq as number)) {
      throw new Error('recorded requests do not match accepted provenance');
    }
    recordedBySeq.set(seq as number, entry as RecordedComparableRequest);
  }
  if (provenance.some(({ recordingRequestSeq }) => !recordedBySeq.has(recordingRequestSeq))) {
    throw new Error('recorded requests do not match accepted provenance');
  }
  return { artifacts, recordedBySeq };
}

/**
 * Compare artifact requests only against their accepted recording provenance.
 * The projection contains positions and byte lengths, never request values.
 * Once a comparison or host operation fails, later targets are not inspected.
 */
export function acceptedRequestComparisonCheck(
  input: AcceptedRequestComparisonInput,
): FactualCheckInput {
  const provenance = parsedAcceptedProvenance(input.provenance);
  const { artifacts, recordedBySeq } = preflightAcceptedRequests(
    provenance,
    input.artifactRequests,
    input.recordedRequests,
  );
  const hostErrorIndex = input.hostError?.artifactRequestIndex;
  if (
    hostErrorIndex !== undefined &&
    (!Number.isInteger(hostErrorIndex) || hostErrorIndex < 0 || hostErrorIndex >= provenance.length)
  ) {
    throw new Error('host error index is outside accepted provenance');
  }

  const facts: ReceiptFact[] = [];
  let stopped = false;
  let hasObservedHostError = false;
  let observedHostError: unknown;
  for (const accepted of provenance) {
    const remainingComparisons = provenance.length - accepted.artifactRequestIndex - 1;
    if (stopped) {
      facts.push(comparisonFact(accepted, 'not_checked', remainingComparisons));
      continue;
    }
    if (hostErrorIndex === accepted.artifactRequestIndex) {
      facts.push(comparisonFact(accepted, 'not_checked', remainingComparisons));
      stopped = true;
      hasObservedHostError = true;
      observedHostError = input.hostError?.error;
      continue;
    }

    const artifact = artifacts[accepted.artifactRequestIndex];
    if (!artifact) throw new Error('artifact requests do not match accepted provenance');
    const recorded = recordedBySeq.get(accepted.recordingRequestSeq);
    if (!recorded) throw new Error('recorded requests do not match accepted provenance');
    const comparison = compareRecordedRequest(recorded, artifact, {
      requestIndex: accepted.artifactRequestIndex,
    });
    const mismatch = COMPARISON_FIELDS.map((field) => comparison.comparisons[field]).find(
      ({ status }) => status === 'mismatched',
    );
    if (mismatch) {
      if (
        mismatch.workflowBytes === undefined ||
        mismatch.recordedBytes === undefined ||
        mismatch.firstMismatchByte === undefined
      ) {
        throw new Error('recorded request mismatch is missing byte facts');
      }
      facts.push(
        comparisonFact(accepted, 'failed', remainingComparisons, {
          expectedBytes: mismatch.recordedBytes,
          actualBytes: mismatch.workflowBytes,
          firstMismatchByte: mismatch.firstMismatchByte,
        }),
      );
      stopped = true;
      continue;
    }
    facts.push(
      comparisonFact(accepted, 'passed', remainingComparisons, {
        expectedBytes: checkedRequestBytes(artifact, recorded),
        actualBytes: checkedRequestBytes(artifact),
      }),
    );
  }

  if (hasObservedHostError) {
    facts.push(
      ReceiptFactSchema.parse({
        kind: 'host_error',
        subject: 'request.host',
        status: 'failed',
        hostError: hostErrorMessage(observedHostError),
      }),
    );
  }
  return { status: summarizeFacts(facts), facts };
}

/** Browser artifacts have no API request replay. This input records that fact without running one. */
export function browserReplayNotApplicableCheck(): FactualCheckInput {
  const facts = [
    ReceiptFactSchema.parse({
      kind: 'invocation',
      subject: 'replay',
      status: 'not_applicable',
      invocationIndex: 0,
    }),
  ];
  return { status: 'not_applicable', facts };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ResultPathSegment = { kind: 'property'; key: string } | { kind: 'index'; index: number };
type ResultPathFailureReason = 'invalid_path' | 'missing_path' | 'non_json_value';

type JsonResultPathExtraction =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: ResultPathFailureReason };

const MAX_RESULT_PATH_SEGMENTS = 64;

function safePropertyName(key: string): boolean {
  return (
    key.length > 0 &&
    key.trim() === key &&
    [...key].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function parseBracket(
  path: string,
  start: number,
): { segment: ResultPathSegment; next: number } | undefined {
  const numberMatch = /^\[(0|[1-9]\d*)\]/.exec(path.slice(start));
  if (numberMatch) {
    const index = Number(numberMatch[1]);
    if (!Number.isSafeInteger(index)) return undefined;
    return {
      segment: { kind: 'index', index },
      next: start + numberMatch[0].length,
    };
  }
  if (path[start + 1] !== '"') return undefined;
  let escaped = false;
  let quoteEnd = start + 2;
  for (; quoteEnd < path.length; quoteEnd++) {
    const character = path[quoteEnd];
    if (character === '"' && !escaped) break;
    if (character === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  if (quoteEnd >= path.length || path[quoteEnd + 1] !== ']') return undefined;
  let key: unknown;
  try {
    key = JSON.parse(path.slice(start + 1, quoteEnd + 1));
  } catch {
    return undefined;
  }
  if (typeof key !== 'string' || !safePropertyName(key)) return undefined;
  return {
    segment: { kind: 'property', key },
    next: quoteEnd + 2,
  };
}

function parseResultPath(path: string): ResultPathSegment[] | undefined {
  if (path.length === 0 || path.length > 512 || path.trim() !== path) return undefined;
  if (path === '$') return [];
  const rooted = path.startsWith('$');
  let cursor = rooted ? 1 : 0;
  const segments: ResultPathSegment[] = [];
  let needsSeparator = rooted;
  while (cursor < path.length) {
    if (segments.length >= MAX_RESULT_PATH_SEGMENTS) return undefined;
    if (path[cursor] === '.') {
      if (!needsSeparator) return undefined;
      cursor++;
      needsSeparator = false;
      if (cursor >= path.length) return undefined;
    }
    if (path[cursor] === '[') {
      const parsed = parseBracket(path, cursor);
      if (!parsed) return undefined;
      segments.push(parsed.segment);
      cursor = parsed.next;
      needsSeparator = true;
      continue;
    }
    if (needsSeparator) return undefined;
    let end = cursor;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end++;
    const key = path.slice(cursor, end);
    if (!safePropertyName(key) || key.includes(']')) return undefined;
    segments.push({ kind: 'property', key });
    cursor = end;
    needsSeparator = true;
  }
  return segments;
}

type OwnDataDescriptor = PropertyDescriptor & { value: unknown };

function ownDataDescriptor(object: object, key: PropertyKey): OwnDataDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? (descriptor as OwnDataDescriptor) : undefined;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) return false;
      }
      return true;
    }
    return Object.keys(value).every((key) =>
      isJsonValue((value as Record<string, unknown>)[key], ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Resolve a bounded property/index path using ordinary own-property traversal. */
export function extractJsonResultPath(result: unknown, path: string): JsonResultPathExtraction {
  const segments = parseResultPath(path);
  if (!segments) return { ok: false, reason: 'invalid_path' };
  let current = result;
  for (const segment of segments) {
    if (segment.kind === 'index') {
      if (
        !Array.isArray(current) ||
        segment.index >= current.length ||
        !Object.hasOwn(current, segment.index)
      ) {
        return { ok: false, reason: 'missing_path' };
      }
      current = current[segment.index];
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { ok: false, reason: 'missing_path' };
    }
    if (!Object.hasOwn(current, segment.key)) return { ok: false, reason: 'missing_path' };
    current = (current as Record<string, unknown>)[segment.key];
  }
  return isJsonValue(current)
    ? { ok: true, value: current }
    : { ok: false, reason: 'non_json_value' };
}

interface ConsumerParameterDeclaration {
  name: string;
  type: 'string' | 'number' | 'boolean';
}

type ChainParameterBinding =
  | { ok: true; parameters: Record<string, string | number | boolean> }
  | {
      ok: false;
      reason:
        | ResultPathFailureReason
        | 'consumer_parameter_not_declared'
        | 'consumer_parameter_declared_more_than_once'
        | 'invalid_consumer_parameters'
        | 'value_not_bindable'
        | 'parameter_type_mismatch';
    };

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function validParameterName(name: string): boolean {
  return PARAMETER_NAME.test(name);
}

function parameterType(value: string | number | boolean): ConsumerParameterDeclaration['type'] {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
}

function copyConsumerParameters(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const copy: Record<string, string | number | boolean> = {};
  for (const [key, parameterValue] of Object.entries(value)) {
    if (!validParameterName(key)) return undefined;
    if (
      typeof parameterValue !== 'string' &&
      typeof parameterValue !== 'boolean' &&
      (typeof parameterValue !== 'number' || !Number.isFinite(parameterValue))
    ) {
      return undefined;
    }
    copy[key] = parameterValue;
  }
  return copy;
}

/** Bind the exact producer scalar to the declared consumer slot without coercion. */
export function bindProducerResultToConsumer(input: {
  edge: Pick<ChainEdge, 'producerResultPath' | 'consumerParameter'>;
  producerResult: unknown;
  consumerParameterDeclarations: readonly ConsumerParameterDeclaration[];
  consumerParameters?: Readonly<Record<string, string | number | boolean>>;
}): ChainParameterBinding {
  const declarations = input.consumerParameterDeclarations.filter(
    ({ name }) => name === input.edge.consumerParameter,
  );
  if (declarations.length === 0) return { ok: false, reason: 'consumer_parameter_not_declared' };
  if (declarations.length > 1) {
    return { ok: false, reason: 'consumer_parameter_declared_more_than_once' };
  }
  if (!validParameterName(input.edge.consumerParameter)) {
    return { ok: false, reason: 'consumer_parameter_not_declared' };
  }
  const extracted = extractJsonResultPath(input.producerResult, input.edge.producerResultPath);
  if (!extracted.ok) return extracted;
  const value = extracted.value;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return { ok: false, reason: 'value_not_bindable' };
  }
  const declaration = declarations[0];
  if (!declaration || parameterType(value) !== declaration.type) {
    return { ok: false, reason: 'parameter_type_mismatch' };
  }
  const parameters = copyConsumerParameters(input.consumerParameters);
  if (!parameters) return { ok: false, reason: 'invalid_consumer_parameters' };
  return {
    ok: true,
    parameters: { ...parameters, [input.edge.consumerParameter]: value },
  };
}

type MechanicalInvocationOutcome =
  | { kind: 'returned'; result: ToolResult<unknown> }
  | { kind: 'host_error'; error: unknown };

function resultCount(result: unknown): number {
  if (result === null || result === undefined) return 0;
  return Array.isArray(result) ? result.length : 1;
}

/** Project one invocation into bounded facts; returned result values are never copied. */
export function invocationOutcomeCheck(input: {
  subject: string;
  invocationIndex: number;
  outcome: MechanicalInvocationOutcome;
  durationMs?: number;
  executionMechanism?: string;
}): FactualCheckInput {
  const invocationBase = {
    kind: 'invocation' as const,
    subject: input.subject,
    invocationIndex: input.invocationIndex,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.executionMechanism === undefined
      ? {}
      : { executionMechanism: input.executionMechanism }),
  };
  const facts: ReceiptFact[] = [];
  if (input.outcome.kind === 'host_error') {
    facts.push(
      ReceiptFactSchema.parse({ ...invocationBase, status: 'failed' }),
      ReceiptFactSchema.parse({
        kind: 'result',
        subject: input.subject,
        status: 'not_checked',
        resultCount: 0,
      }),
      ReceiptFactSchema.parse({
        kind: 'host_error',
        subject: input.subject,
        status: 'failed',
        hostError: hostErrorMessage(input.outcome.error),
      }),
    );
  } else if (input.outcome.result.ok) {
    facts.push(
      ReceiptFactSchema.parse({ ...invocationBase, status: 'passed' }),
      ReceiptFactSchema.parse({
        kind: 'result',
        subject: input.subject,
        status: 'passed',
        resultCount: resultCount(input.outcome.result.data),
      }),
    );
  } else {
    facts.push(
      ReceiptFactSchema.parse({ ...invocationBase, status: 'failed' }),
      ReceiptFactSchema.parse({
        kind: 'result',
        subject: input.subject,
        status: 'failed',
        resultCount: 0,
      }),
    );
  }
  return { status: summarizeFacts(facts), facts };
}
