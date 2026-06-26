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
import { proxyUrl } from './chromium.ts';
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
import { clearCachedToken, loadCachedToken, saveCachedToken } from './stealth-token-cache.ts';
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

type UsedBackend = ConcreteBackend;

interface LadderResult {
  result: ToolResult;
  usedBackend: UsedBackend;
  /** One entry per rung that was tried. */
  attempts: Array<{
    backend: UsedBackend;
    outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
    detail: string;
    durationMs: number;
  }>;
}

const log = createLog('backend');

const DEFAULT_LADDER: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];

const NON_TRANSPORT_ERRORS = new Set(['AWAITING_2FA', 'AUTH_EXPIRED', 'RATE_LIMITED']);

function isProbeReachable(result: ToolResult): boolean {
  if (result.ok) return true;
  return NON_TRANSPORT_ERRORS.has(result.error);
}
// Generous enough to clear an anti-bot interstitial (Cloudflare/Akamai
// "checking your browser", which can hold the navigation 10-30s) before the
// real page's `load` fires. Login pages are exactly where these challenges
// gate, so a 20s per-step cap was too tight and stranded otherwise-correct
// login playbooks at the navigate step. Overridable via env for tuning.
const DEFAULT_PLAYBOOK_BACKEND_TIMEOUT_MS = 150_000;
const DEFAULT_PLAYBOOK_BACKEND_STEP_TIMEOUT_MS = 45_000;

/** Process-scoped memo of the backend that last succeeded for a site on the
 *  compile/test path (`runWorkflowWithLadder`). Lets the param-coverage suite
 *  skip doomed rungs after the first success. Never persisted; never consulted
 *  by production replay. Exported reset for test isolation. */
const compileWinningBackend = new Map<string, ConcreteBackend>();
export function __resetCompileWinningBackendForTest(): void {
  compileWinningBackend.clear();
}

let probeTimeoutMsForTest: number | null = null;
export function __setProbeTimeoutMsForTest(ms: number | null): void {
  probeTimeoutMsForTest = ms;
}

/** Backend preference for the compile parallel-probe winner, LOWER = preferred.
 *  `fetch` first (cheapest, no browser). Among the browser-backed rungs prefer
 *  `cdp-replay` over `stealth-fetch`: cdp-replay's cold start is a one-time cost
 *  (the pool keeps Chrome warm so later calls are ~2-5s) and it is the more
 *  anti-bot-robust path (real Chrome re-validating its sensor between calls), so
 *  it shouldn't lose the probe just because stealth's FIRST call clocked faster. */
const BACKEND_PROBE_RANK: Record<string, number> = {
  fetch: 0,
  'cdp-replay': 1,
  'stealth-fetch': 2,
};

/** Pick the parallel-probe winner among backends that returned real data: prefer
 *  by `BACKEND_PROBE_RANK` (fetch < cdp-replay < stealth-fetch), with first-call
 *  duration only as a tiebreak — so when both browser backends succeed, the
 *  warm-poolable cdp-replay wins instead of stealth's faster cold call. Pure +
 *  exported for unit testing. */
export function pickProbeWinner<T extends { backend: ConcreteBackend; durationMs: number }>(
  winners: T[],
): T | undefined {
  return [...winners].sort((a, b) => {
    const ra = BACKEND_PROBE_RANK[a.backend] ?? 9;
    const rb = BACKEND_PROBE_RANK[b.backend] ?? 9;
    return ra !== rb ? ra - rb : a.durationMs - b.durationMs;
  })[0];
}

/** Process-global CDP pool for the compile/test path (`runWorkflowWithLadder`).
 *  cdp-replay stores its live Chrome here on success so subsequent calls within
 *  the same `bun test` process reuse it (~2-5s vs ~33s cold start) — the same
 *  mechanism as the runtime pool in mcp-server.ts. An idle timer (re)armed after
 *  every call closes each browser shortly after the LAST call, so the host
 *  process drains and exits cleanly (no leak, no hang) without a per-call drain.
 *  Per-process: concurrent compile lanes are separate `bun test` processes, so
 *  this is never shared across lanes; never consulted by production replay. */
const compileCdpPool = new Map<string, CdpBrowserFetch>();
const compileCdpIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const COMPILE_CDP_IDLE_MS = 15_000;

/** Cancel pending idle-closes — called when a new call is about to reuse the pool. */
function clearCompileCdpIdle(): void {
  for (const t of compileCdpIdleTimers.values()) clearTimeout(t);
  compileCdpIdleTimers.clear();
}

/** (Re)arm an idle-close timer for every pooled browser. If no further call
 *  reuses the pool within COMPILE_CDP_IDLE_MS, the browser is closed + evicted so
 *  the event loop drains and the process exits. The timer is intentionally NOT
 *  unref'd: closing the browser is what lets the process exit, so the teardown
 *  must be guaranteed to fire. */
