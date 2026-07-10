/**
 * Live auth verification. The compile agent defines the auth program; this
 * class only preserves one browser session and continuation state while running
 * the requested actions.
 */

import { runWorkflowWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { createLog } from './log.ts';
import type { CredentialStore } from './runtime.ts';

const log = createLog('auth-verify');

type LadderRunner = typeof runWorkflowWithLadder;
let ladderRunner: LadderRunner = runWorkflowWithLadder;

export function __setAuthVerifierLadderForTest(fn: LadderRunner | null): void {
  ladderRunner = fn ?? runWorkflowWithLadder;
}

export interface AuthActionResult {
  action: string;
  ok: boolean;
  error?: string;
  message?: string;
  nextAction?: string;
  continuation?: Record<string, unknown>;
  usedBackend: string;
  status?: number;
  responseBodyPreview?: string;
  durationMs: number;
}

export class AuthVerifier {
  private readonly cdpPool = new Map<string, CdpBrowserFetch>();
  private continuation: Record<string, unknown> | undefined;

  constructor(
    private readonly workflowPath: string,
    private readonly credentials: CredentialStore,
  ) {}

  async runAction(
    action: string,
    parameters: Record<string, string | number | boolean> = {},
    options: { freshSession?: boolean } = {},
  ): Promise<AuthActionResult> {
    if (options.freshSession) await this.reset();
    const startedAt = Date.now();
    const ladder = await ladderRunner({
      workflowPath: this.workflowPath,
      params: { ...parameters, action },
      credentials: this.credentials,
      cdpPool: this.cdpPool,
      forceBackend: 'cdp-replay',
      initialState: this.continuation,
    });
    const durationMs = Date.now() - startedAt;
    const result = ladder.result;

    this.continuation = result.ok ? undefined : result.continuation;

    const actionResult: AuthActionResult = {
      action,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      message: result.ok ? undefined : result.message,
      nextAction: result.ok ? undefined : result.nextAction,
      continuation: result.ok ? undefined : result.continuation,
      usedBackend: ladder.usedBackend,
      status: result.ok ? undefined : result.status,
      responseBodyPreview: result.ok ? undefined : result.responseBodyPreview,
      durationMs,
    };
    log(
      `action=${JSON.stringify(action)} backend=${ladder.usedBackend} ok=${result.ok}${
        result.ok ? '' : ` error=${result.error}`
      } in ${durationMs}ms`,
    );
    return actionResult;
  }

  async drain(): Promise<void> {
    await this.reset();
  }

  private async reset(): Promise<void> {
    for (const browser of this.cdpPool.values()) {
      await browser.close().catch(() => {});
    }
    this.cdpPool.clear();
    this.continuation = undefined;
  }
}
