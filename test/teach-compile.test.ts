import { describe, expect, it } from 'bun:test';
import { parseDuration } from '../src/cli.ts';
import {
  type CandidateCompilePlan,
  mapLimitSettled,
  summarizeCompileOutcomes,
} from '../src/imprint/teach.ts';

// ─── parseDuration ──────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('30m')).toBe(1_800_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('300s')).toBe(300_000);
  });

  it('parses plain milliseconds', () => {
    expect(parseDuration('5000')).toBe(5000);
    expect(parseDuration('60000')).toBe(60_000);
  });

  it('parses explicit ms suffix', () => {
    expect(parseDuration('5000ms')).toBe(5000);
  });

  it('returns null for invalid input', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
  });
});

// ─── mapLimitSettled ────────────────────────────────────────────────────────

describe('mapLimitSettled', () => {
  it('collects all successes', async () => {
    const results = await mapLimitSettled([1, 2, 3], 3, async (n) => n * 2);
    expect(results).toEqual([
      { ok: true, value: 2 },
      { ok: true, value: 4 },
      { ok: true, value: 6 },
    ]);
  });

  it('collects all failures', async () => {
    const results = await mapLimitSettled([1, 2, 3], 3, async () => {
      throw new Error('boom');
    });
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r?.ok).toBe(false);
      if (!r?.ok) {
        expect(r.error).toBeInstanceOf(Error);
        expect((r.error as Error).message).toBe('boom');
      }
    }
  });

  it('collects partial results — successes and failures', async () => {
    const results = await mapLimitSettled([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('fail-2');
      return n * 10;
    });
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;
    const results = await mapLimitSettled([1, 2, 3, 4, 5], 2, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
      return n;
    });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r?.ok)).toHaveLength(5);
  });

  it('continues processing after a failure', async () => {
    const processed: number[] = [];
    const results = await mapLimitSettled([1, 2, 3, 4], 1, async (n) => {
      processed.push(n);
      if (n === 1) throw new Error('first fails');
      return n;
    });
    expect(processed).toEqual([1, 2, 3, 4]);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]).toEqual({ ok: true, value: 2 });
    expect(results[2]).toEqual({ ok: true, value: 3 });
    expect(results[3]).toEqual({ ok: true, value: 4 });
  });

  it('handles empty input', async () => {
    const results = await mapLimitSettled([], 3, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it('handles single item success', async () => {
    const results = await mapLimitSettled([42], 1, async (n) => n);
    expect(results).toEqual([{ ok: true, value: 42 }]);
  });

  it('handles single item failure', async () => {
    const results = await mapLimitSettled([42], 1, async () => {
      throw new Error('solo fail');
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
  });
});

describe('summarizeCompileOutcomes', () => {
  // The summarizer is the pure core of the multi-tool failure-surface
  // hardening: given parallel compile outcomes + their plans, derive what
  // gets printed and whether --all-tools should abort. Keeping it pure
  // means we can drive arbitrary shapes here without spinning up real
  // compile pipelines.
  function plan(name: string): CandidateCompilePlan {
    return {
      workflowKey: name,
      startFrom: 'generate',
      candidate: {
        toolName: name,
        description: '',
        rationale: '',
        confidence: 1,
        primary: false,
        requestSeqs: [],
        representativeSeqs: [],
        eventSeqs: [],
        expectedOutput: '',
        likelyParams: [],
        dependencySeqs: [],
      },
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: TeachToolResult shape isn't relevant here
  const fakeResult = (name: string): any => ({ workflow: { toolName: name } });

  it('returns all successes when every plan compiled', () => {
    const plans = [plan('a'), plan('b'), plan('c')];
    const outcomes = [
      { ok: true as const, value: fakeResult('a') },
      { ok: true as const, value: fakeResult('b') },
      { ok: true as const, value: fakeResult('c') },
    ];
    const summary = summarizeCompileOutcomes(outcomes, plans);
    expect(summary.detected).toBe(3);
    expect(summary.successes).toHaveLength(3);
    expect(summary.successNames).toEqual(['a', 'b', 'c']);
    expect(summary.failures).toHaveLength(0);
  });

  it('captures failure first-line and name when a tool fails', () => {
    const plans = [plan('alpha'), plan('beta')];
    const outcomes = [
      { ok: true as const, value: fakeResult('alpha') },
      {
        ok: false as const,
        error: new Error('compile failed\nstack trace line 2\nstack trace line 3'),
      },
    ];
    const summary = summarizeCompileOutcomes(outcomes, plans);
    expect(summary.successes).toHaveLength(1);
    expect(summary.successNames).toEqual(['alpha']);
    expect(summary.failures).toEqual([{ name: 'beta', firstLineError: 'compile failed' }]);
  });

  it('handles a null outcome (mapLimitSettled returning null for a cancelled task)', () => {
    const plans = [plan('a')];
    const outcomes = [null];
    const summary = summarizeCompileOutcomes(outcomes, plans);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.name).toBe('a');
  });

  it('falls back to workflowKey when candidate is absent', () => {
    const plans: CandidateCompilePlan[] = [{ workflowKey: 'fallback-key', startFrom: 'generate' }];
    const outcomes = [{ ok: false as const, error: 'something' }];
    const summary = summarizeCompileOutcomes(outcomes, plans);
    expect(summary.failures[0]?.name).toBe('fallback-key');
  });

  it('stringifies non-Error errors safely', () => {
    const plans = [plan('x')];
    const outcomes = [{ ok: false as const, error: { code: 42 } }];
    const summary = summarizeCompileOutcomes(outcomes, plans);
    expect(summary.failures[0]?.firstLineError).toBe('[object Object]');
  });
});
