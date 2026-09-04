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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve as pathResolve } from 'node:path';
import type { Page } from 'playwright';
import { loadBackendsCacheStatus } from './backend-cache.ts';
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
  type BrowserNavigationTransport,
  type CredentialStore,
  type ResponseObservation,
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
import { WorkflowSchema } from './types.ts';
import type {
  BootstrapCapture,
  ConcreteBackend,
  ReplayBackend,
  StateCapability,
  StateMissingItem,
  ToolResult,
  Workflow,
} from './types.ts';

type UsedBackend = ConcreteBackend;

export interface BackendAttemptFact {
  backend: UsedBackend;
  /** `ok` means this runtime path completed. Independent semantic review may
   * still reject the returned data. */
  outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
  detail: string;
  durationMs: number;
}

export type BackendResponseObservation = ResponseObservation & { backend: ConcreteBackend };

interface LadderResult {
  result: ToolResult;
  usedBackend: UsedBackend;
  /** One entry per rung that was tried. */
  attempts: BackendAttemptFact[];
  /** Present on compile/teach calls that request bounded response diagnostics. */
  responseObservations?: BackendResponseObservation[];
}

const BACKEND_ATTEMPT_DETAIL_LIMIT = 500;

function backendAttemptDetail(result: Exclude<ToolResult, { ok: true }>): string {
  return `${result.error}: ${result.message.slice(0, BACKEND_ATTEMPT_DETAIL_LIMIT)}`;
}

/**
 * Return a request-construction failure that happened before any earlier
 * request was sent. That narrow case cannot depend on transport-produced
 * response state, so callers can return it to the compiler without walking the
 * expensive backend ladder. Later transforms may consume earlier responses and
 * must remain eligible for another transport.
 */
export function backendInvariantProbeFailure(result: ToolResult): string | null {
  if (result.ok || result.error !== 'BAD_RESPONSE') return null;
  const facts = result.requestStageFacts ?? [];
  const terminalFailure = [...facts]
    .reverse()
    .find(({ outcome }) => outcome === 'failed' || outcome === 'unavailable');
  if (terminalFailure?.stage === 'preparation' || terminalFailure?.stage === 'transform') {
    const priorSend = facts.some(
      ({ requestIndex, stage }) => stage === 'send' && requestIndex < terminalFailure.requestIndex,
    );
    if (priorSend) return null;
    return result.message;
  }
  // Compatibility for older generated runtimes that predate stage receipts.
  if (facts.length > 0) return null;
  const legacy =
    /^request transform (?:failed for request|module was unavailable for request) (\d+)(?::|$)/i.exec(
      result.message,
    );
  return legacy?.[1] === '0' ? result.message : null;
}

const log = createLog('backend');

type PlaybookRunner = (opts: Parameters<typeof runPlaybook>[0]) => ReturnType<typeof runPlaybook>;
let playbookRunner: PlaybookRunner = runPlaybook;

export function __setPlaybookRunnerForTest(fn: PlaybookRunner | null): void {
  playbookRunner = fn ?? runPlaybook;
}

const DEFAULT_LADDER: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];

const NON_TRANSPORT_ERRORS = new Set(['ACTION_REQUIRED', 'AUTH_EXPIRED', 'RATE_LIMITED']);

function isProbeReachable(result: ToolResult): boolean {
  if (result.ok) return true;
  return NON_TRANSPORT_ERRORS.has(result.error);
}
// Generous enough to clear an anti-bot interstitial (Cloudflare/Akamai
// "checking your browser", which can hold the navigation 10-30s) before the
// real page's `load` fires. Overridable via env for tuning.
const DEFAULT_PLAYBOOK_BACKEND_TIMEOUT_MS = 150_000;
const DEFAULT_PLAYBOOK_BACKEND_STEP_TIMEOUT_MS = 45_000;

/** Process-scoped memo of the backend that last succeeded for a site on the
 *  compile/test path (`runWorkflowWithLadder`). Lets the param-coverage suite
 *  skip doomed rungs after the first success. Never persisted; never consulted
 *  by production replay. Exported reset for test isolation. */
const compileWinningBackend = new Map<string, ConcreteBackend>();
/** Compile-only memory of a rung that produced a conclusive mechanical miss for
 * one public tool. This currently records only an unvalidated browser-minted
 * jar: rerunning that same expensive mint on every artifact revision adds no
 * new request evidence. It is process-scoped and never affects production. */
const compileUnavailableBackends = new Map<string, Set<ConcreteBackend>>();
export function __resetCompileWinningBackendForTest(): void {
  compileWinningBackend.clear();
  compileUnavailableBackends.clear();
}

