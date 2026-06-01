/**
 * Walk a list of backends in order, escalating on FORBIDDEN and satisfiable
 * STATE_MISSING; other errors return immediately. fetch-bootstrap is a gated
 * API-replay adapter, not a default DOM fallback rung: auto only reaches it
 * for workflows that declare bootstrap/captures or STATE_MISSING says browser
 * bootstrap can satisfy the missing state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import type { Page } from 'playwright';
import { RuntimeCookieJar } from './cookie-jar.ts';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import {
  type CredentialStore,
  executeWorkflow,
  loadCredentialStore,
  substituteString,
} from './runtime.ts';
import { getStealthChromium } from './stealth-chromium.ts';
import {
  type BootstrapArgs,
  type StealthFetch,
  type TokenCache,
  bootstrapStealthToken,
  createStealthFetch,
} from './stealth-fetch.ts';
import { loadCachedToken, saveCachedToken } from './stealth-token-cache.ts';
import type { ResolvedTool } from './tool-loader.ts';
import {
  type BootstrapCapture,
  type ConcreteBackend,
  type ReplayBackend,
  type StateCapability,
  type StateMissingItem,
  type ToolResult,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

interface LadderResult {
  result: ToolResult;
  usedBackend: ConcreteBackend;
  /** One entry per rung that was tried. */
  attempts: Array<{
    backend: ConcreteBackend;
    outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
    detail: string;
    durationMs: number;
  }>;
}

const log = createLog('backend');

const DEFAULT_LADDER: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];

/** Freshness window for the file-backed compile-time stealth token. Matches
 *  stealth-fetch's in-process `maxTokenAgeSeconds` default so a reused token is
 *  not immediately considered stale by `createStealthFetch`. */
const STEALTH_TOKEN_MAX_AGE_SECONDS = 600;

/** Expand a replayBackend choice into a concrete ladder. 'auto' prefers
 *  the probed order (if any), else the default. Explicit choice → single rung. */
export function resolveLadder(
  backend: ReplayBackend,
  cachedPreferredOrder?: ConcreteBackend[],
): ConcreteBackend[] {
  if (backend === 'auto') {
    return cachedPreferredOrder && cachedPreferredOrder.length > 0
      ? cachedPreferredOrder
      : DEFAULT_LADDER;
  }
  return [backend];
}

