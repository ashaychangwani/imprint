import {
  type BodyComparison,
  type BodyScalarType,
  type BodyStructure,
  type StructureDifference,
  compareBodyStructures,
  decodeBodyStructure,
  describeBodyPaths,
  parseBodyFormat,
  prepareBodyScalarEquality,
} from './body-structure.ts';
import type { CapturedRequest, Session } from './types.ts';

type GroundingState = 'compared' | 'not_checked' | 'invalid' | 'not_found';
type GroundingTruncation =
  | 'request_index'
  | 'event_index'
  | 'before_alternatives'
  | 'after_alternatives';
interface GroundingLimits {
  requestIndex: { total: number; indexed: number; cap: number; truncated: boolean };
  eventIndex: { total: number; indexed: number; cap: number; truncated: boolean };
  alternativesPerSide: number;
}
interface RequestAlternative {
  seq: number;
  method: string;
  resourceType: string;
  hasBody: boolean;
  responseStatus?: number;
}
interface EventGrounding {
  eventSeq: number;
  state: GroundingState;
  reasonCode?: string;
  outcome?: 'changed' | 'no_change' | 'inconclusive';
  changes: StructureDifference[];
  comparison?: Omit<BodyComparison, 'differences'>;
  selectedPair?: { beforeSeq: number; afterSeq: number };
  alternatives: { before: RequestAlternative[]; after: RequestAlternative[] };
  association: { mode: 'unselected' | 'exact_pair' };
  bodyEncoding?: {
    beforeFormat: BodyStructure['format'];
    afterFormat: BodyStructure['format'];
    beforeJsonStringBoundaries: Array<{ depth: number; path?: string }>;
    afterJsonStringBoundaries: Array<{ depth: number; path?: string }>;
    beforePathsTruncated?: true;
    afterPathsTruncated?: true;
  };
  bodyChecks?: Array<{
    seq: number;
    status: 'decoded' | 'skipped' | 'not_checked';
    reasonCode?: string;
  }>;
  work: {
    beforeRequestsAvailable: number;
    afterRequestsAvailable: number;
    alternativesReturned: number;
    bodyDecodesAttempted: number;
    bodyDecodesSucceeded: number;
    bodyDecodesSkipped: number;
    bodyDecodesTruncated: number;
  };
  limits: GroundingLimits;
  truncated?: GroundingTruncation[];
}
const MAX_GROUNDING_REQUESTS = 10_000;
const MAX_GROUNDING_INDEXED_EVENTS = 10_000;
const MAX_EVENT_ALTERNATIVES = 4;
const ENCODING_CONTEXT_LIMIT = 4;
const groundingEncoder = new TextEncoder();
function bodyOf(request: CapturedRequest): string | undefined {
  return (
    (request as unknown as { body?: string }).body ??
    (request as unknown as { requestBody?: string }).requestBody
  );
}
function bodyStructureNotCheckedReason(structure: BodyStructure): string | undefined {
  if (structure.truncated) return structure.truncated;
  if ((structure.nestedJsonExpansion?.candidateNotChecked ?? 0) > 0)
    return 'nested_json_candidate_not_checked';
  return undefined;
}
function lowerBound(requests: CapturedRequest[], seq: number): number {
  let low = 0;
  let high = requests.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((requests[middle]?.seq ?? Number.POSITIVE_INFINITY) < seq) low = middle + 1;
    else high = middle;
  }
  return low;
}
interface GroundingIndex {
  requests: CapturedRequest[];
  events: Set<number>;
  limits: GroundingLimits;
}
function buildGroundingIndex(session: Session): GroundingIndex {
  const requests = session.requests
    .slice(0, MAX_GROUNDING_REQUESTS)
    .sort((left, right) => left.seq - right.seq);
  const indexedEvents = session.events.slice(0, MAX_GROUNDING_INDEXED_EVENTS);
  const events = new Set(indexedEvents.map((event) => event.seq));
  return {
    requests,
    events,
    limits: {
      requestIndex: {
        total: session.requests.length,
        indexed: requests.length,
        cap: MAX_GROUNDING_REQUESTS,
        truncated: session.requests.length > requests.length,
      },
      eventIndex: {
        total: session.events.length,
        indexed: indexedEvents.length,
        cap: MAX_GROUNDING_INDEXED_EVENTS,
        truncated: session.events.length > indexedEvents.length,
      },
      alternativesPerSide: MAX_EVENT_ALTERNATIVES,
    },
  };
}
function boundedEncodingPaths(paths: string[], includePaths: boolean) {
  const described = describeBodyPaths(paths, includePaths);
  return {
    facts: described.facts.slice(0, ENCODING_CONTEXT_LIMIT),
    ...(described.truncated || described.facts.length > ENCODING_CONTEXT_LIMIT
      ? { truncated: true as const }
      : {}),
  };
}
function alternative(request: CapturedRequest): RequestAlternative {
  return {
    seq: request.seq,
    method: String(request.method ?? 'GET'),
    resourceType: request.resourceType,
    hasBody: bodyOf(request) !== undefined,
    ...(request.response ? { responseStatus: request.response.status } : {}),
  };
}
interface GroundEventOptions {
  includePaths?: boolean;
  compare?: {
    beforeSeq: number;
    afterSeq: number;
    beforeFormat?: unknown;
    afterFormat?: unknown;
  };
}
function groundEventWithIndex(
  index: GroundingIndex,
  eventSeq: number,
  options: GroundEventOptions = {},
): EventGrounding {
  const split = Number.isInteger(eventSeq) ? lowerBound(index.requests, eventSeq + 1) : 0;
  const beforeAvailable = split;
  const afterAvailable = index.requests.length - split;
  const before = index.requests
    .slice(Math.max(0, split - MAX_EVENT_ALTERNATIVES), split)
    .reverse()
    .map(alternative);
  const after = index.requests.slice(split, split + MAX_EVENT_ALTERNATIVES).map(alternative);
  const truncated: GroundingTruncation[] = [];
  if (index.limits.requestIndex.truncated) truncated.push('request_index');
  if (index.limits.eventIndex.truncated) truncated.push('event_index');
  if (beforeAvailable > before.length) truncated.push('before_alternatives');
  if (afterAvailable > after.length) truncated.push('after_alternatives');
  const base = {
    eventSeq,
    state: 'not_checked' as GroundingState,
    changes: [] as StructureDifference[],
    alternatives: { before, after },
    association: { mode: options.compare ? ('exact_pair' as const) : ('unselected' as const) },
    work: {
      beforeRequestsAvailable: beforeAvailable,
      afterRequestsAvailable: afterAvailable,
      alternativesReturned: before.length + after.length,
      bodyDecodesAttempted: 0,
      bodyDecodesSucceeded: 0,
      bodyDecodesSkipped: 0,
      bodyDecodesTruncated: 0,
    },
    limits: index.limits,
    ...(truncated.length ? { truncated } : {}),
  };
  if (!Number.isInteger(eventSeq))
    return { ...base, state: 'invalid', reasonCode: 'invalid_event_seq' };
  if (!index.events.has(eventSeq))
    return index.limits.eventIndex.truncated
      ? { ...base, reasonCode: 'event_not_checked_due_to_index_cap' }
      : { ...base, state: 'not_found', reasonCode: 'event_not_found' };
  if (!options.compare) return { ...base, reasonCode: 'agent_pair_required' };
  const { beforeSeq, afterSeq } = options.compare;
  if (!Number.isInteger(beforeSeq) || !Number.isInteger(afterSeq))
    return { ...base, state: 'invalid', reasonCode: 'invalid_request_pair' };
  const beforeRequest = index.requests.find((request) => request.seq === beforeSeq);
  const afterRequest = index.requests.find((request) => request.seq === afterSeq);
  if (!beforeRequest || !afterRequest)
    return {
      ...base,
      state: index.limits.requestIndex.truncated ? 'not_checked' : 'not_found',
      reasonCode: index.limits.requestIndex.truncated
        ? 'selected_request_not_checked_due_to_index_cap'
        : 'selected_request_not_found',
      selectedPair: { beforeSeq, afterSeq },
    };
  const beforeFormat = parseBodyFormat(options.compare.beforeFormat);
  if (!beforeFormat) return { ...base, state: 'invalid', reasonCode: 'invalid_before_format' };
  const afterFormat = parseBodyFormat(options.compare.afterFormat);
  if (!afterFormat) return { ...base, state: 'invalid', reasonCode: 'invalid_after_format' };
  const beforeDecoded = decodeBodyStructure(bodyOf(beforeRequest), beforeFormat);
  const afterDecoded = decodeBodyStructure(bodyOf(afterRequest), afterFormat);
  const beforeTruncation = beforeDecoded.ok
    ? bodyStructureNotCheckedReason(beforeDecoded.structure)
    : undefined;
  const afterTruncation = afterDecoded.ok
    ? bodyStructureNotCheckedReason(afterDecoded.structure)
    : undefined;
  base.work.bodyDecodesAttempted = 2;
  base.work.bodyDecodesSucceeded =
    Number(beforeDecoded.ok && !beforeTruncation) + Number(afterDecoded.ok && !afterTruncation);
  base.work.bodyDecodesSkipped = Number(!beforeDecoded.ok) + Number(!afterDecoded.ok);
  base.work.bodyDecodesTruncated =
    Number(Boolean(beforeTruncation)) + Number(Boolean(afterTruncation));
  const bodyChecks = [
    {
      seq: beforeSeq,
      status: !beforeDecoded.ok
        ? ('skipped' as const)
        : beforeTruncation
          ? ('not_checked' as const)
          : ('decoded' as const),
      ...(!beforeDecoded.ok
        ? { reasonCode: beforeDecoded.code }
        : beforeTruncation
          ? { reasonCode: beforeTruncation }
          : {}),
    },
    {
      seq: afterSeq,
      status: !afterDecoded.ok
        ? ('skipped' as const)
        : afterTruncation
          ? ('not_checked' as const)
          : ('decoded' as const),
      ...(!afterDecoded.ok
        ? { reasonCode: afterDecoded.code }
        : afterTruncation
          ? { reasonCode: afterTruncation }
          : {}),
    },
  ];
  if (!beforeDecoded.ok || !afterDecoded.ok)
    return {
      ...base,
      reasonCode: 'selected_body_not_decoded',
      selectedPair: { beforeSeq, afterSeq },
      bodyChecks,
    };
  if (beforeTruncation || afterTruncation)
    return {
      ...base,
      reasonCode: 'selected_body_decode_truncated',
      selectedPair: { beforeSeq, afterSeq },
      bodyChecks,
    };
  const comparison = compareBodyStructures(beforeDecoded.structure, afterDecoded.structure, {
    includePaths: options.includePaths === true,
  });
  const beforeEncoding = boundedEncodingPaths(
    beforeDecoded.structure.jsonEncodedStringPaths,
    options.includePaths === true,
  );
  const afterEncoding = boundedEncodingPaths(
    afterDecoded.structure.jsonEncodedStringPaths,
    options.includePaths === true,
  );
  return {
    ...base,
    state: 'compared',
    outcome:
      comparison.differences.length > 0
        ? 'changed'
        : comparison.truncated
          ? 'inconclusive'
          : 'no_change',
    selectedPair: { beforeSeq, afterSeq },
    changes: comparison.differences,
    comparison: {
      visitedNodes: comparison.visitedNodes,
      wireEvidence: comparison.wireEvidence,
      ...(comparison.truncated ? { truncated: comparison.truncated } : {}),
    },
    bodyEncoding: {
      beforeFormat: beforeDecoded.structure.format,
      afterFormat: afterDecoded.structure.format,
      beforeJsonStringBoundaries: beforeEncoding.facts,
      afterJsonStringBoundaries: afterEncoding.facts,
      ...(beforeEncoding.truncated ? { beforePathsTruncated: true } : {}),
      ...(afterEncoding.truncated ? { afterPathsTruncated: true } : {}),
    },
    bodyChecks,
  };
}
export function groundEvent(
  session: Session,
  eventSeq: number,
  options: GroundEventOptions = {},
): EventGrounding {
  return groundEventWithIndex(buildGroundingIndex(session), eventSeq, options);
}
type Scalar = string | number | boolean | null;
type ScalarType = BodyScalarType;
const MAX_EQUALITY_HISTORY_REQUESTS = 4_096;
const MAX_EQUALITY_RESPONSES = 12;
const MAX_EQUALITY_RESPONSE_BYTES = 64 * 1024;
const MAX_EQUALITY_TOTAL_BYTES = 256 * 1024;
const MAX_EQUALITY_NODES = 512;
const MAX_EQUALITY_LEAVES = 128;
const MAX_EQUALITY_MATCHES = 8;
function scalarType(value: unknown): ScalarType | undefined {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number' && !Number.isFinite(value)) return undefined;
  return type === 'string' || type === 'number' || type === 'boolean' ? type : undefined;
}
function collectResponseScalars(value: unknown) {
  const leaves: Array<{ path: string; depth: number; type: ScalarType; value: Scalar }> = [];
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: '', depth: 0 },
  ];
  let nodes = 0;
  let nodesTruncated = false;
  let leavesTruncated = false;
  while (stack.length) {
    if (nodes >= MAX_EQUALITY_NODES) {
      nodesTruncated = true;
      break;
    }
    const current = stack.pop();
    if (!current) break;
    nodes++;
    const type = scalarType(current.value);
    if (type) {
      if (leaves.length >= MAX_EQUALITY_LEAVES) {
        leavesTruncated = true;
        break;
      }
      leaves.push({ ...current, type, value: current.value as Scalar });
      continue;
    }
    const entries = Array.isArray(current.value)
      ? current.value.map((item, index) => [String(index), item] as const)
      : current.value && typeof current.value === 'object'
        ? Object.entries(current.value)
        : [];
    const room = Math.max(0, MAX_EQUALITY_NODES - nodes - stack.length);
    if (entries.length > room) nodesTruncated = true;
    for (let index = Math.min(entries.length, room) - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry) continue;
      stack.push({
        value: entry[1],
        path: `${current.path}/${entry[0].replaceAll('~', '~0').replaceAll('/', '~1')}`,
        depth: current.depth + 1,
      });
    }
  }
  return {
    leaves,
    nodes,
    nodesTruncated,
    leavesTruncated,
  };
}
export function findEarlierResponseEqualities(
  session: Session,
  requestSeq: number,
  requestPointer: string,
  selectedStructure: BodyStructure,
  options: { includePaths?: boolean; responseFormat?: unknown } = {},
) {
  const responseFormat = parseBodyFormat(options.responseFormat);
  const facts: Array<{
    responseSeq: number;
    responsePath?: string;
    responseDepth: number;
    matchKind: 'exact_scalar_equality_in_supplied_host_redaction_representation';
    scalarType: ScalarType;
  }> = [];
  const work = {
    earlierHistoryAvailable: 0,
    earlierHistoryInWindow: 0,
    earlierHistoryWindowLimit: MAX_EQUALITY_HISTORY_REQUESTS,
    earlierRequestsScanned: 0,
    responseBodiesFound: 0,
    responsesDecoded: 0,
    responsesSkipped: 0,
    responseNodes: 0,
    responseLeaves: 0,
    comparisons: 0,
  };
  const skippedByReason: Record<string, number> = {};
  const result = {
    requestSeq,
    requestPointer,
    equalityScope: 'supplied_host_redaction_representation_only' as const,
    responseFormat: responseFormat ?? 'invalid',
    facts,
    work,
    skippedByReason,
  };
  if (!responseFormat) return { ...result, reasonCode: 'invalid_response_format' as const };
  const requestIndex = session.requests.findIndex((item) => item.seq === requestSeq);
  if (requestIndex < 0) return { ...result, reasonCode: 'request_not_found' as const };
  if (!session.requests[requestIndex])
    return { ...result, reasonCode: 'request_not_found' as const };
  result.work.earlierHistoryAvailable = requestIndex;
  result.work.earlierHistoryInWindow = Math.min(requestIndex, MAX_EQUALITY_HISTORY_REQUESTS);
  const requests = session.requests
    .slice(Math.max(0, requestIndex - MAX_EQUALITY_HISTORY_REQUESTS), requestIndex + 1)
    .sort((left, right) => left.seq - right.seq);
  const selected = prepareBodyScalarEquality(selectedStructure, requestPointer);
  if (!selected.ok) return { ...result, reasonCode: `selected_pointer_${selected.error}` as const };
  const requestType = selected.scalarType;
  const truncated = new Set<
    'earlier_history' | 'responses' | 'bytes' | 'response_decode' | 'nodes' | 'leaves' | 'matches'
  >();
  if (requestIndex > MAX_EQUALITY_HISTORY_REQUESTS) truncated.add('earlier_history');
  const before = lowerBound(requests, requestSeq);
  let responsesSeen = 0;
  let responseBytes = 0;
  let partialResponseDecode = false;
  const skip = (reason: string) => {
    result.work.responsesSkipped++;
    result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
  };
  outer: for (let position = before - 1; position >= 0; position--) {
    result.work.earlierRequestsScanned++;
    const earlier = requests[position];
    const body = earlier?.response?.body;
    if (!earlier || typeof body !== 'string') {
      skip('missing_response_body');
      continue;
    }
    if (responsesSeen++ >= MAX_EQUALITY_RESPONSES) {
      truncated.add('responses');
      skip('response_count_limit');
      break;
    }
    result.work.responseBodiesFound++;
    if (body.length > MAX_EQUALITY_RESPONSE_BYTES) {
      truncated.add('bytes');
      skip('response_size_limit');
      continue;
    }
    const bytes = groundingEncoder.encode(body).length;
    if (bytes > MAX_EQUALITY_RESPONSE_BYTES) {
      truncated.add('bytes');
      skip('response_size_limit');
      continue;
    }
    if (bytes > MAX_EQUALITY_TOTAL_BYTES - responseBytes) {
      truncated.add('bytes');
      skip('total_response_budget');
      continue;
    }
    responseBytes += bytes;
    const decoded = decodeBodyStructure(body, responseFormat);
    if (!decoded.ok) {
      skip(`decode_${decoded.code}`);
      continue;
    }
    const decodeNotCheckedReason = bodyStructureNotCheckedReason(decoded.structure);
    if (decodeNotCheckedReason) {
      partialResponseDecode = true;
      truncated.add('response_decode');
      skip(`decode_${decodeNotCheckedReason}`);
      continue;
    }
    result.work.responsesDecoded++;
    const collected = collectResponseScalars(decoded.structure.value);
    result.work.responseNodes += collected.nodes;
    result.work.responseLeaves += collected.leaves.length;
    if (collected.nodesTruncated) truncated.add('nodes');
    if (collected.leavesTruncated) truncated.add('leaves');
    for (const leaf of collected.leaves) {
      result.work.comparisons++;
      if (leaf.type !== requestType || !selected.equals(leaf.value)) continue;
      if (result.facts.length >= MAX_EQUALITY_MATCHES) {
        truncated.add('matches');
        break outer;
      }
      result.facts.push({
        responseSeq: earlier.seq,
        ...(options.includePaths ? { responsePath: leaf.path } : {}),
        responseDepth: leaf.depth,
        matchKind: 'exact_scalar_equality_in_supplied_host_redaction_representation',
        scalarType: requestType,
      });
    }
  }
  return {
    ...result,
    reasonCode:
      facts.length > 0
        ? 'matches_found'
        : partialResponseDecode
          ? 'eligible_response_not_fully_decoded'
          : work.responsesDecoded > 0
            ? 'no_equal_scalar_in_supplied_representation'
            : 'no_decoded_responses',
    ...(truncated.size ? { truncated: [...truncated] } : {}),
  };
}
