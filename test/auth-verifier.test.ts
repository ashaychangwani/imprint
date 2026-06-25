import { afterEach, describe, expect, it } from 'bun:test';
import { AuthVerifier, __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { ToolResult } from '../src/imprint/types.ts';

// Synthetic credential store — no real values (test-data hygiene).
const CREDS = {
  site: 'fixture-site',
  cookies: [],
  values: { username: 'fixture-user', password: 'hunter2' },
};

/** Build a fake ladder that returns the given ToolResults in sequence (one per
 *  runPhase call), so AuthVerifier's budget/challenge counting can be exercised
 *  without a live browser. */
function fakeLadder(results: ToolResult[]) {
  let i = 0;
  return (async () => {
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return { result, usedBackend: 'cdp-replay', attempts: [] };
  }) as unknown as Parameters<typeof __setAuthVerifierLadderForTest>[0];
}

const awaiting2fa: ToolResult = {
  ok: false,
  error: 'AWAITING_2FA',
  message: 'awaiting 2FA',
  status: 200,
  twoFactorType: 'push',
  twoFactorContext: { mfaId: 'SYNTH-mfa' },
};
const forbidden: ToolResult = {
  ok: false,
  error: 'FORBIDDEN',
  message: 'edge blocked',
  status: 403,
  responseBodyPreview: 'Access Denied',
};
const okLogin: ToolResult = { ok: true, data: {} };

afterEach(() => {
  __setAuthVerifierLadderForTest(null);
});

describe('AuthVerifier — challenge vs attempt budgets', () => {
  it('a pre-challenge 403 does NOT burn the challenge budget; a later good initiate still runs', async () => {
    __setAuthVerifierLadderForTest(fakeLadder([forbidden, forbidden, awaiting2fa]));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);

    const r1 = await v.runPhase('initiate');
    expect(r1.error).toBe('FORBIDDEN');
    const r2 = await v.runPhase('initiate');
    expect(r2.error).toBe('FORBIDDEN');
    // Two 403s: attempts climbed, but zero challenges spent.
    expect(v.attemptsUsed).toBe(2);
    expect(v.initiatesUsed).toBe(0);

    // Third initiate is still allowed and reaches the challenge.
    const r3 = await v.runPhase('initiate');
    expect(r3.error).toBe('AWAITING_2FA');
    expect(v.initiatesUsed).toBe(1);
    expect(v.attemptsUsed).toBe(3);
  });

  it('refuses BUDGET_EXHAUSTED once maxInitiate challenges have been delivered', async () => {
    __setAuthVerifierLadderForTest(fakeLadder([awaiting2fa]));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);

    expect((await v.runPhase('initiate')).error).toBe('AWAITING_2FA');
    expect((await v.runPhase('initiate')).error).toBe('AWAITING_2FA');
    const third = await v.runPhase('initiate');
    expect(third.error).toBe('BUDGET_EXHAUSTED');
    expect(third.usedBackend).toBe('none');
    expect(v.initiatesUsed).toBe(2);
  });

  it('refuses ATTEMPT_BUDGET_EXHAUSTED when every initiate fails pre-challenge', async () => {
    __setAuthVerifierLadderForTest(fakeLadder([forbidden]));
    // maxInitiate=2, maxInitiateAttempts=3
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2, 3);

    for (let n = 1; n <= 3; n++) {
      const r = await v.runPhase('initiate');
      expect(r.error).toBe('FORBIDDEN');
      // increment-order invariant: attempts climb, challenges never do
      expect(v.attemptsUsed).toBe(n);
      expect(v.initiatesUsed).toBe(0);
    }
    const refused = await v.runPhase('initiate');
    expect(refused.error).toBe('ATTEMPT_BUDGET_EXHAUSTED');
    expect(refused.usedBackend).toBe('none');
  });

  it('attempt cap clamps to be >= challenge cap', () => {
    // ask for fewer attempts than challenges → clamped up to maxInitiate
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 4, 1);
    expect(v.maxInitiateAttempts).toBe(4);
  });

  it('RATE_LIMITED / AUTH_EXPIRED do NOT count as delivered challenges', async () => {
    const rateLimited: ToolResult = {
      ok: false,
      error: 'RATE_LIMITED',
      message: 'rl',
      status: 429,
    };
    const authExpired: ToolResult = {
      ok: false,
      error: 'AUTH_EXPIRED',
      message: 'ax',
      status: 401,
    };
    __setAuthVerifierLadderForTest(fakeLadder([rateLimited, authExpired]));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2, 5);

    await v.runPhase('initiate');
    await v.runPhase('initiate');
    expect(v.initiatesUsed).toBe(0);
    expect(v.attemptsUsed).toBe(2);
  });

  it('a completed (ok) login counts as one delivered challenge', async () => {
    __setAuthVerifierLadderForTest(fakeLadder([okLogin]));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);
    const r = await v.runPhase('initiate');
    expect(r.ok).toBe(true);
    expect(v.initiatesUsed).toBe(1);
  });
});
