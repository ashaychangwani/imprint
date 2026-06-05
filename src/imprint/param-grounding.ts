/**
 * Event-correlated differential param grounding.
 *
 * The candidate detector reliably identifies WHICH inputs the user controlled
 * (`likelyParams`) and WHICH events toggled them (`eventSeqs`) — but the compile
 * agent historically grounded a param by eyeballing a single request, and when
 * the value wasn't obviously present it gave up and shipped the param
 * `verified:false`, inert. Yet the encoding is almost always right there: the
 * request a filter-toggle event triggers differs from the prior equivalent
 * request at exactly the position that param controls.
 *
 * This module makes that differential deterministic and site-agnostic: for each
 * UI event, find the request it triggered, diff it against the most recent
 * comparable request (same endpoint), and report the changed paths. The compile
 * agent (and the precomputed hint surfaced to it) then maps each diff to a
 * `likelyParam` — the semantic step the model is good at — instead of guessing
 * at an encoding. Decoding is generic (JSON body, an `f.req=`-embedded JSON
 * envelope as used by Google's batchexecute, or plain form fields), so this is
 * not specific to any one site.
 */

import type { CapturedRequest, Session } from './types.ts';

interface GroundingChange {
  /** JSON path into the decoded request body, e.g. "[1][4][3]". */
  path: string;
  before: string;
  after: string;
}

interface EventGrounding {
  eventSeq: number;
  /** Human label from the event detail (button text / aria-label / id). */
  label: string;
  /** The request the event triggered (first comparable request after it). */
  triggeredSeq?: number;
  /** The prior request of the same endpoint that the diff is taken against. */
  priorSeq?: number;
  endpoint?: string;
  changes: GroundingChange[];
}

/** First request after `eventSeq`, within a window, that has a decodable body. */
const TRIGGER_WINDOW = 12;

/** Decode a request body into a comparable structure. Handles, in order:
 *  a raw JSON body; an `f.req=<json>` form field whose value is a JSON envelope
 *  (batchexecute) — unwrapping `[[["rpcid","<inner-json-string>",…]]]` to the
 *  inner payload when present; otherwise a flat form-field map; else the raw
 *  string. Never throws. */
export function decodeBodyForDiff(body: string | undefined): unknown {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON */
    }
  }
  // form-encoded?
  if (/(^|&)[\w.]+=/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    const freq = params.get('f.req');
    if (freq != null) {
      try {
        const env = JSON.parse(freq);
        // batchexecute envelope: [[["rpcid","<inner json string>", …]]]
        const innerStr = env?.[0]?.[0]?.[1];
        if (typeof innerStr === 'string') {
          try {
            return JSON.parse(innerStr);
          } catch {
            return env;
          }
        }
        return env;
      } catch {
        /* f.req not JSON */
      }
    }
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  }
  return trimmed;
}

/** Deep structural diff → changed leaf paths (a→b). Identical subtrees are
 *  skipped via a cheap stringify equality check. */
export function structuralDiff(
  a: unknown,
  b: unknown,
  path = '',
  out: GroundingChange[] = [],
): GroundingChange[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) structuralDiff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      structuralDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k,
        out,
      );
    }
    return out;
  }
  const cap = (v: unknown) => {
    const s = v === undefined ? 'undefined' : JSON.stringify(v);
    return s.length > 48 ? `${s.slice(0, 48)}…` : s;
  };
  out.push({ path: path || '(root)', before: cap(a), after: cap(b) });
  return out;
}

/** A stable key grouping "comparable" requests: the batchexecute rpcid when
 *  present, else METHOD + URL path (query stripped). */
function endpointKey(req: CapturedRequest): string {
  const url = req.url ?? '';
  // Accept both `rpcids=` (Google batchexecute, plural) and a singular `rpcid=`
  // in the URL query, matching tool-candidates' endpoint-family keying — so a
  // batchexecute-style endpoint never collapses distinct rpcs to one path key.
  const rpc = /[?&]rpcids?=([^&]+)/.exec(url);
  if (rpc) return `rpc:${decodeURIComponent(rpc[1] ?? '')}`;
  try {
    const u = new URL(url);
    return `${req.method ?? 'GET'} ${u.pathname}`;
  } catch {
    return `${req.method ?? 'GET'} ${url.split('?')[0]}`;
  }
}

function bodyOf(req: CapturedRequest): string | undefined {
  // CapturedRequest stores the request body on `.body`; tolerate alt shapes.
  return (
    (req as unknown as { body?: string }).body ??
    (req as unknown as { requestBody?: string }).requestBody ??
    undefined
  );
}

