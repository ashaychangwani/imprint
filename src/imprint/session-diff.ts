/**
 * Dual-pass session diff: aligns requests from two independent executions
 * and classifies values as constant, server-derived, or browser-minted.
 */

import type { CapturedRequest, Session } from './types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ValueClassification = 'constant' | 'browser_minted' | 'server_derived';

export interface ClassifiedValue {
  classification: ValueClassification;
  /** e.g. "url_param:correlationId", "header:x-csrf-token", "body:$.transaction.id" */
  location: string;
  originalSeq: number;
  value1: string;
  value2: string;
  /** For server_derived: seq of the response that produced this value in run 2. */
  producerSeq?: number;
  /** For server_derived: where in the producer response the value was found. */
  producerPath?: string;
  suggestedStateName?: string;
}

interface AlignedRequestPair {
  originalSeq: number;
  replaySeq: number;
  /** 0–1 based on URL path, method, body structure similarity. */
  confidence: number;
}

interface DiffResult {
  classifications: ClassifiedValue[];
  alignedPairs: AlignedRequestPair[];
  unmatchedOriginal: number[];
  unmatchedReplay: number[];
}

export interface CapturedReplayRequest {
  seq: number;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  resourceType: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    mimeType?: string;
  };
}

// ─── Alignment ──────────────────────────────────────────────────────────────

interface RequestLike {
  seq: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  response?: { status: number; headers: Record<string, string>; body?: string };
}

function urlPathname(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return raw;
  }
}

function alignmentKey(req: RequestLike): string {
  return `${req.method}\t${urlPathname(req.url)}`;
}

function jsonKeySet(body: string | undefined): Set<string> | null {
  if (!body) return null;
  try {
    const obj = JSON.parse(body);
    if (typeof obj !== 'object' || obj === null) return null;
    return new Set(Object.keys(obj));
  } catch {
    return null;
  }
}

function keySetSimilarity(a: Set<string> | null, b: Set<string> | null): number {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const k of a) if (b.has(k)) intersection++;
  return intersection / Math.max(a.size, b.size);
}

/**
 * Align requests from two runs by (method, URL_pathname, relative_sequence).
 * Returns pairs with confidence scores. Low-confidence pairs (< 0.3) excluded.
 */
export function alignRequests(run1: RequestLike[], run2: RequestLike[]): AlignedRequestPair[] {
  const groups1 = new Map<string, RequestLike[]>();
  const groups2 = new Map<string, RequestLike[]>();

  for (const r of run1) {
    const key = alignmentKey(r);
    const arr = groups1.get(key) ?? [];
    arr.push(r);
    groups1.set(key, arr);
  }
  for (const r of run2) {
    const key = alignmentKey(r);
    const arr = groups2.get(key) ?? [];
    arr.push(r);
    groups2.set(key, arr);
  }

  const pairs: AlignedRequestPair[] = [];
  const usedRun2Seqs = new Set<number>();

  for (const [key, g1] of groups1) {
    const g2 = groups2.get(key);
    if (!g2) continue;

    // Match by relative position within group
    for (let i = 0; i < g1.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by loop condition
      const r1 = g1[i]!;
      if (i < g2.length) {
        // biome-ignore lint/style/noNonNullAssertion: bounded by loop condition
        const r2 = g2[i]!;
        if (usedRun2Seqs.has(r2.seq)) continue;

        let confidence = 0.7; // base for method+path match at same position
        const bodySim = keySetSimilarity(jsonKeySet(r1.body), jsonKeySet(r2.body));
        if (bodySim > 0) confidence = Math.min(1.0, confidence + bodySim * 0.3);

        if (confidence >= 0.3) {
          pairs.push({ originalSeq: r1.seq, replaySeq: r2.seq, confidence });
          usedRun2Seqs.add(r2.seq);
        }
      }
    }
  }

  return pairs;
}

// ─── Value extraction ───────────────────────────────────────────────────────

const SKIP_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'connection',
  'host',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'cache-control',
  'pragma',
  'content-length',
  'content-type',
  'origin',
  'referer',
]);

interface ExtractedValue {
  location: string;
  value: string;
}

function extractUrlParams(url: string): ExtractedValue[] {
  try {
    const u = new URL(url);
    const result: ExtractedValue[] = [];
    for (const [key, val] of u.searchParams) {
      result.push({ location: `url_param:${key}`, value: val });
    }
    return result;
  } catch {
    return [];
  }
}

function extractHeaderValues(headers: Record<string, string>): ExtractedValue[] {
  const result: ExtractedValue[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!SKIP_HEADERS.has(name.toLowerCase())) {
      result.push({ location: `header:${name}`, value });
    }
  }
  return result;
}