/** First non-FORBIDDEN result wins; last FORBIDDEN returned if every rung escalates. */
export async function runWithLadder(
  ladder: ConcreteBackend[],
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
  assetRoot: string,
  stealthCache: Map<string, StealthFetch>,
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const effectiveLadder = effectiveAutoLadder(ladder, tool.workflow);
  const attempts: LadderResult['attempts'] = [];
  let lastResult: ToolResult | null = null;
  let skipUntilBackend: ConcreteBackend | null = null;

  for (const backend of effectiveLadder) {
    if (skipUntilBackend && backend !== skipUntilBackend) continue;
    if (skipUntilBackend === backend) skipUntilBackend = null;

    if (backend === 'playbook' && !existsSync(playbookPath(assetRoot, tool.site, tool.dir))) {
      attempts.push({
        backend,
        outcome: 'unavailable',
        detail: 'no playbook.yaml',
        durationMs: 0,
      });
      log(`${backend}: skipped (prerequisite missing)`);
      continue;
    }

    const t0 = Date.now();
    log(`trying ${backend}…`);
    let result: ToolResult;
    try {
      switch (backend) {
        case 'fetch':
          result = await tool.toolFn(params);
          break;
        case 'fetch-bootstrap':
          result = await runFetchBootstrap(tool, params);
          break;
        case 'stealth-fetch': {
          const sf = ensureStealthFetch(tool, stealthCache);
          result = await tool.toolFn(params, { fetchImpl: sf.fetchImpl });
          break;
        }
        case 'playbook':
          result = await runPlaybook({
            playbook: playbookPath(assetRoot, tool.site, tool.dir),
            params,
            site: tool.site,
          });
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: 'UNKNOWN', message: `${backend} threw: ${msg}` };
    }
    const durationMs = Date.now() - t0;
    lastResult = result;

    if (result.ok) {
      attempts.push({ backend, outcome: 'ok', detail: `succeeded in ${durationMs}ms`, durationMs });
      log(`${backend}: OK in ${durationMs}ms`);
      return { result, usedBackend: backend, attempts };
    }

    if (result.error === 'FORBIDDEN') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(`${backend}: FORBIDDEN in ${durationMs}ms — escalating`);
      continue;
    }

    if (result.error === 'STATE_MISSING') {
      const next = nextStateMissingBackend(effectiveLadder, backend, result.missing ?? []);
      if (next) {
        attempts.push({
          backend,
          outcome: 'escalate',
          detail: `${result.error}: ${result.message.slice(0, 120)}`,
          durationMs,
        });
        log(`${backend}: STATE_MISSING in ${durationMs}ms — escalating to ${next}`);
        skipUntilBackend = next;
        continue;
      }
    }

    // NETWORK escalates: a long timeout is usually anti-bot tarpitting
    // (Akamai/Cloudflare/PerimeterX hang the connection rather than 403),
    // and a different transport (stealth-fetch's minted token cookies, or
    // playbook's full stealth browser) can fix it. Real DNS/connectivity
    // failures die in milliseconds at every rung, so the cost ceiling is
    // bounded by the per-rung timeout × ladder length.
    if (result.error === 'NETWORK') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(`${backend}: NETWORK in ${durationMs}ms — escalating to next rung`);
      continue;
    }

    // AUTH_EXPIRED needs a re-login; RATE_LIMITED needs backoff. Neither
    // is fixed by switching transport.
    attempts.push({
      backend,
      outcome: 'failed',
      detail: `${result.error}: ${result.message.slice(0, 120)}`,
      durationMs,
    });
    log(`${backend}: ${result.error} in ${durationMs}ms — non-escalatable, returning`);
    return { result, usedBackend: backend, attempts };
  }

  // Every backend either escalated (FORBIDDEN) or was unavailable.
  if (!lastResult) {
    return {
      result: {
        ok: false,
        error: 'UNKNOWN',
        message: `Every backend in the ladder was unavailable: ${effectiveLadder.join(', ')}. For "auto" mode, ensure at least workflow.json exists; for the playbook rung, run \`imprint compile-playbook\` first.`,
      },
      usedBackend: effectiveLadder[effectiveLadder.length - 1] ?? 'fetch',
      attempts,
    };
  }
  log(
    `every backend escalated; returning last error from ${effectiveLadder[effectiveLadder.length - 1]}`,
  );
  return {
    result: lastResult,
    usedBackend: effectiveLadder[effectiveLadder.length - 1] ?? 'fetch',
    attempts,
  };
}

function effectiveAutoLadder(ladder: ConcreteBackend[], workflow: Workflow): ConcreteBackend[] {
  if (ladder.length <= 1 || ladder.includes('fetch-bootstrap')) return ladder;
  if (!workflowNeedsBootstrap(workflow)) return ladder;
  const fetchIdx = ladder.indexOf('fetch');
  if (fetchIdx === -1) return ladder;
  const next = [...ladder];
  next.splice(fetchIdx + 1, 0, 'fetch-bootstrap');
  return next;
}

function workflowNeedsBootstrap(workflow: Workflow): boolean {
  if (workflow.bootstrap) return true;
  return workflow.requests.some((r) =>
    (r.captures ?? []).some(
      (c) => c.capability === 'browser_bootstrap' || c.capability === 'stealth_bootstrap',
    ),
  );
}

function nextStateMissingBackend(
  ladder: ConcreteBackend[],
  backend: ConcreteBackend,
  missing: StateMissingItem[],
): ConcreteBackend | null {
  const idx = ladder.indexOf(backend);
  if (idx < 0) return null;
  for (const next of ladder.slice(idx + 1)) {
    if (stateMissingSatisfiableBy(next, missing)) return next;
  }
  return null;
}

function stateMissingSatisfiableBy(backend: ConcreteBackend, missing: StateMissingItem[]): boolean {
  const required = missing.filter((m) => m.required !== false);
  if (required.length === 0) return false;
  return required.every((m) => capabilitySatisfiedBy(backend, m.capability));
}

