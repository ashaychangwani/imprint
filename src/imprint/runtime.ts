/**
 * Workflow execution engine — substitutes ${param/credential/env/response[N]}
 * placeholders, loads cookies from the site credential store, runs the
 * chain sequentially, returns a classified ToolResult. Generated tool
 * files are thin wrappers around executeWorkflow().
 */

import { dirname, resolve as pathResolve } from 'node:path';
import {
  type CookieLookupConstraints,
  type RuntimeCookie,
  RuntimeCookieJar,
  extractSetCookieHeaders,
} from './cookie-jar.ts';
import {
  type StorageRecord,
  loadSiteCredentials,
  readSiteManifest,
  saveSiteCookies,
  saveSiteSecret,
} from './credential-store.ts';
import type {
  RequestCapture,
  StateCapability,
  StateMissingItem,
  ToolResult,
  Workflow,
  WorkflowRequest,
} from './types.ts';

export { splitSetCookieHeader } from './cookie-jar.ts';

export interface CredentialStore {
  site: string;
  /** Persisted via `imprint login`; sent on every same-domain request. */
  cookies: RuntimeCookie[];
  /** ${credential.X} substitutions (patron_id, csrf_token, etc). */
  values: Record<string, string>;
  /** Durable browser storage captured by `imprint login`; V1 seeds localStorage only. */
  storage?: StorageRecord[];
}

/** Load credentials for a site from the credential manager (OS keychain →
 *  encrypted-file fallback → legacy JSON for backwards compat). Returns
 *  null only if there's truly nothing recorded; a missing keychain entry
 *  with no legacy file still yields an empty store. */
export async function loadCredentialStore(site: string): Promise<CredentialStore | null> {
  const view = await loadSiteCredentials(site);
  const store: CredentialStore = {
    site: view.site,
    cookies: view.cookies,
    values: { ...view.values },
    storage: view.storage,
  };

  const envCreds = process.env.IMPRINT_TEACH_CREDENTIALS;
  if (envCreds) {
    try {
      const parsed = JSON.parse(envCreds) as { site: string; values: Record<string, string> };
      if (parsed.site === site && parsed.values) {
        for (const [k, v] of Object.entries(parsed.values)) {
          if (!(k in store.values)) store.values[k] = v;
        }
      }
    } catch {
      // Malformed env var — ignore silently.
    }
  }

  if (
    Object.keys(store.values).length === 0 &&
    store.cookies.length === 0 &&
    (store.storage?.length ?? 0) === 0
  ) {
    return null;
  }
  return store;
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
  /** Initial ${state.X} values harvested by fetch-bootstrap. */
  initialState?: Record<string, unknown>;
}

interface ResponseSlot {
  raw: unknown;
  aliases: Record<string, unknown>;
}