function extractJsonBodyValues(body: string | undefined, prefix = 'body'): ExtractedValue[] {
  if (!body) return [];
  try {
    const obj = JSON.parse(body);
    return flattenObject(obj, prefix);
  } catch {
    return [{ location: prefix, value: body }];
  }
}

function flattenObject(obj: unknown, prefix: string): ExtractedValue[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') {
    return [{ location: prefix, value: String(obj) }];
  }
  const result: ExtractedValue[] = [];
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      result.push(...flattenObject(obj[i], `${prefix}[${i}]`));
    }
  } else {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result.push(...flattenObject(val, `${prefix}.${key}`));
    }
  }
  return result;
}

function extractRequestValues(req: RequestLike): ExtractedValue[] {
  return [
    ...extractUrlParams(req.url),
    ...extractHeaderValues(req.headers),
    ...extractJsonBodyValues(req.body),
  ];
}

// ─── Producer search ────────────────────────────────────────────────────────

interface ProducerMatch {
  seq: number;
  path: string;
}

function searchPriorResponses(
  value: string,
  requests: RequestLike[],
  beforeSeq: number,
): ProducerMatch | null {
  if (value.length < 4) return null; // skip trivially short values

  for (let i = requests.length - 1; i >= 0; i--) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by loop condition
    const req = requests[i]!;
    if (req.seq >= beforeSeq) continue;
    const resp = req.response;
    if (!resp) continue;

    // Search response body
    if (resp.body?.includes(value)) {
      const path = findJsonPath(resp.body, value);
      return { seq: req.seq, path: path ?? 'body(substring)' };
    }

    // Search response headers
    for (const [hName, hVal] of Object.entries(resp.headers)) {
      if (hVal.includes(value)) {
        return { seq: req.seq, path: `response_header:${hName}` };
      }
    }
  }
  return null;
}

function findJsonPath(body: string, value: string): string | null {
  try {
    const obj = JSON.parse(body);
    return findInObject(obj, value, '$');
  } catch {
    return null;
  }
}