function capabilitySatisfiedBy(backend: ConcreteBackend, capability: StateCapability): boolean {
  if (backend === 'fetch-bootstrap') {
    return capability === 'browser_bootstrap' || capability === 'stealth_bootstrap';
  }
  if (backend === 'stealth-fetch') return false;
  if (backend === 'playbook') {
    return (
      capability === 'ordinary_http' ||
      capability === 'browser_bootstrap' ||
      capability === 'stealth_bootstrap'
    );
  }
  return false;
}

async function runFetchBootstrap(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
): Promise<ToolResult> {
  if (!tool.workflow.bootstrap) {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'fetch-bootstrap requires workflow.bootstrap metadata.',
      missing: [
        {
          name: 'workflow.bootstrap',
          source: 'workflow',
          capability: 'browser_bootstrap',
          required: true,
          failure: 'producer_unavailable',
          message: 'workflow.bootstrap is missing',
        },
      ],
      remediation: 'Regenerate or edit workflow.json with bootstrap metadata.',
    };
  }

  const credentials = (await loadCredentialStore(tool.site)) ?? {
    site: tool.site,
    cookies: [],
    values: {},
    storage: [],
  };
  const bootstrapUrl = substituteString(tool.workflow.bootstrap.url, params, credentials, []);
  const initialState: Record<string, unknown> = {};
  // Stealth-patched chromium so anti-bot services (Akamai, Cloudflare,
  // PerimeterX) don't tarpit the bootstrap navigation. Vanilla headless
  // Playwright leaks `navigator.webdriver` and other telltales and dies
  // with a 30s NETWORK timeout against any decent enterprise site.
  const chromium = await getStealthChromium();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    if (credentials.cookies.length > 0) {
      await context.addCookies(
        credentials.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.hostOnly ? undefined : c.domain,
          url: c.hostOnly ? cookieUrlFor(c, bootstrapUrl) : undefined,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: sameSiteForPlaywright(c.sameSite),
        })),
      );
    }
    if ((credentials.storage ?? []).length > 0) {
      await context.addInitScript((records) => {
        const browserGlobal = globalThis as unknown as {
          location: { origin: string };
          localStorage: { setItem(key: string, value: string): void };
        };
        for (const record of records as Array<{
          origin: string;
          kind: 'localStorage' | 'sessionStorage';
          key: string;
          value: string;
        }>) {
          if (record.kind !== 'localStorage') continue;
          if (browserGlobal.location.origin !== record.origin) continue;
          browserGlobal.localStorage.setItem(record.key, record.value);
        }
      }, credentials.storage ?? []);
    }
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    const navResponse = await page.goto(bootstrapUrl, {
      waitUntil: tool.workflow.bootstrap.waitUntil ?? 'domcontentloaded',
      timeout: tool.workflow.bootstrap.timeoutMs ?? 30_000,
    });
    if (tool.workflow.bootstrap.waitMs) await page.waitForTimeout(tool.workflow.bootstrap.waitMs);

    const html = await page.content();
    // Lower-case the bootstrap response's headers so `response_header`
    // captures can look up by case-insensitive name. `allHeaders()` already
    // returns lowercase keys per the HTTP/2 spec Playwright follows, but
    // we normalize defensively in case the navigation returned null
    // (`page.goto` returns null for some same-document navigations).
    const responseHeaders: Record<string, string> = {};
    if (navResponse) {
      try {
        const raw = await navResponse.allHeaders();
        for (const [k, v] of Object.entries(raw)) responseHeaders[k.toLowerCase()] = v;
      } catch {
        // best-effort — non-fatal; response_header captures will simply miss.
      }
    }
    for (const capture of tool.workflow.bootstrap.captures ?? []) {
      let value: unknown;
      try {
        value = await evaluateBootstrapCapture(capture, page, html, responseHeaders);
      } catch (err) {
        if (capture.required === false) continue;
        return bootstrapCaptureMissingResult(
          capture,
          `Bootstrap capture "${capture.name}" (${capture.source}) failed: ${err instanceof Error ? err.message : String(err)}`,
          'producer_ran_value_absent',
        );
      }
      if (value !== undefined && value !== null && value !== '') {
        initialState[capture.name] = value;
      } else if (capture.required !== false && capture.source !== 'cookie') {
        return bootstrapCaptureMissingResult(
          capture,
          `Required bootstrap capture "${capture.name}" (${capture.source}) did not produce a value.`,
          'producer_ran_value_absent',
        );
      }
    }

    const cookies = await context.cookies();
    const bootstrappedCredentials: CredentialStore = {
      ...credentials,
      cookies: [
        ...credentials.cookies,
        ...cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          hostOnly: !c.domain.startsWith('.'),
        })),
      ],
    };
    const jar = new RuntimeCookieJar(bootstrappedCredentials.cookies);
    for (const capture of tool.workflow.bootstrap.captures ?? []) {
      if (capture.source !== 'cookie') continue;
      const lookup = jar.lookup(capture.cookie, capture.url ?? bootstrapUrl, {
        url: capture.url,
        domain: capture.domain,
        path: capture.path,
        sameSite: capture.sameSite,
        allowHttpOnlyProjection: capture.allowHttpOnlyProjection,
      });
      if (lookup.ok) initialState[capture.name] = lookup.cookie.value;
      else if (capture.required !== false) {
        return bootstrapCaptureMissingResult(
          capture,
          lookup.reason === 'ambiguous'
            ? `Bootstrap cookie capture "${capture.name}" is ambiguous; add url/domain/path constraints.`
            : lookup.reason === 'httponly'
              ? `Bootstrap cookie capture "${capture.name}" targets HttpOnly cookie "${capture.cookie}" without allowHttpOnlyProjection.`
              : `Bootstrap cookie capture "${capture.name}" did not find cookie "${capture.cookie}".`,
          lookup.reason === 'ambiguous' ? 'ambiguous_cookie' : 'producer_ran_value_absent',
        );
      }
    }
    return await tool.toolFn(params, {
      credentials: bootstrappedCredentials,
      initialState,
    });
  } catch (err) {
    const stateMissing = bootstrapFailureStateMissingResult(
      tool.workflow,
      `fetch-bootstrap could not produce required bootstrap state: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (stateMissing) return stateMissing;
    return {
      ok: false,
      error: 'NETWORK',
      message: `fetch-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function bootstrapFailureStateMissingResult(
  workflow: Workflow,
  message: string,
): ToolResult | null {
  const captures = (workflow.bootstrap?.captures ?? []).filter(
    (capture) => capture.required !== false,
  );
  if (captures.length === 0) return null;
  return {
    ok: false,
    error: 'STATE_MISSING',
    message,
    missing: captures.map((capture) =>
      bootstrapMissingItem(capture, message, 'producer_unavailable'),
    ),
    remediation: remediationForBootstrapCapabilities(captures.map((capture) => capture.capability)),
  };
}

function bootstrapCaptureMissingResult(
  capture: BootstrapCapture,
  message: string,
  failure: StateMissingItem['failure'],
): ToolResult {
  return {
    ok: false,
    error: 'STATE_MISSING',
    message,
    missing: [bootstrapMissingItem(capture, message, failure)],
    remediation: remediationForBootstrapCapabilities([capture.capability]),
  };
}

function bootstrapMissingItem(
  capture: BootstrapCapture,
  message: string,
  failure: StateMissingItem['failure'],
): StateMissingItem {
  return {
    name: capture.name,
    source: bootstrapCaptureSource(capture),
    capability: capture.capability,
    required: true,
    failure,
    message,
  };
}

function bootstrapCaptureSource(capture: BootstrapCapture): StateMissingItem['source'] {
  if (capture.source === 'cookie') return 'cookie';
  if (capture.source === 'local_storage' || capture.source === 'session_storage') return 'storage';
  return 'state';
}

function remediationForBootstrapCapabilities(capabilities: StateCapability[]): string {
  return capabilities.includes('stealth_bootstrap')
    ? 'Use replayBackend: "auto" so Imprint can try fetch-bootstrap and then the playbook fallback when API replay cannot mint bot-defense/browser state.'
    : 'Run through fetch-bootstrap, or update workflow.bootstrap so Imprint can mint browser state before API replay.';
}

// Exported for tests so the per-source logic (regex, DOM, storage, header)
// can be unit-asserted without launching real Chromium. Internal callers
// use it the same way; the export is just a visibility relaxation.
export async function evaluateBootstrapCapture(
  capture: BootstrapCapture,
  page: Page,
  html: string,
  responseHeaders: Record<string, string>,
): Promise<unknown> {
  switch (capture.source) {
    case 'response_header': {
      const raw = responseHeaders[capture.header.toLowerCase()];
      if (raw === undefined) return undefined;
      // Playwright's `allHeaders()` joins multi-valued headers with ", ".
      // Most uses (CSRF, single-valued anti-replay tokens) want the whole
      // string; mode 'first'/'last' splits when the value actually carries
      // a comma-list. Keep the default conservative: return raw.
      if (capture.mode === 'first' || capture.mode === 'last') {
        const parts = raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 0) return undefined;
        return capture.mode === 'first' ? parts[0] : parts[parts.length - 1];
      }
      return raw;
    }
    case 'html_regex': {
      const match = html.match(new RegExp(capture.pattern));
      return match?.[capture.group ?? 1];
    }
    case 'dom_attribute':
      return await page
        .locator(capture.selector)
        .first()
        .getAttribute(capture.attribute, { timeout: capture.timeoutMs ?? 5000 });
    case 'dom_text':
      return await page
        .locator(capture.selector)
        .first()
        .textContent({ timeout: capture.timeoutMs ?? 5000 });
    case 'local_storage':
      return await page.evaluate(
        ({ origin, key }) => {
          const browserGlobal = globalThis as unknown as {
            location: { origin: string };
            localStorage: { getItem(key: string): string | null };
          };
          return browserGlobal.location.origin === origin
            ? browserGlobal.localStorage.getItem(key)
            : null;
        },
        { origin: capture.origin, key: capture.key },
      );
    case 'session_storage':
      return await page.evaluate(
        ({ origin, key }) => {
          const browserGlobal = globalThis as unknown as {
            location: { origin: string };
            sessionStorage: { getItem(key: string): string | null };
          };
          return browserGlobal.location.origin === origin
            ? browserGlobal.sessionStorage.getItem(key)
            : null;
        },
        { origin: capture.origin, key: capture.key },
      );
    case 'cookie':
      return undefined;
  }
}

function sameSiteForPlaywright(
  sameSite: string | undefined,
): 'Strict' | 'Lax' | 'None' | undefined {
  if (!sameSite) return undefined;
  const lower = sameSite.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'lax') return 'Lax';
  if (lower === 'none') return 'None';
  return undefined;
}