function rememberCompileUnavailableBackends(memoKey: string, result: LadderResult): void {
  if (
    !result.attempts.some(
      ({ backend, detail }) => backend === 'fetch-bootstrap' && detail.includes('did not validate'),
    )
  ) {
    return;
  }
  const unavailable = compileUnavailableBackends.get(memoKey) ?? new Set<ConcreteBackend>();
  unavailable.add('fetch-bootstrap');
  compileUnavailableBackends.set(memoKey, unavailable);
}

/** Keep compile-time transport memory scoped to one request construction.
 * Parser-only edits intentionally retain the preference; request, bootstrap,
 * or request-transform edits get a fresh key and cannot inherit stale rung
 * outcomes from an earlier candidate for the same public tool. */
function compileExecutionMemoKey(workflow: Workflow, toolDir: string): string {
  const { parserModule: _parserModule, ...transportWorkflow } = workflow;
  const transformPath = workflow.requestTransformModule
    ? pathResolve(toolDir, workflow.requestTransformModule)
    : undefined;
  const transformSource =
    transformPath && existsSync(transformPath) ? readFileSync(transformPath, 'utf8') : null;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ workflow: transportWorkflow, transformSource }))
    .digest('hex')
    .slice(0, 16);
  return `${workflow.site ?? ''}::${workflow.toolName}::${fingerprint}`;
}

/** Record only a backend whose response an agent has explicitly judged to be
 * the promised operation. A transport-level HTTP success is not semantic
 * proof, especially for APIs that return application errors inside HTTP 200. */
export function rememberProvenCompileBackend(workflowPath: string, backend: ConcreteBackend): void {
  const tool = resolveWorkflowTool(workflowPath);
  compileWinningBackend.set(compileExecutionMemoKey(tool.workflow, tool.dir), backend);
}

/** Process-global CDP pool for the compile/test path (`runWorkflowWithLadder`).
 *  Each tool and rendered bootstrap context has its own entry. Repeated checks
 *  of that same construction stay warm, while concurrent tools and materially
 *  different bootstrap contexts cannot inherit one another's page/session
 *  state. An idle timer closes browsers shortly after the last call. */
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

export function cdpReplayPoolKey(site: string, toolName: string, bootstrapUrl: string): string {
  return `${site}\u0000${toolName}\u0000${bootstrapUrl}`;
}

/** Expand a replayBackend choice into a concrete ladder. 'auto' prefers
 *  the probed order (if any), then appends the default fallback ladder.
 *  Explicit choice → single rung. */
