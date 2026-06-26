/**
 * Derive the credential-entry page for an authenticate tool's `bootstrap` block.
 *
 * The live auth verifier runs the login inside a real browser (cdp-replay). For a
 * bot-defended site, the credential POST is edge-blocked (e.g. Akamai 403 "Access
 * Denied") unless the browser first NAVIGATES the actual login page so its anti-bot
 * sensor runs and validates its token (`_abck`) for the correct Origin. The right
 * page to navigate is the one where the user entered their credentials — NOT the
 * bare API origin of the POST.
 *
 * The compile agent is told to set `workflow.bootstrap.url` itself; this module is
 * the deterministic SAFETY NET that fills it in from the recording when the agent
 * omits it, so a forgetful LLM never costs a wasted live-login attempt. It runs at
 * compile time, where the recording + the auth plan (login request seqs +
 * credential field names) are in scope — the runtime has none of that.
 *
 * Everything here is site-agnostic: the page is sourced from the recording, never
 * a hardcoded host.
 */

import type { Session } from './types.ts';

type CapturedRequest = Session['requests'][number];

/** Default settle for an injected bootstrap navigation — enough for an anti-bot
 *  page's sensor to run and validate its token before the credential POST. */
const DEFAULT_BOOTSTRAP_WAIT_MS = 4000;

/** `origin + pathname` of a URL (query stripped), or undefined if unparseable. */
function normalizePageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

function refererOf(req: CapturedRequest): string | undefined {
  return req.headers?.Referer ?? req.headers?.referer;
}

function isHtmlDocument(req: CapturedRequest): boolean {
  if (req.resourceType === 'Document') return Boolean(req.response?.body);
  const mime = req.response?.mimeType ?? '';
  return mime.includes('text/html') && Boolean(req.response?.body);
}

/** The credential POST: the lowest-seq login request whose body carries a
 *  credential field name, else the lowest-seq login request outright. */
function findCredentialPost(
  reqs: CapturedRequest[],
  loginRequestSeqs: number[],
  credentialNames: string[],
): CapturedRequest | undefined {
  const seqs = new Set(loginRequestSeqs);
  const logins = reqs.filter((r) => seqs.has(r.seq)).sort((a, b) => a.seq - b.seq);
  if (logins.length === 0) return undefined;
  if (credentialNames.length > 0) {
    const carriesCred = logins.find((r) => {
      const hay = `${r.body ?? ''} ${r.url}`;
      return credentialNames.some((n) => n && hay.includes(n));
    });
    if (carriesCred) return carriesCred;
  }
  return logins[0];
}

/** A Document whose HTML hosts the login form — its `<form action>` resolves to
 *  the credential POST URL, or its body contains the credential field names.
 *  Prefers the Document closest before the POST. */
function findFormHostingDocument(
  reqs: CapturedRequest[],
  loginReq: CapturedRequest,
  credentialNames: string[],
): string | undefined {
  let loginPathname: string | undefined;
  try {
    loginPathname = new URL(loginReq.url).pathname;
  } catch {
    /* ignore */
  }
  const docs = reqs
    .filter((r) => r.seq < loginReq.seq && isHtmlDocument(r))
    .sort((a, b) => b.seq - a.seq); // closest-before first

  for (const doc of docs) {
    const body = doc.response?.body ?? '';
    // (a) a <form action="..."> targeting the credential POST.
    const formActions = body.matchAll(/<form\b[^>]*\baction=["']([^"']+)["']/gi);
    for (const m of formActions) {
      const actionAttr = m[1];
      if (!actionAttr) continue;
      try {
        const action = new URL(actionAttr, doc.url);
        if (
          action.href === loginReq.url ||
          (loginPathname !== undefined && action.pathname === loginPathname)
        ) {
          return normalizePageUrl(doc.url);
        }
      } catch {
        /* ignore malformed action */
      }
    }
    // (b) the body declares the credential input fields.
    if (
      credentialNames.length > 0 &&
      credentialNames.every(
        (n) => n && new RegExp(`name=["']${escapeRegExp(n)}["']`, 'i').test(body),
      )
    ) {
      return normalizePageUrl(doc.url);
    }
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The last HTML Document navigated before the credential POST. */
function lastDocumentBefore(reqs: CapturedRequest[], beforeSeq: number): string | undefined {
  const prior = reqs
    .filter((r) => r.seq < beforeSeq && isHtmlDocument(r))
    .sort((a, b) => b.seq - a.seq);
  const closest = prior[0];
  return closest ? normalizePageUrl(closest.url) : undefined;
}

/**
 * Derive the page where the user entered their credentials, for use as the auth
 * tool's `bootstrap.url`. Precedence:
 *   1. the credential POST's own `Referer` (the page the form was submitted from);
 *   2. the Document whose HTML hosts the login form (action → login endpoint, or
 *      contains the credential field names);
 *   3. the last Document navigated before the credential POST.
 * Returns undefined when the recording offers no usable page (e.g. it started
 * after the login page loaded) — the caller then leaves bootstrap unset and the
 * runtime falls back to its existing base-url derivation.
 */
export function deriveCredentialEntryPageUrl(
  session: Session,
  loginRequestSeqs: number[],
  credentialNames: string[],
): string | undefined {
  const reqs = session.requests;
  const loginReq = findCredentialPost(reqs, loginRequestSeqs, credentialNames);
  if (!loginReq) return undefined;

  return (
    normalizePageUrl(refererOf(loginReq)) ??
    findFormHostingDocument(reqs, loginReq, credentialNames) ??
    lastDocumentBefore(reqs, loginReq.seq)
  );
}

/**
 * Safety net: if an authenticate workflow has NO `bootstrap` block, inject one
 * pointing at the derived credential-entry page. Mutates `workflow` in place and
 * reports whether it changed (the caller persists it). No-ops for non-auth tools,
 * for tools that already declare a bootstrap (never overwrite the agent's choice),
 * and when no page can be derived from the recording.
 */
export function ensureAuthBootstrap(
  workflow: { toolKind?: string; bootstrap?: unknown },
  session: Session,
  loginRequestSeqs: number[],
  credentialNames: string[],
): { changed: boolean; url?: string } {
  if (workflow.toolKind !== 'authenticate' || workflow.bootstrap) return { changed: false };
  const url = deriveCredentialEntryPageUrl(session, loginRequestSeqs, credentialNames);
  if (!url) return { changed: false };
  workflow.bootstrap = { url, waitUntil: 'domcontentloaded', waitMs: DEFAULT_BOOTSTRAP_WAIT_MS };
  return { changed: true, url };
}