function cookieUrlFor(cookie: { domain: string; secure?: boolean }, fallback: string): string {
  try {
    const u = new URL(fallback);
    u.hostname = cookie.domain.replace(/^\./, '');
    u.protocol = cookie.secure ? 'https:' : u.protocol;
    return u.toString();
  } catch {
    return `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}/`;
  }
}

/** Per-site stealth fetcher; bootstrap pays its ~12s once per process. */
function ensureStealthFetch(tool: ResolvedTool, cache: Map<string, StealthFetch>): StealthFetch {
  const cached = cache.get(tool.site);
  if (cached) return cached;
  const sf = createStealthFetch({ baseUrl: pickBaseUrl(tool) });
  cache.set(tool.site, sf);
  return sf;
}

/** First request URL's origin — Akamai binds sensor tokens to that
 *  origin, and the origin is always literal (substitutions only appear
 *  after the domain in well-formed workflows). */
function pickBaseUrl(tool: ResolvedTool): string {
  const firstRequest = tool.workflow.requests[0];
  if (!firstRequest) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — stealth-fetch needs at least one request URL.\n→ re-record the session; recording probably stopped before any XHR fired.`,
    );
  }
  const m = firstRequest.url.match(/^(https?:\/\/[^/]+)/);
  if (m?.[1]) return m[1];
  throw new Error(
    `Could not derive bootstrap origin from URL: ${firstRequest.url}\n→ check workflow.json — the first request URL must start with https://<domain>.`,
  );
}

