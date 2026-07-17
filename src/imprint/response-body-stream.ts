import {
  MAX_REACT_FLIGHT_JSON_NODES,
  MAX_REACT_FLIGHT_ROWS,
  boundedJsonNodeCount,
} from './react-flight-limits.ts';

const DEFAULT_PER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACTIVE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECOVERED_BYTES = 4 * 1024 * 1024;
const STREAM_SLAB_BYTES = 64 * 1024;
export const RESPONSE_BODY_STREAM_ALLOCATION_HEADROOM_BYTES = STREAM_SLAB_BYTES;
export const RSC_USER_INTENT_WINDOW_MS = 10_000;

export const STREAM_TRUNCATION_MARKER = '\n[…truncated…]';

interface ResponseBodyStreamCandidate {
  method: string;
  resourceType: string;
  status: number;
  mimeType?: string;
  contentLength?: number;
  url: string;
  requestHeaders: Record<string, string>;
  recentUserIntent?: boolean;
  recentUserActivation?: boolean;
  intendedUrl?: string;
}

export type ResponseBodyCompletion =
  | { kind: 'failed'; errorText: string; canceled?: boolean; blockedReason?: string }
  | { kind: 'finished' }
  | { kind: 'timeout' };

interface StreamedBodyRecoveryContext {
  completion: ResponseBodyCompletion;
  method?: string;
  mimeType?: string;
  url: string;
  requestHeaders: Record<string, string>;
  body: string;
}

interface ResponseBodyResolution {
  body: string | null;
  source: 'normal' | 'stream' | null;
  normalError?: unknown;
}

export interface ResponseBodyStreamCapture {
  readonly requestId: string;
  readonly seq: number;
  readonly prefixSlabs: ResponseBodyStreamSlab[];
  readonly dataSlabs: ResponseBodyStreamSlab[];
  bytes: number;
  allocatedBytes: number;
  truncated: boolean;
  abandoned: boolean;
  released: boolean;
}

interface ResponseBodyStreamSlab {
  readonly buffer: Buffer;
  used: number;
}

interface ResponseBodyStreamStats {
  attempted: number;
  started: number;
  discarded: number;
  abandoned: number;
  observedBytes: number;
  recovered: number;
  recoveredBytes: number;
  activeBytes: number;
  peakActiveBytes: number;
}

interface ResponseBodyStreamLimits {
  perResponseBytes?: number;
  activeBytes?: number;
  recoveredBytes?: number;
}

export interface ResponseBodyStreamLease {
  readonly requestId: string;
  readonly seq: number;
  priority: boolean;
  commandSettled: boolean;
  requestCompleted: boolean;
}

/**
 * Bounds issued CDP streams, including commands that have not settled and
 * browser-side streams whose retained bytes were already abandoned. A lease is
 * released only after both the CDP command and the request have completed.
 */
export class ResponseBodyStreamLeaseTracker {
  readonly #limit: number;
  readonly #priorityReserve: number;
  readonly #leases = new Set<ResponseBodyStreamLease>();

  constructor(limit = 16, priorityReserve = 0) {
    this.#limit = limit;
    this.#priorityReserve = Math.max(0, Math.min(priorityReserve, limit));
  }

