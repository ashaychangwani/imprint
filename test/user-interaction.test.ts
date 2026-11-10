import { describe, expect, it } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuthCompileContext } from '../src/imprint/auth-compile-agent.ts';
import { attachRecordedAuthentication } from '../src/imprint/authentication-interaction.ts';
import { requestRecordingEvidenceStep } from '../src/imprint/master-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import {
  UserInteraction,
  type UserPromptAnswer,
  requestAgentInteraction,
  userInteractionTools,
  withUserInteraction,
} from '../src/imprint/user-interaction.ts';

const question = (message = 'Enter the fixture OTP.') => ({
  action: 'prompt_user' as const,
  prompt: { message, sensitive: true },
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('agent user interaction', () => {
  it('keeps a secret answer out of agent-visible results and expires its reference', async () => {
    const interaction = new UserInteraction(async () => ({
      status: 'answered',
      value: 'fixture-otp-845913',
    }));
    const result = await interaction.request(question());
    expect(result.status).toBe('answered');
    if (!('value' in result)) throw new Error('Expected an answer');
    expect(JSON.stringify(result)).not.toContain('fixture-otp-845913');
    expect(interaction.resolve({ code: result.value })).toEqual({ code: 'fixture-otp-845913' });
    expect(interaction.sanitize('answer=fixture-otp-845913')).toBe(`answer=${result.value}`);
    interaction.clear();
    expect(() => interaction.resolve(result.value)).toThrow('Unknown or expired');
  });

  it('serializes questions from independent agents and preserves ordinary answers', async () => {
    const asked: string[] = [];
    const answers: Array<(answer: UserPromptAnswer) => void> = [];
    const interaction = new UserInteraction(async (prompt) => {
      asked.push(prompt.message);
      return await new Promise((resolve) => answers.push(resolve));
    });
    const first = interaction.request(question('First agent'));
    const second = interaction.request({
      action: 'prompt_user',
      prompt: { message: 'Second agent', options: ['Approved', 'Declined'], sensitive: false },
    });
    await tick();
    expect(asked).toEqual(['First agent']);
    answers[0]?.({ status: 'answered', value: 'fixture-code' });
    await first;
    await tick();
    expect(asked).toEqual(['First agent', 'Second agent']);
    answers[1]?.({ status: 'answered', value: 'Declined' });
    expect(await second).toEqual({ status: 'answered', value: 'Declined' });
    interaction.clear();
  });

  it('returns explicit unavailable and cancelled outcomes without assuming approval', async () => {
    expect(await new UserInteraction().request(question())).toMatchObject({
      status: 'unavailable',
    });
    const cancelled = new UserInteraction(async () => ({
      status: 'cancelled',
      reason: 'User cancelled',
    }));
    expect(await cancelled.request(question())).toEqual({
      status: 'cancelled',
      reason: 'User cancelled',
    });
    cancelled.clear();
  });

  it('cancels a waiting question and releases the next queued agent', async () => {
    let calls = 0;
    const interaction = new UserInteraction(async () => {
      calls += 1;
      if (calls === 1) return await new Promise<UserPromptAnswer>(() => {});
      return { status: 'answered', value: 'second' };
    });
    const abort = new AbortController();
    const pending = interaction.request(question(), abort.signal).catch((error: unknown) => error);
    await tick();
    abort.abort(new Error('fixture cancellation'));
    expect(await pending).toBeInstanceOf(Error);
    expect(
      await interaction.request({
        action: 'prompt_user',
        prompt: { message: 'Next question', sensitive: false },
      }),
    ).toEqual({ status: 'answered', value: 'second' });
    interaction.clear();
  });

  it('keeps human waiting inside the run deadline', async () => {
    const interaction = new UserInteraction(
      async () => await new Promise<UserPromptAnswer>(() => {}),
    );
    interaction.setRunControl(new RunDeadline(Date.now() + 25));
    await expect(interaction.request(question())).rejects.toThrow();
    interaction.clear();
  });

  it('retains the auth host context when a compiler calls from another async context', async () => {
    const scope = new AsyncLocalStorage<string>();
    const interaction = new UserInteraction();
    scope.run('original native family', () =>
      interaction.setAuthenticate(async () => ({
        status: 'authenticated',
        message: scope.getStore() ?? 'lost context',
      })),
    );
    expect(
      await interaction.request({
        action: 'authenticate',
        plan: {
          toolName: 'authenticate_fixture',
          credentialRequestSeqs: [],
          authRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: '',
        },
      }),
    ).toMatchObject({ status: 'authenticated', message: 'original native family' });
    interaction.clear();
  });

  it('continues a retained semantic role after a general question without accepting it as proof', async () => {
    const interaction = new UserInteraction(async () => ({
      status: 'answered',
      value: 'fixture answer',
    }));
    const payloads: unknown[] = [];
    const result = await interaction.run(() =>
      requestRecordingEvidenceStep(
        {},
        z.object({ verified: z.boolean() }),
        {
          provider: 'codex-cli',
          analyzer: {
            analyze: async (_prompt, payload) => {
              payloads.push(payload);
              return {
                text:
                  payloads.length === 1
                    ? JSON.stringify({
                        interaction: {
                          action: 'prompt_user',
                          prompt: { message: 'Fixture question', sensitive: false },
                        },
                      })
                    : '{"verified":false}',
              };
            },
          },
        },
        'fixture-question',
      ),
    );
    expect(result).toEqual({ verified: false });
    expect(payloads[1]).toMatchObject({
      interactionResult: { status: 'answered', value: 'fixture answer' },
    });
    interaction.clear();
  });

  it('bridges a real compiler subprocess to its parent input host without exposing an OTP', async () => {
    const interaction = new UserInteraction(async () => ({
      status: 'answered',
      value: 'fixture-otp-child',
    }));
    await withUserInteraction(interaction, async () => {
      const modulePath = join(import.meta.dir, '../src/imprint/user-interaction.ts');
      const script = `import {requestAgentInteraction,resolveUserInput} from ${JSON.stringify(modulePath)}; const result=await requestAgentInteraction(${JSON.stringify(question())}); const resolved=await resolveUserInput(result.value); console.log(JSON.stringify({result,matched:resolved==='fixture-otp-child'}));`;
      const child = Bun.spawn([Bun.which('bun') ?? 'bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).not.toContain('fixture-otp-child');
      expect(JSON.parse(stdout)).toMatchObject({ matched: true, result: { status: 'answered' } });
    });
  });

  it('attaches the recorded auth compiler in staging and rejects unknown recording requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-auth-interaction-'));
    const interaction = new UserInteraction();
    let attempts = 0;
    let retained: AuthCompileContext | undefined;
    try {
      await interaction.run(async () => {
        attachRecordedAuthentication({
          root,
          sessionPath: join(root, 'recording.json'),
          session: {
            site: 'fixture-site',
            startedAt: '2026-01-01T00:00:00.000Z',
            url: 'https://fixture.test',
            imprintVersion: 'fixture',
            requests: [],
            events: [],
            narration: [],
            cookieSnapshots: [],
            storageSnapshots: [],
          },
          values: { password: 'fixture-pass' },
          compile: async (options) => {
            attempts += 1;
            if (retained) expect(options.context).toBe(retained);
            retained = options.context;
            expect(options.outDir).toBe(join(root, 'authenticate_fixture'));
            return {
              success: true,
              outcome: 'done',
              message: 'Verified auth',
              turns: 1,
              durationMs: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              conversationLogPath: join(root, 'log.json'),
            };
          },
        });
        const plan = {
          toolName: 'authenticate_fixture',
          credentialRequestSeqs: [],
          authRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: '',
        };
        expect(await requestAgentInteraction({ action: 'authenticate', plan })).toMatchObject({
          status: 'authenticated',
        });
        expect(
          await requestAgentInteraction({
            action: 'authenticate',
            plan: { ...plan, authRequestSeqs: [99] },
          }),
        ).toMatchObject({ status: 'failed' });
        await requestAgentInteraction({
          action: 'authenticate',
          plan: { ...plan, notes: 'Consumer still failed; inspect current context' },
        });
        expect(attempts).toBe(2);
      });
    } finally {
      interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('coalesces only in-flight auth work and keeps another caller alive after cancellation', async () => {
    const interaction = new UserInteraction();
    const plan = {
      toolName: 'authenticate_fixture',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    };
    let calls = 0;
    let finish!: () => void;
    let sharedSignal: AbortSignal | undefined;
    interaction.setAuthenticate(async (_plan, signal) => {
      calls += 1;
      sharedSignal = signal;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { status: 'authenticated', message: 'Current auth workspace passed' };
    });
    const abort = new AbortController();
    const first = interaction
      .request({ action: 'authenticate', plan }, abort.signal)
      .catch((error: unknown) => error);
    const second = interaction.request({ action: 'authenticate', plan });
    await tick();
    expect(calls).toBe(1);
    abort.abort(new Error('First consumer cancelled'));
    expect(await first).toBeInstanceOf(Error);
    expect(sharedSignal?.aborted).toBe(false);
    finish();
    expect(await second).toMatchObject({ status: 'authenticated' });
    await interaction.request({ action: 'authenticate', plan });
    expect(calls).toBe(2); // A completed result is never a cached consumer pass.
    await interaction.clear();
  });

  it('aborts unobserved auth work, serializes its teardown, and awaits run cleanup once', async () => {
    const interaction = new UserInteraction();
    const plan = {
      toolName: 'authenticate_fixture',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    };
    let calls = 0;
    let cancelled = false;
    let cleaned = 0;
    interaction.addCleanup(async () => {
      await tick();
      cleaned += 1;
    });
    interaction.setAuthenticate(async (_plan, signal) => {
      calls += 1;
      if (calls === 1)
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      return { status: 'failed', message: 'New evidence still requires agent recovery' };
    });
    const abort = new AbortController();
    const first = interaction
      .request({ action: 'authenticate', plan }, abort.signal)
      .catch((error: unknown) => error);
    await tick();
    abort.abort(new Error('Only consumer cancelled'));
    expect(await first).toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
    expect(
      await interaction.request({
        action: 'authenticate',
        plan: { ...plan, notes: 'Different failure observation' },
      }),
    ).toMatchObject({ status: 'failed' });
    expect(calls).toBe(2);
    await Promise.all([interaction.clear(), interaction.clear()]);
    expect(cleaned).toBe(1);
  });

  it('exposes ordinary compiler interaction tools', () => {
    expect(userInteractionTools().map(({ name }) => name)).toEqual([
      'prompt_user',
      'authenticate',
      'list_authentication_contexts',
      'authentication_status',
      'await_authentication',
      'cancel_authentication',
    ]);
  });
  it('returns discoverable pending handles and keeps deliberate ownership across a cancelled wait', async () => {
    const interaction = new UserInteraction();
    let finish!: () => void;
    let sharedSignal: AbortSignal | undefined;
    interaction.setAuthenticate(async (_plan, signal) => {
      sharedSignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: 'authenticated', message: 'Synthetic action passed' };
    });
    const handle = interaction.startAuthentication({
      toolName: 'fixture_auth',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    });
    expect(handle).toMatchObject({ status: 'pending', state: 'queued', owners: 1 });
    expect(interaction.authenticationContexts()[0]).toMatchObject({
      contextRef: handle.contextRef,
      operations: [{ operationId: handle.operationId }],
    });
    await tick();
    const abort = new AbortController();
    const waiting = interaction
      .authenticationControl(
        { action: 'await', operationId: handle.operationId, waitMs: 45_000 },
        abort.signal,
      )
      .catch((error: unknown) => error);
    abort.abort(new Error('Transient tool wait cancelled'));
    expect(await waiting).toBeInstanceOf(Error);
    expect(sharedSignal?.aborted).toBe(false);
    finish();
    expect(
      await interaction.authenticationControl({
        action: 'await',
        operationId: handle.operationId,
        waitMs: 45_000,
      }),
    ).toMatchObject({ state: 'completed', result: { status: 'authenticated' } });
    await interaction.clear();
  });

  it('cancels queued operations promptly without releasing the running predecessor early', async () => {
    const interaction = new UserInteraction();
    const calls: string[] = [];
    let release!: () => void;
    interaction.setAuthenticate(async (plan) => {
      calls.push(plan.toolName);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { status: 'failed', message: 'Fixture observation' };
    });
    const plan = {
      toolName: 'first_auth',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    };
    const first = interaction.startAuthentication(plan);
    await tick();
    const queued = interaction.startAuthentication({ ...plan, toolName: 'queued_auth' });
    await interaction.authenticationControl({
      action: 'cancel',
      operationId: queued.operationId,
      ownerRef: queued.ownerRef,
    });
    expect(
      await interaction.authenticationControl({
        action: 'await',
        operationId: queued.operationId,
        waitMs: 45_000,
      }),
    ).toMatchObject({ state: 'cancelled' });
    const next = interaction.startAuthentication({ ...plan, toolName: 'next_auth' });
    await tick();
    expect(calls).toEqual(['first_auth']);
    release();
    await interaction.authenticationControl({
      action: 'await',
      operationId: next.operationId,
      waitMs: 45_000,
    });
    expect(calls).toEqual(['first_auth', 'next_auth']);
    expect(
      await interaction.authenticationControl({ action: 'status', operationId: first.operationId }),
    ).toMatchObject({ state: 'completed' });
    await interaction.clear();
  });

  it('releases one explicit coalesced owner without cancelling the other owner', async () => {
    const interaction = new UserInteraction();
    let calls = 0;
    let finish!: () => void;
    let sharedSignal: AbortSignal | undefined;
    interaction.setAuthenticate(async (_plan, signal) => {
      calls += 1;
      sharedSignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: 'authenticated', message: 'Fixture' };
    });
    const plan = {
      toolName: 'fixture_auth',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    };
    const first = interaction.startAuthentication(plan);
    const second = interaction.startAuthentication(plan);
    expect(second.operationId).toBe(first.operationId);
    expect(second.ownerRef).not.toBe(first.ownerRef);
    await tick();
    await interaction.authenticationControl({
      action: 'cancel',
      operationId: first.operationId,
      ownerRef: first.ownerRef,
    });
    expect(sharedSignal?.aborted).toBe(false);
    expect(calls).toBe(1);
    finish();
    expect(
      await interaction.authenticationControl({
        action: 'await',
        operationId: second.operationId,
        waitMs: 45_000,
      }),
    ).toMatchObject({ state: 'completed', owners: 1 });
    await interaction.clear();
  });

  it('uses the current tool request signal without changing the shared tool instance', async () => {
    const interaction = new UserInteraction(
      async (_prompt, signal) =>
        await new Promise<UserPromptAnswer>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const tool = userInteractionTools()[0];
    if (!tool) throw new Error('Missing synthetic interaction tool');
    const abort = new AbortController();
    const pending = interaction
      .run(() => tool.handler({ message: 'Fixture', sensitive: false }, { signal: abort.signal }))
      .catch((error: unknown) => error);
    await tick();
    abort.abort(new Error('SDK request cancelled'));
    expect(await pending).toBeInstanceOf(Error);
    await interaction.clear();
  });

  it('reuses an explicit context across tool labels and keeps new contexts isolated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-explicit-context-'));
    const interaction = new UserInteraction();
    const compiled: Array<{ context: AuthCompileContext | undefined; outDir: string | undefined }> =
      [];
    try {
      await interaction.run(async () => {
        attachRecordedAuthentication({
          root,
          sessionPath: join(root, 'recording.json'),
          session: {
            site: 'fixture-site',
            startedAt: '2026-01-01T00:00:00.000Z',
            url: 'https://fixture.test',
            imprintVersion: 'fixture',
            requests: [],
            events: [],
            narration: [],
            cookieSnapshots: [],
            storageSnapshots: [],
          },
          values: {},
          compile: async (options) => {
            compiled.push({ context: options.context, outDir: options.outDir });
            return {
              success: false,
              outcome: 'give_up',
              message: 'Synthetic result',
              turns: 1,
              durationMs: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              conversationLogPath: join(root, 'log.json'),
            };
          },
        });
        const plan = {
          toolName: 'first_label',
          credentialRequestSeqs: [],
          authRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: '',
        };
        const first = await requestAgentInteraction({ action: 'authenticate', plan });
        if (!('contextRef' in first) || !first.contextRef)
          throw new Error('Missing context reference');
        await requestAgentInteraction({
          action: 'authenticate',
          plan: { ...plan, toolName: 'different_label', contextRef: first.contextRef },
        });
        await requestAgentInteraction({
          action: 'authenticate',
          plan: { ...plan, newContext: true },
        });
        expect(compiled[1]?.context).toBe(compiled[0]?.context);
        expect(compiled[1]?.outDir).toBe(compiled[0]?.outDir);
        expect(compiled[2]?.context).not.toBe(compiled[0]?.context);
        expect(compiled[2]?.outDir).not.toBe(compiled[0]?.outDir);
        await expect(
          requestAgentInteraction({
            action: 'authenticate',
            plan: { ...plan, contextRef: 'stale-fixture-ref' },
          }),
        ).rejects.toThrow('Unknown or expired');
        expect(interaction.authenticationContexts()).toHaveLength(2);
      });
    } finally {
      await interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the queue until active cancellation cleanup really settles', async () => {
    const interaction = new UserInteraction();
    let calls = 0;
    let finishCleanup!: () => void;
    let cleanupEntered!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    interaction.setAuthenticate(async (_plan, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        cleanupEntered();
        await new Promise<void>((resolve) => {
          finishCleanup = resolve;
        });
      }
      return { status: 'failed', message: 'Fixture observation' };
    });
    const plan = {
      toolName: 'fixture_auth',
      credentialRequestSeqs: [],
      authRequestSeqs: [],
      credentialNames: [],
      captures: [],
      notes: '',
    };
    const active = interaction.startAuthentication(plan);
    await tick();
    await interaction.authenticationControl({
      action: 'cancel',
      operationId: active.operationId,
      ownerRef: active.ownerRef,
    });
    await cleanupStarted;
    const replacement = interaction.startAuthentication({ ...plan, notes: 'New caller' });
    await tick();
    expect(calls).toBe(1);
    expect(
      await interaction.authenticationControl({
        action: 'status',
        operationId: active.operationId,
      }),
    ).toMatchObject({ state: 'cancelling' });
    finishCleanup();
    await interaction.authenticationControl({
      action: 'await',
      operationId: replacement.operationId,
      waitMs: 45_000,
    });
    expect(calls).toBe(2);
    expect(
      await interaction.authenticationControl({
        action: 'status',
        operationId: active.operationId,
      }),
    ).toMatchObject({ state: 'cancelled' });
    await interaction.clear();
  });
});
