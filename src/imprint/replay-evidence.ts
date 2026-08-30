/**
 * Value-free observations from a second execution of a teaching recording.
 *
 * This module reports alignment, exact equality/difference, temporal request
 * differences, and prior-response correlations. It never assigns meaning to a
 * value or chooses an implementation strategy; the teaching agents do that.
 */

import { createHash } from 'node:crypto';
import { type BodyStructure, decodeBodyStructure } from './body-structure.ts';
import type { Replacement } from './credential-extract.ts';
import { groundEvent } from './param-grounding.ts';
import { replayRawSession } from './replay-capture.ts';
import { type CapturedReplayRequest, alignRequests } from './session-diff.ts';
import type { ToolCandidatePayload } from './tool-candidates.ts';
import type { CapturedRequest, Session } from './types.ts';

const MAX_SCALARS_PER_REQUEST = 2_048;
const TEXT_PREVIEW_BYTES = 700;
const DETAIL_PREVIEW_BYTES = 2_400;
const DOCUMENT_BYTES = 3_600;

interface LocatedScalar {
  location: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'null';
  encoding: 'native' | 'json-string';
  pointer: string | null;
}

interface RequestBodyDecodeFacts {
  status: 'decoded' | 'not_decoded';
  format: BodyStructure['format'] | null;
  code: string | null;
  message: string | null;
  truncation: BodyStructure['truncated'] | null;
  nestedJsonExpansion: BodyStructure['nestedJsonExpansion'] | null;
  scalarsTruncated: boolean;
}

interface PriorResponseCorrelation {
  responseRequestSeq: number;
  responsePath: string;
  observedIn: 'recording' | 'independent_execution';
}

interface IndependentFieldObservation {
  location: string;
  comparison: 'same' | 'different' | 'not_observed';
  priorResponseCorrelation: PriorResponseCorrelation | null;
}

export interface IndependentRequestObservation {
  recordingRequestSeq: number;
  independentRequestSeq: number;
  alignmentStatus: 'aligned' | 'ambiguous_repeated_occurrence';
  alignmentConfidence: number;
  fields: IndependentFieldObservation[];
  fieldsTruncated: boolean;
}

export type IndependentExecutionObservation =
  | {
      status: 'observed';
      requests: IndependentRequestObservation[];
      unmatchedRecordingRequestSeqs: number[];
    }
  | {
      status: 'unavailable';
      requests: [];
      unmatchedRecordingRequestSeqs: [];
      message: string;
    };

export interface FocusedEvidenceScope {
  toolId?: string;
  toolName?: string;
  requestSeqs: readonly number[];
  /** When present, exact scalar detail is limited to these accepted requests. */
  representativeSeqs?: readonly number[];
  dependencySeqs: readonly number[];
  eventSeqs: readonly number[];
}

export interface FocusedEvidenceDocument {
  provenance: 'recording_request' | 'recording_response' | 'recording_event' | 'plan_note';
  value: Record<string, unknown>;
}

