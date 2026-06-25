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

/** Default cap on live `initiate` logins per run — bounds how many OTPs/pushes
 *  the user ever sees. Overridable via IMPRINT_AUTH_MAX_INITIATE. */
const DEFAULT_MAX_INITIATE = 2;

type AuthPhase = 'initiate' | 'submit_otp' | 'complete';

export interface AuthPhaseResult {
  ok: boolean;
  /** Error code when !ok (e.g. AWAITING_2FA, AUTH_EXPIRED, BAD_RESPONSE, BUDGET_EXHAUSTED). */
  error?: string;
  message?: string;
  /** Which ladder rung ran it (fetch / cdp-replay / playbook / …). */
  usedBackend: string;
  twoFactorType?: string;
  /** The `${state.X}` values echoed on AWAITING_2FA, carried into the next phase. */
  twoFactorContext?: Record<string, unknown>;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class AuthVerifier {
  /** Per-run CDP pool — the ONE live session reused across phases. */
  private readonly cdpPool = new Map<string, CdpBrowserFetch>();
  private initiateCount = 0;
  /** twoFactorContext echoed by the most recent initiate, threaded into the
   *  completion phase so submit_otp can resolve `${state.X}`. */
  private lastTwoFactorContext: Record<string, unknown> | undefined;
  private readonly maxInitiate: number;

  constructor(
    private readonly workflowPath: string,
    private readonly credentials: CredentialStore,
    maxInitiate?: number,
  ) {
    this.maxInitiate =
      maxInitiate ??
      parsePositiveInt(process.env.IMPRINT_AUTH_MAX_INITIATE) ??
      DEFAULT_MAX_INITIATE;
  }

  /** Live initiate logins fired so far (each = one OTP/push to the user). */
  get initiatesUsed(): number {
    return this.initiateCount;
  }

  /** Run one auth phase live through the ladder, reusing the persistent session.
   *  `initiate` is budget-capped; the completion phases reuse the prior context. */
  async runPhase(phase: AuthPhase, opts?: { otp_code?: string }): Promise<AuthPhaseResult> {
    if (phase === 'initiate') {
      if (this.initiateCount >= this.maxInitiate) {
        return {
          ok: false,
          error: 'BUDGET_EXHAUSTED',
          message: `Live-login budget of ${this.maxInitiate} reached — do NOT request another initiate. Either give_up, or only call run_verification for the completion phase if a challenge is already pending.`,
          usedBackend: 'none',
        };
      }
      this.initiateCount += 1;
    }

    const params: Record<string, string> = { action: phase };
    if (phase === 'submit_otp' && opts?.otp_code) params.otp_code = opts.otp_code;

    const ladder = await runWorkflowWithLadder({
      workflowPath: this.workflowPath,
      params,
      credentials: this.credentials,
      cdpPool: this.cdpPool,
      // Carry the echoed challenge token into the completion phase so the same
      // session's submit_otp resolves ${state.X}. (Cookies ride the shared
      // pool/jar; this covers body-returned tokens.)
      initialState: phase === 'initiate' ? undefined : this.lastTwoFactorContext,
    });

    const r = ladder.result;
    if (!r.ok && r.error === 'AWAITING_2FA' && r.twoFactorContext) {
      this.lastTwoFactorContext = r.twoFactorContext;
    }
    log(
      `phase=${phase} backend=${ladder.usedBackend} ok=${r.ok}${r.ok ? '' : ` error=${r.error}`}`,
    );

    return {
      ok: r.ok,
      error: r.ok ? undefined : r.error,
      message: r.ok ? undefined : r.message,
      usedBackend: ladder.usedBackend,
      twoFactorType: !r.ok ? r.twoFactorType : undefined,
      twoFactorContext: !r.ok ? r.twoFactorContext : undefined,
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
