import { describe, expect, it } from 'bun:test';
import type { CompileAgentResult } from '../src/imprint/compile-agent-types.ts';
import {
  type CompilerResume,
  runCompileWithProviderRecovery,
} from '../src/imprint/compile-provider-recovery.ts';
import {
  ProviderDeadlineError,
  ProviderReportedError,
  ProviderUnavailableError,
} from '../src/imprint/provider-retry.ts';

function result(
  overrides: Partial<CompileAgentResult> & Pick<CompileAgentResult, 'outcome' | 'message'>,
): CompileAgentResult {
  const providerError = overrides.providerInterruption
    ? new ProviderReportedError(
        'fixture',
        overrides.providerInterruption === 'transient_safety_filter'
          ? { messages: ['exact provider safety refusal'] }
          : { statuses: [529], codes: ['overloaded_error'] },
        undefined,
        overrides.providerInterruption,
      )
    : overrides.providerError;
  return {
    success: overrides.outcome === 'done',
    conversationLogPath: '/tmp/compile-log.json',
    turns: 0,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    providerError,
    ...overrides,
  };
}

describe('runCompileWithProviderRecovery', () => {
  it('does not start a compiler segment after the absolute deadline', async () => {
    let calls = 0;
    await expect(
      runCompileWithProviderRecovery({
        run: async () => {
          calls++;
          return result({ outcome: 'done', message: 'too late' });
        },
        deadlineMs: 99,
        retry: { now: () => 100 },
      }),
    ).rejects.toBeInstanceOf(ProviderDeadlineError);
    expect(calls).toBe(0);
  });

  it('resumes the exact provider session and aggregates segment usage', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    const waits: number[] = [];
    let calls = 0;

    const final = await runCompileWithProviderRecovery({
      run: async (resume) => {
        resumes.push(resume);
        calls++;
        if (calls === 1) {
          return result({
            outcome: 'error',
            message: 'provider is temporarily overloaded',
            providerInterruption: 'capacity_or_overload',
            sessionId: 'session-123',
            turns: 3,
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 2,
          });
        }
        return result({
          outcome: 'done',
          message: 'verified',
          sessionId: 'session-123',
          turns: 2,
          inputTokens: 7,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 1,
        });
      },
      retry: {
        initialDelayMs: 10,
        random: () => 0.5,
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });

    expect(final).toMatchObject({
      success: true,
      outcome: 'done',
      sessionId: 'session-123',
      turns: 5,
      inputTokens: 17,
      outputTokens: 9,
      cacheReadInputTokens: 9,
      cacheCreationInputTokens: 3,
    });
    expect(waits).toEqual([10]);
    expect(resumes[0]).toBeUndefined();
    expect(resumes[1]).toMatchObject({ sessionId: 'session-123' });
    expect(resumes[1]?.message).toContain('Continue this same compile');
  });

  it('does not replace an interrupted compiler session when no session id was returned', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    await expect(
      runCompileWithProviderRecovery({
        run: async (resume) => {
          resumes.push(resume);
          return result({
            outcome: 'error',
            message: '429 too many requests',
            providerInterruption: 'capacity_or_overload',
          });
        },
        retry: { sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(resumes).toEqual([undefined]);
  });

  it('continues from an existing checkpoint session before handling capacity', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    const final = await runCompileWithProviderRecovery({
      initialResume: { sessionId: 'checkpoint-session', message: 'checkpoint result' },
      run: async (resume) => {
        resumes.push(resume);
        return resumes.length === 1
          ? result({
              outcome: 'error',
              message: 'service overloaded',
              providerInterruption: 'capacity_or_overload',
              sessionId: 'checkpoint-session',
            })
          : result({
              outcome: 'checkpoint',
              message: 'next checkpoint',
              sessionId: 'checkpoint-session',
            });
      },
      retry: { sleep: async () => {} },
    });

    expect(final.outcome).toBe('checkpoint');
    expect(resumes[0]).toEqual({
      sessionId: 'checkpoint-session',
      message: 'checkpoint result',
    });
    expect(resumes[1]?.sessionId).toBe('checkpoint-session');
    expect(resumes[1]?.message).toContain('Continue this same compile');
  });

  it('resumes the exact outer session after nested verifier unavailability', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    const nestedCause = new ProviderUnavailableError(new Error('nested verifier unavailable'));
    const final = await runCompileWithProviderRecovery({
      run: async (resume) => {
        resumes.push(resume);
        if (resumes.length === 1) {
          return result({
            outcome: 'error',
            message: 'nested live verifier provider unavailable',
            sessionId: 'outer-compile-session',
            providerInterruption: 'capacity_or_overload',
            providerError: new ProviderReportedError(
              'nested-live-verifier',
              { codes: ['provider_unavailable'] },
              nestedCause,
              'capacity_or_overload',
            ),
          });
        }
        return result({
          outcome: 'done',
          message: 'verified',
          sessionId: 'outer-compile-session',
        });
      },
      retry: { sleep: async () => {} },
    });

    expect(final.outcome).toBe('done');
    expect(resumes[1]?.sessionId).toBe('outer-compile-session');
  });

  it('keeps an existing session when an interrupted resume omits the id', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    const final = await runCompileWithProviderRecovery({
      initialResume: { sessionId: 'checkpoint-session', message: 'checkpoint result' },
      run: async (resume) => {
        resumes.push(resume);
        return resumes.length === 1
          ? result({
              outcome: 'error',
              message: 'service overloaded',
              providerInterruption: 'capacity_or_overload',
              turns: 1,
            })
          : result({ outcome: 'done', message: 'verified', sessionId: 'checkpoint-session' });
      },
      retry: { sleep: async () => {} },
    });

    expect(final.outcome).toBe('done');
    expect(resumes[1]?.sessionId).toBe('checkpoint-session');
  });

  it('stops when an initial checkpoint resumes into a different session', async () => {
    let calls = 0;
    const final = await runCompileWithProviderRecovery({
      initialResume: { sessionId: 'expected-session', message: 'checkpoint result' },
      run: async () => {
        calls++;
        return result({
          outcome: 'error',
          message: 'provider overloaded',
          sessionId: 'replacement-session',
        });
      },
      retry: { sleep: async () => {} },
    });

    expect(calls).toBe(1);
    expect(final).toMatchObject({
      success: false,
      outcome: 'error',
      sessionId: 'expected-session',
    });
    expect(final.message).toContain('session changed');
  });

  it('pins the first returned session and rejects a later replacement', async () => {
    let calls = 0;
    const final = await runCompileWithProviderRecovery({
      run: async () => {
        calls++;
        return calls === 1
          ? result({
              outcome: 'error',
              message: 'provider overloaded',
              providerInterruption: 'capacity_or_overload',
              sessionId: 'first-session',
            })
          : result({
              outcome: 'done',
              message: 'wrong conversation completed',
              sessionId: 'replacement-session',
            });
      },
      retry: { sleep: async () => {} },
    });

    expect(calls).toBe(2);
    expect(final).toMatchObject({ outcome: 'error', sessionId: 'first-session' });
    expect(final.message).toContain('replacement-session');
  });

  it('resumes the exact session after an adapter-confirmed transient safety refusal', async () => {
    const resumes: Array<CompilerResume | undefined> = [];
    const retryReasons: string[] = [];
    const final = await runCompileWithProviderRecovery({
      run: async (resume) => {
        resumes.push(resume);
        return resumes.length === 1
          ? result({
              outcome: 'error',
              message: 'appears to violate our Usage Policy',
              providerInterruption: 'transient_safety_filter',
              sessionId: 'same-session',
              turns: 1,
            })
          : result({
              outcome: 'done',
              message: 'verified',
              sessionId: 'same-session',
              turns: 2,
            });
      },
      onRetry: ({ reason }) => retryReasons.push(reason),
      retry: { sleep: async () => {} },
    });

    expect(final.outcome).toBe('done');
    expect(final.turns).toBe(3);
    expect(resumes[1]).toMatchObject({ sessionId: 'same-session' });
    expect(retryReasons).toEqual(['transient_safety_filter']);
  });

  it('does not retry an unmarked deterministic policy failure', async () => {
    let calls = 0;
    const final = await runCompileWithProviderRecovery({
      run: async () => {
        calls++;
        return result({ outcome: 'error', message: 'request violates content policy' });
      },
      retry: { sleep: async () => {} },
    });

    expect(calls).toBe(1);
    expect(final.outcome).toBe('error');
  });

  it('throws run-level provider unavailability over partial work without a session id', async () => {
    let calls = 0;
    await expect(
      runCompileWithProviderRecovery({
        run: async () => {
          calls++;
          return result({
            outcome: 'error',
            message: 'provider overloaded',
            providerInterruption: 'capacity_or_overload',
            turns: 1,
          });
        },
        retry: { sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toBe(1);
  });

  it('returns deterministic compiler failures immediately', async () => {
    let calls = 0;
    const final = await runCompileWithProviderRecovery({
      run: async () => {
        calls++;
        return result({ outcome: 'error', message: 'workflow schema validation failed' });
      },
      retry: { sleep: async () => {} },
    });

    expect(calls).toBe(1);
    expect(final.message).toContain('schema validation failed');
  });

  it('never treats target-site live HTTP status text as compiler-provider capacity', async () => {
    for (const status of [429, 503, 529]) {
      let calls = 0;
      const final = await runCompileWithProviderRecovery({
        run: async () => {
          calls++;
          return result({
            outcome: 'error',
            message: `live verification failed: target site returned HTTP ${status}`,
            sessionId: 'same-session',
          });
        },
        retry: { sleep: async () => {} },
      });

      expect(calls).toBe(1);
      expect(final.outcome).toBe('error');
      expect(final.message).toContain(`HTTP ${status}`);
    }
  });

  it('does not retry an unmarked thrown target-site error', async () => {
    let calls = 0;
    await expect(
      runCompileWithProviderRecovery({
        run: async () => {
          calls++;
          throw new Error('target-site request returned 429');
        },
        retry: { sleep: async () => {} },
      }),
    ).rejects.toThrow('target-site request returned 429');
    expect(calls).toBe(1);
  });

  it('propagates cancellation that arrives while a compiler segment is running', async () => {
    const controller = new AbortController();
    await expect(
      runCompileWithProviderRecovery({
        run: async () => {
          controller.abort(new Error('cancelled by operator'));
          return result({ outcome: 'error', message: 'compiler process exited' });
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by operator');
  });

  it('shares a caller-approved deadline extension with the resumed segment', async () => {
    let now = 100;
    let calls = 0;
    const segmentDeadlines: Array<number | undefined> = [];
    const final = await runCompileWithProviderRecovery({
      run: async (_resume, segmentDeadline) => {
        segmentDeadlines.push(segmentDeadline?.deadlineMs);
        calls++;
        return calls === 1
          ? result({
              outcome: 'error',
              message: 'provider overloaded',
              providerInterruption: 'capacity_or_overload',
              sessionId: 'session-123',
            })
          : result({ outcome: 'done', message: 'verified', sessionId: 'session-123' });
      },
      deadlineMs: 110,
      onDeadlineReached: async () => 50,
      retry: {
        initialDelayMs: 100,
        random: () => 0.5,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    });

    expect(final.outcome).toBe('done');
    expect(segmentDeadlines).toEqual([110, 160]);
  });

  it('reports wall duration including provider backoff', async () => {
    let now = 1_000;
    let calls = 0;
    const final = await runCompileWithProviderRecovery({
      run: async () => {
        calls++;
        return calls === 1
          ? result({
              outcome: 'error',
              message: 'provider overloaded',
              providerInterruption: 'capacity_or_overload',
              sessionId: 'same-session',
              durationMs: 4,
            })
          : result({
              outcome: 'done',
              message: 'verified',
              sessionId: 'same-session',
              durationMs: 5,
            });
      },
      retry: {
        initialDelayMs: 25,
        random: () => 0.5,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    });

    expect(final.durationMs).toBe(25);
  });

  it('reports provider timeout without blaming the artifact', async () => {
    let now = 100;
    const recovery = runCompileWithProviderRecovery({
      run: async () =>
        result({
          outcome: 'error',
          message: 'service temporarily unavailable',
          providerInterruption: 'capacity_or_overload',
          sessionId: 'session-123',
        }),
      deadlineMs: 110,
      retry: {
        initialDelayMs: 100,
        random: () => 0.5,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    });

    await expect(recovery).rejects.toThrow('artifact was not treated as the cause');
  });
});
