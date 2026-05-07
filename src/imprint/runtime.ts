/**
 * Workflow execution engine — substitutes ${param/credential/env/response[N]}
 * placeholders, loads cookies from the site credential store, runs the
 * chain sequentially, returns a classified ToolResult. Generated tool
 * files are thin wrappers around executeWorkflow().
 */

import { dirname, resolve as pathResolve } from 'node:path';
import { loadSiteCredentials, readSiteManifest } from './credential-store.ts';
import type { ToolResult, Workflow, WorkflowRequest } from './types.ts';

export interface CredentialStore {
  site: string;
  /** Persisted via `imprint login`; sent on every same-domain request. */
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  /** ${credential.X} substitutions (patron_id, csrf_token, etc). */
  values: Record<string, string>;
}

/** Load credentials for a site from the credential manager (OS keychain →
 *  encrypted-file fallback → legacy JSON for backwards compat). Returns
 *  null only if there's truly nothing recorded; a missing keychain entry
 *  with no legacy file still yields an empty store. */
export async function loadCredentialStore(site: string): Promise<CredentialStore | null> {
  const view = await loadSiteCredentials(site);
  if (Object.keys(view.values).length === 0 && view.cookies.length === 0) return null;
  return { site: view.site, cookies: view.cookies, values: view.values };
}

interface ExecuteOptions {
  workflow: Workflow;
  params: Record<string, string | number | boolean>;
  /** Inject a synthetic credential store; otherwise loads from disk. */
  credentials?: CredentialStore;
  /** Override global fetch (tests, stealth-fetch). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 30000. */
  requestTimeoutMs?: number;
  /** Absolute path of workflow.json — required for parserModule resolution. */
  workflowPath?: string;
}