type ReplayRunner = typeof replayRawSession;

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function contentDigest(value: string | undefined): string | null {
  if (value === undefined) return null;
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function scalarText(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function scalarType(value: unknown): LocatedScalar['type'] | undefined {
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

function pathEncoding(path: string, encodedPaths: ReadonlySet<string>): LocatedScalar['encoding'] {
  return [...encodedPaths].some((boundary) => path === boundary || path.startsWith(`${boundary}/`))
    ? 'json-string'
    : 'native';
}

function flattenScalars(
  value: unknown,
  path: string,
  encodedPaths: ReadonlySet<string>,
  output: LocatedScalar[],
): void {
  if (output.length >= MAX_SCALARS_PER_REQUEST) return;
  const scalar = scalarText(value);
  const type = scalarType(value);
  if (scalar !== undefined && type !== undefined) {
    output.push({
      location: `body:${path || '/'}`,
      value: scalar,
      type,
      encoding: pathEncoding(path, encodedPaths),
      pointer: path,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      flattenScalars(child, `${path}/${index}`, encodedPaths, output);
      if (output.length >= MAX_SCALARS_PER_REQUEST) return;
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenScalars(child, `${path}/${escapePointer(key)}`, encodedPaths, output);
    if (output.length >= MAX_SCALARS_PER_REQUEST) return;
  }
}

function decodeRequestBody(body: string | undefined): {
  facts: RequestBodyDecodeFacts;
  scalars: LocatedScalar[];
} {
  const automatic = decodeBodyStructure(body, 'auto');
  const decoded = automatic.ok
    ? automatic
    : (() => {
        const framed = decodeBodyStructure(body, 'decimal-framed-json');
        return framed.ok ? framed : automatic;
      })();
  if (!decoded.ok) {
    return {
      facts: {
        status: 'not_decoded',
        format: null,
        code: decoded.code,
        message: decoded.error,
        truncation: null,
        nestedJsonExpansion: null,
        scalarsTruncated: false,
      },
      scalars: [],
    };
  }
  const scalars: LocatedScalar[] = [];
  flattenScalars(
    decoded.structure.value,
    '',
    new Set(decoded.structure.jsonEncodedStringPaths),
    scalars,
  );
  return {
    facts: {
      status: 'decoded',
      format: decoded.structure.format,
      code: null,
      message: null,
      truncation: decoded.structure.truncated ?? null,
      nestedJsonExpansion: decoded.structure.nestedJsonExpansion ?? null,
      scalarsTruncated: scalars.length >= MAX_SCALARS_PER_REQUEST,
    },
    scalars,
  };
}

function requestScalars(
  request: Pick<CapturedRequest, 'url' | 'headers' | 'body'>,
): LocatedScalar[] {
  const output: LocatedScalar[] = [];
  try {
    const url = new URL(request.url);
    const positions = new Map<string, number>();
    for (const [key, value] of url.searchParams) {
      const index = positions.get(key) ?? 0;
      positions.set(key, index + 1);
      output.push({
        location: `query:${key}[${index}]`,
        value,
        type: 'string',
        encoding: 'native',
        pointer: null,
      });
    }
  } catch {
    // The request URL is still visible in the focused request document.
  }
  for (const [name, value] of Object.entries(request.headers)) {
    output.push({
      location: `header:${name.toLowerCase()}`,
      value,
      type: 'string',
      encoding: 'native',
      pointer: null,
    });
  }
  output.push(...decodeRequestBody(request.body).scalars);
  return output.slice(0, MAX_SCALARS_PER_REQUEST);
}

function findValuePath(value: unknown, target: string, path = '$'): string | null {
  const scalar = scalarText(value);
  if (scalar !== undefined) return scalar === target ? path : null;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findValuePath(child, target, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = findValuePath(child, target, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function responseCorrelation(
  value: string,
  requests: ReadonlyArray<Pick<CapturedRequest, 'seq' | 'response'> | CapturedReplayRequest>,
  beforeSeq: number,
): { responseRequestSeq: number; responsePath: string } | null {
  if (value.length < 4) return null;
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (!request || request.seq >= beforeSeq || !request.response) continue;
    for (const [name, candidate] of Object.entries(request.response.headers)) {
      if (candidate === value) {
        return { responseRequestSeq: request.seq, responsePath: `response_header:${name}` };
      }
    }
    const body = request.response.body;
    if (!body || !body.includes(value)) continue;
    try {
      const path = findValuePath(JSON.parse(body), value);
      return { responseRequestSeq: request.seq, responsePath: path ?? 'body(substring)' };
    } catch {
      return { responseRequestSeq: request.seq, responsePath: 'body(substring)' };
    }
  }
  return null;
}

function replacementMap(replacements: readonly Replacement[]): Map<string, string> {
  return new Map(
    replacements
      .filter(({ originalValue }) => originalValue.length > 0)
      .sort((left, right) => right.originalValue.length - left.originalValue.length)
      .map(({ originalValue, placeholder }) => [originalValue, placeholder]),
  );
}

function replaceKnownCredentials(value: string, replacements: ReadonlyMap<string, string>): string {
  let output = value;
  for (const [recorded, placeholder] of replacements)
    output = output.replaceAll(recorded, placeholder);
  return output;
}

function normalizeReplayRequests(
  requests: readonly CapturedReplayRequest[],
  replacements: readonly Replacement[],
): CapturedReplayRequest[] {
  const values = replacementMap(replacements);
  if (values.size === 0) return requests.map((request) => ({ ...request }));
  const strings = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, value]) => [name, replaceKnownCredentials(value, values)]),
    );
  return requests.map((request) => ({
    ...request,
    url: replaceKnownCredentials(request.url, values),
    headers: strings(request.headers),
    ...(request.body === undefined ? {} : { body: replaceKnownCredentials(request.body, values) }),
    ...(request.response
      ? {
          response: {
            ...request.response,
            headers: strings(request.response.headers),
            ...(request.response.body === undefined
              ? {}
              : { body: replaceKnownCredentials(request.response.body, values) }),
          },
        }
      : {}),
  }));
}

function alignmentGroupKey(request: Pick<CapturedRequest, 'method' | 'url'>): string {
  try {
    const url = new URL(request.url);
    return `${request.method}\t${url.hostname}${url.pathname}`;
  } catch {
    return `${request.method}\t${request.url}`;
  }
}

function alignmentGroupCounts(
  requests: ReadonlyArray<Pick<CapturedRequest, 'method' | 'url'>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const key = alignmentGroupKey(request);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Pure observation builder used after any independently captured execution. */
export function compareIndependentExecution(
  recording: Session,
  replayRequests: readonly CapturedReplayRequest[],
  replacements: readonly Replacement[] = [],
): IndependentExecutionObservation {
  const normalizedReplay = normalizeReplayRequests(replayRequests, replacements);
  const pairs = alignRequests(recording.requests, normalizedReplay);
  const replayToRecording = new Map(pairs.map((pair) => [pair.replaySeq, pair.originalSeq]));
  const recordingGroupCounts = alignmentGroupCounts(recording.requests);
  const replayGroupCounts = alignmentGroupCounts(normalizedReplay);
  const requests: IndependentRequestObservation[] = [];

  for (const pair of pairs) {
    const original = recording.requests.find(({ seq }) => seq === pair.originalSeq);
    const replay = normalizedReplay.find(({ seq }) => seq === pair.replaySeq);
    if (!original || !replay) continue;
    const alignmentKey = alignmentGroupKey(original);
    const recordingOccurrences = recordingGroupCounts.get(alignmentKey) ?? 0;
    const replayOccurrences = replayGroupCounts.get(alignmentKey) ?? 0;
    const ambiguousRepeatedOccurrence =
      recordingOccurrences !== replayOccurrences &&
      (recordingOccurrences > 1 || replayOccurrences > 1);
    if (ambiguousRepeatedOccurrence) {
      const originalFields = requestScalars(original);
      requests.push({
        recordingRequestSeq: pair.originalSeq,
        independentRequestSeq: pair.replaySeq,
        alignmentStatus: 'ambiguous_repeated_occurrence',
        alignmentConfidence: pair.confidence,
        fields: originalFields.map(({ location }) => ({
          location,
          comparison: 'not_observed',
          priorResponseCorrelation: null,
        })),
        fieldsTruncated: originalFields.length >= MAX_SCALARS_PER_REQUEST,
      });
      continue;
    }
    const replayFields = new Map(
      requestScalars(replay).map((field) => [field.location, field.value]),
    );
    const originalFields = requestScalars(original);
    const fields = originalFields.map((field): IndependentFieldObservation => {
      const replayValue = replayFields.get(field.location);
      const independentMatch =
        replayValue === undefined
          ? null
          : responseCorrelation(replayValue, normalizedReplay, pair.replaySeq);
      const recordedMatch = responseCorrelation(field.value, recording.requests, pair.originalSeq);
      const match = independentMatch
        ? {
            responseRequestSeq:
              replayToRecording.get(independentMatch.responseRequestSeq) ??
              independentMatch.responseRequestSeq,
            responsePath: independentMatch.responsePath,
            observedIn: 'independent_execution' as const,
          }
        : recordedMatch
          ? { ...recordedMatch, observedIn: 'recording' as const }
          : null;
      return {
        location: field.location,
        comparison:
          replayValue === undefined
            ? 'not_observed'
            : replayValue === field.value
              ? 'same'
              : 'different',
        priorResponseCorrelation: match,
      };
    });
    requests.push({
      recordingRequestSeq: pair.originalSeq,
      independentRequestSeq: pair.replaySeq,
      alignmentStatus: 'aligned',
      alignmentConfidence: pair.confidence,
      fields,
      fieldsTruncated: originalFields.length >= MAX_SCALARS_PER_REQUEST,
    });
  }

  const aligned = new Set(requests.map(({ recordingRequestSeq }) => recordingRequestSeq));
  return {
    status: 'observed',
    requests,
    unmatchedRecordingRequestSeqs: recording.requests
      .filter(({ seq }) => !aligned.has(seq))
      .map(({ seq }) => seq),
  };
}

/** Best-effort browser observation. Failure returns facts about availability and
 * never blocks discovery, planning, compilation, or verification. */
export async function observeIndependentExecution(input: {
  session: Session;
  site: string;
  credentials?: Record<string, string>;
  replacements?: readonly Replacement[];
  replay?: ReplayRunner;
}): Promise<IndependentExecutionObservation> {
  try {
    const replay = await (input.replay ?? replayRawSession)({
      session: input.session,
      site: input.site,
      credentials: input.credentials,
    });
    if (!replay.ok) {
      return {
        status: 'unavailable',
        requests: [],
        unmatchedRecordingRequestSeqs: [],
        message: utf8Prefix(replay.error ?? 'independent execution did not complete', 1_000),
      };
    }
    return compareIndependentExecution(input.session, replay.requests, input.replacements);
  } catch (error) {
    return {
      status: 'unavailable',
      requests: [],
      unmatchedRecordingRequestSeqs: [],
      message: utf8Prefix(error instanceof Error ? error.message : String(error), 1_000),
    };
  }
}

function relevantNarration(session: Session, requestSeqs: Set<number>, eventSeqs: Set<number>) {
  const timestamps = [
    ...session.requests.filter(({ seq }) => requestSeqs.has(seq)).map(({ timestamp }) => timestamp),
    ...session.events.filter(({ seq }) => eventSeqs.has(seq)).map(({ timestamp }) => timestamp),
  ];
  if (timestamps.length === 0) return session.narration;
  const inside = session.narration.filter(({ timestamp }) =>
    timestamps.some((anchor) => Math.abs(timestamp - anchor) <= 30_000),
  );
  if (inside.length > 0) return inside;
  return session.narration
    .slice()
    .sort(
      (left, right) =>
        Math.min(...timestamps.map((anchor) => Math.abs(left.timestamp - anchor))) -
        Math.min(...timestamps.map((anchor) => Math.abs(right.timestamp - anchor))),
    )
    .slice(0, 4)
    .sort((left, right) => left.seq - right.seq);
}

function pushArrayDocuments(
  output: FocusedEvidenceDocument[],
  provenance: FocusedEvidenceDocument['provenance'],
  base: Record<string, unknown>,
  key: string,
  values: readonly unknown[],
): void {
  if (values.length === 0) return;
  let chunk: unknown[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    output.push({ provenance, value: { ...base, [key]: chunk } });
    chunk = [];
  };
  for (const value of values) {
    const next = [...chunk, value];
    if (
      chunk.length > 0 &&
      Buffer.byteLength(JSON.stringify({ ...base, [key]: next }), 'utf8') > DOCUMENT_BYTES
    ) {
      flush();
    }
    chunk.push(value);
  }
  flush();
}

function promptScalarFact(field: LocatedScalar): Record<string, unknown> {
  const valueBytes = Buffer.byteLength(field.value, 'utf8');
  return {
    pointer: field.pointer,
    location: field.location,
    type: field.type,
    encoding: field.encoding,
    valueBytes,
    ...(valueBytes <= 1_600
      ? { valueStatus: 'exact', redactedValue: field.value }
      : {
          valueStatus: 'omitted_oversized',
          redactedValue: null,
          valueSha256: contentDigest(field.value),
        }),
  };
}

function sameRequestShape(left: CapturedRequest, right: CapturedRequest): boolean {
  if (left.method.toUpperCase() !== right.method.toUpperCase()) return false;
  try {
    const leftUrl = new URL(left.url);
    const rightUrl = new URL(right.url);
    return leftUrl.hostname === rightUrl.hostname && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return left.url.split('?')[0] === right.url.split('?')[0];
  }
}

function requestEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return utf8Prefix(`${parsed.origin}${parsed.pathname}`, 700);
  } catch {
    return utf8Prefix(url.split(/[?#]/, 1)[0] ?? url, 700);
  }
}

function scalarLocationCounts(fields: readonly LocatedScalar[]) {
  let query = 0;
  let header = 0;
  let body = 0;
  for (const { location } of fields) {
    if (location.startsWith('query:')) query += 1;
    else if (location.startsWith('header:')) header += 1;
    else if (location.startsWith('body:')) body += 1;
  }
  return { total: fields.length, query, header, body };
}

function requestVariationFacts(
  session: Session,
  request: CapturedRequest,
  independent: IndependentExecutionObservation,
) {
  const observed =
    independent.status === 'observed'
      ? independent.requests.find(({ recordingRequestSeq }) => recordingRequestSeq === request.seq)
      : undefined;
  const recordedFields = requestScalars(request);
  const independentByLocation = new Map(
    (observed?.fields ?? []).map((field) => [field.location, field]),
  );
  const ambiguousAlignment = observed?.alignmentStatus === 'ambiguous_repeated_occurrence';
  return {
    observed,
    recordedFields,
    facts: recordedFields.map((field) => {
      const independentField = independentByLocation.get(field.location);
      const recordedMatch = ambiguousAlignment
        ? null
        : responseCorrelation(field.value, session.requests, request.seq);
      return {
        acceptedConsumerRequestSeq: request.seq,
        location: field.location,
        independentRequestSeq: observed?.independentRequestSeq ?? null,
        alignmentStatus: observed?.alignmentStatus ?? 'not_observed',
        alignmentConfidence: observed?.alignmentConfidence ?? null,
        comparison: ambiguousAlignment
          ? 'not_observed'
          : (independentField?.comparison ?? 'not_observed'),
        priorResponseCorrelation: ambiguousAlignment
          ? null
          : (independentField?.priorResponseCorrelation ??
            (recordedMatch ? { ...recordedMatch, observedIn: 'recording' as const } : null)),
      };
    }),
  };
}

function interleaveDocumentGroups(
  groups: readonly (readonly FocusedEvidenceDocument[])[],
): FocusedEvidenceDocument[] {
  const output: FocusedEvidenceDocument[] = [];
  const maximum = Math.max(0, ...groups.map(({ length }) => length));
  for (let index = 0; index < maximum; index += 1) {
    for (const group of groups) {
      const document = group[index];
      if (document) output.push(document);
    }
  }
  return output;
}

function eventDifferenceFacts(session: Session, scope: FocusedEvidenceScope) {
  const requests = session.requests
    .filter(({ seq }) => scope.requestSeqs.includes(seq))
    .sort((left, right) => left.seq - right.seq);
  return scope.eventSeqs.map((eventSeq) => {
    const before = requests.filter(({ seq }) => seq < eventSeq).at(-1);
    const after = requests.find(({ seq }) => seq > eventSeq);
    if (!before || !after || !sameRequestShape(before, after)) {
      return {
        kind: 'event_request_difference',
        eventSeq,
        association: 'nearest accepted request sequences; temporal only',
        beforeRequestSeq: before?.seq ?? null,
        afterRequestSeq: after?.seq ?? null,
        comparison: 'not_checked',
      };
    }
    const grounded = groundEvent(session, eventSeq, {
      includePaths: true,
      compare: { beforeSeq: before.seq, afterSeq: after.seq },
    });
    return {
      kind: 'event_request_difference',
      eventSeq,
      association: 'nearest accepted same-path request sequences; temporal only',
      beforeRequestSeq: before.seq,
      afterRequestSeq: after.seq,
      comparison: grounded.state,
      outcome: grounded.outcome ?? null,
      changes: grounded.changes,
      truncated: grounded.comparison?.truncated ?? null,
    };
  });
}

function utf8Fragments(value: string, maximumBytes: number): string[] {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return [value];
  const fragments: string[] = [];
  let fragment = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes && fragment) {
      fragments.push(fragment);
      fragment = '';
      bytes = 0;
    }
    fragment += character;
    bytes += characterBytes;
  }
  if (fragment || fragments.length === 0) fragments.push(fragment);
  return fragments;
}

/** Reuse a content-complete, mechanically chunked copy of the detector's
 * compact evidence without deciding which operations should exist. */
export function discoveryEvidenceDocuments(input: {
  candidatePayload: ToolCandidatePayload;
}): FocusedEvidenceDocument[] {
  const { candidatePayload } = input;
  const output: FocusedEvidenceDocument[] = [
    {
      provenance: 'plan_note',
      value: {
        kind: 'discovery_detector_evidence',
        site: candidatePayload.site,
        url: candidatePayload.url,
        narrationCount: candidatePayload.narration.length,
        eventCount: candidatePayload.events.length,
        compactedRequestCount: candidatePayload.requests.length,
      },
    },
  ];
  const narration = candidatePayload.narration.flatMap(({ seq, timestamp, text }) => {
    const fragments = utf8Fragments(text, DETAIL_PREVIEW_BYTES);
    return fragments.map((textFragment, fragmentIndex) => ({
      seq,
      timestamp,
      textFragment,
      fragmentIndex,
      fragmentCount: fragments.length,
    }));
  });
  pushArrayDocuments(
    output,
    'recording_event',
    { kind: 'discovery_detector_narration' },
    'entries',
    narration,
  );
  pushArrayDocuments(
    output,
    'recording_event',
    { kind: 'discovery_detector_events' },
    'events',
    candidatePayload.events,
  );
  pushArrayDocuments(
    output,
    'recording_request',
    { kind: 'discovery_detector_requests' },
    'requests',
    candidatePayload.requests,
  );

  return output;
}

/** Build per-tool prompt documents. The controller stores each document as its
 * own evidence entry, so later requests and narration are not hidden behind one
 * global 4 KB prefix. */
export function focusedEvidenceDocuments(input: {
  session: Session;
  scope: FocusedEvidenceScope;
  independent: IndependentExecutionObservation;
}): FocusedEvidenceDocument[] {
  const { session, scope, independent } = input;
  const requestSeqs = new Set([...scope.requestSeqs, ...scope.dependencySeqs]);
  const eventSeqs = new Set(scope.eventSeqs);
  const representativeSeqs = new Set(
    scope.representativeSeqs?.length ? scope.representativeSeqs : scope.requestSeqs,
  );
  const detailedRequestSeqs = new Set([...representativeSeqs, ...scope.dependencySeqs]);
  const output: FocusedEvidenceDocument[] = [
    {
      provenance: 'plan_note',
      value: {
        kind: 'focused_recording_scope',
        toolId: scope.toolId ?? null,
        toolName: scope.toolName ?? null,
        requestCount: scope.requestSeqs.length,
        representativeRequestCount: representativeSeqs.size,
        dependencyCount: scope.dependencySeqs.length,
        eventCount: scope.eventSeqs.length,
        independentExecutionStatus: independent.status,
        ...(independent.status === 'unavailable'
          ? { independentExecutionMessage: independent.message }
          : {}),
      },
    },
  ];

  const narrationDocuments: FocusedEvidenceDocument[] = [];
  pushArrayDocuments(
    narrationDocuments,
    'recording_event',
    { kind: 'focused_narration' },
    'entries',
    relevantNarration(session, requestSeqs, eventSeqs).map(({ seq, timestamp, text }) => ({
      seq,
      timestamp,
      text: utf8Prefix(text, DETAIL_PREVIEW_BYTES),
    })),
  );

  const detailGroups = new Map<
    number,
    { structure: FocusedEvidenceDocument[]; variation: FocusedEvidenceDocument[] }
  >();
  const requestSummaries: Record<string, unknown>[] = [];
  for (const request of session.requests.filter(({ seq }) => requestSeqs.has(seq))) {
    const bodyEvidence = decodeRequestBody(request.body);
    const locatedScalars = requestScalars(request);
    requestSummaries.push({
      recordingRequestSeq: request.seq,
      role: scope.requestSeqs.includes(request.seq) ? 'accepted' : 'dependency',
      timestamp: request.timestamp,
      method: request.method,
      endpoint: requestEndpoint(request.url),
      resourceType: request.resourceType,
      body: {
        bytes: Buffer.byteLength(request.body ?? '', 'utf8'),
        sha256: contentDigest(request.body),
        decodeStatus: bodyEvidence.facts.status,
        format: bodyEvidence.facts.format,
        code: bodyEvidence.facts.code,
        truncation: bodyEvidence.facts.truncation,
        scalarLocationCounts: scalarLocationCounts(locatedScalars),
        scalarLocationsTruncated:
          bodyEvidence.facts.scalarsTruncated || locatedScalars.length >= MAX_SCALARS_PER_REQUEST,
      },
      detailedScalarEvidenceIncluded: detailedRequestSeqs.has(request.seq),
      response: {
        status: request.response?.status ?? null,
        mimeType: request.response?.mimeType ?? null,
        bodyBytes: Buffer.byteLength(request.response?.body ?? '', 'utf8'),
        bodySha256: contentDigest(request.response?.body),
      },
    });
    if (!detailedRequestSeqs.has(request.seq)) continue;
    const structure: FocusedEvidenceDocument[] = [
      {
        provenance: 'recording_request',
        value: {
          kind: 'focused_request_preview',
          recordingRequestSeq: request.seq,
          url: utf8Prefix(request.url, TEXT_PREVIEW_BYTES),
          bodyPreview: utf8Prefix(request.body ?? '', TEXT_PREVIEW_BYTES),
          responsePreview: utf8Prefix(request.response?.body ?? '', TEXT_PREVIEW_BYTES),
          previewsTruncated: {
            url: Buffer.byteLength(request.url, 'utf8') > TEXT_PREVIEW_BYTES,
            body: Buffer.byteLength(request.body ?? '', 'utf8') > TEXT_PREVIEW_BYTES,
            response: Buffer.byteLength(request.response?.body ?? '', 'utf8') > TEXT_PREVIEW_BYTES,
          },
        },
      },
    ];
    const structureScalars = locatedScalars.map(promptScalarFact);
    const structureBase = {
      kind: 'focused_request_structure',
      recordingRequestSeq: request.seq,
      bodyDecode: bodyEvidence.facts,
      scalarLimit: MAX_SCALARS_PER_REQUEST,
      scalarFactsTruncated:
        bodyEvidence.facts.scalarsTruncated || structureScalars.length >= MAX_SCALARS_PER_REQUEST,
    };
    if (structureScalars.length === 0) {
      structure.push({
        provenance: 'recording_request',
        value: { ...structureBase, scalars: [] },
      });
    } else {
      pushArrayDocuments(
        structure,
        'recording_request',
        structureBase,
        'scalars',
        structureScalars,
      );
    }
    detailGroups.set(request.seq, { structure, variation: [] });
  }

  pushArrayDocuments(
    output,
    'recording_request',
    { kind: 'focused_request_summaries' },
    'requests',
    requestSummaries,
  );
  pushArrayDocuments(
    output,
    'recording_event',
    { kind: 'focused_event_summaries' },
    'events',
    session.events
      .filter(({ seq }) => eventSeqs.has(seq))
      .map(({ seq, timestamp, type, detail }) => ({
        seq,
        timestamp,
        type,
        detailBytes: Buffer.byteLength(detail, 'utf8'),
        detailSha256: contentDigest(detail),
      })),
  );
  const eventDetailDocuments: FocusedEvidenceDocument[] = [];
  pushArrayDocuments(
    eventDetailDocuments,
    'recording_event',
    { kind: 'focused_events' },
    'entries',
    session.events
      .filter(({ seq }) => eventSeqs.has(seq))
      .map(({ seq, timestamp, type, detail }) => ({
        seq,
        timestamp,
        type,
        detail: utf8Prefix(detail, DETAIL_PREVIEW_BYTES),
      })),
  );

  for (const requestSeq of scope.requestSeqs.filter((seq) => representativeSeqs.has(seq))) {
    const request = session.requests.find(({ seq }) => seq === requestSeq);
    if (!request) continue;
    const variation = requestVariationFacts(session, request, independent);
    const documents = detailGroups.get(requestSeq)?.variation ?? [];
    pushArrayDocuments(
      documents,
      'recording_response',
      {
        kind: 'request_variation_and_response_correlation',
        acceptedConsumerRequestSeq: requestSeq,
        factsAreObservationsNotCausality: true,
        absenceOfCorrelationHasNoStrategyMeaning: true,
        fieldsTruncated:
          variation.recordedFields.length >= MAX_SCALARS_PER_REQUEST ||
          variation.observed?.fieldsTruncated === true,
      },
      'fields',
      variation.facts,
    );
    const group = detailGroups.get(requestSeq);
    if (group) group.variation = documents;
  }

  const detailValues = [...detailGroups.values()];
  const detailedDocuments = [
    ...detailValues.flatMap(({ structure }) => structure.slice(0, 1)),
    ...interleaveDocumentGroups(detailValues.map(({ structure }) => structure.slice(1))),
    ...interleaveDocumentGroups(detailValues.map(({ variation }) => variation)),
  ];
  const eventDifferenceDocuments: FocusedEvidenceDocument[] = [];
  pushArrayDocuments(
    eventDifferenceDocuments,
    'recording_event',
    { kind: 'event_driven_request_differences', associationsAreTemporalNotCausal: true },
    'facts',
    eventDifferenceFacts(session, scope),
  );
  return [
    ...output,
    ...narrationDocuments,
    ...eventDetailDocuments,
    ...detailedDocuments,
    ...eventDifferenceDocuments,
  ];
}
