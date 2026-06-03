/**
 * Walk a list of backends in order, escalating on FORBIDDEN, NETWORK (tarpit),
 * and satisfiable STATE_MISSING; other errors return immediately.
 *
 * Rung tiers:
 *  - `fetch`           — plain HTTP API replay.
 *  - `fetch-bootstrap` — the API ANTI-BOT path: a one-time cdp-browser mint of a
 *    validated Akamai session jar (real Chrome used ONLY to bootstrap, then
 *    closed), then PLAIN-fetch replay of every request with that jar. The jar is
 *    cached (~90 min) so one bootstrap serves many searches. Auto mode always
 *    splices this right after `fetch`; it only RUNS when `fetch` escalates, so a
 *    healthy plain-API site never pays for it.
 *  - `stealth-fetch`   — Playwright stealth bootstrap + native fetch (token tier).
 *  - `playbook`        — DOM-walk LAST RESORT (needs a compiled playbook.yaml).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import type { Page } from 'playwright';
import {
  type CdpBrowserFetch,
  type CdpBrowserFetchOptions,
  type MintedJar,
  createCdpBrowserFetch,
} from './cdp-browser-fetch.ts';
import {
  clearJar,
  loadJar,
  newestRecording,
  saveJar,
  seedJarFromRecording,
} from './cdp-jar-cache.ts';
import { RuntimeCookieJar } from './cookie-jar.ts';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import {
  type CredentialStore,
  executeWorkflow,
  loadCredentialStore,
  substituteString,
} from './runtime.ts';
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

/** Process-scoped memo of the backend that last succeeded for a site on the
 *  compile/test path (`runWorkflowWithLadder`). Lets the param-coverage suite
 *  skip doomed rungs after the first success. Never persisted; never consulted
 *  by production replay. Exported reset for test isolation. */
const compileWinningBackend = new Map<string, ConcreteBackend>();
export function __resetCompileWinningBackendForTest(): void {
  compileWinningBackend.clear();
}

/** Freshness window for the file-backed compile-time stealth token. Matches
 *  stealth-fetch's in-process `maxTokenAgeSeconds` default so a reused token is
 *  not immediately considered stale by `createStealthFetch`. */
const STEALTH_TOKEN_MAX_AGE_SECONDS = 600;

/** Min spacing (ms) between LIVE requests to one origin on the compile/test path,
 *  to stay under the transient anti-bot rate-flag (observed: ~2 rapid state-
 *  changing requests OK, ~3-4 trips it; recovers). The param-coverage suite fires
 *  one search per parameter — without pacing that burst flags the IP and TARPITS
 *  every later request (exactly what made v13's `.act` tools fail compile, and
 *  what flagged the IP during manual testing). Read per-call so tests can set
 *  IMPRINT_COMPILE_ACT_SPACING_MS=0. Process-scoped; production replay untouched. */