export async function executeWorkflow<T = unknown>(opts: ExecuteOptions): Promise<ToolResult<T>> {
  if (opts.workflow.toolKind === 'authenticate') {
    return executeAuthWorkflow(opts) as Promise<ToolResult<T>>;
  }

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

  // Validate required parameters are present and merge declared defaults
  // into the working params map. Without the merge, `parameter.default` would
  // be a presence-sentinel only — the substitution layer at
  // `resolvePlaceholder` would still throw STATE_MISSING because it reads
  // from this map directly. The schema declares `default` as a real value
  // (string | number | boolean), so honor it.
  const params: Record<string, string | number | boolean> = { ...opts.params };
  for (const p of opts.workflow.parameters) {
    if (!(p.name in params)) {
      if (p.default === undefined) {
        return {
          ok: false,
          error: 'UNKNOWN',
          message: `Missing required parameter: ${p.name} (${p.description})`,
        };
      }
      params[p.name] = p.default;
    }
  }

  // rawResponses feeds parser modules and the final return shape. responseSlots
  // keeps legacy request.extract aliases without replacing raw parser input.
  const responseSlots: ResponseSlot[] = [];
  const state: Record<string, unknown> = { ...(opts.initialState ?? {}) };

  // Per-execution mutable jar. Never shared across MCP/cron calls.
  const cookieJar = new RuntimeCookieJar(credentials.cookies);
  const liveCredentials: CredentialStore = { ...credentials, cookies: cookieJar.toJSON() };
  const stateCapabilities = collectStateCapabilities(opts.workflow);
  const dependencyPreflight = preflightStateDependencies(opts.workflow, state, stateCapabilities);
  if (!dependencyPreflight.ok) return dependencyPreflight.result;

  type TransformResult = string | { url: string; body?: string; headers?: Record<string, string> };
  let requestTransform:
    | ((
        method: string,
        url: string,
        responses: unknown[],
        params?: Record<string, string | number | boolean>,
      ) => TransformResult)
    | null = null;
  if (opts.workflow.requestTransformModule && opts.workflowPath) {
    try {
      const transformPath = pathResolve(
        dirname(opts.workflowPath),
        opts.workflow.requestTransformModule,
      );
      const mod = await import(transformPath);
      if (typeof mod.transform === 'function') requestTransform = mod.transform;
    } catch {
      // Non-fatal — proceed without transform.
    }
  }

  for (let i = 0; i < opts.workflow.requests.length; i++) {
    const req = opts.workflow.requests[i];
    if (!req) continue;

    const subbedResult = substituteRequest(req, {
      params,
      credentials: liveCredentials,
      responseSlots,
      state,
      cookieJar,
      stateCapabilities,
      requestUrlTemplate: req.url,
    });
    if (!subbedResult.ok) return subbedResult.result;
    const subbed = subbedResult.value;

    if (requestTransform) {
      try {
        const transformResult = requestTransform(
          subbed.method,
          subbed.url,
          responseSlots.map((s) => s.raw),
          params,
        );
        if (typeof transformResult === 'string') {
          subbed.url = transformResult;
        } else if (transformResult && typeof transformResult === 'object') {
          subbed.url = transformResult.url;
          if (transformResult.body !== undefined) subbed.body = transformResult.body;
          if (transformResult.headers) {
            for (const [k, v] of Object.entries(transformResult.headers)) {
              subbed.headers[k] = v;
            }
          }
        }
      } catch {
        // Non-fatal — proceed with the original request.
      }
    }

    const cookieHeader = cookieJar.getCookieHeader(subbed.url);
    if (cookieHeader && !hasHeader(subbed.headers, 'cookie')) subbed.headers.cookie = cookieHeader;

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

    // Capture Set-Cookie response headers into the in-flight cookie jar before
    // evaluating captures. Set-Cookie is not exposed as a normal header capture.
    try {
      for (const sc of extractSetCookieHeaders(resp.headers))
        cookieJar.setCookieFromHeader(sc, subbed.url);
      liveCredentials.cookies = cookieJar.toJSON();
    } catch {
      // Non-fatal; cookies stay as they were.
    }

    const text = await safeText(resp);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not valid JSON — keep as raw text string.
    }
    const aliases = evaluateLegacyExtract(req, parsed);
    responseSlots.push({ raw: parsed, aliases });

    const captureResult = evaluateRequestCaptures(req.captures ?? [], {
      parsed,
      text,
      headers: resp.headers,
      requestUrl: subbed.url,
      cookieJar,
    });
    if (!captureResult.ok) return captureResult.result;
    Object.assign(state, captureResult.value);
  }

  // Apply parser if present
  let finalData = responseSlots.at(-1)?.raw ?? null;
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
      finalData = mod.extract(finalData, {
        params,
        responses: responseSlots.map((s) => s.raw),
      });
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
  return { site, cookies: [], values: {}, storage: [] };
}