export async function executeWorkflow<T = unknown>(opts: ExecuteOptions): Promise<ToolResult<T>> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;

  // A zero-request workflow would silently return null data — almost
  // certainly a misconfigured workflow (LLM produced an empty `requests`
  // array). Fail loud so the user knows to re-record or re-generate.
  if (opts.workflow.requests.length === 0) {
    return {
      ok: false,
      error: 'UNKNOWN',
      message: `Workflow ${opts.workflow.toolName} has no requests — nothing to execute.`,
      remediation:
        're-record the session (capture probably stopped before any XHR fired), or re-run `imprint generate` if the workflow JSON looks empty.',
    };
  }

  const credentials =
    opts.credentials ??
    (await loadCredentialStore(opts.workflow.site)) ??
    emptyStore(opts.workflow.site);

  // Validate required parameters are present.
  for (const p of opts.workflow.parameters) {
    if (!(p.name in opts.params) && p.default === undefined) {
      return {
        ok: false,
        error: 'UNKNOWN',
        message: `Missing required parameter: ${p.name} (${p.description})`,
      };
    }
  }

  // Each request's parsed JSON response (when JSON) is appended here so later
  // requests can reference ${response[N].path}.
  const responses: unknown[] = [];

  // In-flight cookie jar — starts as a copy of the persisted cookies and gets
  // updated from every Set-Cookie response header during the chain. Lets a
  // login request "set" auth cookies that subsequent requests in the same
  // workflow can use, mirroring browser behaviour. Not persisted back to the
  // credential store at workflow end (that's `imprint login`'s job).
  const inFlightCookies: Array<{ name: string; value: string; domain: string; path: string }> = [
    ...credentials.cookies,
  ];
  const liveCredentials: CredentialStore = {
    ...credentials,
    cookies: inFlightCookies,
  };

  for (let i = 0; i < opts.workflow.requests.length; i++) {
    const req = opts.workflow.requests[i];
    if (!req) continue;

    const subbed = substituteRequest(req, opts.params, liveCredentials, responses);

    const cookieHeader = buildCookieHeader(liveCredentials, subbed.url);
    if (cookieHeader) subbed.headers.cookie = cookieHeader;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetchFn(subbed.url, {
        method: subbed.method,
        headers: subbed.headers,
        body: subbed.body,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('AbortError')) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `Request ${i} timed out after ${timeoutMs}ms`,
          remediation: 'Retry, or increase the timeout if the endpoint is slow.',
        };
      }
      return { ok: false, error: 'NETWORK', message: `Request ${i} failed: ${msg}` };
    }
    clearTimeout(timeoutHandle);

    if (resp.status === 401) {
      const text = await safeText(resp);
      return {
        ok: false,
        error: 'AUTH_EXPIRED',
        message: `Request ${i} returned 401 — auth has likely expired: ${text.slice(0, 300)}`,
        remediation: `Run \`imprint login ${opts.workflow.site}\` to refresh credentials.`,
      };
    }
    if (resp.status === 403) {
      // 403 = bot detection / geo / ToS / missing capability. The body
      // usually disambiguates — surface it rather than guessing.
      const text = await safeText(resp);
      return {
        ok: false,
        error: 'FORBIDDEN',
        message: `Request ${i} returned 403: ${text.slice(0, 300)}`,
        remediation: `Common causes: bot detection (Akamai/Cloudflare/DataDome), geo-block, expired credential, or ToS violation. Inspect the response body above; if it looks like bot detection, the captured workflow can't replay against this site without a real browser. If it's auth, try \`imprint login ${opts.workflow.site}\`.`,
      };
    }
    if (resp.status === 429) {
      const text = await safeText(resp);
      return {
        ok: false,
        error: 'RATE_LIMITED',
        message: `Request ${i} returned 429: ${text.slice(0, 300)}`,
        remediation: 'Back off and retry after the Retry-After interval.',
      };
    }
    if (resp.status >= 400) {
      const text = await safeText(resp);
      return {
        ok: false,
        error: 'BAD_RESPONSE',
        message: `Request ${i} (${subbed.method} ${subbed.url}) returned ${resp.status}: ${text.slice(0, 500)}`,
      };
    }

    // Capture Set-Cookie response headers into the in-flight cookie jar so
    // subsequent requests in the chain see the freshly-issued auth cookies.
    // Works for fetch (single Set-Cookie header concatenated) and the rare
    // Set-Cookie iterator on stealth-fetch responses.
    try {
      // biome-ignore lint/suspicious/noExplicitAny: getSetCookie() is ES2024
      const headers: any = resp.headers;
      let setCookieList: string[] = [];
      if (typeof headers.getSetCookie === 'function') {
        setCookieList = headers.getSetCookie();
      } else {
        const sc = resp.headers.get('set-cookie');
        if (sc) setCookieList = [sc];
      }
      for (const sc of setCookieList) {
        const cookie = parseSetCookie(sc, subbed.url);
        if (!cookie) continue;
        // Replace existing same-name cookie; otherwise append.
        const idx = inFlightCookies.findIndex(
          (c) => c.name === cookie.name && c.domain === cookie.domain,
        );
        if (idx >= 0) inFlightCookies[idx] = cookie;
        else inFlightCookies.push(cookie);
      }
    } catch {
      // Non-fatal; cookies stay as they were.
    }

    const text = await safeText(resp);
    let parsed: unknown = text;
    if ((resp.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
    }
    responses.push(parsed);
  }

  // Apply parser if present
  let finalData = responses.at(-1) ?? null;
  if (opts.workflow.parserModule && opts.workflowPath) {
    try {
      const parserModulePath = pathResolve(dirname(opts.workflowPath), opts.workflow.parserModule);
      const mod = await import(parserModulePath);
      if (typeof mod.extract !== 'function') {
        return {
          ok: false,
          error: 'BAD_RESPONSE',
          message: 'parser module does not export extract function',
          remediation: 'regenerate the workflow via `imprint compile`',
        };
      }
      finalData = mod.extract(finalData);
    } catch (err) {
      return {
        ok: false,
        error: 'BAD_RESPONSE',
        message: `parser failed: ${err instanceof Error ? err.message : String(err)}`,
        remediation: 'check the parser module or regenerate the workflow',
      };
    }
  }

  // Return the LAST response as the workflow's `data`.
  return { ok: true, data: finalData as T };
}

function emptyStore(site: string): CredentialStore {
  return { site, cookies: [], values: {} };
}

interface SubstitutedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function substituteRequest(
  req: WorkflowRequest,
  params: Record<string, string | number | boolean>,
  credentials: CredentialStore,
  responses: unknown[],
): SubstitutedRequest {
  const subbed: SubstitutedRequest = {
    method: req.method,
    url: substituteString(req.url, params, credentials, responses),
    headers: {},
  };
  for (const [k, v] of Object.entries(req.headers)) {
    subbed.headers[k] = substituteString(v, params, credentials, responses);
  }
  if (req.body !== undefined) {
    const ct = (req.headers['content-type'] ?? req.headers['Content-Type'] ?? '').toLowerCase();
    const ctx: SubstitutionContext = ct.includes('json')
      ? 'json-body'
      : ct.includes('urlencoded') || req.body.includes('=')
        ? 'form-body'
        : 'opaque-body';
    subbed.body = substituteString(req.body, params, credentials, responses, ctx);
  }
  return subbed;
}