export function resolveLadder(
  backend: ReplayBackend,
  cachedPreferredOrder?: ConcreteBackend[],
): ConcreteBackend[] {
  if (backend === 'auto') {
    if (cachedPreferredOrder && cachedPreferredOrder.length > 0) {
      const seen = new Set<ConcreteBackend>();
      const ordered: ConcreteBackend[] = [];
      for (const rung of [...cachedPreferredOrder, ...DEFAULT_LADDER]) {
        if (seen.has(rung)) continue;
        seen.add(rung);
        ordered.push(rung);
      }
      return ordered;
    }
    return DEFAULT_LADDER;
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
    /** Seed state for `${state.X}` substitution, merged under state minted by a
     *  rung. Auth actions use this for their declared continuation projection. */
    initialState?: Record<string, unknown>;
    /** Optional credential override used by auth verification. */
    credentials?: CredentialStore;
    /** Caller cancellation for bounded verification work. */
    signal?: AbortSignal;
    /** Bounded, value-free response observations for factual repair feedback. */
    onResponse?: (observation: BackendResponseObservation) => void;
  },
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const permittedLadder =
    tool.workflow.toolKind === 'authenticate'
      ? ladder.filter((backend) => backend !== 'playbook')
      : ladder;
  if (permittedLadder.length === 0) {
    return {
      result: {
        ok: false,
        error: 'UNKNOWN',
        message: 'Authenticate workflows do not execute playbooks.',
      },
      usedBackend: 'playbook',
      attempts: [],
    };
  }
  const baseLadder = options?.skipBootstrapSplice
    ? permittedLadder
    : effectiveAutoLadder(permittedLadder);

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
  let lastResultBackend: ConcreteBackend | null = null;
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
    const onResponse = (observation: ResponseObservation): void =>
      options?.onResponse?.({ ...observation, backend });
    try {
      switch (backend) {
        case 'fetch': {
          // Egress the plain `fetch` rung through IMPRINT_PROXY when set, so even
          // the first rung (and GET-only tools) use the residential proxy IP.
          const proxyFetch = makeProxyFetch();
          const fetchOpts: Record<string, unknown> = {};
          if (proxyFetch) fetchOpts.fetchImpl = proxyFetch;
          if (options?.initialState) fetchOpts.initialState = options.initialState;
          if (options?.credentials) fetchOpts.credentials = options.credentials;
          if (options?.onResponse) fetchOpts.onResponse = onResponse;
          result = await tool.toolFn(params, fetchOpts);
          break;
        }
        case 'fetch-bootstrap':
          result = await runFetchBootstrap(
            tool,
            params,
            options?.initialState,
            options?.credentials,
            options?.onResponse ? onResponse : undefined,
          );
          break;
        case 'cdp-replay':
          result = await runCdpReplay(
            tool,
            params,
            options?.cdpPool,
            options?.initialState,
            options?.credentials,
            options?.signal,
            options?.onResponse ? onResponse : undefined,
          );
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
          result = await tool.toolFn(paramsWithDefaults, {
            fetchImpl: sf.fetchImpl,
            initialState,
            credentials: options?.credentials,
            ...(options?.onResponse ? { onResponse } : {}),
          });
          break;
        }
        case 'playbook': {
          // DOM-walk last resort (the anti-bot API path is fetch-bootstrap, above).
          // Apply workflow.json's declared parameter defaults — runPlaybook
          // validates and throws on absent values regardless of declared defaults.
          const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
          result = await playbookRunner({
            playbook: playbookPath(assetRoot, tool.site, tool.dir),
            params: paramsWithDefaults,
            site: tool.site,
            stepTimeoutMs: playbookBackendStepTimeoutMs(),
            maxDurationMs: playbookBackendTimeoutMs(),
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
    lastResultBackend = backend;

    if (result.ok) {
      attempts.push({
        backend,
        outcome: 'ok',
        detail: `request completed in ${durationMs}ms; semantic verification is separate`,
        durationMs,
      });
      log(
        `${backend}: REQUEST COMPLETED in ${durationMs}ms (transport only; semantic verification is separate)`,
      );
      options?.winnerCache?.set(memoKey, backend);
      return { result, usedBackend: backend, attempts };
    }

    if (result.error === 'FORBIDDEN') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: backendAttemptDetail(result),
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
          detail: backendAttemptDetail(result),
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
        detail: backendAttemptDetail(result),
        durationMs,
      });
      log(`${backend}: NETWORK in ${durationMs}ms — escalating to next rung`);
      continue;
    }

    // A local preparation/transform failure is an artifact fact, not a
    // transport result. Return it immediately so the retained compiler can
    // repair the request instead of paying for the same failure in browsers.
    const invariantFailure = backendInvariantProbeFailure(result);
    if (invariantFailure) {
      attempts.push({
        backend,
        outcome: 'failed',
        detail: backendAttemptDetail(result),
        durationMs,
      });
      log(`${backend}: request construction failed in ${durationMs}ms — returning to compiler`);
      return { result, usedBackend: backend, attempts };
    }

    // A BAD_RESPONSE produced by a completed HTTP send can differ by transport,
    // so leave the other rungs available. If they all fail, return the last
    // concrete response below.
    if (result.error === 'BAD_RESPONSE') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: backendAttemptDetail(result),
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
        detail: backendAttemptDetail(result),
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
      detail: backendAttemptDetail(result),
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
  const lastBackend = lastResultBackend ?? effectiveLadder[effectiveLadder.length - 1] ?? 'fetch';
  // Be accurate about ladder size: pinned callers use a single-rung ladder, so
  // only say "all rungs" when there really was more than one.
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

export function effectiveAutoLadder(ladder: ConcreteBackend[]): ConcreteBackend[] {
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
  return next;
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

/** Scope transient browser state to one tool and one execution rung without
 * placing cache files inside the generated artifact directory. */
export function compileBackendStateDir(
  toolDir: string,
  backend: 'fetch-bootstrap' | 'cdp-replay' | 'stealth-fetch',
): string {
  return pathResolve(toolDir, '..', '.imprint-backend-state', basename(toolDir), backend);
}

async function getOrMintCdpJar(
  baseUrl: string,
  bootstrapUrl: string | undefined,
  cacheDir: string,
  recordingDir: string,
  forceFresh: boolean,
): Promise<MintedJar | null> {
  if (cdpJarMinterForTest) return cdpJarMinterForTest(baseUrl, bootstrapUrl);
  if (!forceFresh) {
    let cached = loadJar(cacheDir);
    // A recording NEWER than the cached jar supersedes it — e.g. the user
    // re-recorded on a new IP, so the cached (old-IP) jar would tarpit. Drop the
    // stale cache and re-seed from the fresh recording below.
    const rec = newestRecording(recordingDir);
    if (cached && rec && rec.mtimeMs > cached.bootstrapEpoch) cached = null;
    // No (usable) cached jar? Prefer seeding from the user's most recent
    // RECORDING — a real-browser session whose `_abck` is HIGH-TRUST (sustains
    // many sequential .act), strictly better than a synthetic cdp-browser mint
    // (low-trust → tarpitted even on a fresh IP). "The recording IS the
    // executable." Reuse the `rec` stat above so we don't re-glob.
    if (!cached && seedJarFromRecording(cacheDir, rec, bootstrapUrl)) cached = loadJar(cacheDir);
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
    saveJar(cacheDir, jar);
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

function credentialSeedCookies(credentials: CredentialStore): MintedJar['cookies'] {
  return credentials.cookies
    .filter((c) => c.name && c.value && c.domain)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? '/',
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
}

function uniqueSeedCookies(cookies: MintedJar['cookies']): MintedJar['cookies'] | undefined {
  if (cookies.length === 0) return undefined;
  const byScope = new Map<string, MintedJar['cookies'][number]>();
  for (const c of cookies) {
    byScope.set(`${c.domain}\t${c.path ?? '/'}\t${c.name}`, c);
  }
  return [...byScope.values()];
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
  credentialOverride?: CredentialStore,
  onResponse?: (observation: ResponseObservation) => void,
): Promise<ToolResult> {
  const credentials = credentialOverride ??
    (await loadCredentialStore(tool.site)) ?? {
      site: tool.site,
      cookies: [],
      values: {},
      storage: [],
    };
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  let baseUrl: string;
  try {
    baseUrl = pickBaseUrl(tool, paramsWithDefaults, credentials);
  } catch {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'fetch-bootstrap needs a resolvable request URL to bootstrap from.',
      remediation: 'Supply the workflow parameters required by its first request URL.',
    };
  }
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, paramsWithDefaults, credentials, [])
    : undefined;
  const recordingDir = pathResolve(tool.dir, '..');
  const cacheDir = compileBackendStateDir(tool.dir, 'fetch-bootstrap');

  for (let attempt = 0; attempt < 2; attempt++) {
    const jar = await getOrMintCdpJar(baseUrl, bootstrapUrl, cacheDir, recordingDir, attempt > 0);
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

    // Satisfy any declared bootstrap captures from the minted browser session:
    // cookies, page HTML, and document response headers are all captured from
    // the same navigation.
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
      ...(onResponse ? { onResponse } : {}),
    });

    if (result.ok) return result;
    if (attempt === 0 && jarLikelyStale(result)) {
      log('fetch-bootstrap replay was rejected (403/auth) — clearing jar and re-minting once');
      clearJar(cacheDir);
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
  credentialOverride?: CredentialStore,
  signal?: AbortSignal,
  onResponse?: (observation: ResponseObservation) => void,
): Promise<ToolResult> {
  const credentials = credentialOverride ??
    (await loadCredentialStore(tool.site)) ?? {
      site: tool.site,
      cookies: [],
      values: {},
      storage: [],
    };
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  let baseUrl: string;
  try {
    baseUrl = pickBaseUrl(tool, paramsWithDefaults, credentials);
  } catch {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'cdp-replay needs a resolvable request URL to bootstrap from.',
      remediation: 'Supply the workflow parameters required by its first request URL.',
    };
  }
  const bootstrapUrl = tool.workflow.bootstrap
    ? substituteString(tool.workflow.bootstrap.url, paramsWithDefaults, credentials, [])
    : undefined;

  const recordingDir = pathResolve(tool.dir, '..');
  const cacheDir = compileBackendStateDir(tool.dir, 'cdp-replay');
  const poolKey = cdpReplayPoolKey(tool.site, tool.workflow.toolName, bootstrapUrl ?? baseUrl);
  const pooled = cdpPool?.get(poolKey);
  const ownsSession = !pooled;

  let cf: CdpBrowserFetch;
  if (pooled) {
    log('cdp-replay: reusing pooled Chrome session');
    cf = pooled;
  } else {
    const seeds: MintedJar['cookies'] = [];
    // Cached replay jars are recording-derived and may be stale, so authenticate
    // workflows do not inherit them implicitly. Current credential-store cookies
    // are different: they represent durable device/session state and remain
    // available unless the caller intentionally supplies a clean credential store.
    if (tool.workflow.toolKind !== 'authenticate') {
      try {
        const rec = newestRecording(recordingDir);
        let cached = loadJar(cacheDir);
        if (cached && rec && rec.mtimeMs > cached.bootstrapEpoch) cached = null;
        if (!cached && seedJarFromRecording(cacheDir, rec, bootstrapUrl))
          cached = loadJar(cacheDir);
        if (cached?.cookies.length) seeds.push(...cached.cookies);
      } catch {
        // best-effort
      }
    }
    seeds.push(...credentialSeedCookies(credentials));
    const seedCookies = uniqueSeedCookies(seeds);
    cf = (cdpBrowserFetchFactoryForTest ?? createCdpBrowserFetch)({
      baseUrl,
      bootstrapUrl,
      seedCookies,
      seedStorage: credentials.storage,
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
    // Register immediately so caller cancellation can close a browser that is
    // still launching or minting its first jar.
    if (cdpPool) cdpPool.set(poolKey, cf);
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
      browser:
        cf.navigate && cf.snapshotCookies
          ? {
              navigate: cf.navigate.bind(cf),
              snapshotCookies: cf.snapshotCookies.bind(cf),
            }
          : undefined,
      signal,
      ...(onResponse ? { onResponse } : {}),
    });

    if (result.ok) {
      if (cdpPool && ownsSession) cdpPool.set(poolKey, cf);
      try {
        const postJar = await cf.mintJar();
        saveJar(cacheDir, postJar);
      } catch {
        // best-effort
      } finally {
        if (!cdpPool && ownsSession) await cf.close();
      }
    } else if (cdpPool && result.error === 'ACTION_REQUIRED') {
      // A paused auth action is healthy progress. Retain the browser so the next
      // declared action sees the same cookies, page, and browser-owned state.
      if (ownsSession) cdpPool.set(poolKey, cf);
      try {
        const postJar = await cf.mintJar();
        saveJar(cacheDir, postJar);
      } catch {
        // best-effort
      }
      // Deliberately do NOT close cf — the pool retains it for the completion phase.
    } else if (cdpPool) {
      let sessionAlive = !cdpToolResultImpliesDeadSession(result);
      if (!sessionAlive && cf.inspectPage) {
        try {
          await cf.inspectPage();
          sessionAlive = true;
        } catch {
          // A failed liveness probe confirms that the transport is unusable.
        }
      }

      if (sessionAlive) {
        // A caller-owned pool also owns diagnostic failures. Keep the rendered
        // page available so the caller can inspect what the browser actually saw
        // before deciding whether to retry, revise the workflow, or reset state.
        if (ownsSession) cdpPool.set(poolKey, cf);
      } else {
        cdpPool.delete(poolKey);
        log('cdp-replay: evicted degraded session from pool');
        await cf.close();
      }
    } else {
      if (ownsSession) {
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
    await cf.close();
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'NETWORK', message: `cdp-replay failed: ${msg}` };
  }
}

/** Resolve workflow.bootstrap captures from a minted jar (cookie source) + the
 *  bootstrap page HTML (html_regex source), and bootstrap document headers
 *  (response_header source). Returns the initial ${state.X} map, or a
 *  STATE_MISSING result if a required capture can't be satisfied. */
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
    } else if (capture.source === 'response_header') {
      const value = jar.bootstrapResponseHeaders?.[capture.header.toLowerCase()];
      if (value) state[capture.name] = value;
      else if (capture.required !== false) {
        return {
          ok: false,
          result: bootstrapCaptureMissingResult(
            capture,
            `Required bootstrap capture "${capture.name}" (response_header:${capture.header}) did not appear on the bootstrap document response.`,
            'producer_ran_value_absent',
          ),
        };
      }
    } else if (capture.required !== false) {
      // dom_* can't be resolved from a closed browser jar.
      return {
        ok: false,
        result: bootstrapCaptureMissingResult(
          capture,
          `Bootstrap capture "${capture.name}" (${capture.source}) is not supported by the fetch-bootstrap jar path; use cookie, html_regex, or response_header.`,
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
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  const bootstrapUrl = tool.workflow.bootstrap?.url
    ? substituteString(tool.workflow.bootstrap.url, paramsWithDefaults, credentials, [], 'url')
    : undefined;
  const cacheKey = bootstrapUrl ? `${tool.site}:${bootstrapUrl}` : tool.site;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const sf = createStealthFetch({
    baseUrl: pickBaseUrl(tool, paramsWithDefaults, credentials),
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
export function pickBaseUrl(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean> = {},
  credentials: CredentialStore = { site: tool.site, cookies: [], values: {} },
): string {
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
  const paramsWithDefaults = withWorkflowDefaults(tool.workflow, params);
  for (const req of requests) {
    const referer = req.headers?.Referer ?? req.headers?.referer;
    if (referer) {
      try {
        const resolvedReferer = substituteString(
          referer,
          paramsWithDefaults,
          credentials,
          [],
          'url',
        );
        const u = new URL(resolvedReferer);
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
    const resolvedUrl = substituteString(first.url, paramsWithDefaults, credentials, [], 'url');
    const u = new URL(resolvedUrl);
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
  /** Seed state for `${state.X}`. AuthVerifier uses the action program's
   *  declared continuation projection here. */
  initialState?: Record<string, unknown>;
  /** Caller-owned CDP pool. When provided, cdp-replay pools its live Chrome here
   *  (reused across calls that pass the SAME map) and the process-global idle
   *  close is NOT armed — the caller owns the browser's lifecycle and must drain
   *  it. AuthVerifier uses this to preserve one browser across action
   *  checkpoints. */
  cdpPool?: Map<string, CdpBrowserFetch>;
  /** Pin execution to a single rung, bypassing the winner memo. AuthVerifier
   *  pins `cdp-replay` so all actions share one browser. */
  forceBackend?: ConcreteBackend;
  /** Caller cancellation for bounded verification work. */
  signal?: AbortSignal;
}): Promise<LadderResult> {
  if (!existsSync(opts.workflowPath)) {
    throw new Error(`runWorkflowWithLadder: workflow.json not found at ${opts.workflowPath}`);
  }
  const tool = resolveWorkflowTool(opts.workflowPath, opts.credentials);
  const workflow = tool.workflow;
  const toolDir = tool.dir;
  const responseObservations: BackendResponseObservation[] = [];
  const observeResponse = (observation: BackendResponseObservation): void => {
    responseObservations.push(observation);
  };
  // assetRoot only matters for playbook-rung path resolution, which this
  // ladder skips. Use a conventional value for completeness.
  const assetRoot = pathResolve(toolDir, '..', '..');

  const memoKey = compileExecutionMemoKey(workflow, toolDir);
  const unavailable = compileUnavailableBackends.get(memoKey);
  const defaultCompileLadder: ConcreteBackend[] = [
    'fetch',
    'fetch-bootstrap',
    'cdp-replay',
    'stealth-fetch',
  ];
  const ladder = defaultCompileLadder.filter((backend) => !unavailable?.has(backend));
  if (unavailable?.has('fetch-bootstrap')) {
    log(`compile memo: ${memoKey} skipping previously unvalidated fetch-bootstrap`);
  }
  let memoWinner = compileWinningBackend.get(memoKey);

  // Reuse stealth state only for repeated calls to this exact tool and rung.
  const stealthCache = new Map<string, StealthFetch>();
  try {
    const cacheDir = compileBackendStateDir(toolDir, 'stealth-fetch');
    const compileCredentials = opts.credentials ?? { site: tool.site, cookies: [], values: {} };
    const compileParams = withWorkflowDefaults(workflow, opts.params);
    const baseUrl = pickBaseUrl(tool, compileParams, compileCredentials);
    const bootstrapUrl = workflow.bootstrap?.url
      ? substituteString(workflow.bootstrap.url, compileParams, compileCredentials, [], 'url')
      : undefined;
    let fileCacheConsumed = false;
    const cachingBootstrap = async (args: BootstrapArgs): Promise<TokenCache> => {
      if (!fileCacheConsumed) {
        const cached = loadCachedToken(cacheDir, STEALTH_TOKEN_MAX_AGE_SECONDS);
        if (cached) {
          fileCacheConsumed = true;
          log(`reusing cached stealth token for ${workflow.toolName}`);
          return cached;
        }
      }
      clearCachedToken(cacheDir);
      const token = await bootstrapStealthToken(args);
      saveCachedToken(cacheDir, token);
      fileCacheConsumed = true;
      return token;
    };
    stealthCache.set(
      tool.site,
      createStealthFetch({ baseUrl, bootstrapUrl }, { bootstrap: cachingBootstrap }),
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
      await paceCompileRequest(new URL(pickBaseUrl(tool, opts.params, opts.credentials)).origin);
    } catch {
      // no parseable base URL → nothing to pace
    }

    // ── Pinned rung: skip the probe + memo entirely ─────────────────────────
    // A caller that requires a specific rung (the 2FA auth verifier → cdp-replay
    // for cross-phase session continuity) runs ONLY that rung, with no fallback —
    // falling to another rung would lose the live session and defeat the pin.
    if (opts.forceBackend) {
      log(`forced backend: ${opts.forceBackend} (probe + memo skipped)`);
      const result = await runWithLadder(
        [opts.forceBackend],
        tool,
        opts.params,
        assetRoot,
        stealthCache,
        {
          skipBootstrapSplice: true,
          cdpPool,
          initialState: opts.initialState,
          credentials: opts.credentials,
          signal: opts.signal,
          onResponse: observeResponse,
        },
      );
      return { ...result, responseObservations };
    }

    if (!memoWinner) {
      const cacheStatus = loadBackendsCacheStatus(tool.site, dirname(toolDir), toolDir, {
        warn: false,
        toolName: workflow.toolName,
      });
      const cachedWinner =
        cacheStatus.status === 'ok'
          ? cacheStatus.cache.preferredOrder.find((backend) => ladder.includes(backend))
          : undefined;
      if (cacheStatus.status === 'ok' && cachedWinner) {
        memoWinner = cachedWinner;
        compileWinningBackend.set(memoKey, cachedWinner);
        log(
          `compile cache: ${memoKey} using ${cachedWinner} from backends.json; preferred order: ${cacheStatus.cache.preferredOrder.join(' → ')}`,
        );
      }
    }

    // First call: use the ordinary fixed ladder and stop at the first usable
    // result. The former parallel probe waited for a cold Chrome even when
    // plain fetch had already succeeded. It did not establish semantic
    // correctness; it only repeated the same invocation over more transports.
    // Preserve the facts for rungs that were actually needed and memoize the
    // winner for the next call.
    if (!memoWinner) {
      const result = await runWithLadder(ladder, tool, opts.params, assetRoot, stealthCache, {
        skipBootstrapSplice: unavailable?.has('fetch-bootstrap') === true,
        cdpPool,
        initialState: opts.initialState,
        credentials: opts.credentials,
        signal: opts.signal,
        onResponse: observeResponse,
      });
      rememberCompileUnavailableBackends(memoKey, result);
      if (isProbeReachable(result.result)) compileWinningBackend.set(memoKey, result.usedBackend);
      return { ...result, responseObservations };
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
      `compile memo: ${memoKey} previously reached the site via ${memoWinner} (transport only); ladder: ${memoLadder.join(' → ')}`,
    );
    const result = await runWithLadder(memoLadder, tool, opts.params, assetRoot, stealthCache, {
      skipBootstrapSplice: true,
      cdpPool,
      initialState: opts.initialState,
      credentials: opts.credentials,
      signal: opts.signal,
      onResponse: observeResponse,
    });
    rememberCompileUnavailableBackends(memoKey, result);
    if (isProbeReachable(result.result)) {
      compileWinningBackend.set(memoKey, result.usedBackend);
    } else {
      compileWinningBackend.delete(memoKey);
    }
    return { ...result, responseObservations };
  } finally {
    // Keep the pool warm for the next call in this process; arm an idle-close so
    // it's torn down shortly after the LAST call — that lets a raw `bun probe.ts`
    // exit cleanly (no 30-min hang) and never leaks a browser.
    armCompileCdpIdleClose();
  }
}

/** Build the same in-memory tool used by compile-time integration execution,
 * without requiring the emitted index.ts that production discovery loads.
 * Backend probing reuses this adapter during final pre-emission verification. */
export function resolveWorkflowTool(
  workflowPath: string,
  fallbackCredentials?: CredentialStore,
): ResolvedTool {
  if (!existsSync(workflowPath)) {
    throw new Error(`resolveWorkflowTool: workflow.json not found at ${workflowPath}`);
  }
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  const toolDir = dirname(workflowPath);
  return {
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
            browser?: BrowserNavigationTransport;
            initialState?: Record<string, unknown>;
            credentials?: CredentialStore;
            signal?: AbortSignal;
            onResponse?: (observation: ResponseObservation) => void;
          }
        | undefined;
      return executeWorkflow({
        workflow,
        params: params as Record<string, string | number | boolean>,
        credentials: o?.credentials ?? fallbackCredentials,
        workflowPath,
        fetchImpl: o?.fetchImpl,
        browser: o?.browser,
        initialState: o?.initialState,
        signal: o?.signal,
        onResponse: o?.onResponse,
      });
    },
  };
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

export interface RenderedRequestLookup {
  /** Zero-based ordinal among requests that were actually sent. */
  requestOrdinal: number;
  /** Accepted artifact/recording identity for this request, when supplied. */
  provenance?: {
    artifactRequestIndex: number;
    recordingRequestSeq: number;
    /** Recorded request whose response is returned for an explicit page-network
     * capture. The outgoing request is still compared with recordingRequestSeq. */
    recordingResponseRequestSeq?: number;
  };
}

/**
 * Render a workflow's outgoing requests OFFLINE — no network and no live
 * browser. Runs the real `executeWorkflow` (so `${param}`/`${state}`
 * substitution, captures, and any `requestTransformModule` all execute) with
 * synthetic fetch/navigation transports that return the matching RECORDED
 * response and capture each prepared outgoing request.
 *
 * Purpose: verify a parameter actually reaches its field by diffing renders
 * across param overrides — WITHOUT firing a live `.act` per parameter (the burst
 * that flags anti-bot IPs and made costco's tools fail compile). The live suite
 * then needs only ONE baseline call to prove the workflow produces real data; the
 * per-parameter "does X reach field F" check becomes a deterministic offline diff.
 *
 * `recordedResponseFor(method, url, lookup)` supplies the recorded response so
 * captures (csrf via text_regex, etc.) resolve and the transform builds the real
 * body. The lookup includes the outgoing request ordinal and, when provided,
 * its accepted recording provenance. Callers should prefer that provenance to
 * method+URL matching because parameters and transforms can change the URL and
 * repeated requests can share the same method+URL. Return undefined to fall
 * back to an empty `200`.
 */
export async function renderWorkflowRequests(opts: {
  workflow: Workflow;
  params: Record<string, string | number | boolean>;
  workflowPath?: string;
  credentials?: CredentialStore;
  /** Synthetic captured state for offline request tests. */
  initialState?: Record<string, unknown>;
  /** Exact accepted request order used to select recorded responses offline. */
  requestProvenance?: readonly {
    artifactRequestIndex: number;
    recordingRequestSeq: number;
    recordingResponseRequestSeq?: number;
  }[];
  recordedResponseFor?: (
    method: string,
    url: string,
    lookup: RenderedRequestLookup,
  ) => { status: number; body: string; headers?: Record<string, string>; url?: string } | undefined;
}): Promise<{ requests: RenderedRequest[]; result: ToolResult }> {
  const captured: RenderedRequest[] = [];
  let preparedArtifactRequestIndex: number | undefined;
  const capturePreparedRequest = (
    method: string,
    url: string,
    inputHeaders: RequestInit['headers'],
    body: string | null,
  ): Response => {
    const headers: Record<string, string> = {};
    if (inputHeaders) {
      const h = new Headers(inputHeaders);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    const requestOrdinal = captured.length;
    const artifactRequestIndex = preparedArtifactRequestIndex ?? requestOrdinal;
    preparedArtifactRequestIndex = undefined;
    const provenance = opts.requestProvenance?.find(
      (accepted) => accepted.artifactRequestIndex === artifactRequestIndex,
    );
    captured.push({ method, url, headers, body });
    const rec = opts.recordedResponseFor?.(method, url, {
      requestOrdinal,
      ...(provenance ? { provenance } : {}),
    });
    const recordedHeaders = new Headers();
    for (const [name, rawValue] of Object.entries(rec?.headers ?? {})) {
      // CDP can preserve literal line breaks in a combined response header
      // (notably CSP), while the Fetch Headers implementation rejects that
      // wire representation. Unfold it to ordinary HTTP whitespace for this
      // offline response. A malformed response field must not erase every
      // later prepared-request fact.
      const value = rawValue.replace(/\r?\n[\t ]*/g, ' ');
      try {
        recordedHeaders.append(name, value);
      } catch {
        // Ignore only the unrepresentable response field.
      }
    }
    if (rec?.url) recordedHeaders.set('x-imprint-network-response-url', rec.url);
    return new Response(rec?.body ?? '{}', {
      status: rec?.status ?? 200,
      headers: recordedHeaders,
    });
  };
  const fetchImpl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    return capturePreparedRequest(method, url, init?.headers, body);
  }) as typeof fetch;
  const browser: BrowserNavigationTransport = {
    navigate: async (url, options = {}) =>
      capturePreparedRequest(
        (options.method ?? 'GET').toUpperCase(),
        url,
        options.headers,
        options.body ?? null,
      ),
    snapshotCookies: async () => [],
  };

  const result = await executeWorkflow({
    workflow: opts.workflow,
    params: opts.params,
    // Offline rendering must not silently depend on whichever credentials are
    // currently stored on this machine. Callers may inject an explicit store;
    // otherwise use a deterministic empty one.
    credentials: opts.credentials ?? {
      site: opts.workflow.site,
      cookies: [],
      values: {},
      storage: [],
    },
    workflowPath: opts.workflowPath,
    initialState: opts.initialState,
    fetchImpl,
    browser,
    persistAuthState: false,
    onPreparedRequest: (requestIndex) => {
      preparedArtifactRequestIndex = requestIndex;
    },
  });
  return { requests: captured, result };
}