async function executeAuthWorkflow(opts: ExecuteOptions): Promise<ToolResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  const action = String(opts.params?.action ?? 'initiate');
  const authConfig = opts.workflow.authConfig;
  const initiateCount = authConfig?.initiateRequestCount ?? opts.workflow.requests.length;

  const credentials =
    opts.credentials ??
    (await loadCredentialStore(opts.workflow.site)) ??
    emptyStore(opts.workflow.site);

  const cookieJar = new RuntimeCookieJar(credentials.cookies);
  const liveCredentials: CredentialStore = { ...credentials, cookies: cookieJar.toJSON() };
  const responseSlots: ResponseSlot[] = [];
  const state: Record<string, unknown> = { ...(opts.initialState ?? {}) };
  const stateCapabilities = collectStateCapabilities(opts.workflow);
  const params: Record<string, string | number | boolean> = { ...opts.params };
  let loginResponsePreview: string | undefined;
  /** Latest response context, used to resolve authConfig.sessionCapture against
   *  the final completion response when the login succeeds. */
  let lastAuthResponseCtx:
    | { parsed: unknown; text: string; headers: Headers; requestUrl: string }
    | undefined;

  const runRequests = async (startIdx: number, endIdx: number): Promise<ToolResult | null> => {
    for (let i = startIdx; i < endIdx; i++) {
      const req = opts.workflow.requests[i];
      if (!req) continue;

      let subbedReq: SubstitutedRequest;
      const subbedResult = substituteRequest(req, {
        params,
        credentials: liveCredentials,
        responseSlots,
        state,
        cookieJar,
        stateCapabilities,
        requestUrlTemplate: req.url,
      });
      if (!subbedResult.ok) return subbedResult.result;
      subbedReq = subbedResult.value;

      const cookieHeader = cookieJar.getCookieHeader(subbedReq.url);
      if (cookieHeader && !hasHeader(subbedReq.headers, 'cookie'))
        subbedReq.headers.cookie = cookieHeader;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchFn(subbedReq.url, {
          method: subbedReq.method,
          headers: subbedReq.headers,
          body: subbedReq.body,
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'NETWORK', message: `Auth request ${i} failed: ${msg}` };
      }
      clearTimeout(timeoutHandle);

      if (resp.status >= 400) {
        const text = await safeText(resp);
        // An OPTIONAL request (e.g. a "remember this device" registration that
        // 4xxs when the device is already trusted, or a telemetry beacon) must
        // not abort the flow — log and continue to the next (terminal) request.
        if (req.optional) {
          process.stderr.write(
            `[imprint runtime] optional auth request ${i} (${subbedReq.url}) returned ${resp.status} — skipping, continuing\n`,
          );
          continue;
        }
        return {
          ok: false,
          error: resp.status === 401 ? 'AUTH_EXPIRED' : 'BAD_RESPONSE',
          message: `Auth request ${i} (${subbedReq.method} ${subbedReq.url}) returned ${resp.status}: ${text.slice(0, 500)}`,
          // Surface the concrete status + body so the auth compile agent sees the
          // server's actual error (e.g. a 401 "tokens missing" vs a 400 schema
          // error) without re-running — see run_verification's result.
          status: resp.status,
          responseBodyPreview: text.slice(0, 500),
        };
      }

      try {
        for (const sc of extractSetCookieHeaders(resp.headers))
          cookieJar.setCookieFromHeader(sc, subbedReq.url);
        liveCredentials.cookies = cookieJar.toJSON();
      } catch {
        // Non-fatal
      }

      const text = await safeText(resp);
      // Capture the last login-phase response for shape comparison
      if (i < initiateCount) loginResponsePreview = text.slice(0, 500);

      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep raw
      }
      // Remember the latest response so sessionCapture can be resolved against
      // the final completion response after the login finishes.
      lastAuthResponseCtx = { parsed, text, headers: resp.headers, requestUrl: subbedReq.url };
      const aliases = evaluateLegacyExtract(req, parsed);
      responseSlots.push({ raw: parsed, aliases });

      const captureResult = evaluateRequestCaptures(req.captures ?? [], {
        parsed,
        text,
        headers: resp.headers,
        requestUrl: subbedReq.url,
        cookieJar,
      });
      if (!captureResult.ok) return captureResult.result;
      Object.assign(state, captureResult.value);
    }
    return null;
  };

  // Persist durable session tokens (authConfig.sessionCapture) after a SUCCESSFUL
  // login completion so data tools reuse them as ${credential.NAME} without
  // re-running auth. Best-effort: a token that can't be resolved is skipped, not
  // fatal. Cookies are persisted separately (saveSiteCookies). General — driven
  // only by the declared captures + the recorded response shape.
  const persistSessionCapture = async (): Promise<void> => {
    const caps = authConfig?.sessionCapture ?? [];
    if (caps.length === 0) return;
    for (const cap of caps) {
      let value: unknown;
      if (lastAuthResponseCtx) {
        const res = evaluateRequestCaptures([cap], {
          parsed: lastAuthResponseCtx.parsed,
          text: lastAuthResponseCtx.text,
          headers: lastAuthResponseCtx.headers,
          requestUrl: lastAuthResponseCtx.requestUrl,
          cookieJar,
        });
        if (res.ok) value = res.value[cap.name];
      }
      if (value === undefined || value === null) value = state[cap.name];
      if (value !== undefined && value !== null && String(value).length > 0) {
        try {
          await saveSiteSecret(opts.workflow.site, cap.name, String(value));
        } catch {
          /* non-fatal — cookies are the primary token */
        }
      }
    }
  };

  if (action === 'initiate') {
    const err = await runRequests(0, initiateCount);
    if (err) return err;

    if (authConfig && authConfig.twoFactorType !== 'none') {
      await saveSiteCookies(opts.workflow.site, cookieJar.toJSON());
      // Stateless state-chain bridge: each MCP call is a fresh executeAuthWorkflow
      // with a fresh `state`, so a token the login response returned in its body
      // (e.g. a reauth mfaId) would be lost before submit_otp. Project the
      // declared twoFactorContext names out of the captured state and echo them
      // to the caller, who passes them back as initialState on the next call.
      const ctx: Record<string, unknown> = {};
      for (const name of authConfig.twoFactorContext ?? []) {
        if (name in state) ctx[name] = state[name];
      }
      return {
        ok: false,
        error: 'AWAITING_2FA',
        twoFactorType: authConfig.twoFactorType,
        twoFactorContext: Object.keys(ctx).length > 0 ? ctx : undefined,
        loginResponsePreview,
        message: `2FA required (${authConfig.twoFactorType}). ${
          authConfig.twoFactorType === 'push'
            ? 'Approve the push notification on your device, then call again with action=complete.'
            : 'Enter the code and call again with action=submit_otp, otp_code, and the echoed twoFactorContext.'
        }`,
      };
    }

    await saveSiteCookies(opts.workflow.site, cookieJar.toJSON());
    return { ok: true, data: { authenticated: true }, loginResponsePreview };
  }

  if (action === 'complete') {
    if (authConfig?.twoFactorType === 'push' && authConfig.pollEndpoint) {
      // The recorded default is generous (≈3 min) for a real run where a human
      // approves the push. An unattended *attempt* (e.g. `imprint teach
      // --no-interactive`) wants a short bound so it fails fast instead of
      // blocking. IMPRINT_AUTH_POLL_ATTEMPTS lets any caller cap the poll
      // without mutating the artifact; the runtime default stays generous.
      const pollOverride = parsePositiveInt(process.env.IMPRINT_AUTH_POLL_ATTEMPTS);
      const pollMax = pollOverride ?? authConfig.maxPollAttempts ?? 60;
      const pollInterval = authConfig.pollIntervalMs ?? 3000;
      const pollMethod = authConfig.pollMethod ?? 'POST';
      // Many poll/status endpoints reject an empty body (they need the recorded
      // JSON payload, e.g. `{mfaId,...}`). Substitute the declared pollBody once
      // (state is fixed during the completion phase) against the same runtime as
      // any request, so `${state.X}`/`${credential.X}`/`${param.X}` resolve.
      const pollContentType =
        authConfig.pollBody !== undefined
          ? (authConfig.pollContentType ?? 'application/json')
          : undefined;
      let pollBody: string | undefined;
      if (authConfig.pollBody !== undefined) {
        const ctLower = (pollContentType ?? '').toLowerCase();
        const bodyCtx: SubstitutionContext = ctLower.includes('json')
          ? 'json-body'
          : ctLower.includes('urlencoded') || authConfig.pollBody.includes('=')
            ? 'form-body'
            : 'opaque-body';
        const pollBodyResult = substituteStringInternal(
          authConfig.pollBody,
          {
            params,
            credentials: liveCredentials,
            responseSlots,
            state,
            cookieJar,
            stateCapabilities,
            requestUrlTemplate: authConfig.pollEndpoint,
          },
          bodyCtx,
        );
        if (!pollBodyResult.ok) return pollBodyResult.result;
        pollBody = pollBodyResult.value;
      }
      let approved = false;
      for (let attempt = 0; attempt < pollMax; attempt++) {
        await sleep(pollInterval);
        const cookieHeader = cookieJar.getCookieHeader(authConfig.pollEndpoint);
        const pollHeaders: Record<string, string> = {};
        if (cookieHeader) pollHeaders.cookie = cookieHeader;
        if (pollContentType) pollHeaders['content-type'] = pollContentType;
        // Bound each poll the same way as a normal request: without a timeout a
        // pollEndpoint that accepts the connection but never responds hangs this
        // single fetch forever, so the poll budget never advances and `complete`
        // hangs indefinitely. An abort throws → caught below → next attempt.
        const pollController = new AbortController();
        const pollTimeout = setTimeout(() => pollController.abort(), timeoutMs);
        try {
          const pollResp = await fetchFn(authConfig.pollEndpoint, {
            method: pollMethod,
            headers: pollHeaders,
            body: pollBody,
            signal: pollController.signal,
          });
          if (pollResp.ok) {
            const body = await safeText(pollResp);
            let newSessionCookie = false;
            try {
              for (const sc of extractSetCookieHeaders(pollResp.headers)) {
                cookieJar.setCookieFromHeader(sc, authConfig.pollEndpoint);
                newSessionCookie = true;
              }
              liveCredentials.cookies = cookieJar.toJSON();
            } catch {
              /* non-fatal */
            }
            // Approval is recognized from the recording, not from hardcoded
            // strings: `pollTerminal` is a capture the compile agent grounds in
            // the recorded *approved* poll response (and which is absent on the
            // pending ones). It is "done" once that capture yields a value.
            // Fallback when no terminal was declared: a fresh session Set-Cookie
            // appeared, the universal sign of a completed login.
            if (authConfig.pollTerminal) {
              let parsed: unknown = body;
              try {
                parsed = JSON.parse(body);
              } catch {
                /* keep raw */
              }
              const term = evaluateRequestCaptures([authConfig.pollTerminal], {
                parsed,
                text: body,
                headers: pollResp.headers,
                requestUrl: authConfig.pollEndpoint,
                cookieJar,
              });
              if (term.ok && Object.keys(term.value).length > 0) {
                approved = true;
                break;
              }
            } else if (newSessionCookie) {
              approved = true;
              break;
            }
          }
        } catch {
          // retry (a network error or a timed-out abort falls through to the
          // next poll attempt rather than failing the whole completion)
        } finally {
          clearTimeout(pollTimeout);
        }
      }
      if (!approved) {
        return {
          ok: false,
          error: 'UNKNOWN',
          message: `Push notification was not approved after ${pollMax} attempts.`,
        };
      }
    }

    const err = await runRequests(initiateCount, opts.workflow.requests.length);
    if (err) return err;

    await saveSiteCookies(opts.workflow.site, cookieJar.toJSON());
    await persistSessionCapture();
    return { ok: true, data: { authenticated: true } };
  }

  if (action === 'submit_otp') {
    const err = await runRequests(initiateCount, opts.workflow.requests.length);
    if (err) return err;

    await saveSiteCookies(opts.workflow.site, cookieJar.toJSON());
    await persistSessionCapture();
    return { ok: true, data: { authenticated: true } };
  }

  return {
    ok: false,
    error: 'UNKNOWN',
    message: `Unknown auth action: ${action}. Use 'initiate', 'complete', or 'submit_otp'.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a strictly-positive integer from an env string; undefined otherwise. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface SubstitutedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type RuntimeErrorResult = Extract<ToolResult, { ok: false }>;
type RuntimeResult<T> = { ok: true; value: T } | { ok: false; result: RuntimeErrorResult };

interface SubstituteRuntime {
  params: Record<string, string | number | boolean>;
  credentials: CredentialStore;
  responseSlots: ResponseSlot[];
  state: Record<string, unknown>;
  cookieJar: RuntimeCookieJar;
  stateCapabilities: Map<string, StateCapability>;
  requestUrlTemplate: string;
}

function substituteRequest(
  req: WorkflowRequest,
  runtime: SubstituteRuntime,
): RuntimeResult<SubstitutedRequest> {
  const urlResult = substituteStringInternal(req.url, runtime, undefined);
  if (!urlResult.ok) return urlResult;
  const subbed: SubstitutedRequest = { method: req.method, url: urlResult.value, headers: {} };

  const requestRuntime = { ...runtime, requestUrlTemplate: subbed.url };
  for (const [k, v] of Object.entries(req.headers)) {
    const headerResult = substituteStringInternal(v, requestRuntime, 'header');
    if (!headerResult.ok) return headerResult;
    subbed.headers[k] = headerResult.value;
  }
  if (req.body !== undefined) {
    const ct = (req.headers['content-type'] ?? req.headers['Content-Type'] ?? '').toLowerCase();
    const ctx: SubstitutionContext = ct.includes('json')
      ? 'json-body'
      : ct.includes('urlencoded') || req.body.includes('=')
        ? 'form-body'
        : 'opaque-body';
    const bodyResult = substituteStringInternal(req.body, requestRuntime, ctx);
    if (!bodyResult.ok) return bodyResult;
    subbed.body = bodyResult.value;
  }
  return { ok: true, value: subbed };
}

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

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
  const runtime: SubstituteRuntime = {
    params,
    credentials,
    responseSlots: responses.map((raw) => ({ raw, aliases: {} })),
    state: {},
    cookieJar: new RuntimeCookieJar(credentials.cookies),
    stateCapabilities: new Map(),
    requestUrlTemplate: template,
  };
  const result = substituteStringInternal(template, runtime, context);
  if (!result.ok) throw new Error(result.result.message);
  return result.value;
}

function substituteStringInternal(
  template: string,
  runtime: SubstituteRuntime,
  context?: SubstitutionContext,
): RuntimeResult<string> {
  let missing: RuntimeErrorResult | null = null;
  const out = template.replace(PLACEHOLDER_RE, (match, expr: string) => {
    const resolved = resolvePlaceholder(match, expr, template, runtime, context);
    if (!resolved.ok) {
      missing = resolved.result;
      return match;
    }
    return resolved.value;
  });
  return missing ? { ok: false, result: missing } : { ok: true, value: out };
}

function resolvePlaceholder(
  match: string,
  expr: string,
  template: string,
  runtime: SubstituteRuntime,
  context?: SubstitutionContext,
): RuntimeResult<string> {
  const parsed = parsePlaceholderExpression(expr);
  if (!parsed) return { ok: true, value: match };

  if (parsed.kind === 'response') {
    const slot = runtime.responseSlots[parsed.index];
    if (!slot) {
      return missingState({
        name: match,
        source: 'response',
        capability: 'ordinary_http',
        failure: 'producer_unavailable',
        message: `Workflow refers to ${match} but only ${runtime.responseSlots.length} responses exist so far`,
      });
    }
    const v =
      parsed.path in slot.aliases ? slot.aliases[parsed.path] : jsonpath(slot.raw, parsed.path);
    return { ok: true, value: encodePart(v, template, match, context) };
  }

  if (parsed.kind === 'env') {
    const v = process.env[parsed.name];
    if (v === undefined) {
      return missingState({
        name: parsed.name,
        source: 'workflow',
        capability: 'unsupported',
        failure: 'unsupported_workflow',
        message: `Workflow placeholder ${match} but environment variable "${parsed.name}" is not set`,
      });
    }
    return { ok: true, value: encodePart(v, template, match, context) };
  }

  if (parsed.kind === 'generated') {
    const v = generateValue(parsed.name);
    if (v === null) {
      return missingState({
        name: parsed.name,
        source: 'workflow',
        capability: 'unsupported',
        failure: 'unsupported_workflow',
        message: `Workflow placeholder ${match} uses an unknown generated kind "${parsed.name}" (expected uuid | epoch_ms | epoch_s | iso8601 | nonce)`,
      });
    }
    return { ok: true, value: encodePart(v, template, match, context) };
  }

  if (parsed.kind === 'param') {
    if (!(parsed.name in runtime.params)) {
      const available = Object.keys(runtime.params);
      const hint =
        available.length === 0
          ? `no params were passed; the tool needs --param ${parsed.name}=<value>`
          : `available params: ${available.join(', ')}`;
      return missingState({
        name: parsed.name,
        source: 'workflow',
        capability: 'unsupported',
        failure: 'unsupported_workflow',
        message: `Workflow placeholder ${match} but no param "${parsed.name}" provided (${hint})`,
      });
    }
    return { ok: true, value: encodePart(runtime.params[parsed.name], template, match, context) };
  }

  if (parsed.kind === 'credential') {
    const v = runtime.credentials.values[parsed.name];
    if (v === undefined) {
      return missingState({
        name: parsed.name,
        source: 'credential',
        capability: 'credential_required',
        failure: 'credential_missing',
        message: buildMissingCredentialMessage(runtime.credentials, parsed.name),
      });
    }
    return { ok: true, value: encodePart(v, template, match, context) };
  }

  if (parsed.kind === 'state') {
    if (!(parsed.name in runtime.state)) {
      const capability = runtime.stateCapabilities.get(parsed.name) ?? 'unsupported';
      return missingState({
        name: parsed.name,
        source: 'state',
        capability,
        failure: 'producer_unavailable',
        message: `Workflow placeholder ${match} but state "${parsed.name}" has not been captured yet`,
      });
    }
    return { ok: true, value: encodePart(runtime.state[parsed.name], template, match, context) };
  }

  const lookup = runtime.cookieJar.lookup(parsed.name, runtime.requestUrlTemplate);
  if (!lookup.ok) {
    return missingState({
      name: parsed.name,
      source: 'cookie',
      capability: 'ordinary_http',
      failure: lookup.reason === 'ambiguous' ? 'ambiguous_cookie' : 'producer_ran_value_absent',
      message:
        lookup.reason === 'ambiguous'
          ? `Cookie placeholder ${match} is ambiguous for ${runtime.requestUrlTemplate}; use a named capture with url/domain/path constraints.`
          : lookup.reason === 'httponly'
            ? `Cookie placeholder ${match} refers to an HttpOnly cookie; use a named capture with allowHttpOnlyProjection only if intentional.`
            : `Cookie placeholder ${match} could not find cookie "${parsed.name}" for ${runtime.requestUrlTemplate}`,
    });
  }
  return { ok: true, value: encodePart(lookup.cookie.value, template, match, context) };
}

type ParsedPlaceholder =
  | { kind: 'param' | 'credential' | 'env' | 'state' | 'cookie' | 'generated'; name: string }
  | { kind: 'response'; index: number; path: string };

function parsePlaceholderExpression(expr: string): ParsedPlaceholder | null {
  const response = expr.match(/^response\[(\d+)\]\.(.+)$/);
  if (response?.[1] && response[2]) {
    return { kind: 'response', index: Number.parseInt(response[1], 10), path: response[2] };
  }

  const bracket = expr.match(/^(state|cookie)\["([^"]+)"\]$/);
  if (bracket?.[1] && bracket[2]) {
    return { kind: bracket[1] as 'state' | 'cookie', name: bracket[2] };
  }

  const dotted = expr.match(/^(param|credential|env|state|cookie|generated)\.([A-Za-z0-9_.-]+)$/);
  if (dotted?.[1] && dotted[2]) {
    return {
      kind: dotted[1] as 'param' | 'credential' | 'env' | 'state' | 'cookie' | 'generated',
      name: dotted[2],
    };
  }

  return null;
}

/** Mint a fresh per-call value for a `${generated.KIND}` placeholder. Resolved
 *  anew on EVERY substitution so two occurrences in one request can differ and a
 *  later call never reuses an earlier value. Returns null for an unknown kind. */
function generateValue(kind: string): string | null {
  switch (kind) {
    case 'uuid':
      return crypto.randomUUID();
    case 'epoch_ms':
      return String(Date.now());
    case 'epoch_s':
      return String(Math.floor(Date.now() / 1000));
    case 'iso8601':
      return new Date().toISOString();
    case 'nonce': {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    default:
      return null;
  }
}

/** Lookup a JSON path inside a parsed value. Segments may be:
 *   - an object key:            `reauth.mfaId`
 *   - a numeric array index:    `items[0]` (bracket) or `items.0` (dot)
 *   - a field-match predicate:  `challenges[type=push]`
 *     → the FIRST array element whose `element[field]` stringifies to the value.
 *  The predicate makes captures robust to non-deterministic array ordering — e.g.
 *  a 2FA endpoint that returns its SMS/email/push challenges in a varying order, so
 *  a fixed `challenges[0]` grabs the wrong one while `[type=push]` always selects
 *  the push one. A bracketed token that is neither a number nor a `key=value`
 *  predicate is treated as a literal object key. */
function jsonpath(root: unknown, path: string): unknown {
  const tokens: Array<
    | { kind: 'key'; v: string }
    | { kind: 'index'; v: number }
    | { kind: 'pred'; k: string; v: string }
  > = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ kind: 'key', v: m[1] });
    } else {
      const inner = m[2] ?? '';
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: 'index', v: Number.parseInt(inner, 10) });
      } else {
        const eq = inner.indexOf('=');
        if (eq >= 0)
          tokens.push({
            kind: 'pred',
            k: inner.slice(0, eq).trim(),
            v: inner.slice(eq + 1).trim(),
          });
        else tokens.push({ kind: 'key', v: inner });
      }
    }
  }
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.kind === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t.v];
    } else if (t.kind === 'pred') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find(
        (el) =>
          el != null &&
          typeof el === 'object' &&
          String((el as Record<string, unknown>)[t.k]) === t.v,
      );
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[t.v];
    } else {
      return undefined;
    }
  }
  return cur;
}

function evaluateLegacyExtract(req: WorkflowRequest, parsed: unknown): Record<string, unknown> {
  const aliases: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(req.extract ?? {})) {
    aliases[name] = jsonpath(parsed, path);
  }
  return aliases;
}

function collectStateCapabilities(workflow: Workflow): Map<string, StateCapability> {
  const out = new Map<string, StateCapability>();
  for (const c of workflow.bootstrap?.captures ?? []) out.set(c.name, c.capability);
  for (const req of workflow.requests) {
    for (const c of req.captures ?? []) out.set(c.name, c.capability);
  }
  return out;
}

function preflightStateDependencies(
  workflow: Workflow,
  initialState: Record<string, unknown>,
  stateCapabilities: Map<string, StateCapability>,
): RuntimeResult<void> {
  if (!workflowHasStateFeatures(workflow)) return { ok: true, value: undefined };

  const producers = new Map<string, number>();
  for (const c of workflow.bootstrap?.captures ?? []) producers.set(c.name, -1);
  workflow.requests.forEach((req, idx) => {
    for (const c of req.captures ?? []) producers.set(c.name, idx);
  });

  for (let i = 0; i < workflow.requests.length; i++) {
    const req = workflow.requests[i];
    if (!req) continue;
    const missingBeforeRequest = collectStatePlaceholders(req).filter((name) => {
      if (name in initialState) return false;
      const producer = producers.get(name);
      return producer === undefined || producer >= i;
    });
    if (missingBeforeRequest.length === 0) continue;
    const hasPriorUnsafe = workflow.requests.slice(0, i).some((r) => requestEffect(r) === 'unsafe');
    if (!hasPriorUnsafe) continue;

    const name = missingBeforeRequest[0];
    if (!name) continue;
    const capability = stateCapabilities.get(name) ?? 'unsupported';
    return missingState({
      name,
      source: 'state',
      capability,
      failure: producers.has(name) ? 'producer_unavailable' : 'unsupported_workflow',
      message: `Workflow needs state "${name}" before request ${i + 1}, but an earlier unsafe request would run before that state can be produced.`,
    });
  }

  return { ok: true, value: undefined };
}

function workflowHasStateFeatures(workflow: Workflow): boolean {
  return Boolean(
    workflow.bootstrap || workflow.requests.some((r) => r.effect || (r.captures?.length ?? 0) > 0),
  );
}

function requestEffect(req: WorkflowRequest): 'safe' | 'idempotent' | 'unsafe' {
  if (req.effect) return req.effect;
  const method = req.method.toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 'safe' : 'unsafe';
}

export function collectStatePlaceholders(req: WorkflowRequest): string[] {
  const templates = [req.url, ...Object.values(req.headers), req.body ?? ''];
  const names = new Set<string>();
  for (const template of templates) {
    for (const match of template.matchAll(PLACEHOLDER_RE)) {
      const expr = match[1];
      if (!expr) continue;
      const parsed = parsePlaceholderExpression(expr);
      if (parsed?.kind === 'state') names.add(parsed.name);
    }
  }
  return Array.from(names);
}

function evaluateRequestCaptures(
  captures: RequestCapture[],
  ctx: {
    parsed: unknown;
    text: string;
    headers: Headers;
    requestUrl: string;
    cookieJar: RuntimeCookieJar;
  },
): RuntimeResult<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const capture of captures) {
    let value: unknown;
    switch (capture.source) {
      case 'json':
        value = jsonpath(ctx.parsed, capture.path);
        break;
      case 'response_header':
        value = captureHeader(ctx.headers, capture.header, capture.mode);
        break;
      case 'text_regex': {
        const re = new RegExp(capture.pattern);
        const match = ctx.text.match(re);
        value = match?.[capture.group ?? 1];
        break;
      }
      case 'cookie': {
        const constraints: CookieLookupConstraints = {
          url: capture.url,
          domain: capture.domain,
          path: capture.path,
          sameSite: capture.sameSite,
          allowHttpOnlyProjection: capture.allowHttpOnlyProjection,
        };
        const lookup = ctx.cookieJar.lookup(
          capture.cookie,
          capture.url ?? ctx.requestUrl,
          constraints,
        );
        if (!lookup.ok) {
          if (capture.required === false) break;
          return missingState({
            name: capture.name,
            source: 'cookie',
            capability: capture.capability,
            failure:
              lookup.reason === 'ambiguous' ? 'ambiguous_cookie' : 'producer_ran_value_absent',
            message:
              lookup.reason === 'ambiguous'
                ? `Cookie capture "${capture.name}" is ambiguous; add url/domain/path constraints.`
                : lookup.reason === 'httponly'
                  ? `Cookie capture "${capture.name}" targets HttpOnly cookie "${capture.cookie}" without allowHttpOnlyProjection.`
                  : `Cookie capture "${capture.name}" did not find cookie "${capture.cookie}".`,
          });
        }
        value = lookup.cookie.value;
        break;
      }
    }

    if (value === undefined || value === null || value === '') {
      if (capture.required === false) continue;
      return missingState({
        name: capture.name,
        source: capture.source === 'cookie' ? 'cookie' : 'response',
        capability: capture.capability,
        failure: 'producer_ran_value_absent',
        message: `Required capture "${capture.name}" (${capture.source}) did not produce a value.`,
      });
    }
    values[capture.name] = value;
  }
  return { ok: true, value: values };
}

function captureHeader(
  headers: Headers,
  name: string,
  mode: 'first' | 'last' | 'all' = 'last',
): string | string[] | undefined {
  if (name.toLowerCase() === 'set-cookie') return undefined;
  const value = headers.get(name);
  if (value === null) return undefined;
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (mode === 'all') return values.length ? values : [value];
  if (mode === 'first') return values[0] ?? value;
  return values.at(-1) ?? value;
}

function missingState(input: {
  name: string;
  source: StateMissingItem['source'];
  capability: StateCapability;
  failure: StateMissingItem['failure'];
  message: string;
}): RuntimeResult<never> {
  return {
    ok: false,
    result: {
      ok: false,
      error: 'STATE_MISSING',
      message: input.message,
      missing: [
        {
          name: input.name,
          source: input.source,
          capability: input.capability,
          required: true,
          failure: input.failure,
          message: input.message,
        },
      ],
      remediation: remediationForCapability(input.capability),
    },
  };
}

function remediationForCapability(capability: StateCapability): string {
  switch (capability) {
    case 'browser_bootstrap':
      return 'Run through fetch-bootstrap, or add workflow.bootstrap so Imprint can mint browser state before API replay.';
    case 'stealth_bootstrap':
      return 'Run through stealth-fetch so Imprint can mint bot-defense/browser state before API replay.';
    case 'credential_required':
      return 'Provision credentials with `imprint credential set` or rerun `imprint login`.';
    case 'ordinary_http':
      return 'Check request captures and ordering; an earlier HTTP request was expected to produce this state.';
    case 'unsupported':
      return 'Regenerate or edit workflow.json; the workflow references state that no backend can produce.';
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
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
    // so a value containing `@` / `&` / `=` doesn't corrupt the body shape.
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
  const store = (await loadCredentialStore(site)) ?? { site, cookies: [], values: {}, storage: [] };
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
