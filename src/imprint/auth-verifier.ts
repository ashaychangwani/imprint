/**
 * AuthVerifier — the live "verification stage" for the agent-orchestrated 2FA
 * flow. It is the ONLY thing that fires a real login at the site (the compile
 * agent shapes artifacts from the recording and never logs in itself).
 *
 * The whole point is ONE persistent browser session across the two 2FA phases:
 * a per-instance `cdpPool` is passed to every `runWorkflowWithLadder` call, so
 * the cdp-replay rung reuses the same live Chrome page across phase 1 (send the
 * OTP / push) → user input → phase 2 (submit the OTP / poll). Launching a fresh
 * browser between phases would reset a server-side challenge or drop a
 * single-use in-page token, so the pool is the load-bearing piece.
 *
 * Lifecycle: the orchestrator (teach) creates one AuthVerifier per auth run,
 * calls `runPhase` as the agent requests verifications, and ALWAYS calls
 * `drain()` in a `finally` — the pool keeps a real Chrome alive across the
 * user-input wait and any cool-off, so it must be closed deterministically.
 *
 * General: nothing here is site- or channel-specific; every decision is driven
 * by the compiled `workflow.json` / `authConfig` and the ladder.
 */

import { runWorkflowWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { createLog } from './log.ts';
import type { CredentialStore } from './runtime.ts';

const log = createLog('auth-verify');

/** Test seam: the ladder runner AuthVerifier drives. Swappable so the budget /
 *  challenge-counting logic can be unit-tested without a live browser. */
type LadderRunner = typeof runWorkflowWithLadder;
let ladderRunner: LadderRunner = runWorkflowWithLadder;
export function __setAuthVerifierLadderForTest(fn: LadderRunner | null): void {
  ladderRunner = fn ?? runWorkflowWithLadder;
}

/** Two budgets bound the live `initiate` phase:
 *
 *  - CHALLENGE budget (`maxInitiate`, env IMPRINT_AUTH_MAX_INITIATE, default 2):
 *    how many initiates may actually REACH the user — a completed login (`ok`) or
 *    an `AWAITING_2FA` (a challenge was delivered). This is what bounds how many
 *    OTPs/pushes the user ever sees. It is a *lower bound* on pushes for a
 *    multi-request initiate sequence: if the push is sent mid-sequence but a later
 *    sub-request fails, the whole initiate is not counted — the attempt budget
 *    backstops that.
 *  - ATTEMPT budget (`maxInitiateAttempts`, env IMPRINT_AUTH_MAX_INITIATE_ATTEMPTS,
 *    default 5): how many initiate tries total, INCLUDING ones that fail BEFORE any
 *    challenge is delivered (an edge 403 / network error / bad request shape never
 *    reaches the 2FA step, so it sends nothing). This is the runaway guard so a
 *    login blocked pre-challenge can't loop forever without ever spending the
 *    challenge budget. Clamped `>= maxInitiate` so it can never fire first.
 *
 *  Why two: a pre-challenge failure (e.g. an Akamai edge 403 on the credential
 *  POST) sends ZERO OTPs/pushes, so it must NOT consume the user-visible challenge
 *  budget — otherwise a transient block exhausts the budget and a subsequently
 *  corrected workflow can never be verified in the same run. */
const DEFAULT_MAX_INITIATE = 2;
const DEFAULT_MAX_INITIATE_ATTEMPTS = 5;

type AuthPhase = 'initiate' | 'submit_otp' | 'complete';

export interface AuthPhaseResult {
  ok: boolean;
  /** Error code when !ok (e.g. AWAITING_2FA, AUTH_EXPIRED, BAD_RESPONSE,
   *  BUDGET_EXHAUSTED [challenge cap], ATTEMPT_BUDGET_EXHAUSTED [attempt cap]). */
  error?: string;
  message?: string;
  /** Which ladder rung ran it (fetch / cdp-replay / playbook / …). */
  usedBackend: string;
  twoFactorType?: string;
  /** The `${state.X}` values echoed on AWAITING_2FA, carried into the next phase. */
  twoFactorContext?: Record<string, unknown>;
  /** HTTP status code that produced this result, when one was received. Surfaced
   *  so the compile agent sees the concrete code (e.g. 401 vs 400) directly. */
  status?: number;
  /** Truncated response body of the failing / initiate request (first ~500
   *  chars) so the agent can inspect the server payload without re-running. */
  responseBodyPreview?: string;
  /** Wall-clock duration of this phase's live execution, in milliseconds. */
  durationMs: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class AuthVerifier {
  /** Per-run CDP pool — the ONE live session reused across phases. */
  private readonly cdpPool = new Map<string, CdpBrowserFetch>();
  /** Initiates that actually reached the user (completed login or AWAITING_2FA).
   *  Bounded by `maxInitiate` — the user-visible OTP/push budget. */
  private challengesIssued = 0;
  /** All initiate tries, including ones that failed before any challenge was
   *  delivered. Bounded by `maxInitiateAttempts` — the runaway guard. */
  private initiateAttempts = 0;
  /** twoFactorContext echoed by the most recent initiate, threaded into the
   *  completion phase so submit_otp can resolve `${state.X}`. */
  private lastTwoFactorContext: Record<string, unknown> | undefined;
  private readonly maxInitiate: number;
  /** Public so the orchestrator's progress line can show "attempt N/M". */
  readonly maxInitiateAttempts: number;

  constructor(
    private readonly workflowPath: string,
    private readonly credentials: CredentialStore,
    maxInitiate?: number,
    maxInitiateAttempts?: number,
  ) {
    this.maxInitiate =
      maxInitiate ??
      parsePositiveInt(process.env.IMPRINT_AUTH_MAX_INITIATE) ??
      DEFAULT_MAX_INITIATE;
    // The attempt cap can never fire before the challenge budget is usable.
    this.maxInitiateAttempts = Math.max(
      this.maxInitiate,
      maxInitiateAttempts ??
        parsePositiveInt(process.env.IMPRINT_AUTH_MAX_INITIATE_ATTEMPTS) ??
        DEFAULT_MAX_INITIATE_ATTEMPTS,
    );
  }

  /** User-visible challenges delivered so far (each ≈ one OTP/push the user saw). */
  get initiatesUsed(): number {
    return this.challengesIssued;
  }

  /** All live initiate tries so far (incl. pre-challenge failures). */
  get attemptsUsed(): number {
    return this.initiateAttempts;
  }

  /** Run one auth phase live through the ladder, reusing the persistent session.
   *  `initiate` is budget-capped; the completion phases reuse the prior context. */
  async runPhase(phase: AuthPhase, opts?: { otp_code?: string }): Promise<AuthPhaseResult> {
    if (phase === 'initiate') {
      // Gate 1: challenge budget — bounds OTPs/pushes the user actually sees.
      if (this.challengesIssued >= this.maxInitiate) {
        return {
          ok: false,
          error: 'BUDGET_EXHAUSTED',
          message: `Live-login budget of ${this.maxInitiate} delivered 2FA challenge(s) reached — do NOT request another initiate. Either give_up, or only call run_verification for the completion phase if a challenge is already pending.`,
          usedBackend: 'none',
          durationMs: 0,
        };
      }
      // Gate 2: attempt budget — runaway guard for logins blocked BEFORE any
      // challenge is delivered (edge 403 / network / bad request shape). These
      // send nothing, so they don't spend the challenge budget, but they must
      // not loop forever.
      if (this.initiateAttempts >= this.maxInitiateAttempts) {
        return {
          ok: false,
          error: 'ATTEMPT_BUDGET_EXHAUSTED',
          message: `Made ${this.maxInitiateAttempts} live initiate attempt(s), none of which delivered a 2FA challenge — the login is being blocked before it reaches the 2FA step (edge/anti-bot block or a defect in the request shape). Stop and give_up; a fresh run with corrected artifacts is needed.`,
          usedBackend: 'none',
          durationMs: 0,
        };
      }
    }

    const params: Record<string, string> = { action: phase };
    if (phase === 'submit_otp' && opts?.otp_code) params.otp_code = opts.otp_code;

    const t0 = Date.now();
    const ladder = await ladderRunner({
      workflowPath: this.workflowPath,
      params,
      credentials: this.credentials,
      cdpPool: this.cdpPool,
      // Pin every phase to cdp-replay. This is the load-bearing decision for 2FA:
      // ONLY the cdp-replay rung keeps a live browser in `cdpPool`, and the
      // AWAITING_2FA carve-out in runCdpReplay retains it across the user-input
      // gap — so phase 2 reuses the EXACT session (cookies + server challenge +
      // in-page tokens) that phase 1 minted. Left to the probe, the fastest rung
      // returning AWAITING_2FA wins (often fetch/fetch-bootstrap), which is
      // stateless across calls → the completion poll/re-login 401s with
      // "tokens missing". cdp-replay is also the most anti-bot-robust rung, so
      // there's no downside for an (infrequent) auth flow.
      forceBackend: 'cdp-replay',
      // Carry the echoed challenge token into the completion phase so the same
      // session's submit_otp resolves ${state.X}. (Cookies ride the shared
      // pool/jar; this covers body-returned tokens.)
      initialState: phase === 'initiate' ? undefined : this.lastTwoFactorContext,
    });
    const durationMs = Date.now() - t0;

    const r = ladder.result;
    if (phase === 'initiate') {
      // Every try counts toward the attempt cap…
      this.initiateAttempts += 1;
      // …but only a delivered challenge (completed login or AWAITING_2FA) counts
      // toward the user-visible challenge budget. A pre-challenge failure (403,
      // network, bad-response) sent no OTP/push, so it must not burn it. Strictly
      // `ok || AWAITING_2FA` — AUTH_EXPIRED / RATE_LIMITED are non-transport but
      // are NOT delivered challenges.
      if (r.ok || r.error === 'AWAITING_2FA') this.challengesIssued += 1;
    }
    if (!r.ok && r.error === 'AWAITING_2FA' && r.twoFactorContext) {
      this.lastTwoFactorContext = r.twoFactorContext;
    }
    log(
      `phase=${phase} backend=${ladder.usedBackend} ok=${r.ok}${r.ok ? '' : ` error=${r.error}`} in ${durationMs}ms`,
    );

    // Surface the full picture to the compile agent: concrete status code, the
    // response body preview (the initiate preview on AWAITING_2FA; the failing
    // body otherwise), backend, timing, and the carried challenge context.
    const responseBodyPreview = !r.ok
      ? (r.responseBodyPreview ?? r.loginResponsePreview)
      : r.loginResponsePreview;
    return {
      ok: r.ok,
      error: r.ok ? undefined : r.error,
      message: r.ok ? undefined : r.message,
      usedBackend: ladder.usedBackend,
      twoFactorType: !r.ok ? r.twoFactorType : undefined,
      twoFactorContext: !r.ok ? r.twoFactorContext : undefined,
      status: !r.ok ? r.status : undefined,
      responseBodyPreview,
      durationMs,
    };
  }

  /** Close every pooled browser. MUST be called (teach's `finally`) — the pool
   *  holds a live Chrome across the user-input wait, so it never auto-closes. */
  async drain(): Promise<void> {
    for (const cf of this.cdpPool.values()) {
      await cf.close().catch(() => {});
    }
    this.cdpPool.clear();
  }
}
