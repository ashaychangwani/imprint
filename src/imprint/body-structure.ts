type BodyFormat = 'auto' | 'json' | 'form-urlencoded' | 'decimal-framed-json';
export type BodyWireFormat = Exclude<BodyFormat, 'auto'>;
type BodyErrorCode =
  | 'format_required'
  | 'invalid_format'
  | 'invalid_body'
  | 'limit'
  | 'not_applicable';
export interface BodyStructure {
  format: BodyWireFormat;
  value: unknown;
  sourceValue?: unknown;
  jsonEncodedStringPaths: string[];
  truncated?: 'nested_json_limit';
  nestedJsonExpansion?: {
    candidatesObserved: number;
    attempted: number;
    expanded: number;
    truncated: number;
    candidateNotChecked: number;
    candidateNotCheckedState?: 'candidate_not_checked';
    nodesVisited: number;
    perStringNodeLimit: number;
    totalNodeLimit: number;
    totalLimitReached: boolean;
  };
}
type BodyDecodeResult =
  | { ok: true; structure: BodyStructure }
  | { ok: false; error: string; code: BodyErrorCode };
interface StructureFact {
  path: string;
  type: string;
  length?: number;
  encoding: 'native' | 'json-string';
}
export type BodyScalarType = 'string' | 'number' | 'boolean' | 'null';
export interface StructureDifference {
  depth: number;
  path?: string;
  kind: 'format' | 'encoding' | 'missing' | 'type' | 'length' | 'value';
  leftType?: string;
  rightType?: string;
  leftLength?: number;
  rightLength?: number;
  leftEncoding?: 'native' | 'json-string';
  rightEncoding?: 'native' | 'json-string';
  leftFormat?: BodyWireFormat;
  rightFormat?: BodyWireFormat;
  missingFrom?: 'left' | 'right' | 'both';
}
export type BodyComparisonTruncation = 'max_nodes' | 'max_differences' | 'max_depth' | 'max_path';
export interface BodyComparison {
  differences: StructureDifference[];
  visitedNodes: number;
  wireEvidence: 'unavailable_from_redacted_evidence';
  truncated?: BodyComparisonTruncation;
}
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_DECODE_NODES = 10_000;
const MAX_FORM_FIELDS = 4_096;
const MAX_DEPTH = 24;
const MAX_PATH_BYTES = 512;
const MAX_POINTER_SEGMENTS = 64;
const MAX_COMPARE_NODES = 2_000;
const MAX_DIFFERENCES = 12;
const MAX_PATH_FACTS = 8;
const MAX_FRAME_PREAMBLE_BYTES = 256;
const MAX_FRAME_PREAMBLE_LINES = 8;
const MAX_FRAME_GUARD_BYTES = 64;
const MAX_NESTED_STRING_NODES = 1_024;
const MAX_NESTED_TOTAL_NODES = 4_096;
const LIMIT = Symbol('body structure limit');
const NESTED_LIMIT = Symbol('nested JSON limit');
const INVALID_FORM = Symbol('invalid form encoding');
const encoder = new TextEncoder();
export function parseBodyFormat(value: unknown = 'auto'): BodyFormat | undefined {
  switch (value) {
    case 'auto':
    case 'json':
    case 'form-urlencoded':
    case 'decimal-framed-json':
      return value;
    default:
      return undefined;
  }
}
function failure(code: BodyErrorCode, error: string): BodyDecodeResult {
  return { ok: false, code, error };
}
const byteLength = (value: string): number => encoder.encode(value).length;
function childPath(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}
function pointerDepth(path: string): number {
  return path === '' ? 0 : path.split('/').length - 1;
}
function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function valueLength(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return undefined;
}
function frameStart(body: string): number {
  let offset = 0;
  let preambleLines = 0;
  let guardSeen = false;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\n', offset);
    if (lineEnd < 0) throw new Error('missing frame length newline');
    let headerEnd = lineEnd;
    if (headerEnd > offset && body.charCodeAt(headerEnd - 1) === 13) headerEnd--;
    const header = body.slice(offset, headerEnd);
    if (/^(0|[1-9]\d{0,8})$/.test(header)) return offset;
    const punctuationGuard =
      header.length > 0 &&
      header.length <= MAX_FRAME_GUARD_BYTES &&
      [...header].every((character) => {
        const code = character.charCodeAt(0);
        return (
          (code >= 33 && code <= 47) ||
          (code >= 58 && code <= 64) ||
          (code >= 91 && code <= 96) ||
          (code >= 123 && code <= 126)
        );
      });
    if (header.length > 0 && (guardSeen || !punctuationGuard))
      throw new Error('invalid framed preamble');
    if (header.length > 0) guardSeen = true;
    offset = lineEnd + 1;
    if (
      ++preambleLines > MAX_FRAME_PREAMBLE_LINES ||
      byteLength(body.slice(0, offset)) > MAX_FRAME_PREAMBLE_BYTES
    )
      throw new Error('framed preamble exceeds safety limit');
  }
  throw new Error('missing frame length');
}
function utf8End(body: string, start: number, length: number): number | undefined {
  let bytes = 0;
  let offset = start;
  while (offset < body.length && bytes < length) {
    const codePoint = body.codePointAt(offset);
    if (codePoint === undefined) return undefined;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > length) return undefined;
    bytes += size;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return bytes === length ? offset : undefined;
}
function afterFrameDelimiter(body: string, end: number): number | undefined {
  if (end === body.length) return end;
  if (body.charCodeAt(end) === 13 && body.charCodeAt(end + 1) === 10) return end + 2;
  if (body.charCodeAt(end) === 10) return end + 1;
  return undefined;
}
function framedPayload(
  body: string,
  start: number,
  declaredLength: number,
): { value: unknown; next: number } {
  const ends = new Set<number>();
  // Captures use two bounded framing conventions: the decimal counts the JSON
  // payload itself, or the payload plus its two-character record delimiter.
  // Either count may be expressed in UTF-8 bytes or JavaScript string units.
  for (const length of [declaredLength, declaredLength - 2]) {
    if (length <= 0) continue;
    if (start + length <= body.length) ends.add(start + length);
    const byteEnd = utf8End(body, start, length);
    if (byteEnd !== undefined) ends.add(byteEnd);
  }
  const candidates: { value: unknown; next: number }[] = [];
  for (const end of ends) {
    const next = afterFrameDelimiter(body, end);
    if (next === undefined) continue;
    try {
      candidates.push({ value: JSON.parse(body.slice(start, end)), next });
    } catch {
      // This exact bounded length convention does not describe a JSON frame.
    }
  }
  const unique = candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.next === candidate.next) === index,
  );
  if (unique.length !== 1) throw new Error('invalid or ambiguous decimal frame length');
  return unique[0] as { value: unknown; next: number };
}
function parseFrames(body: string): unknown[] {
  const frames: unknown[] = [];
  let offset = frameStart(body);
  while (offset < body.length) {
    const lineEnd = body.indexOf('\n', offset);
    if (lineEnd < 0) throw new Error('missing frame length newline');
    let headerEnd = lineEnd;
    if (headerEnd > offset && body.charCodeAt(headerEnd - 1) === 13) headerEnd--;
    const header = body.slice(offset, headerEnd);
    if (!/^(0|[1-9]\d{0,8})$/.test(header)) throw new Error('invalid decimal frame length');
    const length = Number(header);
    const start = lineEnd + 1;
    if (length === 0) throw new Error('invalid decimal frame length');
    const frame = framedPayload(body, start, length);
    frames.push(frame.value);
    offset = frame.next;
  }
  if (frames.length === 0) throw new Error('no frames');
  return frames;
}
function decodeFormComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    throw INVALID_FORM;
  }
}
function parseForm(body: string): Record<string, unknown> {
  const fields = new Map<string, string[]>();
  let start = 0;
  let count = 0;
  for (let end = 0; end <= body.length; end++) {
    if (end < body.length && body.charCodeAt(end) !== 38) continue;
    const pair = body.slice(start, end);
    start = end + 1;
    if (pair.length === 0) continue;
    if (++count > MAX_FORM_FIELDS) throw LIMIT;
    const equals = pair.indexOf('=');
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const rawValue = equals < 0 ? '' : pair.slice(equals + 1);
    const key = decodeFormComponent(rawKey);
    const entry = decodeFormComponent(rawValue);
    const entries = fields.get(key);
    if (entries) entries.push(entry);
    else fields.set(key, [entry]);
  }
  const value = Object.create(null) as Record<string, unknown>;
  for (const [key, entries] of fields) {
    const base = childPath('', key);
    if (byteLength(base) > MAX_PATH_BYTES) throw LIMIT;
    value[key] = entries.length === 1 ? entries[0] : entries;
  }
  return value;
}
function inferFormat(body: string): BodyWireFormat | 'ambiguous' | 'unsupported' {
  const trimmed = body.trim();
  try {
    frameStart(body);
    return 'ambiguous';
  } catch {
    // Not a supported explicit frame prefix.
  }
  if (/[}\]]\s*\r?\n\s*[{[]/.test(trimmed)) return 'ambiguous';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/(^|&)[^=&]+=[^&]*/.test(trimmed)) return 'form-urlencoded';
  return 'unsupported';
}
export function decodeBodyStructure(
  body: string | undefined,
  format: unknown = 'auto',
): BodyDecodeResult {
  const selectedFormat = parseBodyFormat(format);
  if (!selectedFormat) return failure('invalid_format', 'unsupported body format');
  if (!body) return failure('not_applicable', 'body is empty');
  if (byteLength(body) > MAX_INPUT_BYTES)
    return failure('limit', 'body exceeds input safety limit');
  const inferred = selectedFormat === 'auto' ? inferFormat(body) : selectedFormat;
  if (inferred === 'ambiguous')
    return failure(
      'format_required',
      'body needs an explicit supported format before it can be inspected',
    );
  if (inferred === 'unsupported')
    return failure('not_applicable', 'plain or opaque body structure is unsupported');
  try {
    let parsed: unknown;
    if (inferred === 'json') parsed = JSON.parse(body);
    else if (inferred === 'decimal-framed-json') parsed = parseFrames(body);
    else parsed = parseForm(body);
    let nativeNodes = 0;
    let nestedNodes = 0;
    let nestedCandidatesObserved = 0;
    let nestedAttempts = 0;
    let nestedExpanded = 0;
    let nestedTruncated = 0;
    let nestedCandidatesNotChecked = 0;
    let nestedTotalLimitReached = false;
    const encodedPaths: string[] = [];
    const visit = (
      value: unknown,
      path: string,
      depth: number,
      nestedBudget?: { nodes: number },
    ): unknown => {
      if (depth > MAX_DEPTH || byteLength(path) > MAX_PATH_BYTES)
        throw nestedBudget ? NESTED_LIMIT : LIMIT;
      if (nestedBudget) {
        if (
          nestedBudget.nodes >= MAX_NESTED_STRING_NODES ||
          nestedNodes >= MAX_NESTED_TOTAL_NODES
        ) {
          if (nestedNodes >= MAX_NESTED_TOTAL_NODES) nestedTotalLimitReached = true;
          throw NESTED_LIMIT;
        }
        nestedBudget.nodes++;
        nestedNodes++;
      } else if (++nativeNodes > MAX_DECODE_NODES) throw LIMIT;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          nestedCandidatesObserved++;
          if (nestedNodes >= MAX_NESTED_TOTAL_NODES) {
            nestedTotalLimitReached = true;
            nestedCandidatesNotChecked++;
            return value;
          }
          nestedAttempts++;
          let nested: unknown;
          try {
            nested = JSON.parse(trimmed);
          } catch {
            return value;
          }
          encodedPaths.push(path);
          try {
            const expanded = visit(nested, path, depth + 1, { nodes: 0 });
            nestedExpanded++;
            return expanded;
          } catch (error) {
            if (error !== NESTED_LIMIT) throw error;
            nestedTruncated++;
          }
        }
        return value;
      }
      if (Array.isArray(value))
        return value.map((item, index) =>
          visit(item, childPath(path, index), depth + 1, nestedBudget),
        );
      if (value && typeof value === 'object') {
        const out = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(value))
          out[key] = visit(item, childPath(path, key), depth + 1, nestedBudget);
        return out;
      }
      return value;
    };
    const structure: BodyStructure = {
      format: inferred,
      value: visit(parsed, '', 0),
      sourceValue: parsed,
      jsonEncodedStringPaths: encodedPaths,
      ...(nestedTruncated ? { truncated: 'nested_json_limit' as const } : {}),
      ...(nestedCandidatesObserved
        ? {
            nestedJsonExpansion: {
              candidatesObserved: nestedCandidatesObserved,
              attempted: nestedAttempts,
              expanded: nestedExpanded,
              truncated: nestedTruncated,
              candidateNotChecked: nestedCandidatesNotChecked,
              ...(nestedCandidatesNotChecked
                ? { candidateNotCheckedState: 'candidate_not_checked' as const }
                : {}),
              nodesVisited: nestedNodes,
              perStringNodeLimit: MAX_NESTED_STRING_NODES,
              totalNodeLimit: MAX_NESTED_TOTAL_NODES,
              totalLimitReached: nestedTotalLimitReached,
            },
          }
        : {}),
    };
    return { ok: true, structure };
  } catch (error) {
    if (error === LIMIT) return failure('limit', 'body structure exceeds safety limits');
    if (error === INVALID_FORM) return failure('invalid_body', 'invalid form-urlencoded body');
    return failure('invalid_body', `invalid ${inferred} body`);
  }
}
function decodePointer(pointer: string): string[] | null {
  if (byteLength(pointer) > MAX_PATH_BYTES || (pointer !== '' && !pointer.startsWith('/')))
    return null;
  const raw = pointer === '' ? [] : pointer.slice(1).split('/');
  if (raw.length > MAX_POINTER_SEGMENTS || raw.some((token) => /~(?:[^01]|$)/.test(token)))
    return null;
  return raw.map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}