function compileActSpacingMs(): number {
  const v = Number(process.env.IMPRINT_COMPILE_ACT_SPACING_MS ?? 25_000);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
const compileLastRequestAt = new Map<string, number>();
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** Await the per-origin min spacing before a compile-path live request. The
 *  first call to an origin never waits (last=0); subsequent ones within the
 *  window are delayed so the suite paces itself under the rate-flag. */
async function paceCompileRequest(origin: string): Promise<void> {
  const spacing = compileActSpacingMs();
  if (spacing <= 0) return;
  const last = compileLastRequestAt.get(origin) ?? 0;
  const waitMs = last + spacing - Date.now();
  if (waitMs > 0) {
    log(
      `compile pacing: waiting ${Math.round(waitMs / 1000)}s before next live request to ${origin}`,
    );
    await sleepMs(waitMs);
  }
  compileLastRequestAt.set(origin, Date.now());
}
export function __resetCompilePacingForTest(): void {
  compileLastRequestAt.clear();
}

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
  options?: { skipBootstrapSplice?: boolean },
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const effectiveLadder = options?.skipBootstrapSplice
    ? ladder
    : effectiveAutoLadder(ladder, tool.workflow);
  const attempts: LadderResult['attempts'] = [];
  let lastResult: ToolResult | null = null;
  let skipUntilBackend: ConcreteBackend | null = null;

  for (const backend of effectiveLadder) {
    if (skipUntilBackend && backend !== skipUntilBackend) continue;
    if (skipUntilBackend === backend) skipUntilBackend = null;

    // The playbook rung is the DOM-walk LAST RESORT (needs a playbook.yaml). The
    // anti-bot API path is the fetch-bootstrap rung above (cdp-browser jar mint
    // then PLAIN-fetch replay) — NOT this rung. Skip when no playbook.yaml.
    if (backend === 'playbook' && !existsSync(playbookPath(assetRoot, tool.site, tool.dir))) {
      attempts.push({
        backend,
        outcome: 'unavailable',
        detail: 'no playbook.yaml',
        durationMs: 0,
      });
      log(`${backend}: skipped (no playbook.yaml)`);
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
        case 'cdp-replay':
          result = await runCdpReplay(tool, params);
          break;
        case 'stealth-fetch': {
          const sf = ensureStealthFetch(tool, stealthCache);
          // When the workflow declares a bootstrap block, mint its declared
          // session-token state (CSRF cookies etc.) from the SAME stealth
          // session that provides the transport cookies. Without this, a
          // workflow escalating here from fetch-bootstrap loses the
          // ${state.X} its requests need — the gap that made bootstrap-block
          // tools on anti-bot sites unverifiable.
          const initialState = tool.workflow.bootstrap
            ? await stealthBootstrapState(sf, tool.workflow.bootstrap)
            : undefined;
          result = await tool.toolFn(params, { fetchImpl: sf.fetchImpl, initialState });
          break;
        }
        case 'playbook': {
          // DOM-walk last resort (the anti-bot API path is fetch-bootstrap, above).
          // Apply workflow.json's declared parameter defaults — runPlaybook
          // validates and throws on absent values regardless of declared defaults.
          const paramsWithDefaults: typeof params = { ...params };
          for (const p of tool.workflow.parameters) {
            if (!(p.name in paramsWithDefaults) && p.default !== undefined) {
              paramsWithDefaults[p.name] = p.default;
            }
          }
          result = await runPlaybook({
            playbook: playbookPath(assetRoot, tool.site, tool.dir),
            params: paramsWithDefaults,
            site: tool.site,
          });
          break;
        }
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

export function effectiveAutoLadder(
  ladder: ConcreteBackend[],
  workflow: Workflow,
): ConcreteBackend[] {
  if (ladder.length <= 1) return ladder;
  const next = [...ladder];
  // Splice fetch-bootstrap right after `fetch`. It is the plain-fetch API
  // anti-bot path: a one-time cdp-browser jar mint, then PLAIN-fetch replay. It
  // only RUNS when `fetch` escalates (FORBIDDEN/NETWORK/satisfiable
  // STATE_MISSING), so a healthy plain-API site never pays for it. (Gating it on
  // workflowNeedsBootstrap previously excluded inline-token workflows like
  // costco — so we always splice now.)
  if (!next.includes('fetch-bootstrap')) {
    const fetchIdx = next.indexOf('fetch');
    if (fetchIdx !== -1) next.splice(fetchIdx + 1, 0, 'fetch-bootstrap');
  }
  // Splice cdp-replay right after fetch-bootstrap. It runs the API requests IN a
  // live trusted Chrome so a protected POST's self-invalidated _abck is
  // re-validated by the page's bmak sensor between calls — the only path that
  // SUSTAINS multiple sensitive .act POSTs (plain-fetch replay dies after ~1-2
  // because it cannot re-post sensor data). Expensive (a real Chrome launch), so
  // it only RUNS when fetch-bootstrap also escalates; a single-.act tool wins at
  // fetch-bootstrap and never pays for it.
  if (!next.includes('cdp-replay')) {
    const fbIdx = next.indexOf('fetch-bootstrap');
    if (fbIdx !== -1) next.splice(fbIdx + 1, 0, 'cdp-replay');
  }
  // For a MULTI-step state-changing anti-bot workflow, plain-fetch rungs are not
  // just doomed — their tarpitted .act attempts BURN the per-IP rate budget
  // before cdp-replay even runs, which can flag the IP and make cdp-replay tarpit
  // too. Front-load cdp-replay for these so the live browser handles every
  // protected POST from a clean slate.
  if (prefersCdpReplayFirst(workflow)) {
    const i = next.indexOf('cdp-replay');
    if (i > 0) {
      next.splice(i, 1);
      next.unshift('cdp-replay');
    }
  }
  return next;
}

/** A multi-step, state-changing, anti-bot workflow: ≥2 mutating requests AND an
 *  anti-bot signal (a bootstrap block, or requests that depend on captured
 *  `${state.X}` tokens). Plain-fetch replay can't sustain its sequence of
 *  protected POSTs (each self-invalidates `_abck`); only the live-browser
 *  cdp-replay rung can — and it should run FIRST so the doomed fetch /
 *  fetch-bootstrap attempts don't pre-burn the per-IP .act budget. A plain
 *  multi-POST REST API (no bootstrap, no `${state.X}`) is NOT matched, so it
 *  keeps the cheap fetch-first order. */
export function prefersCdpReplayFirst(workflow: Workflow): boolean {
  const mutating = workflow.requests.filter((r) => {
    const m = (r.method ?? 'GET').toUpperCase();
    return r.effect === 'unsafe' || m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  });
  if (mutating.length < 2) return false;
  const hasStateRefs = workflow.requests.some(
    (r) =>
      /\$\{state\./.test(r.url ?? '') ||
      /\$\{state\./.test(r.body ?? '') ||
      Object.values(r.headers ?? {}).some((v) => /\$\{state\./.test(v)),
  );
  return Boolean(workflow.bootstrap) || hasStateRefs;
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
  if (backend === 'cdp-replay') {
    return capability === 'browser_bootstrap' || capability === 'stealth_bootstrap';
  }
  if (backend === 'stealth-fetch') {
    return capability === 'browser_bootstrap' || capability === 'stealth_bootstrap';
  }
  if (backend === 'playbook') {
    return (
      capability === 'ordinary_http' ||
      capability === 'browser_bootstrap' ||
      capability === 'stealth_bootstrap'
    );
  }
  return false;
}

/** Get a validated Akamai jar for this site: reuse the cached one (<=90 min,
 *  _abck~0~) or mint a fresh one via cdp-browser (ONE real-Chrome launch — the
 *  only mechanism that earns Akamai's trust; Playwright tarpits and never
 *  validates _abck). The browser is closed before returning; the jar replays
 *  via plain fetch. Returns null if Chrome can't launch (caller escalates). */
/** Test seam: stub the cdp-browser jar mint so unit tests don't launch real
 *  Chrome. Production leaves this null and uses the real cdp-browser path. */
let cdpJarMinterForTest:
  | ((baseUrl: string, bootstrapUrl: string | undefined) => Promise<MintedJar | null>)
  | null = null;
export function __setCdpJarMinterForTest(
  fn: ((baseUrl: string, bootstrapUrl: string | undefined) => Promise<MintedJar | null>) | null,
): void {
  cdpJarMinterForTest = fn;
}

/** Test seam: stub the cdp-browser factory used by the cdp-replay rung so unit
 *  tests don't launch real Chrome. Production leaves this null. */
let cdpBrowserFetchFactoryForTest: ((opts: CdpBrowserFetchOptions) => CdpBrowserFetch) | null =
  null;
export function __setCdpBrowserFetchFactoryForTest(
  fn: ((opts: CdpBrowserFetchOptions) => CdpBrowserFetch) | null,
): void {
  cdpBrowserFetchFactoryForTest = fn;
}

async function getOrMintCdpJar(
  baseUrl: string,
  bootstrapUrl: string | undefined,
  siteDir: string,
  forceFresh: boolean,
): Promise<MintedJar | null> {
  if (cdpJarMinterForTest) return cdpJarMinterForTest(baseUrl, bootstrapUrl);
  if (!forceFresh) {
    let cached = loadJar(siteDir);
    // A recording NEWER than the cached jar supersedes it — e.g. the user
    // re-recorded on a new IP, so the cached (old-IP) jar would tarpit. Drop the
    // stale cache and re-seed from the fresh recording below.
    const rec = newestRecording(siteDir);
    if (cached && rec && rec.mtimeMs > cached.bootstrapEpoch) cached = null;
    // No (usable) cached jar? Prefer seeding from the user's most recent
    // RECORDING — a real-browser session whose `_abck` is HIGH-TRUST (sustains
    // many sequential .act), strictly better than a synthetic cdp-browser mint
    // (low-trust → tarpitted even on a fresh IP). "The recording IS the
    // executable." Reuse the `rec` stat above so we don't re-glob.
    if (!cached && seedJarFromRecording(siteDir, rec, bootstrapUrl)) cached = loadJar(siteDir);
    if (cached) {
      const provenance =
        cached.source === 'recording'
          ? 'recording-seeded'
          : cached.source === 'mint'
            ? 'cdp-minted'
            : // pre-`source` cache: html-emptiness was the old (now-unreliable) tell
              cached.html
              ? 'cdp-minted'
              : 'recording-seeded';
      log(
        `reusing ${provenance} jar (age ${Math.round((Date.now() - cached.bootstrapEpoch) / 1000)}s, _abck~${cached.abckFlag}~, html=${cached.html.length}b)`,
      );
      return cached;
    }
  }
  let cf: CdpBrowserFetch | undefined;
  try {
    cf = createCdpBrowserFetch({ baseUrl, bootstrapUrl });
    const jar = await cf.mintJar();
    if (jar.abckFlag !== '0') {
      log(`cdp jar minted with _abck~${jar.abckFlag}~ (not validated) — replay may be rejected`);
    }
    saveJar(siteDir, jar);
    return jar;
  } catch (err) {
    log(`cdp jar mint failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await cf?.close(); // browser dead; the jar outlives it
  }
}

/** Replay transport for the bootstrap-then-fetch path: PLAIN fetch that presents
 *  the jar's exact UA (Akamai drops the jar on a UA mismatch). Cookies are
 *  attached by executeWorkflow's RuntimeCookieJar from bootstrappedCredentials,
 *  so this only forces the UA. */
function makeJarUaFetch(ua: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    if (ua) headers.set('user-agent', ua);
    return globalThis.fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
  }) as typeof fetch;
}

/** A replay error that means the JAR is bad (clear it + re-mint), as opposed to a
 *  transient IP rate-flag (NETWORK/RATE_LIMITED — a fresh jar won't help; back off). */
function jarLikelyStale(result: ToolResult): boolean {
  return !result.ok && (result.error === 'FORBIDDEN' || result.error === 'AUTH_EXPIRED');
}

/**
 * fetch-bootstrap rung — the API anti-bot path. Mint a validated session jar via
 * cdp-browser (real Chrome, used ONLY to bootstrap), CLOSE the browser, then
 * replay every workflow request via PLAIN fetch with that jar. Works with or
 * without a workflow.bootstrap block: cookie/html_regex bootstrap captures are
 * satisfied from the minted jar + page HTML, and a workflow that captures its
 * tokens inline (e.g. csrf via a request text_regex) just needs the jar's
 * anti-bot cookies. Self-heals: a stale jar (403/AUTH) is cleared and re-minted
 * once; an IP rate-flag (NETWORK) is returned for the ladder to handle (a fresh
 * jar can't beat a transient rate tarpit).
 */
async function runFetchBootstrap(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
): Promise<ToolResult> {
  let baseUrl: string;
  try {
    baseUrl = pickBaseUrl(tool);
  } catch {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'fetch-bootstrap needs at least one request URL to bootstrap from.',
      remediation: 'Regenerate workflow.json — it has no requests.',
    };
  }

  const credentials = (await loadCredentialStore(tool.site)) ?? {
    site: tool.site,
    cookies: [],
    values: {},
    storage: [],
  };
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, params, credentials, [])
    : undefined;
  const siteDir = pathResolve(tool.dir, '..');

  for (let attempt = 0; attempt < 2; attempt++) {
    const jar = await getOrMintCdpJar(baseUrl, bootstrapUrl, siteDir, attempt > 0);
    if (!jar) {
      // Couldn't even launch the bootstrap browser → let the ladder escalate.
      const stateMissing = bootstrapFailureStateMissingResult(
        tool.workflow,
        'fetch-bootstrap could not launch the bootstrap browser to mint a session jar.',
      );
      if (stateMissing) return stateMissing;
      return {
        ok: false,
        error: 'NETWORK',
        message: 'fetch-bootstrap could not mint a session jar (browser launch failed).',
      };
    }

    // Build credentials carrying the minted jar's cookies (executeWorkflow's
    // RuntimeCookieJar scopes them per-request); fetchImpl only forces the UA.
    const bootstrappedCredentials: CredentialStore = {
      ...credentials,
      cookies: [
        ...credentials.cookies,
        ...jar.cookies.map((c) => ({
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

    // Satisfy any declared bootstrap captures from the minted jar (cookie) +
    // page HTML (html_regex). response_header/dom captures aren't available from
    // a closed browser — required ones of those fail loud below.
    const captureResult = jarBootstrapCaptureState(
      tool.workflow.bootstrap,
      jar,
      bootstrappedCredentials,
      bootstrapUrl ?? baseUrl,
    );
    if (!captureResult.ok) return captureResult.result;

    const result = await tool.toolFn(params, {
      credentials: bootstrappedCredentials,
      initialState: captureResult.state,
      fetchImpl: makeJarUaFetch(jar.ua),
    });

    if (result.ok) return result;
    if (attempt === 0 && jarLikelyStale(result)) {
      log('fetch-bootstrap replay was rejected (403/auth) — clearing jar and re-minting once');
      clearJar(siteDir);
      continue;
    }
    return result;
  }

  return {
    ok: false,
    error: 'NETWORK',
    message: 'fetch-bootstrap exhausted its bootstrap retries.',
  };
}

/**
 * cdp-replay rung — run the workflow's requests INSIDE a live trusted Chrome
 * page (cdp-browser-fetch's in-page `fetchImpl`) instead of replaying a harvested
 * jar via plain fetch. The decisive difference: a same-origin protected POST
 * executes in the real page, so when its `_abck` self-invalidates the page's
 * Akamai bmak sensor auto-re-validates it before the next call. This is the only
 * path that SUSTAINS a SEQUENCE of sensitive `.act` POSTs (a multi-step
 * search→agency→details flow); plain-fetch replay (fetch-bootstrap) dies after
 * ~1-2 because it cannot re-post sensor data. Expensive (a real Chrome launch
 * held open for the whole workflow), so it sits after fetch-bootstrap in the
 * ladder — single-.act tools never reach it.
 *
 * Bootstrap state (csrf / csp-nonce) is resolved exactly as fetch-bootstrap does
 * (via jarBootstrapCaptureState over the live page HTML + cookies harvested by
 * mintJar) — only the transport differs.
 */
async function runCdpReplay(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
): Promise<ToolResult> {
  let baseUrl: string;
  try {
    baseUrl = pickBaseUrl(tool);
  } catch {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'cdp-replay needs at least one request URL to bootstrap from.',
      remediation: 'Regenerate workflow.json — it has no requests.',
    };
  }

  const credentials = (await loadCredentialStore(tool.site)) ?? {
    site: tool.site,
    cookies: [],
    values: {},
    storage: [],
  };
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, params, credentials, [])
    : undefined;

  // Plant the user's recorded high-trust jar into the live page before navigating
  // (a synthetic mint reaches _abck~0~ yet still tarpits .act; only the
  // recording's earned trust sustains it). Reuse the cached jar; else seed one
  // from the newest recording.
  const siteDir = pathResolve(tool.dir, '..');
  let seedCookies: MintedJar['cookies'] | undefined;
  try {
    const rec = newestRecording(siteDir);
    let cached = loadJar(siteDir);
    if (cached && rec && rec.mtimeMs > cached.bootstrapEpoch) cached = null;
    if (!cached && seedJarFromRecording(siteDir, rec, bootstrapUrl)) cached = loadJar(siteDir);
    if (cached?.cookies.length) seedCookies = cached.cookies;
  } catch {
    // best-effort — cdp-replay still works (lower trust) from a synthetic mint
  }

  let cf: CdpBrowserFetch | undefined;
  try {
    cf = (cdpBrowserFetchFactoryForTest ?? createCdpBrowserFetch)({
      baseUrl,
      bootstrapUrl,
      seedCookies,
    });
    // Navigate the bootstrap page, validate `_abck` via interaction, and harvest
    // the live page HTML + session cookies. The browser stays OPEN (mintJar does
    // not close it) so the in-page fetchImpl reuses the SAME trusted session.
    const jar = await cf.mintJar();
    const bootstrappedCredentials: CredentialStore = {
      ...credentials,
      cookies: [
        ...credentials.cookies,
        ...jar.cookies.map((c) => ({
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
    const captureResult = jarBootstrapCaptureState(
      tool.workflow.bootstrap,
      jar,
      bootstrappedCredentials,
      bootstrapUrl ?? baseUrl,
    );
    if (!captureResult.ok) return captureResult.result;

    return await tool.toolFn(params, {
      credentials: bootstrappedCredentials,
      initialState: captureResult.state,
      fetchImpl: cf.fetchImpl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'NETWORK', message: `cdp-replay failed: ${msg}` };
  } finally {
    await cf?.close();
  }
}

/** Resolve workflow.bootstrap captures from a minted jar (cookie source) + the
 *  bootstrap page HTML (html_regex source). Returns the initial ${state.X} map,
 *  or a STATE_MISSING result if a required capture can't be satisfied. */
function jarBootstrapCaptureState(
  bootstrap: ResolvedTool['workflow']['bootstrap'],
  jar: MintedJar,
  credentials: CredentialStore,
  bootstrapUrl: string,
): { ok: true; state: Record<string, unknown> } | { ok: false; result: ToolResult } {
  const state: Record<string, unknown> = {};
  const captures = bootstrap?.captures ?? [];
  if (captures.length === 0) return { ok: true, state };
  const cookieJar = new RuntimeCookieJar(credentials.cookies);
  for (const capture of captures) {
    if (capture.source === 'cookie') {
      const lookup = cookieJar.lookup(capture.cookie, capture.url ?? bootstrapUrl, {
        url: capture.url,
        domain: capture.domain,
        path: capture.path,
        sameSite: capture.sameSite,
        allowHttpOnlyProjection: capture.allowHttpOnlyProjection,
      });
      if (lookup.ok) state[capture.name] = lookup.cookie.value;
      else if (capture.required !== false) {
        return {
          ok: false,
          result: bootstrapCaptureMissingResult(
            capture,
            lookup.reason === 'ambiguous'
              ? `Bootstrap cookie capture "${capture.name}" is ambiguous; add url/domain/path constraints.`
              : `Bootstrap cookie capture "${capture.name}" did not find cookie "${capture.cookie}".`,
            lookup.reason === 'ambiguous' ? 'ambiguous_cookie' : 'producer_ran_value_absent',
          ),
        };
      }
    } else if (capture.source === 'html_regex') {
      let value: string | undefined;
      try {
        const m = new RegExp(capture.pattern).exec(jar.html);
        value = m?.[capture.group ?? 1] ?? m?.[0];
      } catch {
        value = undefined;
      }
      if (value) state[capture.name] = value;
      else if (capture.required !== false) {
        return {
          ok: false,
          result: bootstrapCaptureMissingResult(
            capture,
            `Required bootstrap capture "${capture.name}" (html_regex) did not match the bootstrap page.`,
            'producer_ran_value_absent',
          ),
        };
      }
    } else if (capture.required !== false) {
      // response_header / dom_* can't be resolved from a closed browser jar.
      return {
        ok: false,
        result: bootstrapCaptureMissingResult(
          capture,
          `Bootstrap capture "${capture.name}" (${capture.source}) is not supported by the fetch-bootstrap jar path; use cookie or html_regex.`,
          'producer_ran_value_absent',
        ),
      };
    }
  }
  return { ok: true, state };
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

/** Per-site stealth fetcher; bootstrap pays its ~12s once per process. */
/** Mint `${state.X}` values from the stealth bootstrap session for a workflow
 *  that declares a bootstrap block. Satisfies `cookie`, `html_regex`, and
 *  `response_header` captures from the cookies / HTML / response headers the
 *  stealth navigation minted — all one consistent session as the transport
 *  cookies, so a token the later API POST checks against the session resolves.
 *  `dom_*` / storage sources need a live page and are left for the
 *  fetch-bootstrap rung (the compile prompt steers replay-safe session tokens
 *  to cookie/html_regex, which this covers). */
async function stealthBootstrapState(
  sf: StealthFetch,
  bootstrap: NonNullable<ResolvedTool['workflow']['bootstrap']>,
): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  const captures = bootstrap.captures ?? [];
  const supported = captures.filter(
    (c) => c.source === 'cookie' || c.source === 'html_regex' || c.source === 'response_header',
  );
  if (supported.length === 0) return state;
  const tokens = await sf.ensureBootstrapped();
  for (const cap of supported) {
    if (cap.source === 'cookie') {
      const hit = tokens.cookies.find((c) => c.name === cap.cookie);
      if (hit) state[cap.name] = hit.value;
    } else if (cap.source === 'html_regex') {
      const html = tokens.bootstrapHtml ?? '';
      try {
        const m = html.match(new RegExp(cap.pattern));
        const v = m?.[cap.group ?? 1];
        if (v !== undefined) state[cap.name] = v;
      } catch {
        // invalid regex — leave unset; substitution will surface STATE_MISSING
      }
    } else if (cap.source === 'response_header') {
      const v = tokens.bootstrapResponseHeaders?.[cap.header.toLowerCase()];
      if (v !== undefined && v !== '') state[cap.name] = v;
    }
  }
  return state;
}

function ensureStealthFetch(tool: ResolvedTool, cache: Map<string, StealthFetch>): StealthFetch {
  const cached = cache.get(tool.site);
  if (cached) return cached;
  const sf = createStealthFetch({
    baseUrl: pickBaseUrl(tool),
    // When the workflow declares a bootstrap page, navigate IT during the
    // stealth bootstrap so the session-token cookies it sets (CSRF etc.) are
    // minted in the same session as the anti-bot cookies. Otherwise the
    // stealth rung can't satisfy a `${state.X}` the workflow bootstrap was
    // supposed to provide, and escalation from fetch-bootstrap dead-ends.
    bootstrapUrl: tool.workflow.bootstrap?.url,
  });
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
  // Strip query string but KEEP the path. Anti-bot services like Akamai
  // can apply different protection profiles per URL path: navigating to
  // the bare origin (e.g. https://www.costcotravel.com/) may trip a
  // stricter challenge that RSTs the HTTP/2 stream, whereas the
  // recorded landing path (e.g. /Rental-Cars) is exactly the URL the
  // user reached during recording, so Akamai's bot-cookie minting
  // behavior is known to work for it. URL resolution inside stealth-fetch
  // uses `new URL(baseUrl).origin` regardless, so the path is only used
  // for the bootstrap navigation target and Referer header — both of
  // which are correct with the path included.
  try {
    const u = new URL(firstRequest.url);
    return `${u.origin}${u.pathname}`;
  } catch {
    throw new Error(
      `Could not parse bootstrap URL: ${firstRequest.url}\n→ check workflow.json — the first request URL must be absolute (https://...).`,
    );
  }
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
      // Thread ALL execution opts the rungs pass — fetchImpl (stealth), and
      // crucially initialState + credentials minted by fetch-bootstrap's
      // Chrome navigation. The production generated tool fn (tool-loader path)
      // forwards these to executeWorkflow; this test/probe-path toolFn must do
      // the same, otherwise a bootstrap-block tool's csrf/session state is
      // silently dropped here and the integration test fails a workflow that
      // actually works in production — a false waiver.
      const o = fnOpts as
        | {
            fetchImpl?: typeof fetch;
            initialState?: Record<string, unknown>;
            credentials?: CredentialStore;
          }
        | undefined;
      return executeWorkflow({
        workflow,
        params: params as Record<string, string | number | boolean>,
        credentials: o?.credentials ?? opts.credentials,
        workflowPath: opts.workflowPath,
        fetchImpl: o?.fetchImpl,
        initialState: o?.initialState,
      });
    },
  };

  // Include `fetch-bootstrap` so compile-time live verification can reach the
  // API anti-bot path: a one-time cdp-browser jar mint, then PLAIN-fetch replay.
  // On an anti-bot site where `fetch` tarpits the state-changing `.act`, this is
  // the transport that gets a real baseline — without it a correct anti-bot
  // workflow can never pass compile verification and the tool fails to ship
  // (verified: costco's `.act` tools timed out at compile because neither fetch
  // nor stealth can defeat Akamai). NO playbook rung here — playbook is DOM-only
  // and playbook.yaml doesn't exist at tool-compile time. The per-tool memo below
  // makes only the FIRST call pay the doomed `fetch` timeout; siblings start at
  // the winning rung (and the cdp jar is cached across them — bounding .act volume).
  //
  // NOTE: cdp-replay is deliberately NOT in the compile ladder. It launches a
  // real Chrome PER call, and the compile path runs the live integration suite
  // as many short-lived `bun test` subprocesses (retries × per-param tests),
  // each re-walking the ladder from scratch (the winning-backend memo is
  // process-scoped and a fresh subprocess can't see it) — so cdp-replay here
  // spawns (and orphans) a Chrome per call, piling up dozens of browsers that
  // thrash the host and never converge. Compile verifies via the cached-jar
  // PLAIN-fetch rung (fetch-bootstrap mints Chrome ONCE, cached to disk); a
  // multi-step .act tool that plain-fetch can't sustain ships liveVerified=false
  // and is verified at AUDIT/runtime instead, where the production ladder runs
  // cdp-replay exactly once per tool (bounded, properly closed).
  let ladder: ConcreteBackend[] = ['fetch', 'fetch-bootstrap', 'stealth-fetch'];

  // Compile-time speedup: on an anti-bot site, `fetch` (and `fetch-bootstrap`)
  // are doomed — each costs a full ~30s timeout before the ladder escalates to
  // the stealth rung that actually works. The param-coverage suite makes one
  // runWorkflowWithLadder call PER exposed parameter (plus the producer chain
  // for consumer tools), so paying ~60s of doomed-rung timeouts on every call
  // can push a multi-param tool's verification past the per-tool timeout. Once
  // a backend has won for THIS TOOL in THIS process, start the ladder there and
  // skip the rungs we already know fail. Process-scoped only (never persisted),
  // and only on this compile/test path — production replay (runWithLadder via
  // the tool-loader) is untouched and still tries fetch-first every call.
  //
  // Keyed by tool, NOT site: sibling tools on one site can have DIFFERENT
  // winning backends (e.g. a JSON API tool wins via `fetch` while the anti-bot
  // .act tool needs `stealth-fetch`). A site-wide key would thrash — the API
  // tool would memoize `fetch`, forcing the anti-bot tool to re-pay the doomed
  // 30s fetch timeout on every param-coverage call.
  const memoKey = `${tool.site}::${workflow.toolName}`;
  const memoWinner = compileWinningBackend.get(memoKey);
  if (memoWinner) {
    const idx = ladder.indexOf(memoWinner);
    if (idx > 0) {
      log(
        `compile memo: ${memoKey} previously succeeded via ${memoWinner}; skipping earlier rungs`,
      );
      ladder = ladder.slice(idx);
    }
  }

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
    stealthCache.set(
      tool.site,
      createStealthFetch(
        { baseUrl, bootstrapUrl: tool.workflow.bootstrap?.url },
        { bootstrap: cachingBootstrap },
      ),
    );
  } catch {
    // No usable base URL → leave the cache empty; runWithLadder/ensureStealthFetch
    // will lazily bootstrap (same behavior as before this optimization).
  }

  // Skip the fetch-bootstrap splice on the compile/test path. On an anti-bot
  // site, fetch-bootstrap's plain-fetch request to the protected endpoint hangs
  // until the server RSTs (~30s+) AND those hanging/RST'd requests are a strong
  // bot signal — the param-coverage suite fires one per parameter, and the
  // resulting burst trips the site's IP-level defense, which then TARPITS every
  // later request including the stealth rung that works in isolation (observed:
  // stealth .act hanging 4-5 min after a fetch-bootstrap burst). stealth-fetch
  // now fully honors the workflow bootstrap (same-session CSRF + transport), so
  // it is a superset of fetch-bootstrap here — skipping fetch-bootstrap removes
  // the doomed, defense-tripping requests without losing verification coverage.
  // Production replay (the tool-loader path) keeps fetch-bootstrap: it's a valid
  // lighter rung there and isn't under a per-test burst.
  // Pace live requests under the anti-bot rate-flag: the param-coverage suite
  // makes one runWorkflowWithLadder call per parameter, and an unpaced burst
  // flags the IP and tarpits everything. Space them per origin (no-op in tests
  // via IMPRINT_COMPILE_ACT_SPACING_MS=0).
  try {
    await paceCompileRequest(new URL(pickBaseUrl(tool)).origin);
  } catch {
    // no parseable base URL → nothing to pace
  }
  // skipBootstrapSplice: the compile ladder already lists fetch-bootstrap
  // explicitly (in the API-anti-bot position), so don't let effectiveAutoLadder
  // re-splice it.
  const result = await runWithLadder(ladder, tool, opts.params, assetRoot, stealthCache, {
    skipBootstrapSplice: true,
  });
  // Memoize the winning backend so sibling param tests in this process skip the
  // doomed `fetch` rung. Memoizing a `fetch-bootstrap` (cdp jar) win is what
  // bounds per-param .act volume on an anti-bot site — without it every param
  // test re-pays the doomed fetch timeout before reaching the working rung. The
  // minted jar is itself cached (cdp-jar-cache, 90 min) so the memoized
  // fetch-bootstrap rung reuses ONE browser bootstrap across the whole suite.
  if (
    result.result.ok &&
    (result.usedBackend === 'fetch' ||
      result.usedBackend === 'fetch-bootstrap' ||
      result.usedBackend === 'cdp-replay' ||
      result.usedBackend === 'stealth-fetch')
  ) {
    compileWinningBackend.set(memoKey, result.usedBackend);
  }
  return result;
}

export interface RenderedRequest {
  method: string;
  /** Final, fully-substituted + transform-applied request URL. */
  url: string;
  /** Outgoing headers (lower/mixed case as the runtime set them). */
  headers: Record<string, string>;
  /** Outgoing body, or null for body-less requests. */
  body: string | null;
}

/**
 * Render a workflow's outgoing requests OFFLINE — no network, no browser. Runs
 * the real `executeWorkflow` (so `${param}`/`${state}` substitution, captures,
 * and any `requestTransformModule` all execute) but with a `fetchImpl` that
 * returns the matching RECORDED response for each request and CAPTURES the final
 * outgoing request before returning it.
 *
 * Purpose: verify a parameter actually reaches its field by diffing renders
 * across param overrides — WITHOUT firing a live `.act` per parameter (the burst
 * that flags anti-bot IPs and made costco's tools fail compile). The live suite
 * then needs only ONE baseline call to prove the workflow produces real data; the
 * per-parameter "does X reach field F" check becomes a deterministic offline diff.
 *
 * `recordedResponseFor(method, url)` supplies the recorded response so captures
 * (csrf via text_regex, etc.) resolve and the transform builds the real body;
 * return undefined to fall back to an empty `200`.
 */
export async function renderWorkflowRequests(opts: {
  workflow: Workflow;
  params: Record<string, string | number | boolean>;
  workflowPath?: string;
  credentials?: CredentialStore;
  recordedResponseFor?: (
    method: string,
    url: string,
  ) => { status: number; body: string; headers?: Record<string, string> } | undefined;
}): Promise<{ requests: RenderedRequest[]; result: ToolResult }> {
  const captured: RenderedRequest[] = [];
  const fetchImpl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as Record<string, string>);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    captured.push({ method, url, headers, body });
    const rec = opts.recordedResponseFor?.(method, url);
    return new Response(rec?.body ?? '{}', {
      status: rec?.status ?? 200,
      headers: new Headers(rec?.headers ?? {}),
    });
  }) as typeof fetch;

  const result = await executeWorkflow({
    workflow: opts.workflow,
    params: opts.params,
    credentials: opts.credentials,
    workflowPath: opts.workflowPath,
    fetchImpl,
  });
  return { requests: captured, result };
}
