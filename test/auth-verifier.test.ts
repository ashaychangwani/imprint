import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import { AuthVerifier, __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { ToolResult } from '../src/imprint/types.ts';

type TestLadder = NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>;
type TestLadderArgs = Parameters<TestLadder>[0];

// Synthetic credential store — no real values (test-data hygiene).
const CREDS = {
  site: 'fixture-site',
  cookies: [],
  values: { username: 'fixture-user', password: 'hunter2' },
  storage: [],
};
const ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK = process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK;

/** Build a fake ladder that returns the given ToolResults in sequence (one per
 *  runPhase call), so AuthVerifier's budget/challenge counting can be exercised
 *  without a live browser. */
function fakeLadder(
  results: ToolResult[],
  calls?: {
    count: number;
    params: Array<Record<string, string>>;
    initialStates?: Array<Record<string, unknown> | undefined>;
  },
) {
  let i = 0;
  return (async (args: TestLadderArgs) => {
    if (calls) {
      calls.count += 1;
      calls.params.push(args.params as Record<string, string>);
      calls.initialStates?.push(args.initialState);
    }
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return { result, usedBackend: args.forceBackend ?? 'cdp-replay', attempts: [] };
  }) as TestLadder;
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

function withAuthWorkflowDir(fn: (workflowPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-verifier-'));
  const workflowPath = pathJoin(dir, 'workflow.json');
  writeFileSync(workflowPath, '{}', 'utf8');
  return fn(workflowPath).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

afterEach(() => {
  __setAuthVerifierLadderForTest(null);
  if (ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK === undefined) {
    process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = undefined;
  } else {
    process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK;
  }
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

  it('returns cached initiate success instead of re-firing a live login', async () => {
    const calls = { count: 0, params: [] as Array<Record<string, string>> };
    __setAuthVerifierLadderForTest(fakeLadder([awaiting2fa, okLogin], calls));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);

    const first = await v.runPhase('initiate');
    expect(first.error).toBe('AWAITING_2FA');

    const repeated = await v.runPhase('initiate');
    expect(repeated.error).toBe('AWAITING_2FA');
    expect(repeated.usedBackend).toBe('cached');
    expect(repeated.durationMs).toBe(0);
    expect(repeated.message).toContain('cached success signal');
    expect(calls.count).toBe(1);
    expect(v.initiatesUsed).toBe(1);
    expect(v.attemptsUsed).toBe(1);

    const completed = await v.runPhase('complete');
    expect(completed.ok).toBe(true);
    expect(calls.count).toBe(2);
    expect(calls.params).toEqual([{ action: 'initiate' }, { action: 'complete' }]);
  });

  it('clears cached initiate proof after a failed completion and preserves the challenge budget', async () => {
    const calls = { count: 0, params: [] as Array<Record<string, string>> };
    __setAuthVerifierLadderForTest(
      fakeLadder([awaiting2fa, forbidden, awaiting2fa, forbidden], calls),
    );
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);

    expect((await v.runPhase('initiate')).error).toBe('AWAITING_2FA');
    expect((await v.runPhase('complete')).error).toBe('FORBIDDEN');
    expect((await v.runPhase('initiate')).error).toBe('AWAITING_2FA');
    expect((await v.runPhase('complete')).error).toBe('FORBIDDEN');

    const refused = await v.runPhase('initiate');
    expect(refused.error).toBe('BUDGET_EXHAUSTED');
    expect(refused.usedBackend).toBe('none');
    expect(v.initiatesUsed).toBe(2);
    expect(calls.count).toBe(4);
  });

  it('threads consumed push approval progress into a completion retry', async () => {
    const calls = {
      count: 0,
      params: [] as Array<Record<string, string>>,
      initialStates: [] as Array<Record<string, unknown> | undefined>,
    };
    const failedAfterApproval: ToolResult = {
      ok: false,
      error: 'BAD_RESPONSE',
      message: 'later completion request failed',
      status: 400,
      _authContinuation: { pushApproved: true, nextRequestIndex: 4 },
    };
    __setAuthVerifierLadderForTest(fakeLadder([awaiting2fa, failedAfterApproval, okLogin], calls));
    const v = new AuthVerifier('/tmp/fixture-workflow.json', CREDS, 2);

    expect((await v.runPhase('initiate')).error).toBe('AWAITING_2FA');
    expect((await v.runPhase('complete')).error).toBe('BAD_RESPONSE');
    expect((await v.runPhase('complete')).ok).toBe(true);
    expect(calls.initialStates[2]).toEqual({
      mfaId: 'SYNTH-mfa',
      __imprintPushApproved: true,
      __imprintNextRequestIndex: 4,
    });
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

  it('does not try playbook fallback when no auth playbook exists', async () => {
    await withAuthWorkflowDir(async (workflowPath) => {
      const stateMissing: ToolResult = {
        ok: false,
        error: 'STATE_MISSING',
        message: 'mfaId missing',
      };
      const calls = { count: 0, params: [] as Array<Record<string, string>> };
      __setAuthVerifierLadderForTest(fakeLadder([stateMissing, awaiting2fa], calls));
      const v = new AuthVerifier(workflowPath, CREDS, 2);

      const r = await v.runPhase('initiate');

      expect(r.error).toBe('STATE_MISSING');
      expect(r.usedBackend).toBe('cdp-replay');
      expect(calls.count).toBe(1);
      expect(v.initiatesUsed).toBe(0);
      expect(v.attemptsUsed).toBe(1);
    });
  });

  it('does not try playbook fallback by default even when an auth playbook exists', async () => {
    await withAuthWorkflowDir(async (workflowPath) => {
      mkdirSync(dirname(workflowPath), { recursive: true });
      writeFileSync(pathJoin(dirname(workflowPath), 'playbook.yaml'), 'steps: []\n', 'utf8');
      const stateMissing: ToolResult = {
        ok: false,
        error: 'STATE_MISSING',
        message: 'mfaId missing',
      };
      const calls = { count: 0, params: [] as Array<Record<string, string>> };
      __setAuthVerifierLadderForTest(fakeLadder([stateMissing, awaiting2fa], calls));
      const v = new AuthVerifier(workflowPath, CREDS, 2);

      const r = await v.runPhase('initiate');

      expect(r.error).toBe('STATE_MISSING');
      expect(r.usedBackend).toBe('cdp-replay');
      expect(calls.count).toBe(1);
      expect(v.initiatesUsed).toBe(0);
      expect(v.attemptsUsed).toBe(1);
    });
  });

  it('falls back to an auth playbook only when explicitly enabled', async () => {
    await withAuthWorkflowDir(async (workflowPath) => {
      process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = '1';
      mkdirSync(dirname(workflowPath), { recursive: true });
      writeFileSync(pathJoin(dirname(workflowPath), 'playbook.yaml'), 'steps: []\n', 'utf8');
      const stateMissing: ToolResult = {
        ok: false,
        error: 'STATE_MISSING',
        message: 'mfaId missing',
      };
      const calls = { count: 0, params: [] as Array<Record<string, string>> };
      __setAuthVerifierLadderForTest(fakeLadder([stateMissing, awaiting2fa], calls));
      const v = new AuthVerifier(workflowPath, CREDS, 2);

      const r = await v.runPhase('initiate');

      expect(r.error).toBe('AWAITING_2FA');
      expect(r.usedBackend).toBe('playbook');
      expect(calls.count).toBe(2);
      expect(v.initiatesUsed).toBe(1);
      expect(v.attemptsUsed).toBe(1);
    });
  });
});