function playbookPath(assetRoot: string, site: string, toolDir?: string): string {
  if (toolDir) return pathResolve(toolDir, 'playbook.yaml');
  return pathResolve(assetRoot, site, 'playbook.yaml');
}

/**
 * Compile-time integration-test convenience: dispatch a request through
 * `runWithLadder` using only a `workflow.json` path. Avoids requiring an
 * emitted `index.ts` (which doesn't exist when integration.test.ts runs
 * during compile, before `imprint emit`).
 *
 * **Ladder is intentionally fixed to `['fetch', 'stealth-fetch']`** —
 * the playbook rung is excluded because `playbook.yaml` is compiled in
 * a separate later step (`imprint compile-playbook`), so at integration-
 * test time there is no playbook to fall back to. Even if a stale
 * playbook from a prior compile exists on disk, exercising it here would
 * conflate two independent verification surfaces and pull a slow
 * Playwright bootstrap into every test run.
 *
 * Credentials are loaded by `executeWorkflow` from the credential store
 * for the workflow's `site` by default; pass `credentials` explicitly to
 * override (e.g., when a test wants to assert behavior under a known
 * credential state).
 *
 * The test "passes" as long as ANY backend in the ladder returns ok —
 * fetch OR stealth-fetch. Tools whose fetch path will be blocked at
 * runtime are still verified end-to-end via stealth-fetch.
 */