const PLACEHOLDER_RE =
  /\$\{(param|credential|env|response)\.([^}]+)\}|\$\{response\[(\d+)\]\.([^}]+)\}/g;

/** What kind of context the template represents; controls how substituted
 *  values are escaped. */
type SubstitutionContext = 'url' | 'form-body' | 'json-body' | 'opaque-body' | 'header';

export function substituteString(
  template: string,
  params: Record<string, string | number | boolean>,
  credentials: CredentialStore,
  responses: unknown[],
  context?: SubstitutionContext,
): string {
  return template.replace(
    PLACEHOLDER_RE,
    (
      match,
      kind: string | undefined,
      name: string | undefined,
      idx: string | undefined,
      path: string | undefined,
    ) => {
      // ${response[N].JSON_PATH}
      if (idx !== undefined && path !== undefined) {
        const i = Number.parseInt(idx, 10);
        const target = responses[i];
        if (target === undefined) {
          throw new Error(
            `Workflow refers to ${match} but only ${responses.length} responses recorded so far`,
          );
        }
        const v = jsonpath(target, path);
        return encodePart(v, template, match, context);
      }
      // ${env.X}
      if (kind === 'env' && name) {
        const v = process.env[name];
        if (v === undefined) {
          throw new Error(
            `Workflow placeholder ${match} but environment variable "${name}" is not set`,
          );
        }
        return encodePart(v, template, match);
      }
      // ${param.X} / ${credential.X}
      if (kind === 'param' && name) {
        if (!(name in params)) {
          const available = Object.keys(params);
          const hint =
            available.length === 0
              ? `→ no params were passed; the tool needs --param ${name}=<value>`
              : `→ available params: ${available.join(', ')}`;
          throw new Error(`Workflow placeholder ${match} but no param "${name}" provided\n${hint}`);
        }
        return encodePart(params[name], template, match, context);
      }
      if (kind === 'credential' && name) {
        const v = credentials.values[name];
        if (v === undefined) {
          throw new Error(buildMissingCredentialMessage(credentials, name));
        }
        return encodePart(v, template, match, context);
      }
      return match;
    },
  );
}