function eventLabel(detail: string): string {
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(detail);
  } catch {
    return detail.slice(0, 48);
  }
  const txt = (d.text ?? d.ariaLabel ?? d.name ?? d.id ?? '') as string;
  return String(txt).replace(/\s+/g, ' ').trim().slice(0, 48);
}

/** Telemetry/beacon endpoints that fire constantly and are never the tool's
 *  load-bearing request — excluded when we can't scope to the candidate's own
 *  endpoints. */
const TELEMETRY = /\/(log|gen_204|jserror|ping|beacon|csi|_\/bscframe|metrics|stats)\b/i;

/** A decoded body worth diffing: a structured array/object, not a raw (often
 *  gzipped/opaque) string. */
function isStructured(v: unknown): boolean {
  return v != null && typeof v === 'object';
}

/** Ground a single event: find the request it triggered and diff against the
 *  most recent prior request of the same endpoint.
 *
 *  `relevantEndpoints` (the candidate's own request endpoints, via endpointKey)
 *  scopes the search to the tool's load-bearing requests — without it a burst of
 *  telemetry POSTs between the click and the real request would be mistaken for
 *  the trigger. */
export function groundEvent(
  session: Session,
  eventSeq: number,
  relevantEndpoints?: Set<string>,
): EventGrounding {
  const reqs = [...session.requests].sort((a, b) => a.seq - b.seq);
  const ev = session.events.find((e) => e.seq === eventSeq);
  const label = ev ? eventLabel(ev.detail) : '';

  const triggered = reqs.find((r) => {
    if (r.seq <= eventSeq || r.seq > eventSeq + windowEnd(reqs, eventSeq)) return false;
    const decoded = decodeBodyForDiff(bodyOf(r));
    if (decoded === undefined) return false;
    if (relevantEndpoints && relevantEndpoints.size > 0)
      return relevantEndpoints.has(endpointKey(r));
    // Fallback: structured body + not an obvious telemetry endpoint.
    return isStructured(decoded) && !TELEMETRY.test(r.url ?? '');
  });
  if (!triggered) return { eventSeq, label, changes: [] };

  const key = endpointKey(triggered);
  const prior = [...reqs]
    .reverse()
    .find(
      (r) =>
        r.seq < triggered.seq &&
        endpointKey(r) === key &&
        decodeBodyForDiff(bodyOf(r)) !== undefined,
    );

  const changes = prior
    ? structuralDiff(decodeBodyForDiff(bodyOf(prior)), decodeBodyForDiff(bodyOf(triggered)))
    : [];
  return {
    eventSeq,
    label,
    triggeredSeq: triggered.seq,
    priorSeq: prior?.seq,
    endpoint: key,
    changes,
  };
}

/** Window end: don't scan unboundedly — cap at TRIGGER_WINDOW requests past the
 *  event (by seq distance to the Nth following request). */
function windowEnd(reqs: CapturedRequest[], eventSeq: number): number {
  const after = reqs.filter((r) => r.seq > eventSeq).slice(0, TRIGGER_WINDOW);
  const last = after.at(-1);
  return last ? last.seq - eventSeq : TRIGGER_WINDOW;
}

/** Precompute grounding diffs for a candidate's filter-toggle events, dropping
 *  events that triggered nothing or changed nothing.
 *
 *  Pass `relevantEndpoints` = endpointKey() of the candidate's own request seqs
 *  so the diff is taken against the tool's load-bearing request, not telemetry. */
export function groundingForEvents(
  session: Session,
  eventSeqs: number[],
  relevantEndpoints?: Set<string>,
): EventGrounding[] {
  const all = eventSeqs
    .map((seq) => groundEvent(session, seq, relevantEndpoints))
    .filter((g) => g.changes.length > 0);

  // Drop session-churn paths — positions that change across MOST events are
  // per-call session state (rotating tokens, pagination flags, a display-mode
  // value), not the param the event toggled. A param's encoding shows up only
  // in the diff(s) of the event(s) that control it, so frequency cleanly
  // separates signal from churn.
  const pathFreq = new Map<string, number>();
  for (const g of all) {
    for (const p of new Set(g.changes.map((c) => c.path)))
      pathFreq.set(p, (pathFreq.get(p) ?? 0) + 1);
  }
  const churnAt = Math.max(3, Math.ceil(all.length / 2));
  for (const g of all) g.changes = g.changes.filter((c) => (pathFreq.get(c.path) ?? 0) < churnAt);
  return all.filter((g) => g.changes.length > 0);
}