function armCompileCdpIdleClose(): void {
  clearCompileCdpIdle();
  for (const [site, cf] of compileCdpPool) {
    const timer = setTimeout(() => {
      compileCdpPool.delete(site);
      compileCdpIdleTimers.delete(site);
      // Close releases the websocket + Chrome child handles so the event loop
      // drains and the host process exits (mirrors mcp-server's idle close).
      void cf.close().catch(() => {});
    }, COMPILE_CDP_IDLE_MS);
    compileCdpIdleTimers.set(site, timer);
  }
}

/** Test isolation: cancel idle timers + drop pooled browsers (best-effort close). */
export function __resetCompileCdpPoolForTest(): void {
  clearCompileCdpIdle();
  for (const cf of compileCdpPool.values()) void cf.close().catch(() => {});
  compileCdpPool.clear();
}

function cdpToolResultImpliesDeadSession(result: ToolResult): boolean {
  return !result.ok && result.error === 'NETWORK';
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

function playbookBackendTimeoutMs(): number {
  return positiveEnvMs('IMPRINT_PLAYBOOK_BACKEND_TIMEOUT_MS', DEFAULT_PLAYBOOK_BACKEND_TIMEOUT_MS);
}

function playbookBackendStepTimeoutMs(): number {
  return positiveEnvMs(
    'IMPRINT_PLAYBOOK_BACKEND_STEP_TIMEOUT_MS',
    DEFAULT_PLAYBOOK_BACKEND_STEP_TIMEOUT_MS,
  );
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function withWorkflowDefaults(
  workflow: Workflow,
  params: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const paramsWithDefaults: Record<string, string | number | boolean> = { ...params };
  for (const p of workflow.parameters) {
    if (!(p.name in paramsWithDefaults) && p.default !== undefined) {
      paramsWithDefaults[p.name] = p.default;
    }
  }
  return paramsWithDefaults;
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
  options?: {
    skipBootstrapSplice?: boolean;
    /** Per-site CDP browser pool so cdp-replay reuses a live Chrome across
     *  calls (~2-5s) instead of launching a fresh one each time (~33s). */
    cdpPool?: Map<string, CdpBrowserFetch>;
    /** Per-session memo of the backend that last served each tool. Once set, the
     *  next call starts at that backend instead of re-walking the doomed early
     *  rungs — the runtime analog of the compile path's `compileWinningBackend`.
     *  The mcp-server owns one map and ties its lifetime to `cdpPool` (a memoized
     *  cdp-replay is only fast while its Chrome is pooled). */
    winnerCache?: Map<string, ConcreteBackend>;
    /** Seed state for `${state.X}` substitution, merged UNDER any state a rung
     *  mints itself (bootstrap captures win on key overlap). The auth 2FA bridge
     *  uses it: the caller echoes the AWAITING_2FA `twoFactorContext` back on
     *  submit_otp so a body-returned token (e.g. a reauth mfaId) resolves on the
     *  stateless second call. Undefined for every non-auth call → no effect. */
    initialState?: Record<string, unknown>;
  },
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const baseLadder = options?.skipBootstrapSplice
    ? ladder
    : effectiveAutoLadder(ladder, tool.workflow);

  // Runtime winner memo. Once a backend has served this tool in THIS session,
  // start there next time instead of re-walking the doomed early rungs (southwest
  // re-paid an ~80s fetch-bootstrap before cdp-replay on every call). The memo
  // reorders the POST-splice ladder — cdp-replay only exists after
  // effectiveAutoLadder splices it in, so reordering the raw `ladder` could never
  // memoize it. Wrap-around keeps every other rung as fallback, so a now-stale
  // winner still escalates correctly.
  const memoKey = `${tool.site}:${tool.workflow.toolName}`;
  let effectiveLadder = baseLadder;
  const memoWinner = options?.winnerCache?.get(memoKey);
  if (memoWinner) {
    const idx = baseLadder.indexOf(memoWinner);
    if (idx > 0) {
      effectiveLadder = [...baseLadder.slice(idx), ...baseLadder.slice(0, idx)];
      log(
        `runtime memo: ${memoKey} → start at ${memoWinner}; ladder: ${effectiveLadder.join(' → ')}`,
      );
    }
  }
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
        case 'fetch': {
          // Egress the plain `fetch` rung through IMPRINT_PROXY when set, so even
          // the first rung (and GET-only tools) use the residential proxy IP.
          const proxyFetch = makeProxyFetch();
          const fetchOpts: Record<string, unknown> = {};
          if (proxyFetch) fetchOpts.fetchImpl = proxyFetch;
          if (options?.initialState) fetchOpts.initialState = options.initialState;
          result = await tool.toolFn(params, fetchOpts);
          break;
        }
        case 'fetch-bootstrap':
          result = await runFetchBootstrap(tool, params, options?.initialState);
          break;
        case 'cdp-replay':
          result = await runCdpReplay(tool, params, options?.cdpPool, options?.initialState);
          break;
        case 'stealth-fetch': {
          const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
          const sf = await ensureStealthFetch(tool, stealthCache, paramsWithDefaults);
          // When the workflow declares a bootstrap block, mint its declared
          // session-token state (CSRF cookies etc.) from the SAME stealth
          // session that provides the transport cookies. Without this, a
          // workflow escalating here from fetch-bootstrap loses the
          // ${state.X} its requests need — the gap that made bootstrap-block
          // tools on anti-bot sites unverifiable.
          const bootstrapState = tool.workflow.bootstrap
            ? await stealthBootstrapState(sf, tool.workflow.bootstrap)
            : undefined;
          // Merge the caller-seeded state (e.g. the echoed 2FA context) UNDER
          // freshly-minted bootstrap state — bootstrap captures win on overlap.
          const initialState =
            options?.initialState || bootstrapState
              ? { ...options?.initialState, ...bootstrapState }
              : undefined;
          result = await tool.toolFn(paramsWithDefaults, { fetchImpl: sf.fetchImpl, initialState });
          break;
        }
        case 'playbook': {
          // DOM-walk last resort (the anti-bot API path is fetch-bootstrap, above).
          // Apply workflow.json's declared parameter defaults — runPlaybook
          // validates and throws on absent values regardless of declared defaults.
          const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
          result = await runPlaybook({
            playbook: playbookPath(assetRoot, tool.site, tool.dir),
            params: paramsWithDefaults,
            site: tool.site,
            stepTimeoutMs: playbookBackendStepTimeoutMs(),
            maxDurationMs: playbookBackendTimeoutMs(),
            // A login playbook mints a fresh session — persist it so downstream
            // data tools reuse the cookies.
            persistCookies: tool.workflow.toolKind === 'authenticate',
          });
          result = reshapePlaybookAuthResult(result, tool.workflow, paramsWithDefaults);
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
      options?.winnerCache?.set(memoKey, backend);
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

    // BAD_RESPONSE (e.g. HTTP 400) is backend-specific on anti-bot sites, so it
    // escalates rather than stopping. A cdp-replay in-page POST can be rejected
    // because it lacks the live Akamai sensor headers the endpoint demands, while
    // stealth-fetch — which MINTS those sensor headers during its bootstrap —
    // returns 200 for the byte-identical request. Validated on southwest's
    // low-fare-calendar (cdp-replay 400, stealth-fetch 200). Stopping at the first
    // 400 stranded the working rung; escalate so a higher-trust backend gets a
    // shot, and the winner memo then locks onto whatever passed. A genuinely
    // malformed request 400s at every rung and the last 400 is still returned
    // below — cost is bounded by the ladder length.
    if (result.error === 'BAD_RESPONSE') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(
        `${backend}: BAD_RESPONSE in ${durationMs}ms — escalating (a higher-trust rung may pass)`,
      );
      continue;
    }

    // For an AUTHENTICATE tool, AUTH_EXPIRED means the login attempt itself
    // failed — e.g. a browser-minted credential POST (encrypted body, per-load
    // nonce, recaptcha) replayed via an API rung sends a stale/invalid body and
    // 401s. That is NOT terminal: escalate so the playbook rung (a real browser
    // that re-mints the login) gets a shot. For a DATA tool AUTH_EXPIRED stays
    // terminal (the session expired — switching transport won't help).
    if (tool.workflow.toolKind === 'authenticate' && result.error === 'AUTH_EXPIRED') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(
        `${backend}: AUTH_EXPIRED in ${durationMs}ms — escalating (auth login failed, try next rung)`,
      );
      continue;
    }

    // AUTH_EXPIRED (data tools) needs a re-login; RATE_LIMITED needs backoff.
    // Neither is fixed by switching transport.
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
  const lastBackend = effectiveLadder[effectiveLadder.length - 1] ?? 'fetch';
  // Be accurate about ladder size: the parallel probe calls this with SINGLE-rung
  // ladders, so "every backend escalated" was misleading (it described one rung,
  // e.g. fetch-only, as if the whole ladder gave up — and fooled the integration
  // classifier). Only say "all rungs" when there really was more than one.
  log(
    effectiveLadder.length === 1
      ? `${lastBackend}: exhausted (no fallback rung in this ladder); returning its error`
      : `ladder exhausted: all ${effectiveLadder.length} rungs escalated (${effectiveLadder.join(' → ')}); returning last error from ${lastBackend}`,
  );
  return {
    result: lastResult,
    usedBackend: lastBackend,
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
    if (fetchIdx !== -1) {
      next.splice(fetchIdx + 1, 0, 'fetch-bootstrap');
    } else if (!next.includes('cdp-replay')) {
      // `fetch` was probed-out (e.g. Akamai 403) and `cdp-replay` is not
      // explicitly in the ladder. Splice fetch-bootstrap before stealth-fetch
      // so the jar-based path gets a shot. When cdp-replay IS explicit, the
      // probe already determined it's the right rung and fetch-bootstrap was
      // exhausted — don't re-add a doomed 60s+ rung before it.
      const sfIdx = next.indexOf('stealth-fetch');
      if (sfIdx !== -1) next.splice(sfIdx, 0, 'fetch-bootstrap');
    }
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
 *  so this only forces the UA. Egresses through IMPRINT_PROXY when set, so the
 *  replay's IP matches the (proxied) browser that minted the jar — else Akamai
 *  drops the jar on the IP mismatch. */
function makeJarUaFetch(ua: string): typeof fetch {
  const proxy = proxyUrl();
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    if (ua) headers.set('user-agent', ua);
    return globalThis.fetch(
      input as Parameters<typeof fetch>[0],
      {
        ...init,
        headers,
        ...(proxy ? { proxy } : {}),
      } as RequestInit,
    );
  }) as typeof fetch;
}

/** Plain proxied fetch for the `fetch` rung so even the first (no-jar) rung
 *  egresses through IMPRINT_PROXY — keeps the egress IP uniform across rungs and
 *  lets GET-only tools (e.g. location lookups) succeed from the residential
 *  proxy. No-op (returns global fetch) when no proxy is configured. */
function makeProxyFetch(): typeof fetch | undefined {
  const proxy = proxyUrl();
  if (!proxy) return undefined;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(
      input as Parameters<typeof fetch>[0],
      {
        ...init,
        proxy,
      } as RequestInit,
    )) as typeof fetch;
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
  callerState?: Record<string, unknown>,
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
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, paramsWithDefaults, credentials, [])
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

    // Fast-fail an UNVALIDATED jar. A cdp-minted jar without `_abck~0~`/`bm_sv`
    // (validated:false) is rejected by Akamai on plain-fetch replay, and a second
    // mint just produces another unvalidated jar — so don't pay two doomed
    // ~40s mint+replay cycles (the ~80s that made southwest's every call slow).
    // Escalate straight to cdp-replay, which fetches INSIDE the live page (the
    // bmak sensor re-validates `_abck` between calls) and is the only path that
    // works once the recording is too old to seed a high-trust jar. A
    // recording-seeded or cached jar is validated:true by construction, so the
    // cheap plain-fetch path is untouched; `=== false` (not falsy) leaves jars
    // without the field — older caches / test stubs — on the original path.
    if (jar.validated === false) {
      log(
        'fetch-bootstrap: minted jar unvalidated (no _abck~0~/bm_sv) — plain-fetch replay doomed; escalating to cdp-replay',
      );
      return {
        ok: false,
        error: 'FORBIDDEN',
        message: 'fetch-bootstrap: cdp-minted jar did not validate; cdp-replay (in-page) required.',
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

    const result = await tool.toolFn(paramsWithDefaults, {
      credentials: bootstrappedCredentials,
      initialState: { ...callerState, ...captureResult.state },
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
  cdpPool?: Map<string, CdpBrowserFetch>,
  callerState?: Record<string, unknown>,
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
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, paramsWithDefaults, credentials, [])
    : undefined;

  const siteDir = pathResolve(tool.dir, '..');
  const poolKey = tool.site;
  const pooled = cdpPool?.get(poolKey);
  const ownsSession = !pooled;

  let cf: CdpBrowserFetch;
  if (pooled) {
    log('cdp-replay: reusing pooled Chrome session');
    cf = pooled;
  } else {
    let seedCookies: MintedJar['cookies'] | undefined;
    // An authentication flow establishes a BRAND-NEW session and must start from a
    // clean cookie slate. Seeding a prior run's cookies — especially anti-bot tokens
    // (e.g. Akamai `_abck`/`bm_sz`) carried over from a cached `.cdp-jar.json` or an
    // old recording — poisons the live sensor: the page still validates a fresh
    // `_abck` to `~0~`, but the cross-origin credential POST is edge-403'd ("Failed
    // to fetch", no ACAO). saveJar persists each cdp-replay session, so seeding would
    // otherwise re-arm itself every run (initiate writes a jar that the next initiate
    // seeds → cascade of 403s). Data tools still seed (they reuse an authed session).
    if (tool.workflow.toolKind !== 'authenticate') {
      try {
        const rec = newestRecording(siteDir);
        let cached = loadJar(siteDir);
        if (cached && rec && rec.mtimeMs > cached.bootstrapEpoch) cached = null;
        if (!cached && seedJarFromRecording(siteDir, rec, bootstrapUrl)) cached = loadJar(siteDir);
        if (cached?.cookies.length) seedCookies = cached.cookies;
      } catch {
        // best-effort
      }
    }
    cf = (cdpBrowserFetchFactoryForTest ?? createCdpBrowserFetch)({
      baseUrl,
      bootstrapUrl,
      seedCookies,
      // Run HEADED for authentication: a strong anti-bot edge (e.g. Akamai Bot
      // Manager) fingerprints headless Chrome beyond the `HeadlessChrome` UA token
      // we strip, so a cross-origin credential POST that 403s headless passes
      // headed. Auth is interactive (the user is present to approve the 2FA), so a
      // visible window is fine; data-tool cdp-replay stays headless.
      // `IMPRINT_CDP_HEADED=1` forces headed for any rung.
      headed: tool.workflow.toolKind === 'authenticate' || process.env.IMPRINT_CDP_HEADED === '1',
      // Cross-origin Set-Cookie re-injection only when the (auth) workflow
      // declares it — never a blanket default. See AuthConfig.crossOriginCookieReinjection.
      reinjectCrossOriginCookies: tool.workflow.authConfig?.crossOriginCookieReinjection ?? false,
    });
  }

  try {
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
    if (!captureResult.ok) {
      if (ownsSession) await cf.close();
      return captureResult.result;
    }

    const result = await tool.toolFn(paramsWithDefaults, {
      credentials: bootstrappedCredentials,
      initialState: { ...callerState, ...captureResult.state },
      fetchImpl: cf.fetchImpl,
    });

    if (result.ok) {
      if (cdpPool && ownsSession) cdpPool.set(poolKey, cf);
      try {
        const postJar = await cf.mintJar();
        saveJar(siteDir, postJar);
      } catch {
        // best-effort
      } finally {
        if (!cdpPool && ownsSession) await cf.close();
      }
    } else if (cdpPool && result.error === 'AWAITING_2FA') {
      // Cross-phase 2FA continuity: AWAITING_2FA is the EXPECTED, healthy outcome
      // of the initiate phase — NOT a failure. Keep the live browser pooled so the
      // completion phase reuses the EXACT page that minted the challenge: the
      // server-side challenge state and any single-use in-page tokens are bound to
      // THIS session, so a fresh browser would reset them and the poll/complete
      // would 401. The caller (AuthVerifier) owns this pool and drains it in its
      // `finally`. Without this carve-out the generic `else` below evicts+closes
      // the session here and phase 2 silently starts cold → "tokens missing" 401.
      if (ownsSession) cdpPool.set(poolKey, cf);
      try {
        const postJar = await cf.mintJar();
        saveJar(siteDir, postJar);
      } catch {
        // best-effort
      }
      // Deliberately do NOT close cf — the pool retains it for the completion phase.
    } else {
      if (ownsSession) {
        await cf.close();
      } else if (cdpPool && cdpToolResultImpliesDeadSession(result)) {
        cdpPool.delete(poolKey);
        log('cdp-replay: evicted degraded session from pool');
        await cf.close();
      }
    }

    return result;
  } catch (err) {
    // Session is dead — evict from pool so the next call creates a fresh one.
    if (cdpPool) {
      cdpPool.delete(poolKey);
      log('cdp-replay: evicted dead session from pool');
    }
    if (ownsSession) await cf.close();
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'NETWORK', message: `cdp-replay failed: ${msg}` };
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

async function ensureStealthFetch(
  tool: ResolvedTool,
  cache: Map<string, StealthFetch>,
  params: Record<string, string | number | boolean>,
): Promise<StealthFetch> {
  const credentials = (await loadCredentialStore(tool.site)) ?? {
    site: tool.site,
    cookies: [],
    values: {},
  };
  const bootstrapUrl = tool.workflow.bootstrap?.url
    ? substituteString(tool.workflow.bootstrap.url, params, credentials, [], 'url')
    : undefined;
  const cacheKey = bootstrapUrl ? `${tool.site}:${bootstrapUrl}` : tool.site;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const sf = createStealthFetch({
    baseUrl: pickBaseUrl(tool),
    // When the workflow declares a bootstrap page, navigate IT during the
    // stealth bootstrap so the session-token cookies it sets (CSRF etc.) are
    // minted in the same session as the anti-bot cookies. Otherwise the
    // stealth rung can't satisfy a `${state.X}` the workflow bootstrap was
    // supposed to provide, and escalation from fetch-bootstrap dead-ends.
    bootstrapUrl,
  });
  cache.set(cacheKey, sf);
  return sf;
}

/** Pick the URL to navigate when bootstrapping an anti-bot session.
 *  Akamai binds sensor tokens to the origin+path the browser navigated
 *  to, so we need an HTML page — not a JSON API endpoint.
 *
 *  Heuristic: skip leading requests whose path looks like a raw data
 *  endpoint (.json, .xml, /api/, /version) — those return JSON/XML
 *  without rendering an HTML page, so the anti-bot sensor JS never
 *  fires and the _abck cookie stays unvalidated. Fall back to
 *  requests[0] if every request looks like an API call. */
export function pickBaseUrl(tool: ResolvedTool): string {
  const requests = tool.workflow.requests;
  if (!requests.length) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — stealth-fetch needs at least one request URL.\n→ re-record the session; recording probably stopped before any XHR fired.`,
    );
  }

  // Prefer the first request whose Referer is an HTML page — the Referer
  // is the page the user was on when the API call fired, so it's the
  // correct bootstrap target. Referer is set by the browser and always
  // points to a real navigable page.
  for (const req of requests) {
    const referer = req.headers?.Referer ?? req.headers?.referer;
    if (referer) {
      try {
        const u = new URL(referer);
        return `${u.origin}${u.pathname}`;
      } catch {
        // malformed referer — skip
      }
    }
  }

  // Fallback: use the origin of the first request. API paths
  // (/api/...) aren't navigable HTML pages — the anti-bot sensor only
  // fires on a real page load — so the bare origin (homepage) is the
  // safest bootstrap target. The homepage loads the full SPA shell
  // with Akamai/Cloudflare/DataDome sensor scripts, minting a valid
  // _abck cookie that covers all paths under that origin.
  const first = requests[0];
  if (!first) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — unreachable after length check above.`,
    );
  }
  try {
    const u = new URL(first.url);
    return u.origin;
  } catch {
    throw new Error(
      `Could not parse bootstrap URL: ${first.url}\n→ check workflow.json — the first request URL must be absolute (https://...).`,
    );
  }
}

function playbookPath(assetRoot: string, site: string, toolDir?: string): string {
  if (toolDir) return pathResolve(toolDir, 'playbook.yaml');
  return pathResolve(assetRoot, site, 'playbook.yaml');
}

/**
 * For a 2FA authenticate tool whose login runs on the playbook rung, the
 * playbook's success marker is the **2FA challenge state** (per the
 * auth-compile contract), not full authentication. Reshape that `ok: true`
 * into the same `AWAITING_2FA` signal the API rungs emit so every consumer
 * (teach, mcp-server) handles playbook- and API-reached 2FA uniformly — and
 * carry any best-effort `twoFactorContext` token the playbook captured (named
 * per `authConfig.twoFactorContext`) across the stateless initiate→submit_otp
 * gap. Only fires on the login/initiate action; submit_otp/complete run via
 * the fetch path, not the playbook.
 */
export function reshapePlaybookAuthResult(
  result: ToolResult,
  workflow: Workflow,
  params: Record<string, string | number | boolean>,
): ToolResult {
  const authCfg = workflow.authConfig;
  const action = String(params.action ?? 'initiate');
  if (
    !result.ok ||
    workflow.toolKind !== 'authenticate' ||
    !authCfg ||
    authCfg.twoFactorType === 'none' ||
    action === 'submit_otp' ||
    action === 'complete'
  ) {
    return result;
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  const ctx: Record<string, unknown> = {};
  for (const name of authCfg.twoFactorContext ?? []) {
    if (data && typeof data === 'object' && name in data && data[name] != null) {
      ctx[name] = data[name];
    }
  }
  return {
    ok: false,
    error: 'AWAITING_2FA',
    twoFactorType: authCfg.twoFactorType,
    twoFactorContext: Object.keys(ctx).length > 0 ? ctx : undefined,
    message: `2FA required (${authCfg.twoFactorType}) — login reached the 2FA challenge via the playbook rung.`,
  };
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
  /** Seed state for `${state.X}` (auth 2FA bridge): the echoed twoFactorContext
   *  from a prior AWAITING_2FA result, threaded into every rung so a submit_otp
   *  completion request can resolve a token the initiate response returned. */
  initialState?: Record<string, unknown>;
  /** Caller-owned CDP pool. When provided, cdp-replay pools its live Chrome here
   *  (reused across calls that pass the SAME map) and the process-global idle
   *  close is NOT armed — the caller owns the browser's lifecycle and must drain
   *  it. Used by the auth verifier to keep ONE live session across 2FA phase 1
   *  (send) → user input → phase 2 (verify) so the challenge isn't reset. */
  cdpPool?: Map<string, CdpBrowserFetch>;
  /** Pin execution to a single rung, bypassing the parallel probe AND the winner
   *  memo. The 2FA auth verifier sets this to `cdp-replay`: only cdp-replay keeps
   *  one live browser in `cdpPool` (which the AWAITING_2FA carve-out retains), so
   *  phase 2 can reuse the exact session that minted the challenge. Left to the
   *  probe, the FASTEST rung returning AWAITING_2FA wins (often fetch /
   *  fetch-bootstrap), which can't persist the session → completion 401s. */
  forceBackend?: ConcreteBackend;
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

  // Authenticate tools may need the playbook rung: a login whose POST body is
  // browser-minted (encrypted credentials) can't be API-replayed, so the login
  // DOM steps must run in a real browser. runWithLadder skips playbook when no
  // playbook.yaml exists, so including it is safe for tools without one.
  const ladder: ConcreteBackend[] =
    workflow.toolKind === 'authenticate'
      ? ['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch', 'playbook']
      : ['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch'];

  const memoKey = `${tool.site}::${workflow.toolName}`;
  const memoWinner = compileWinningBackend.get(memoKey);

  // Share one stealth token across this site's compile-time test processes.
  const stealthCache = new Map<string, StealthFetch>();
  try {
    const siteDir = pathResolve(toolDir, '..');
    const baseUrl = pickBaseUrl(tool);
    let fileCacheConsumed = false;
    const cachingBootstrap = async (args: BootstrapArgs): Promise<TokenCache> => {
      if (!fileCacheConsumed) {
        const cached = loadCachedToken(siteDir, STEALTH_TOKEN_MAX_AGE_SECONDS);
        if (cached) {
          fileCacheConsumed = true;
          log(`reusing cached stealth token for ${tool.site || siteDir}`);
          return cached;
        }
      }
      clearCachedToken(siteDir);
      const token = await bootstrapStealthToken(args);
      saveCachedToken(siteDir, token);
      fileCacheConsumed = true;
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

  // Reuse the process-global compile CDP pool so cdp-replay stays warm (~2-5s)
  // across this `bun test` process's calls; cancel any pending idle-close now
  // that we're about to use it again. The pool is torn down by an idle timer
  // (armed in `finally`) shortly after the LAST call — see compileCdpPool.
  // A caller-owned pool (auth verifier) opts out of the global idle close: that
  // caller keeps the session alive across the user-input gap and drains it itself.
  const usingCallerPool = opts.cdpPool !== undefined;
  const cdpPool = opts.cdpPool ?? compileCdpPool;
  if (!usingCallerPool) clearCompileCdpIdle();

  try {
    try {
      await paceCompileRequest(new URL(pickBaseUrl(tool)).origin);
    } catch {
      // no parseable base URL → nothing to pace
    }

    // ── Pinned rung: skip the probe + memo entirely ─────────────────────────
    // A caller that requires a specific rung (the 2FA auth verifier → cdp-replay
    // for cross-phase session continuity) runs ONLY that rung, with no fallback —
    // falling to another rung would lose the live session and defeat the pin.
    if (opts.forceBackend) {
      log(`forced backend: ${opts.forceBackend} (probe + memo skipped)`);
      return await runWithLadder([opts.forceBackend], tool, opts.params, assetRoot, stealthCache, {
        skipBootstrapSplice: true,
        cdpPool,
        initialState: opts.initialState,
      });
    }

    // ── First call: parallel probe (45s deadline) ───────────────────────────
    // Race non-overlapping backends so a tarpitted rung doesn't block a
    // faster one. fetch-bootstrap is excluded: it launches Chrome to the
    // same origin as cdp-replay, and two simultaneous Chromes trip Akamai's
    // concurrent-session detection. cdp-replay is strictly better when both
    // need Chrome; if fetch wins, fetch-bootstrap is unnecessary anyway.
    //
    // Uses Promise.allSettled (NOT Promise.any) deliberately: a fast OK from
    // a lower rung (e.g. fetch returning a cached/stale 200) may not be the
    // best result — we need all backends to settle so we can pick the
    // fastest *correct* one. The tradeoff is wall-clock: the probe blocks
    // until the slowest backend resolves (or hits the deadline). cdp-replay
    // is slow on its first cold start (~33s) but subsequent calls reuse the
    // CDP pool and complete in ~2-5s — so the first probe pays the cost but
    // all later calls benefit from having discovered the right rung.
    //
    // The compile agent's integration tests MUST use a timeout >= 60s (the
    // compile-agent.md prompt recommends this) so the test process survives
    // the full probe duration. A 30s test timeout kills the probe before
    // cdp-replay can finish its cold start.
    //
    // Each bun-test subprocess is a fresh process (memo empty), so the
    // compile agent's iteration loop re-probes after every workflow change —
    // no premature lock-in.
    if (!memoWinner) {
      const PROBE_TIMEOUT_MS = probeTimeoutMsForTest ?? 45_000;
      const probeBackends: ConcreteBackend[] = ['fetch', 'cdp-replay', 'stealth-fetch'];

      const settled = await Promise.allSettled(
        probeBackends.map(async (b) => {
          const t0 = Date.now();
          // Keep a handle to the real backend run (the race's non-timeout arm) so a
          // backend that LOSES the deadline race — still launching Chrome in the
          // background — gets settled and its pooled browser drained, not leaked,
          // once the probe returns.
          const inner = runWithLadder([b], tool, opts.params, assetRoot, stealthCache, {
            skipBootstrapSplice: true,
            cdpPool,
            initialState: opts.initialState,
          });
          // A backend that finishes AFTER the probe returned (it lost the race but
          // is still cold-starting Chrome) pools its browser late — arm the idle
          // close so it's torn down rather than left lingering. (Caller-owned pool
          // drains itself, so don't arm the global idle close for it.)
          if (!usingCallerPool) void inner.finally(() => armCompileCdpIdleClose()).catch(() => {});
          const r = await Promise.race([
            inner,
            sleepMs(PROBE_TIMEOUT_MS).then(
              () =>
                ({
                  result: { ok: false, error: 'NETWORK', message: 'probe deadline exceeded' },
                  usedBackend: b,
                  attempts: [],
                }) as LadderResult,
            ),
          ]);
          return { backend: b, result: r, durationMs: Date.now() - t0 };
        }),
      );

      // For an authenticate tool, AUTH_EXPIRED is NOT a reachable winner — it
      // means the login failed, and the playbook rung (only reached via the
      // sequential fallback below) is the browser-minted login's actual path.
      // Treating it as "reachable" would let a cdp-replay 401 win the probe and
      // the playbook would never run. AWAITING_2FA stays reachable (it IS success).
      const isAuthTool = tool.workflow.toolKind === 'authenticate';
      const probeReachable = (r: ToolResult): boolean =>
        isProbeReachable(r) && !(isAuthTool && !r.ok && r.error === 'AUTH_EXPIRED');
      const digest = settled.map((s, i) => {
        const b = probeBackends[i];
        if (s.status === 'rejected')
          return `${b}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`.slice(
            0,
            120,
          );
        const { result: lr, durationMs } = s.value;
        const r = lr.result;
        if (r.ok) return `${b}: OK in ${durationMs}ms`;
        return probeReachable(r)
          ? `${b}: ${r.error} in ${durationMs}ms`
          : `${b}: ${r.error} — ${r.message.slice(0, 200)} (${durationMs}ms)`;
      });

      type ProbeEntry = { backend: ConcreteBackend; result: LadderResult; durationMs: number };
      const winners = settled
        .filter(
          (s): s is PromiseFulfilledResult<ProbeEntry> =>
            s.status === 'fulfilled' && probeReachable(s.value.result.result),
        )
        .map((s) => s.value);

      const best = pickProbeWinner(winners);
      if (best) {
        compileWinningBackend.set(memoKey, best.backend);
        log(
          `parallel probe: winner=${best.backend} (${best.durationMs}ms)\n  ${digest.join('\n  ')}`,
        );
        return best.result;
      }

      log(
        `parallel probe: all backends failed — falling through to sequential ladder\n  ${digest.join('\n  ')}`,
      );
      const seqResult = await runWithLadder(ladder, tool, opts.params, assetRoot, stealthCache, {
        cdpPool,
        initialState: opts.initialState,
      });
      if (probeReachable(seqResult.result)) {
        compileWinningBackend.set(memoKey, seqResult.usedBackend);
      }
      return seqResult;
    }

    // ── Memo hit: start at the memoized winner, keep all later rungs ─────
    // Previous logic sliced earlier rungs away (`ladder.slice(idx)`), which
    // dropped cdp-replay as a fallback when stealth-fetch (the last rung)
    // was the winner. Now: reorder the ladder to start at the winner and
    // wrap around so every rung remains reachable. The winner is tried first
    // (the optimization), but if it fails the remaining rungs catch it.
    const idx = ladder.indexOf(memoWinner);
    const memoLadder = idx > 0 ? [...ladder.slice(idx), ...ladder.slice(0, idx)] : ladder;
    log(
      `compile memo: ${memoKey} previously succeeded via ${memoWinner}; ladder: ${memoLadder.join(' → ')}`,
    );
    const result = await runWithLadder(memoLadder, tool, opts.params, assetRoot, stealthCache, {
      skipBootstrapSplice: true,
      cdpPool,
      initialState: opts.initialState,
    });
    if (isProbeReachable(result.result)) {
      compileWinningBackend.set(memoKey, result.usedBackend);
    } else {
      compileWinningBackend.delete(memoKey);
    }
    return result;
  } finally {
    // Keep the pool warm for the next call in this process; arm an idle-close so
    // it's torn down shortly after the LAST call — that lets a raw `bun probe.ts`
    // exit cleanly (no 30-min hang) and never leaks a browser.
    armCompileCdpIdleClose();
  }
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