/** Lookup a dotted JSON path inside a parsed value. Supports nested objects + numeric array indices. */
function jsonpath(root: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(p)) {
      cur = cur[Number.parseInt(p, 10)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Decide how a substituted value gets escaped before splicing into the
 * template. Honors an explicit context hint when given (set by
 * substituteRequest based on Content-Type); otherwise falls back to a
 * URL-shaped heuristic for backwards compatibility.
 */
function encodePart(
  value: unknown,
  template: string,
  match: string,
  context?: SubstitutionContext,
): string {
  const s = value === undefined || value === null ? '' : String(value);

  if (context === 'form-body') {
    // Each substituted value sits between `&` and `=` separators; URL-encode
    // so a password like `REDACTED-PASSWORD` doesn't corrupt the body shape.
    return encodeURIComponent(s);
  }
  if (context === 'json-body') {
    // We're substituting INTO a string that will be parsed as JSON. The
    // template treats `${credential.X}` as a literal string token, so
    // escape characters that would terminate the surrounding JSON string.
    return s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }
  if (context === 'header' || context === 'opaque-body') {
    return s;
  }

  // URL context (default).
  const isUrlContext = context === 'url' || /^https?:\/\//.test(template);
  if (!isUrlContext) return s;

  // If the placeholder sits in the URL path, encode strictly. If it's in the
  // query string, use encodeURIComponent (which is what most clients do).
  const idx = template.indexOf(match);
  const beforeMatch = template.slice(0, idx);
  const inQuery = beforeMatch.includes('?');
  return inQuery ? encodeURIComponent(s) : encodeURI(s);
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function buildCookieHeader(store: CredentialStore, url: string): string | null {
  if (!store.cookies.length) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const matching = store.cookies.filter((c) => domainMatches(c.domain, host));
  if (!matching.length) return null;
  return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

function domainMatches(cookieDomain: string, host: string): boolean {
  // Cookie domain may start with a leading dot. Strip it.
  const dom = cookieDomain.replace(/^\./, '');
  return host === dom || host.endsWith(`.${dom}`);
}

/** Build a clear, actionable error when a `${credential.NAME}` placeholder
 *  can't be resolved. Reads the per-site manifest (if present) so the
 *  message can list ALL missing credentials at once and explain the kinds
 *  the user is being asked to provision. */
function buildMissingCredentialMessage(store: CredentialStore, missingName: string): string {
  const site = store.site;
  const have = new Set(Object.keys(store.values));
  // Pull the manifest so we can list every required credential, not just the
  // one that happened to fire first.
  let manifestEntries: Array<{ name: string; kind: string; description?: string }> = [];
  try {
    const m = readSiteManifest(site);
    if (m && Array.isArray(m.secrets)) manifestEntries = m.secrets;
  } catch {
    /* no manifest — fall back to a simpler hint */
  }

  const missingFromManifest = manifestEntries.filter((e) => !have.has(e.name));
  const missing =
    missingFromManifest.length > 0
      ? missingFromManifest.map((e) => e.name)
      : have.has(missingName)
        ? [missingName]
        : [missingName];

  const setCommands = missing.map((n) => `  imprint credential set ${site} ${n}`).join('\n');
  const manifestNote =
    missingFromManifest.length > 1
      ? `\nAll ${missingFromManifest.length} credentials this skill needs are missing.`
      : '';
  const manifestKinds =
    missingFromManifest.length > 0
      ? `\nThe skill's credentials.manifest.json says it expects:\n${missingFromManifest
          .map((e) => `  • ${e.name} [${e.kind}]${e.description ? ` — ${e.description}` : ''}`)
          .join('\n')}`
      : '';

  return [
    `Missing credential "${missingName}" for site "${site}". The MCP tool can't run until you provision it.${manifestNote}${manifestKinds}`,
    '',
    'To fix — pick ONE of:',
    '',
    '  (1) Set it on this machine (interactive, silent prompt):',
    setCommands,
    '',
    '  (2) Import an encrypted bundle exported from a machine where this is already set up:',
    `      (on the source machine)  imprint credential export ${site} --out ${site}.imprintbundle`,
    `      (transfer the bundle file via any channel — it's passphrase-protected)`,
    `      (on this machine)        imprint credential import ${site} ${site}.imprintbundle`,
    '',
    'See docs/credential-sharing.md for the full sharing workflow.',
  ].join('\n');
}

/** Pre-flight result for one site's credential readiness. */
interface CredentialReadinessReport {
  site: string;
  ok: boolean;
  /** Entries the manifest says this site needs but that aren't in the store. */
  missing: Array<{ name: string; kind: string; description?: string }>;
  /** Human-friendly multi-line message; safe to log as-is. Empty when ok. */
  message: string;
}

/** Pre-flight check: read the manifest for a site, compare to what's in the
 *  credential store, and report what's missing. Used by `imprint mcp-server`
 *  startup and `imprint cron` so users find out ahead of the first tool call
 *  rather than mid-workflow. Returns `ok: true` if no manifest exists OR if
 *  every manifested credential is present. */
export async function checkSiteCredentialsReady(site: string): Promise<CredentialReadinessReport> {
  const manifest = readSiteManifest(site);
  if (!manifest || manifest.secrets.length === 0) {
    return { site, ok: true, missing: [], message: '' };
  }
  const store = (await loadCredentialStore(site)) ?? { site, cookies: [], values: {} };
  const have = new Set(Object.keys(store.values));
  const missing = manifest.secrets.filter((s) => !have.has(s.name));
  if (missing.length === 0) return { site, ok: true, missing: [], message: '' };

  const firstMissing = missing[0];
  if (!firstMissing) return { site, ok: true, missing: [], message: '' };
  return {
    site,
    ok: false,
    missing: missing.map((s) => ({
      name: s.name,
      kind: s.kind,
      description: s.description,
    })),
    message: buildMissingCredentialMessage(store, firstMissing.name),
  };
}

/** Minimal Set-Cookie parser. Pulls name=value plus Domain/Path attrs and
 *  ignores Expires/Max-Age/Secure/HttpOnly/SameSite — we don't need them
 *  for in-flight forwarding (the jar is per-execution, not persistent).
 *  When Domain isn't set we default to the request URL's hostname per RFC 6265. */
function parseSetCookie(
  setCookie: string,
  requestUrl: string,
): { name: string; value: string; domain: string; path: string } | null {
  const parts = setCookie.split(';').map((s) => s.trim());
  const first = parts[0] ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq);
  const value = first.slice(eq + 1);
  let domain = '';
  let path = '/';
  for (const p of parts.slice(1)) {
    const lower = p.toLowerCase();
    if (lower.startsWith('domain=')) domain = p.slice('domain='.length);
    else if (lower.startsWith('path=')) path = p.slice('path='.length);
  }
  if (!domain) {
    try {
      domain = new URL(requestUrl).hostname;
    } catch {
      return null;
    }
  }
  return { name, value, domain, path };
}