/** Derive the relevant-endpoint set from a candidate's request seqs. */
export function endpointsForSeqs(session: Session, seqs: number[]): Set<string> {
  const set = new Set<string>();
  for (const seq of seqs) {
    const r = session.requests.find((x) => x.seq === seq);
    if (r) set.add(endpointKey(r));
  }
  return set;
}

// ─── Input-value provenance ──────────────────────────────────────────────────
//
// The grounding above covers params the user *toggled* (filters/sort). It does
// not cover a primary param whose value is an opaque id the request can't carry
// as plain text — e.g. an entity/object handle, an account id, a place/geo id, a
// category token. The compile agent historically shipped these as the raw param
// text, which the backend silently ignores and falls back to a default (an
// unfiltered/global result set, or a server-chosen default scope). The id was
// never the user's text; it was *minted by an earlier response* and chained into
// the request. That cross-request data-flow is the signal this detects — keyed
// on structure, not any vendor's id format.

interface InputProvenance {
  /** JSON path into the decoded request body where the minted value sits. */
  path: string;
  /** Example resolved value (truncated). Varies per call — the PATH is the signal. */
  valueSample: string;
  /** The candidate request that consumes the value. */
  requestSeq: number;
  /** Earliest earlier request whose RESPONSE first carried this value. */
  sourceSeq: number;
  sourceEndpoint: string;
  /** True when the source is the tool's own endpoint (resolve-then-refine: an
   *  initial text request whose response yields the id, re-sent as a refined
   *  request carrying that id). */
  selfChain: boolean;
}

/** An opaque, machine-minted identifier — not human-typed text. Vendor-agnostic:
 *  keyed on structure (no whitespace, long enough, mixes character classes or is
 *  a delimited handle), not on any specific id format. Excludes free text
 *  (multi-word phrases, single dictionary words), ISO dates, and bare counts so
 *  they never trip it, while still catching namespaced handles ("ns/abc123"),
 *  hex ids, UUIDs, and base64-ish session handles. */
function isIdLike(v: string): boolean {
  if (/\s/.test(v)) return false; // free text has spaces
  if (v.length < 6) return false; // too short to be an opaque handle
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v)) return false; // ISO date / datetime
  const hasLetter = /[A-Za-z]/.test(v);
  const hasDigit = /\d/.test(v);
  const hasIdPunct = /[/:_.+=~-]/.test(v); // namespaced / delimited handle
  // Opaque if it mixes letters+digits (a token), or is a delimited handle that
  // still carries an alphanumeric payload. A bare word or a pure number is not.
  return (hasLetter && hasDigit) || (hasIdPunct && (hasLetter || hasDigit));
}

function responseBodyOf(req: CapturedRequest): string | undefined {
  const b = (req as unknown as { response?: { body?: string } }).response?.body;
  return typeof b === 'string' ? b : undefined;
}

function leafStrings(
  v: unknown,
  path = '',
  out: { path: string; val: string }[] = [],
): { path: string; val: string }[] {
  if (Array.isArray(v)) {
    v.forEach((x, i) => leafStrings(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object))
      leafStrings((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else if (typeof v === 'string' && v.length >= 4) {
    out.push({ path, val: v });
  }
  return out;
}

/** For each candidate request, find body positions holding an id-like value that
 *  first appears in an EARLIER response — i.e. a value the request did not get
 *  from the user's text but chained in from upstream. Deduped by endpoint+path
 *  (the value varies per call; the position is the durable signal). */
export function inputProvenance(session: Session, candidateSeqs: number[]): InputProvenance[] {
  const reqs = [...session.requests].sort((a, b) => a.seq - b.seq);
  const seen = new Set<string>();
  const out: InputProvenance[] = [];
  for (const seq of [...candidateSeqs].sort((a, b) => a - b)) {
    const r = reqs.find((x) => x.seq === seq);
    if (!r) continue;
    const decoded = decodeBodyForDiff(bodyOf(r));
    if (decoded == null || typeof decoded !== 'object') continue;
    const ep = endpointKey(r);
    for (const { path, val } of leafStrings(decoded)) {
      if (!isIdLike(val)) continue;
      const key = `${ep}|${path}`;
      if (seen.has(key)) continue;
      const src = reqs.find((x) => x.seq < seq && (responseBodyOf(x)?.includes(val) ?? false));
      if (!src) continue; // not minted upstream → it IS the param's own text / a constant
      seen.add(key);
      out.push({
        path,
        valueSample: val.length > 40 ? `${val.slice(0, 40)}…` : val,
        requestSeq: seq,
        sourceSeq: src.seq,
        sourceEndpoint: endpointKey(src),
        selfChain: endpointKey(src) === ep,
      });
    }
  }
  return out;
}
