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
  commitSiteAuthState,
  loadSiteCredentials,
  readSiteManifest,
  saveSiteCookies,
} from './credential-store.ts';
import { captureHeader, captureValueMatches, jsonpath } from './request-capture.ts';
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

/** Browser-only workflow operations supplied by cdp-replay. Keeping this
 *  transport generic lets pages mint coupled browser state through their own
 *  JavaScript without adding OAuth-provider or frontend-framework logic here. */
export interface BrowserNavigationTransport {
  navigate(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      waitUntil?: 'domcontentloaded' | 'load';
      timeoutMs?: number;
      pollIntervalMs?: number;
      urlIncludes?: string;
      cookie?: { name: string; domain?: string; path?: string };
    },
  ): Promise<Response>;
  snapshotCookies(): Promise<RuntimeCookie[]>;
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
  /** Top-level document navigation, available only on cdp-replay. */
  browser?: BrowserNavigationTransport;
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

  type TransformResult =
    | string
    | { url?: string; body?: string; headers?: Record<string, string>; skip?: boolean };
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
          if (transformResult.skip === true) continue;
          if (typeof transformResult.url === 'string') subbed.url = transformResult.url;
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

    let resp: Response;
    let responseAbortTimer: ReturnType<typeof setTimeout> | undefined;
    if (req.mode === 'navigate') {
      if (!opts.browser) {
        return {
          ok: false,
          error: 'BAD_RESPONSE',
          message: `Request ${i} requires top-level browser navigation; retry with cdp-replay.`,
        };
      }
      try {
        resp = await opts.browser.navigate(subbed.url, {
          ...req.navigation,
          method: subbed.method,
          headers: subbed.headers,
          body: subbed.body,
        });
        for (const cookie of await opts.browser.snapshotCookies()) cookieJar.setCookie(cookie);
        liveCredentials.cookies = cookieJar.toJSON();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'NETWORK', message: `Navigation ${i} failed: ${msg}` };
      }
    } else {
      const controller = new AbortController();
      responseAbortTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        resp = await fetchFn(subbed.url, {
          method: subbed.method,
          headers: subbed.headers,
          body: subbed.body,
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (err) {
        if (responseAbortTimer) clearTimeout(responseAbortTimer);
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
    }

    let text = '';
    let responseReadError: string | undefined;
    try {
      text = await resp.text();
    } catch (err) {
      responseReadError = err instanceof Error ? err.message : String(err);
    } finally {
      if (responseAbortTimer) clearTimeout(responseAbortTimer);
    }

    const bodyPreview = responseReadError
      ? `[response body unavailable: ${responseReadError}]`
      : text;

    if (resp.status === 401) {
      return {
        ok: false,
        error: 'AUTH_EXPIRED',
        message: `Request ${i} returned 401 — auth has likely expired: ${bodyPreview.slice(0, 300)}`,
        remediation: `Run \`imprint login ${opts.workflow.site}\` to refresh credentials.`,
      };
    }
    if (resp.status === 403) {
      // 403 = bot detection / geo / ToS / missing capability. The body
      // usually disambiguates — surface it rather than guessing.
      return {
        ok: false,
        error: 'FORBIDDEN',
        message: `Request ${i} returned 403: ${bodyPreview.slice(0, 300)}`,
        remediation: `Common causes: bot detection (Akamai/Cloudflare/DataDome), geo-block, expired credential, or ToS violation. Inspect the response body above; if it looks like bot detection, the captured workflow can't replay against this site without a real browser. If it's auth, try \`imprint login ${opts.workflow.site}\`.`,
      };
    }
    if (resp.status === 429) {
      return {
        ok: false,
        error: 'RATE_LIMITED',
        message: `Request ${i} returned 429: ${bodyPreview.slice(0, 300)}`,
        remediation: 'Back off and retry after the Retry-After interval.',
      };
    }
    if (resp.status >= 400) {
      return {
        ok: false,
        error: 'BAD_RESPONSE',
        message: `Request ${i} (${subbed.method} ${subbed.url}) returned ${resp.status}: ${bodyPreview.slice(0, 500)}`,
      };
    }
    if (responseReadError) {
      const timedOut =
        responseReadError.includes('aborted') || responseReadError.includes('AbortError');
      return {
        ok: false,
        error: 'NETWORK',
        message: timedOut
          ? `Request ${i} timed out after ${timeoutMs}ms`
          : `Response ${i} could not be read: ${responseReadError}`,
        remediation: timedOut
          ? 'Retry, or increase the timeout if the endpoint is slow.'
          : undefined,
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
  const authConfig = opts.workflow.authConfig;
  const params = { ...opts.params };
  for (const parameter of opts.workflow.parameters) {
    if (!(parameter.name in params) && parameter.default !== undefined) {
      params[parameter.name] = parameter.default;
    }
  }
  const actionName = String(params.action ?? authConfig?.entry ?? '');
  const action = authConfig?.actions[actionName];
  if (!authConfig || !action) {
    return {
      ok: false,
      error: 'UNKNOWN',
      message: `Unknown auth action ${JSON.stringify(actionName)}. Available actions: ${Object.keys(
        authConfig?.actions ?? {},
      ).join(', ')}`,
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  const credentials =
    opts.credentials ??
    (await loadCredentialStore(opts.workflow.site)) ??
    emptyStore(opts.workflow.site);
  const cookieJar = new RuntimeCookieJar(credentials.cookies);
  const liveCredentials: CredentialStore = { ...credentials, cookies: cookieJar.toJSON() };
  const responseSlots: ResponseSlot[] = [];
  const initialState: Record<string, unknown> = { ...(opts.initialState ?? {}) };
  const state: Record<string, unknown> = { ...initialState };
  const stateCapabilities = collectStateCapabilities(opts.workflow);
  const missingParameters = action.parameters.filter((name) => !(name in params));
  if (missingParameters.length > 0) {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: `Auth action ${JSON.stringify(actionName)} requires: ${missingParameters.join(', ')}.`,
    };
  }
  let requestTransform:
    | ((
        method: string,
        url: string,
        responses: unknown[],
        params?: Record<string, string | number | boolean>,
      ) =>
        | string
        | { url?: string; body?: string; headers?: Record<string, string>; skip?: boolean })
    | undefined;
  if (opts.workflow.requestTransformModule && opts.workflowPath) {
    try {
      const mod = await import(
        pathResolve(dirname(opts.workflowPath), opts.workflow.requestTransformModule)
      );
      if (typeof mod.transform === 'function') requestTransform = mod.transform;
    } catch {
      // A missing transform is surfaced by the request that depended on it.
    }
  }

  type ResponseContext = {
    parsed: unknown;
    text: string;
    headers: Headers;
    requestUrl: string;
  };
  let lastResponse: ResponseContext | undefined;

  const fail = (result: RuntimeErrorResult): RuntimeErrorResult => {
    return {
      ...result,
      continuation: Object.keys(initialState).length > 0 ? initialState : undefined,
    };
  };

  const persistenceFailure = (material: string, err: unknown): RuntimeErrorResult =>
    fail({
      ok: false,
      error: 'BAD_RESPONSE',
      message: `Auth action ${JSON.stringify(actionName)} could not persist ${material}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });

  const persistCookies = async (): Promise<RuntimeErrorResult | undefined> => {
    try {
      await saveSiteCookies(opts.workflow.site, cookieJar.toJSON());
      return undefined;
    } catch (err) {
      return persistenceFailure('session cookies', err);
    }
  };

  const executeRequest = async (
    requestIndex: number,
  ): Promise<RuntimeResult<ResponseContext | undefined>> => {
    const req = opts.workflow.requests[requestIndex];
    if (!req) {
      return {
        ok: false,
        result: {
          ok: false,
          error: 'BAD_RESPONSE',
          message: `Auth action ${JSON.stringify(actionName)} references missing request ${requestIndex}.`,
        },
      };
    }

    const substituted = substituteRequest(req, {
      params,
      credentials: liveCredentials,
      responseSlots,
      state,
      cookieJar,
      stateCapabilities,
      requestUrlTemplate: req.url,
    });
    if (!substituted.ok) return substituted;
    const request = substituted.value;

    if (requestTransform) {
      try {
        const transformed = requestTransform(
          request.method,
          request.url,
          responseSlots.map((slot) => slot.raw),
          params,
        );
        if (typeof transformed === 'string') request.url = transformed;
        else if (transformed) {
          if (transformed.skip) return { ok: true, value: undefined };
          if (transformed.url !== undefined) request.url = transformed.url;
          if (transformed.body !== undefined) request.body = transformed.body;
          if (transformed.headers) Object.assign(request.headers, transformed.headers);
        }
      } catch (err) {
        return {
          ok: false,
          result: {
            ok: false,
            error: 'BAD_RESPONSE',
            message: `request transform failed for request ${requestIndex}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }
    }

    const cookieHeader = cookieJar.getCookieHeader(request.url);
    if (cookieHeader && !hasHeader(request.headers, 'cookie'))
      request.headers.cookie = cookieHeader;

    let response: Response;
    let responseAbortTimer: ReturnType<typeof setTimeout> | undefined;
    if (req.mode === 'navigate') {
      if (!opts.browser) {
        return {
          ok: false,
          result: {
            ok: false,
            error: 'BAD_RESPONSE',
            message: `Request ${requestIndex} requires a browser navigation transport.`,
          },
        };
      }
      try {
        response = await opts.browser.navigate(request.url, {
          ...req.navigation,
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        for (const cookie of await opts.browser.snapshotCookies()) cookieJar.setCookie(cookie);
      } catch (err) {
        return {
          ok: false,
          result: {
            ok: false,
            error: 'NETWORK',
            message: `Navigation ${requestIndex} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }
    } else {
      const controller = new AbortController();
      responseAbortTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (err) {
        if (responseAbortTimer) clearTimeout(responseAbortTimer);
        return {
          ok: false,
          result: {
            ok: false,
            error: 'NETWORK',
            message: `Auth request ${requestIndex} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }
    }

    let text = '';
    let responseReadError: string | undefined;
    try {
      text = await response.text();
    } catch (err) {
      responseReadError = err instanceof Error ? err.message : String(err);
    } finally {
      if (responseAbortTimer) clearTimeout(responseAbortTimer);
    }
    if (response.status >= 400) {
      const bodyPreview = responseReadError
        ? `[response body unavailable: ${responseReadError}]`
        : text;
      return {
        ok: false,
        result: {
          ok: false,
          error: response.status === 401 ? 'AUTH_EXPIRED' : 'BAD_RESPONSE',
          message: `Auth request ${requestIndex} (${request.method} ${request.url}) returned ${response.status}: ${bodyPreview.slice(0, 500)}`,
          status: response.status,
          responseBodyPreview: bodyPreview.slice(0, 500),
        },
      };
    }
    if (responseReadError) {
      return {
        ok: false,
        result: {
          ok: false,
          error: 'NETWORK',
          message: `Auth response ${requestIndex} could not be read: ${responseReadError}`,
        },
      };
    }

    for (const header of extractSetCookieHeaders(response.headers)) {
      cookieJar.setCookieFromHeader(header, request.url);
    }
    liveCredentials.cookies = cookieJar.toJSON();

    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the raw body for text captures.
    }
    const context = { parsed, text, headers: response.headers, requestUrl: request.url };
    responseSlots.push({ raw: parsed, aliases: evaluateLegacyExtract(req, parsed) });
    const captures = evaluateRequestCaptures(req.captures ?? [], {
      ...context,
      cookieJar,
    });
    if (!captures.ok) {
      return {
        ok: false,
        result: {
          ...captures.result,
          status: response.status,
          responseBodyPreview: text.slice(0, 500),
        },
      };
    }
    Object.assign(state, captures.value);
    lastResponse = context;
    return { ok: true, value: context };
  };

  for (let stepIndex = 0; stepIndex < action.steps.length; stepIndex++) {
    const step = action.steps[stepIndex];
    if (!step) continue;
    let matched = !step.repeat;

    for (let attempt = 0; attempt < (step.repeat?.maxAttempts ?? 1); attempt++) {
      if (attempt > 0 && step.repeat) await sleep(step.repeat.intervalMs);
      const executed = await executeRequest(step.request);
      if (!executed.ok) {
        if (step.onError === 'continue') {
          matched = true;
          break;
        }
        if (step.onError === 'retry' && step.repeat) continue;
        return fail(executed.result);
      }
      if (!step.repeat) break;
      if (!executed.value) continue;

      const until = evaluateRequestCaptures(
        [{ ...step.repeat.until, required: false } as RequestCapture],
        { ...executed.value, cookieJar },
      );
      if (until.ok && Object.hasOwn(until.value, step.repeat.until.name)) {
        Object.assign(state, until.value);
        matched = true;
        break;
      }
    }

    if (!matched) {
      return fail({
        ok: false,
        error: 'BAD_RESPONSE',
        message: `Auth action ${JSON.stringify(actionName)} did not satisfy the declared repeat condition for request ${step.request} after ${step.repeat?.maxAttempts ?? 1} attempts.`,
      });
    }
  }

  const missingEvidence = action.outcome.evidence.filter((name) => !Object.hasOwn(state, name));
  if (missingEvidence.length > 0) {
    return fail({
      ok: false,
      error: 'BAD_RESPONSE',
      message: `Auth action ${JSON.stringify(actionName)} completed without declared evidence: ${missingEvidence.join(', ')}.`,
    });
  }

  if (action.outcome.type === 'pause') {
    const missingCarry = action.outcome.carry.filter((name) => !Object.hasOwn(state, name));
    if (missingCarry.length > 0) {
      return fail({
        ok: false,
        error: 'BAD_RESPONSE',
        message: `Auth action ${JSON.stringify(actionName)} completed without declared carry state: ${missingCarry.join(', ')}.`,
      });
    }
    const continuation = Object.fromEntries(
      action.outcome.carry.map((name) => [name, state[name]]),
    );
    const cookieFailure = await persistCookies();
    if (cookieFailure && !opts.browser) return cookieFailure;
    const persistenceWarning = cookieFailure
      ? ` ${cookieFailure.message} Continue in the current browser session.`
      : '';
    return {
      ok: false,
      error: 'ACTION_REQUIRED',
      message: `${action.outcome.message}${persistenceWarning}`,
      nextAction: action.outcome.next,
      continuation,
      responseBodyPreview: lastResponse?.text.slice(0, 500),
    };
  }

  const missingPersisted = authConfig.persist.filter((name) => !Object.hasOwn(state, name));
  if (missingPersisted.length > 0) {
    return fail({
      ok: false,
      error: 'BAD_RESPONSE',
      message: `Auth action ${JSON.stringify(actionName)} completed without declared persisted state: ${missingPersisted.join(', ')}.`,
    });
  }
  const persistedSecrets: Record<string, string> = {};
  for (const name of authConfig.persist) {
    const value = state[name];
    if (value !== undefined && value !== null && String(value) !== '') {
      persistedSecrets[name] = String(value);
    }
  }
  try {
    await commitSiteAuthState(opts.workflow.site, cookieJar.toJSON(), persistedSecrets);
  } catch (err) {
    return persistenceFailure('authenticated session state', err);
  }
  return { ok: true, data: { authenticated: true } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    if (!captureValueMatches(value, capture.equals)) {
      if (capture.required === false) continue;
      return missingState({
        name: capture.name,
        source: capture.source === 'cookie' ? 'cookie' : 'response',
        capability: capture.capability,
        failure: 'producer_ran_value_absent',
        message:
          capture.equals === undefined
            ? `Required capture "${capture.name}" (${capture.source}) did not produce a value.`
            : `Required capture "${capture.name}" (${capture.source}) did not produce the expected value.`,
      });
    }
    values[capture.name] = value;
  }
  return { ok: true, value: values };
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