export async function runWorkflowWithLadder(opts: {
  workflowPath: string;
  params: Record<string, string | number | boolean>;
  /** Optional credential override; otherwise loaded from the credential
   *  store by executeWorkflow. */
  credentials?: CredentialStore;
}): Promise<LadderResult> {
  if (!existsSync(opts.workflowPath)) {
    throw new Error(`runWorkflowWithLadder: workflow.json not found at ${opts.workflowPath}`);
  }
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowPath, 'utf8')));
  const toolDir = dirname(opts.workflowPath);
  // assetRoot only matters for playbook-rung path resolution, which this
  // ladder skips. Use a conventional value for completeness.
  const assetRoot = pathResolve(toolDir, '..', '..');

  const tool: ResolvedTool = {
    site: workflow.site ?? '',
    dir: toolDir,
    workflow,
    toolFn: async (params, fnOpts) => {
      const fetchImpl =
        (fnOpts as { fetchImpl?: typeof fetch } | undefined)?.fetchImpl ?? undefined;
      return executeWorkflow({
        workflow,
        params: params as Record<string, string | number | boolean>,
        credentials: opts.credentials,
        workflowPath: opts.workflowPath,
        fetchImpl,
      });
    },
  };

  const ladder: ConcreteBackend[] = ['fetch', 'stealth-fetch'];

  // Share one stealth token across this site's compile-time test processes.
  // Each `bun test` is a fresh process and would otherwise mint a new ~12s
  // headless bootstrap; the resulting burst against one origin trips anti-bot
  // and forces the integration test to be waived. Pre-seed the ladder's stealth
  // cache with a fetcher whose bootstrap is file-backed (keyed by the site asset
  // dir). On any failure to derive a base URL, fall back to the default lazy
  // bootstrap inside runWithLadder.
  const stealthCache = new Map<string, StealthFetch>();
  try {
    const siteDir = pathResolve(toolDir, '..');
    const baseUrl = pickBaseUrl(tool);
    const cachingBootstrap = async (args: BootstrapArgs): Promise<TokenCache> => {
      const cached = loadCachedToken(siteDir, STEALTH_TOKEN_MAX_AGE_SECONDS);
      if (cached) {
        log(`reusing cached stealth token for ${tool.site || siteDir}`);
        return cached;
      }
      const token = await bootstrapStealthToken(args);
      saveCachedToken(siteDir, token);
      return token;
    };
    stealthCache.set(tool.site, createStealthFetch({ baseUrl }, { bootstrap: cachingBootstrap }));
  } catch {
    // No usable base URL → leave the cache empty; runWithLadder/ensureStealthFetch
    // will lazily bootstrap (same behavior as before this optimization).
  }

  return runWithLadder(ladder, tool, opts.params, assetRoot, stealthCache);
}