function findInObject(obj: unknown, target: string, path: string): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'string' && obj === target) return path;
  if (typeof obj === 'number' && String(obj) === target) return path;
  if (typeof obj !== 'object') return null;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const found = findInObject(obj[i], target, `${path}[${i}]`);
      if (found) return found;
    }
  } else {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const found = findInObject(val, target, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

// ─── State name suggestion ──────────────────────────────────────────────────

function suggestStateName(location: string): string {
  // url_param:context.correlationIdentifier → correlation_identifier
  // header:x-csrf-token → csrf_token
  // body.transaction.id → transaction_id
  const raw = location.replace(/^(url_param|header|body):?/, '').replace(/^x-/, '');

  return raw
    .replace(/[.\[\]]/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Whether a value looks like an opaque token/id (vs human text, a city name, a
 *  date). Gates provenance-tagging of stable values so an incidental constant
 *  (a UI label, the echoed query) isn't treated as a server-provided token.
 *  Shared with the build-plan token detector. */
export function looksLikeToken(v: string): boolean {
  if (v.length < 12) return false;
  if (/\s/.test(v)) return false; // multi-word / free text
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; // dates
  return /[:|_-]/.test(v) || /\d/.test(v);
}

// ─── Main diff ──────────────────────────────────────────────────────────────

export function diffTriagedSessions(
  original: Session,
  replay: { requests: CapturedReplayRequest[] },
): DiffResult {
  const pairs = alignRequests(original.requests, replay.requests);
  const pairedOrigSeqs = new Set(pairs.map((p) => p.originalSeq));
  const pairedReplaySeqs = new Set(pairs.map((p) => p.replaySeq));
  // `searchPriorResponses` over the replay returns a producer in REPLAY-seq
  // space, but `originalSeq` and every downstream consumer (capture hints,
  // build-plan token detection, the planner) work in ORIGINAL-seq space — so a
  // replay producer must be translated back via the alignment pairs.
  const replayToOriginal = new Map(pairs.map((p) => [p.replaySeq, p.originalSeq]));
  const toOriginalSeq = (replaySeq: number): number => replayToOriginal.get(replaySeq) ?? replaySeq;

  const classifications: ClassifiedValue[] = [];

  for (const pair of pairs) {
    if (pair.confidence < 0.5) continue;

    const r1 = original.requests.find((r) => r.seq === pair.originalSeq);
    const r2 = replay.requests.find((r) => r.seq === pair.replaySeq);
    if (!r1 || !r2) continue;

    const vals1 = extractRequestValues(r1);
    const vals2 = extractRequestValues(r2);

    const map2 = new Map(vals2.map((v) => [v.location, v.value]));

    for (const v1 of vals1) {
      const v2Value = map2.get(v1.location);
      if (v2Value === undefined) continue; // field only in run 1

      if (v1.value === v2Value) {
        // Stable across runs. Normally a constant — but an OPAQUE stable value
        // that also appears in a PRIOR response is a server-PROVIDED token (e.g.
        // a per-entity id minted by a sibling search tool). The same-flow replay
        // can't expose it by variance (same entity → same token), so recover its
        // provenance from the original responses (already original-seq space).
        // A cross-tool consumer then sources it as a param instead of hardcoding.
        const provider = looksLikeToken(v1.value)
          ? searchPriorResponses(v1.value, original.requests, pair.originalSeq)
          : null;
        classifications.push({
          classification: 'constant',
          location: v1.location,
          originalSeq: pair.originalSeq,
          value1: v1.value,
          value2: v2Value,
          ...(provider ? { producerSeq: provider.seq, producerPath: provider.path } : {}),
        });
        continue;
      }

      // Value differs — check if it came from a prior response in run 2,
      // translating the replay producer back to original-seq space.
      const producer = searchPriorResponses(v2Value, replay.requests, pair.replaySeq);

      if (producer) {
        const name = suggestStateName(v1.location);
        classifications.push({
          classification: 'server_derived',
          location: v1.location,
          originalSeq: pair.originalSeq,
          value1: v1.value,
          value2: v2Value,
          producerSeq: toOriginalSeq(producer.seq),
          producerPath: producer.path,
          suggestedStateName: name || undefined,
        });
      } else {
        const name = suggestStateName(v1.location);
        classifications.push({
          classification: 'browser_minted',
          location: v1.location,
          originalSeq: pair.originalSeq,
          value1: v1.value,
          value2: v2Value,
          suggestedStateName: name || undefined,
        });
      }
    }
  }

  return {
    classifications,
    alignedPairs: pairs,
    unmatchedOriginal: original.requests
      .filter((r) => !pairedOrigSeqs.has(r.seq))
      .map((r) => r.seq),
    unmatchedReplay: replay.requests.filter((r) => !pairedReplaySeqs.has(r.seq)).map((r) => r.seq),
  };
}

/**
 * Triage run-2 requests by aligning them against run-1's already-triaged set.
 * No narration or LLM call needed — the first triage acts as the oracle.
 */
export function triageByAlignment(
  run1TriagedRequests: CapturedRequest[],
  run2AllRequests: CapturedReplayRequest[],
): number[] {
  const aligned = alignRequests(run1TriagedRequests, run2AllRequests);
  return aligned.filter((pair) => pair.confidence >= 0.5).map((pair) => pair.replaySeq);
}

/**
 * Severity order — a value seen varying in ANY pass outranks one seen constant.
 * server_derived (traceable to a response) wins over browser_minted.
 */
const CLASSIFICATION_RANK: Record<ValueClassification, number> = {
  constant: 0,
  browser_minted: 1,
  server_derived: 2,
};

/**
 * Merge `ClassifiedValue`s from several diff passes that all share the SAME
 * `original` recording (so `originalSeq` is a stable join key across passes).
 *
 * Each pass diffs the original recording against one other run — the automated
 * browser replay AND every other real recording of the site. Anti-bot edges
 * (Akamai, DataDome, …) often block the automated replay at the page level, so
 * the replay reproduces only a fraction of the recording's requests and their
 * functional values (GraphQL safelisting signatures, persisted-query hashes,
 * app keys) never get classified. Real recordings come from a trusted browser
 * and DO carry those requests, so diffing recordings against each other
 * recovers the missing signal.
 *
 * Merge rule per (originalSeq, location):
 *   - a value that VARIES in any pass is ephemeral — the strongest non-constant
 *     classification wins (server_derived > browser_minted), preserving its
 *     producer provenance;
 *   - a value constant in every pass that observed it is `constant`.
 * A value the replay never observed (because it was blocked) but that is
 * identical across time-separated recordings is therefore kept as `constant`,
 * not silently dropped.
 */
export function mergeClassifications(passes: ClassifiedValue[][]): ClassifiedValue[] {
  const byKey = new Map<string, ClassifiedValue>();
  for (const pass of passes) {
    for (const cv of pass) {
      const key = `${cv.originalSeq} ${cv.location}`;
      const prev = byKey.get(key);
      if (
        !prev ||
        CLASSIFICATION_RANK[cv.classification] > CLASSIFICATION_RANK[prev.classification]
      ) {
        byKey.set(key, cv);
      }
    }
  }
  return [...byKey.values()];
}