  begin(requestId: string, seq: number, priority = false): ResponseBodyStreamLease | null {
    if (this.#leases.size >= this.#limit) return null;
    if (!priority && this.#leases.size >= this.#limit - this.#priorityReserve) {
      return null;
    }
    const lease = { requestId, seq, priority, commandSettled: false, requestCompleted: false };
    this.#leases.add(lease);
    return lease;
  }

  markCommandSettled(lease: ResponseBodyStreamLease): void {
    if (!this.#leases.has(lease)) return;
    lease.commandSettled = true;
    this.#releaseIfDone(lease);
  }

  promote(lease: ResponseBodyStreamLease): void {
    if (this.#leases.has(lease)) lease.priority = true;
  }

  markRequestCompleted(requestId: string, seq: number | undefined): void {
    if (seq === undefined) return;
    for (const lease of this.#leases) {
      if (lease.requestId !== requestId || lease.seq !== seq) continue;
      lease.requestCompleted = true;
      this.#releaseIfDone(lease);
    }
  }

  clear(): void {
    this.#leases.clear();
  }

  get size(): number {
    return this.#leases.size;
  }

  #releaseIfDone(lease: ResponseBodyStreamLease): void {
    if (lease.commandSettled && lease.requestCompleted) this.#leases.delete(lease);
  }
}

const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

function requestHeader(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name);
  return entry?.[1];
}

export function matchesIntendedRoute(requestUrl: string, intendedUrl: string | undefined): boolean {
  if (!intendedUrl) return false;
  try {
    const request = new URL(requestUrl);
    const intended = new URL(intendedUrl);
    request.searchParams.delete('_rsc');
    intended.searchParams.delete('_rsc');
    const normalizePath = (path: string): string => (path === '/' ? path : path.replace(/\/$/, ''));
    const normalizeSearch = (url: URL): string =>
      JSON.stringify(
        [...url.searchParams.entries()].sort(([firstKey, firstValue], [secondKey, secondValue]) =>
          firstKey === secondKey
            ? firstValue.localeCompare(secondValue)
            : firstKey.localeCompare(secondKey),
        ),
      );
    return (
      request.origin === intended.origin &&
      normalizePath(request.pathname) === normalizePath(intended.pathname) &&
      normalizeSearch(request) === normalizeSearch(intended)
    );
  } catch {
    return false;
  }
}

function isRscGetRequest(url: string, headers: Record<string, string>): boolean {
  const rsc = requestHeader(headers, 'rsc')?.trim();
  const accept = requestHeader(headers, 'accept')?.toLowerCase() ?? '';
  const hasRouterState = Boolean(requestHeader(headers, 'next-router-state-tree')?.trim());
  let hasRscQuery = false;
  try {
    hasRscQuery = new URL(url).searchParams.has('_rsc');
  } catch {
    // Headers remain sufficient when a captured URL is malformed.
  }
  return rsc === '1' || hasRscQuery || accept.includes('text/x-component') || hasRouterState;
}

function isRscPrefetchRequest(headers: Record<string, string>): boolean {
  return (
    requestHeader(headers, 'next-router-prefetch')?.trim() === '1' ||
    Boolean(requestHeader(headers, 'next-router-segment-prefetch')?.trim())
  );
}

export function needsLaterIntent(candidate: ResponseBodyStreamCandidate): boolean {
  return (
    isRscPrefetchRequest(candidate.requestHeaders) &&
    (!candidate.recentUserActivation || !matchesIntendedRoute(candidate.url, candidate.intendedUrl))
  );
}

/**
 * Keep speculative streaming limited to React Flight responses that Chrome can
 * evict from getResponseBody. Production App Router traffic has two families:
 * GET navigation/prefetch requests and POST Server Actions. Both are Fetch
 * requests returning text/x-component, but Server Actions use Next-Action and
 * have neither `_rsc` nor `RSC: 1`. Ordinary JSON/XHR bodies continue through
 * the normal recorder path and incur no streaming traffic.
 */
export function shouldStreamResponseBody(candidate: ResponseBodyStreamCandidate): boolean {
  if (candidate.resourceType !== 'Fetch') return false;
  if (
    candidate.status < 200 ||
    candidate.status >= 300 ||
    BODYLESS_STATUSES.has(candidate.status)
  ) {
    return false;
  }
  if (
    candidate.contentLength !== undefined &&
    candidate.contentLength > DEFAULT_PER_RESPONSE_BYTES
  ) {
    return false;
  }

  const mime = (candidate.mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime !== 'text/x-component') return false;

  const method = candidate.method.toUpperCase();
  if (method === 'POST') {
    return Boolean(requestHeader(candidate.requestHeaders, 'next-action')?.trim());
  }
  if (method !== 'GET') return false;

  return isRscGetRequest(candidate.url, candidate.requestHeaders);
}

function flightJsonPayload(payload: string): string {
  // Flight row tags precede a JSON payload. React 18/19 uses single-letter
  // tags such as I while Next's resource hints use combined tags such as HL.
  return /^[A-Z]+(?=[\[{\"\d\-ntf])(.*)$/.exec(payload)?.[1] ?? payload;
}

function parseFlightJsonPayload(payload: string, budget: { remaining: number }): unknown {
  const candidate = flightJsonPayload(payload);
  const nodes = boundedJsonNodeCount(candidate, budget.remaining);
  if (nodes === null) throw new Error('React Flight JSON width exceeds budget');
  budget.remaining -= nodes;
  return JSON.parse(candidate);
}

function isAsciiHex(byte: number | undefined): boolean {
  return (
    byte !== undefined &&
    ((byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66))
  );
}

function collectFlightChunkReferences(node: unknown, references: string[]): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 256 || ++visited > MAX_REACT_FLIGHT_JSON_NODES) return false;
    if (typeof current.node === 'string') {
      // React's model reviver only interprets strings whose first byte is `$`;
      // `$$` is an escaped literal dollar. Do not scan arbitrary user text.
      if (!current.node.startsWith('$') || current.node.startsWith('$$')) continue;
      const match = /^\$(?:L|@|F|Q|W|B|K|Z|i|h|P|Y@|Y)?([0-9a-fA-F]+)(?::|$)/.exec(current.node);
      if (match?.[1]) references.push(match[1].toLowerCase());
      continue;
    }
    if (!current.node || typeof current.node !== 'object') continue;
    const values = Array.isArray(current.node)
      ? current.node
      : Object.values(current.node as Record<string, unknown>);
    for (const value of values) stack.push({ node: value, depth: current.depth + 1 });
  }
  return true;
}

interface ParsedFlightBody {
  defined: Set<string>;
  root: unknown;
  referenceCount: number;
}

function parseCompleteFlightBody(body: string): ParsedFlightBody | null {
  if (!body.endsWith('\n') || body.includes(STREAM_TRUNCATION_MARKER)) return null;

  const bytes = Buffer.from(body, 'utf8');
  const defined = new Set<string>();
  const parsedPayloads: unknown[] = [];
  const openStreams = new Set<string>();
  const closedStreams = new Set<string>();
  let root: unknown;
  let offset = 0;
  let rowCount = 0;
  const jsonBudget = { remaining: MAX_REACT_FLIGHT_JSON_NODES };

  while (offset < bytes.length) {
    if (++rowCount > MAX_REACT_FLIGHT_ROWS) return null;
    const lineEnd = bytes.indexOf(0x0a, offset);
    if (lineEnd < 0 || lineEnd === offset) return null;

    if (bytes[offset] === 0x3a) {
      const line = bytes.toString('utf8', offset, lineEnd);
      const hintPayload = /^:[A-Z]+(.+)$/.exec(line)?.[1];
      if (!hintPayload) return null;
      try {
        parseFlightJsonPayload(hintPayload, jsonBudget);
      } catch {
        return null;
      }
      offset = lineEnd + 1;
      continue;
    }

    // React 19 may prefix its first timing row with `#`. It remains an
    // ordinary chunk definition for completeness/reference accounting.
    let idStart = offset;
    if (bytes[idStart] === 0x23) idStart++;
    let colon = idStart;
    while (colon < bytes.length) {
      if (!isAsciiHex(bytes[colon])) break;
      colon++;
    }
    if (colon === idStart || bytes[colon] !== 0x3a) return null;
    const chunkId = bytes.toString('ascii', idStart, colon).toLowerCase();
    if (closedStreams.has(chunkId)) return null;
    const payloadStart = colon + 1;
    if (payloadStart >= bytes.length) return null;

    // T rows are byte-length-framed rather than newline-framed. Their text
    // may contain newlines and the next row may begin immediately afterward.
    if (bytes[payloadStart] === 0x54) {
      if (defined.has(chunkId) || openStreams.has(chunkId)) return null;
      let comma = payloadStart + 1;
      while (comma < bytes.length) {
        if (!isAsciiHex(bytes[comma])) break;
        comma++;
      }
      if (comma === payloadStart + 1 || bytes[comma] !== 0x2c) return null;
      const length = Number.parseInt(bytes.toString('ascii', payloadStart + 1, comma), 16);
      if (!Number.isSafeInteger(length)) return null;
      const textEnd = comma + 1 + length;
      if (textEnd > bytes.length) return null;
      defined.add(chunkId);
      offset = textEnd;
      continue;
    }

    const payload = bytes.toString('utf8', payloadStart, lineEnd);
    if (!payload) return null;
    let parsed: unknown;
    if (payload === 'R' || payload === 'r' || payload === 'X' || payload === 'x') {
      if (defined.has(chunkId) || openStreams.has(chunkId)) return null;
      openStreams.add(chunkId);
      parsed = null;
    } else if (payload.startsWith('C')) {
      if (!openStreams.delete(chunkId)) return null;
      closedStreams.add(chunkId);
      const finalValue = payload.slice(1);
      if (finalValue) {
        try {
          parsed = parseFlightJsonPayload(finalValue, jsonBudget);
        } catch {
          return null;
        }
        parsedPayloads.push(parsed);
      } else {
        parsed = null;
      }
    } else {
      if (defined.has(chunkId) || openStreams.has(chunkId)) return null;
      try {
        parsed = parseFlightJsonPayload(payload, jsonBudget);
      } catch {
        // Reject binary/text Flight rows for failed loads until we have an
        // observed, independently verifiable completeness rule for them.
        return null;
      }
      parsedPayloads.push(parsed);
    }
    defined.add(chunkId);
    if (chunkId === '0') root = parsed;
    offset = lineEnd + 1;
  }

  if (openStreams.size > 0) return null;

  let referenceCount = 0;
  const references: string[] = [];
  for (const payload of parsedPayloads) {
    if (!collectFlightChunkReferences(payload, references)) return null;
  }
  for (const chunkId of references) {
    if (!defined.has(chunkId)) return null;
    referenceCount++;
  }
  return { defined, root, referenceCount };
}

/**
 * React Flight has no explicit EOF marker. A safely reusable canceled payload
 * must nevertheless be line-complete, contain the root chunk, and define every
 * chunk referenced by that payload. This deliberately favors false negatives:
 * an unfamiliar but valid Flight encoding falls back to a bodyless request.
 */
export function isStructurallyCompleteReactFlight(body: string): boolean {
  const parsed = parseCompleteFlightBody(body);
  if (!parsed) return false;
  const { defined, root, referenceCount } = parsed;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const rootRecord = root as Record<string, unknown>;
  const isLegacyNavigation =
    typeof rootRecord.b === 'string' &&
    Array.isArray(rootRecord.f) &&
    typeof rootRecord.q === 'string';
  const isModernNavigation =
    Array.isArray(rootRecord.c) &&
    Array.isArray(rootRecord.f) &&
    typeof rootRecord.q === 'string' &&
    typeof rootRecord.i === 'boolean';
  const isTreePrefetch =
    rootRecord.tree !== null &&
    typeof rootRecord.tree === 'object' &&
    typeof rootRecord.staleTime === 'number' &&
    Number.isFinite(rootRecord.staleTime);
  const isDataPrefetch = typeof rootRecord.buildId === 'string' && Array.isArray(rootRecord.data);

  if (isTreePrefetch) return defined.size === 1 && referenceCount === 0;
  if (!isLegacyNavigation && !isModernNavigation && !isDataPrefetch) return false;
  return defined.size > 1 && referenceCount > 0;
}

/**
 * Server Action Flight roots differ by Next.js generation: older responses
 * use an array root, while newer responses use { a, f, b }. In both cases we
 * require a line-complete JSON-tagged stream, root chunk zero, more than one
 * defined chunk, and no dangling chunk references.
 */
export function isStructurallyCompleteServerActionFlight(body: string): boolean {
  const parsed = parseCompleteFlightBody(body);
  if (!parsed || parsed.defined.size <= 1 || parsed.referenceCount === 0) return false;
  let actionReference: string | undefined;
  if (Array.isArray(parsed.root)) {
    if (!Array.isArray(parsed.root[1])) return false;
    actionReference = typeof parsed.root[0] === 'string' ? parsed.root[0] : undefined;
  }
  if (!parsed.root || typeof parsed.root !== 'object') return false;
  if (!Array.isArray(parsed.root)) {
    const root = parsed.root as Record<string, unknown>;
    if (!('f' in root) || typeof root.b !== 'string') return false;
    actionReference = typeof root.a === 'string' ? root.a : undefined;
  }
  const referencedChunk = /^\$@([0-9a-fA-F]+)$/.exec(actionReference ?? '')?.[1]?.toLowerCase();
  return Boolean(referencedChunk && parsed.defined.has(referencedChunk));
}

/**
 * A completed load is safe to recover. Failed loads are normally partial and
 * remain bodyless; the sole exception is the verified Next.js RSC navigation
 * pattern where Chrome reports ERR_ABORTED after delivering the complete
 * text/x-component payload to the renderer.
 */
export function shouldRecoverStreamedBody(context: StreamedBodyRecoveryContext): boolean {
  if (context.body.includes(STREAM_TRUNCATION_MARKER)) return false;
  const mime = (context.mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'text/x-component') return false;
  if (context.completion.kind === 'finished') return true;
  if (
    context.completion.kind !== 'failed' ||
    context.completion.errorText !== 'net::ERR_ABORTED' ||
    context.completion.canceled !== true ||
    context.completion.blockedReason !== undefined
  ) {
    return false;
  }

  if (
    context.method?.toUpperCase() === 'POST' &&
    requestHeader(context.requestHeaders, 'next-action')?.trim()
  ) {
    return isStructurallyCompleteServerActionFlight(context.body);
  }

  if (context.method && context.method.toUpperCase() !== 'GET') return false;
  return (
    isRscGetRequest(context.url, context.requestHeaders) &&
    isStructurallyCompleteReactFlight(context.body)
  );
}

/** Normal CDP body capture always wins; the speculative stream is consulted only on failure. */
export async function resolveResponseBodyWithFallback(input: {
  readNormal: () => Promise<string>;
  readStream?: () => Promise<string | null>;
}): Promise<ResponseBodyResolution> {
  try {
    return { body: await input.readNormal(), source: 'normal' };
  } catch (normalError) {
    if (!input.readStream) return { body: null, source: null, normalError };
    const body = await input.readStream();
    return body === null
      ? { body: null, source: null, normalError }
      : { body, source: 'stream', normalError };
  }
}

/**
 * Bounded in-memory storage for speculative CDP response streams. Nothing is
 * persisted unless the recorder later calls recover() after getResponseBody
 * failed. Aggregate pressure abandons a capture instead of returning a random
 * partial suffix/prefix as if it were trustworthy.
 */
export class ResponseBodyStreamStore {
  readonly #perResponseBytes: number;
  readonly #activeBytesLimit: number;
  readonly #recoveredBytesLimit: number;
  readonly #stats: ResponseBodyStreamStats = {
    attempted: 0,
    started: 0,
    discarded: 0,
    abandoned: 0,
    observedBytes: 0,
    recovered: 0,
    recoveredBytes: 0,
    activeBytes: 0,
    peakActiveBytes: 0,
  };

  constructor(limits: ResponseBodyStreamLimits = {}) {
    this.#perResponseBytes = limits.perResponseBytes ?? DEFAULT_PER_RESPONSE_BYTES;
    this.#activeBytesLimit = limits.activeBytes ?? DEFAULT_ACTIVE_BYTES;
    this.#recoveredBytesLimit = limits.recoveredBytes ?? DEFAULT_RECOVERED_BYTES;
  }

  begin(requestId: string, seq: number): ResponseBodyStreamCapture {
    this.#stats.attempted++;
    return {
      requestId,
      seq,
      prefixSlabs: [],
      dataSlabs: [],
      bytes: 0,
      allocatedBytes: 0,
      truncated: false,
      abandoned: false,
      released: false,
    };
  }

  markStarted(capture: ResponseBodyStreamCapture): void {
    if (!capture.released && !capture.abandoned) this.#stats.started++;
  }

  appendBufferedData(capture: ResponseBodyStreamCapture, base64: string): void {
    this.#append(capture, base64, capture.prefixSlabs);
  }

  appendData(capture: ResponseBodyStreamCapture, base64: string): void {
    this.#append(capture, base64, capture.dataSlabs);
  }

  discard(capture: ResponseBodyStreamCapture): void {
    if (capture.released) return;
    this.#release(capture);
    this.#stats.discarded++;
  }

  abandon(capture: ResponseBodyStreamCapture): void {
    if (capture.released) return;
    capture.abandoned = true;
    this.#release(capture);
    this.#stats.abandoned++;
  }

  recover(
    capture: ResponseBodyStreamCapture,
    accept: (body: string) => boolean = () => true,
  ): string | null {
    if (capture.released || capture.abandoned || capture.bytes === 0) {
      this.discard(capture);
      return null;
    }

    const remainingRecoveryBudget = this.#recoveredBytesLimit - this.#stats.recoveredBytes;
    if (remainingRecoveryBudget <= 0 || capture.bytes > remainingRecoveryBudget) {
      this.abandon(capture);
      return null;
    }

    const chunks = [...capture.prefixSlabs, ...capture.dataSlabs].map((slab) =>
      slab.buffer.subarray(0, slab.used),
    );
    const complete = Buffer.concat(chunks, capture.bytes);
    const body = `${complete.toString('utf8')}${capture.truncated ? STREAM_TRUNCATION_MARKER : ''}`;

    let accepted = false;
    try {
      accepted = accept(body);
    } catch {
      this.discard(capture);
      return null;
    }
    if (!accepted) {
      this.discard(capture);
      return null;
    }

    this.#stats.recovered++;
    this.#stats.recoveredBytes += complete.length;
    this.#release(capture);
    return body;
  }

  get stats(): ResponseBodyStreamStats {
    return { ...this.#stats };
  }

  #append(
    capture: ResponseBodyStreamCapture,
    base64: string,
    target: ResponseBodyStreamSlab[],
  ): void {
    if (capture.released || capture.abandoned || base64.length === 0) return;

    const remainingForResponse = this.#perResponseBytes - capture.bytes;
    if (remainingForResponse <= 0) {
      capture.truncated = true;
      return;
    }

    // CDP chunks are independently padded base64 strings. Decode each chunk
    // independently, but retain bytes until finalization so split UTF-8 code
    // points are decoded only after concatenation.
    const maxBase64Chars = Math.ceil(remainingForResponse / 3) * 4;
    const encodedPrefix = base64.slice(0, maxBase64Chars);
    const decoded = Buffer.from(encodedPrefix, 'base64');
    const accepted = decoded.subarray(0, remainingForResponse);
    const wasTruncated = encodedPrefix.length < base64.length || decoded.length > accepted.length;

    if (accepted.length > 0) {
      let sourceOffset = 0;
      while (sourceOffset < accepted.length) {
        let slab = target.at(-1);
        if (!slab || slab.used === slab.buffer.length) {
          const remainingAllocation = this.#activeBytesLimit - this.#stats.activeBytes;
          if (remainingAllocation <= 0) {
            this.abandon(capture);
            return;
          }
          const capacity = Math.min(
            STREAM_SLAB_BYTES,
            this.#perResponseBytes - capture.bytes - sourceOffset,
            remainingAllocation,
          );
          if (capacity <= 0) {
            this.abandon(capture);
            return;
          }
          slab = { buffer: Buffer.allocUnsafe(capacity), used: 0 };
          target.push(slab);
          capture.allocatedBytes += capacity;
          this.#stats.activeBytes += capacity;
          this.#stats.peakActiveBytes = Math.max(
            this.#stats.peakActiveBytes,
            this.#stats.activeBytes,
          );
        }
        const copied = accepted.copy(
          slab.buffer,
          slab.used,
          sourceOffset,
          sourceOffset + Math.min(accepted.length - sourceOffset, slab.buffer.length - slab.used),
        );
        slab.used += copied;
        sourceOffset += copied;
      }
      capture.bytes += accepted.length;
      this.#stats.observedBytes += accepted.length;
    }
    if (wasTruncated) capture.truncated = true;
  }

  #release(capture: ResponseBodyStreamCapture): void {
    if (capture.released) return;
    this.#stats.activeBytes = Math.max(0, this.#stats.activeBytes - capture.allocatedBytes);
    capture.prefixSlabs.length = 0;
    capture.dataSlabs.length = 0;
    capture.allocatedBytes = 0;
    capture.released = true;
  }
}
