/**
 * Workflow execution engine — substitutes ${param/credential/response[N]}
 * placeholders, loads cookies from the site credential store, runs the
 * chain sequentially, returns a classified ToolResult. Generated tool
 * files are thin wrappers around executeWorkflow().
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import envPaths from 'env-paths';
import type { ToolResult, Workflow, WorkflowRequest } from './types.ts';

const PATHS = envPaths('imprint', { suffix: '' });

export interface CredentialStore {
  site: string;
  /** Persisted via `imprint login`; sent on every same-domain request. */
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  /** ${credential.X} substitutions (patron_id, csrf_token, etc). */
  values: Record<string, string>;
}

/** Load credentials for a site from disk. Returns null if no login is recorded. */
export function loadCredentialStore(site: string): CredentialStore | null {
  const path = pathJoin(PATHS.config, 'credentials', `${site}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CredentialStore;
  return raw;
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
}

export async function executeWorkflow<T = unknown>(opts: ExecuteOptions): Promise<ToolResult<T>> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;

  const credentials =
    opts.credentials ?? loadCredentialStore(opts.workflow.site) ?? emptyStore(opts.workflow.site);

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

  for (let i = 0; i < opts.workflow.requests.length; i++) {
    const req = opts.workflow.requests[i];
    if (!req) continue;

    const subbed = substituteRequest(req, opts.params, credentials, responses);

    const cookieHeader = buildCookieHeader(credentials, subbed.url);
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

  // Return the LAST response as the workflow's `data`.
  return { ok: true, data: (responses.at(-1) ?? null) as T };
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
    subbed.body = substituteString(req.body, params, credentials, responses);
  }
  return subbed;
}

const PLACEHOLDER_RE =
  /\$\{(param|credential|response)\.([^}]+)\}|\$\{response\[(\d+)\]\.([^}]+)\}/g;

export function substituteString(
  template: string,
  params: Record<string, string | number | boolean>,
  credentials: CredentialStore,
  responses: unknown[],
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
        return encodePart(v, template, match);
      }
      // ${param.X} / ${credential.X}
      if (kind === 'param' && name) {
        if (!(name in params))
          throw new Error(`Workflow placeholder ${match} but no param "${name}" provided`);
        return encodePart(params[name], template, match);
      }
      if (kind === 'credential' && name) {
        const v = credentials.values[name];
        if (v === undefined)
          throw new Error(
            `Workflow placeholder ${match} but credential "${name}" not in store (run \`imprint login ${credentials.site}\`)`,
          );
        return encodePart(v, template, match);
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
 * Decide whether a substituted value needs URL-encoding.
 *
 * Heuristic: if the placeholder appears inside what looks like a URL (the
 * template starts with http:// or https://), we URL-encode. If it appears
 * inside a header value or body, we don't (the caller is expected to format
 * the body appropriately for its content-type).
 */
function encodePart(value: unknown, template: string, match: string): string {
  const s = value === undefined || value === null ? '' : String(value);
  const isUrlContext = /^https?:\/\//.test(template);
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