function resolveBodyPointer(
  structure: BodyStructure,
  pointer: string,
):
  | { ok: true; value?: unknown; missing?: true; crossedEncoding: boolean }
  | { ok: false; error: string } {
  const tokens = decodePointer(pointer);
  if (!tokens) return { ok: false, error: 'invalid or oversized RFC 6901 pointer' };
  let value = structure.sourceValue ?? structure.value;
  let crossedEncoding = false;
  let nestedDepth = 0;
  const decodeSelectedString = (): boolean => {
    while (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return true;
      if (++nestedDepth > MAX_DEPTH || byteLength(trimmed) > MAX_INPUT_BYTES) return false;
      try {
        value = JSON.parse(trimmed);
        crossedEncoding = true;
      } catch {
        return true;
      }
    }
    return true;
  };
  for (const token of tokens) {
    if (!decodeSelectedString())
      return { ok: false, error: 'selected nested JSON exceeds safety limits' };
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= value.length)
        return { ok: true, missing: true, crossedEncoding };
      value = value[Number(token)];
    } else if (value && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else return { ok: true, missing: true, crossedEncoding };
  }
  if (!decodeSelectedString())
    return { ok: false, error: 'selected nested JSON exceeds safety limits' };
  return { ok: true, value, crossedEncoding };
}
function isAtOrBelow(path: string, pointer: string): boolean {
  return pointer === '' || path === pointer || path.startsWith(`${pointer}/`);
}
function crossesEncodingBoundary(path: string, pointer: string): boolean {
  return path === pointer || path === '' || pointer.startsWith(`${path}/`);
}
export function bodyEncodingPathsAtPointer(
  structure: BodyStructure,
  pointer: string,
): string[] | undefined {
  const resolved = resolveBodyPointer(structure, pointer);
  if (!resolved.ok || resolved.missing) return undefined;
  const descendants = structure.jsonEncodedStringPaths
    .filter((path) => isAtOrBelow(path, pointer))
    .map((path) => (pointer === '' ? path : path === pointer ? '' : path.slice(pointer.length)));
  if (
    (resolved.crossedEncoding ||
      structure.jsonEncodedStringPaths.some((path) => crossesEncodingBoundary(path, pointer))) &&
    !descendants.includes('')
  )
    descendants.unshift('');
  return [...new Set(descendants)];
}
export function readBodyPointer(
  structure: BodyStructure,
  pointer: string,
): (StructureFact & { missing?: true }) | { error: string } {
  const resolved = resolveBodyPointer(structure, pointer);
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.missing)
    return { path: pointer, type: 'missing', encoding: 'native', missing: true };
  const value = resolved.value;
  return {
    path: pointer,
    type: valueType(value),
    ...(valueLength(value) === undefined ? {} : { length: valueLength(value) }),
    encoding:
      resolved.crossedEncoding ||
      structure.jsonEncodedStringPaths.some((path) => crossesEncodingBoundary(path, pointer))
        ? 'json-string'
        : 'native',
  };
}
function scalarType(value: unknown): BodyScalarType | undefined {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number' && !Number.isFinite(value)) return undefined;
  return type === 'string' || type === 'number' || type === 'boolean' ? type : undefined;
}
export function prepareBodyScalarEquality(
  structure: BodyStructure,
  pointer: string,
):
  | { ok: true; scalarType: BodyScalarType; equals: (candidate: unknown) => boolean }
  | { ok: false; error: 'invalid_pointer' | 'missing' | 'not_scalar' } {
  const resolved = resolveBodyPointer(structure, pointer);
  if (!resolved.ok) return { ok: false, error: 'invalid_pointer' };
  if (resolved.missing) return { ok: false, error: 'missing' };
  const value = resolved.value;
  const type = scalarType(value);
  if (!type) return { ok: false, error: 'not_scalar' };
  return {
    ok: true,
    scalarType: type,
    equals: (candidate) => scalarType(candidate) === type && Object.is(candidate, value),
  };
}
export function describeBodyPaths(paths: string[], includePaths = false) {
  const unique = [...new Set(paths)];
  const visible = unique.slice(0, MAX_PATH_FACTS);
  return {
    facts: visible.map((path) => ({
      depth: pointerDepth(path),
      ...(includePaths ? { path } : {}),
    })),
    ...(unique.length > visible.length ? { truncated: true } : {}),
  };
}
export function compareBodyStructures(
  left: BodyStructure,
  right: BodyStructure,
  options: {
    maxNodes?: number;
    includePaths?: boolean;
    pointer?: string;
  } = {},
): BodyComparison {
  const requestedNodes = Math.trunc(options.maxNodes ?? MAX_COMPARE_NODES);
  const maxNodes = Number.isFinite(requestedNodes)
    ? Math.max(1, Math.min(MAX_COMPARE_NODES, requestedNodes))
    : MAX_COMPARE_NODES;
  const differences: StructureDifference[] = [];
  const selectedScope = options.pointer !== undefined && options.pointer !== '';
  const leftResolved =
    options.pointer === undefined ? undefined : resolveBodyPointer(left, options.pointer);
  const rightResolved =
    options.pointer === undefined ? undefined : resolveBodyPointer(right, options.pointer);
  const leftUnavailable = leftResolved && (!leftResolved.ok || leftResolved.missing);
  const rightUnavailable = rightResolved && (!rightResolved.ok || rightResolved.missing);
  const leftValue = leftResolved?.ok && !leftResolved.missing ? leftResolved.value : left.value;
  const rightValue =
    rightResolved?.ok && !rightResolved.missing ? rightResolved.value : right.value;
  const leftEncoded = new Set(
    options.pointer === undefined
      ? left.jsonEncodedStringPaths
      : (bodyEncodingPathsAtPointer(left, options.pointer) ?? []),
  );
  const rightEncoded = new Set(
    options.pointer === undefined
      ? right.jsonEncodedStringPaths
      : (bodyEncodingPathsAtPointer(right, options.pointer) ?? []),
  );
  let visitedNodes = 0;
  let truncated: BodyComparisonTruncation | undefined;
  const add = (path: string, difference: Omit<StructureDifference, 'depth' | 'path'>) => {
    if (truncated) return;
    if (byteLength(path) > MAX_PATH_BYTES) {
      truncated = 'max_path';
      return;
    }
    if (differences.length >= MAX_DIFFERENCES) {
      truncated = 'max_differences';
      return;
    }
    differences.push({
      depth: pointerDepth(path),
      ...(options.includePaths ? { path } : {}),
      ...difference,
    });
  };
  if (leftUnavailable || rightUnavailable)
    add('', {
      kind: 'missing',
      missingFrom:
        leftUnavailable && rightUnavailable ? 'both' : leftUnavailable ? 'left' : 'right',
    });
  if (!selectedScope && left.format !== right.format)
    add('', { kind: 'format', leftFormat: left.format, rightFormat: right.format });
  const visit = (a: unknown, b: unknown, path: string, depth: number) => {
    if (truncated) return;
    if (visitedNodes >= maxNodes) {
      truncated = 'max_nodes';
      return;
    }
    visitedNodes++;
    const ae = leftEncoded.has(path) ? 'json-string' : 'native';
    const be = rightEncoded.has(path) ? 'json-string' : 'native';
    if (ae !== be) add(path, { kind: 'encoding', leftEncoding: ae, rightEncoding: be });
    if (truncated) return;
    const at = valueType(a);
    const bt = valueType(b);
    if (at !== bt) {
      add(path, {
        kind: 'type',
        leftType: at,
        rightType: bt,
        ...(valueLength(a) === undefined ? {} : { leftLength: valueLength(a) }),
        ...(valueLength(b) === undefined ? {} : { rightLength: valueLength(b) }),
      });
      return;
    }
    if (a === null || typeof a !== 'object') {
      if (!Object.is(a, b))
        add(path, {
          kind: 'value',
          leftType: at,
          rightType: bt,
          ...(valueLength(a) === undefined ? {} : { leftLength: valueLength(a) }),
          ...(valueLength(b) === undefined ? {} : { rightLength: valueLength(b) }),
        });
      return;
    }
    if (depth >= MAX_DEPTH) {
      if (valueLength(a) || valueLength(b)) truncated = 'max_depth';
      return;
    }
    const rightObject = b as unknown[] | Record<string, unknown>;
    const leftLength = valueLength(a);
    const rightLength = valueLength(b);
    if (leftLength !== rightLength)
      add(path, { kind: 'length', leftType: at, rightType: bt, leftLength, rightLength });
    const compareChild = (key: string, inLeft: boolean, inRight: boolean) => {
      const nextPath = childPath(path, key);
      if (!inLeft || !inRight) {
        const present = inLeft
          ? (a as Record<string, unknown>)[key]
          : (rightObject as Record<string, unknown>)[key];
        add(nextPath, {
          kind: 'missing',
          missingFrom: inLeft ? 'right' : 'left',
          ...(inLeft
            ? { leftType: valueType(present), leftLength: valueLength(present) }
            : { rightType: valueType(present), rightLength: valueLength(present) }),
        });
      } else
        visit(
          (a as Record<string, unknown>)[key],
          (rightObject as Record<string, unknown>)[key],
          nextPath,
          depth + 1,
        );
    };
    if (Array.isArray(a)) {
      const rightArray = rightObject as unknown[];
      const length = Math.max(a.length, rightArray.length);
      for (let index = 0; index < length && !truncated; index++)
        compareChild(String(index), index < a.length, index < rightArray.length);
    } else {
      for (const key in a) {
        if (truncated) break;
        if (Object.hasOwn(a, key)) compareChild(key, true, Object.hasOwn(rightObject, key));
      }
      for (const key in rightObject) {
        if (truncated) break;
        if (Object.hasOwn(rightObject, key) && !Object.hasOwn(a, key))
          compareChild(key, false, true);
      }
    }
  };
  if (!truncated && !leftUnavailable && !rightUnavailable) visit(leftValue, rightValue, '', 0);
  return {
    differences,
    visitedNodes,
    wireEvidence: 'unavailable_from_redacted_evidence',
    ...(truncated ? { truncated } : {}),
  };
}
