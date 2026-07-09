import { describe, expect, it } from 'bun:test';
import { TimeoutError, withTimeout, withTimeoutCleanup } from '../src/imprint/concurrency.ts';

describe('withTimeout', () => {
  it('resolves with the work value when it finishes before the deadline', async () => {
    const out = await withTimeout(Promise.resolve('ok'), 1000, 'unit');
    expect(out).toBe('ok');
  });

  it('throws TimeoutError when the work exceeds the deadline', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(slow, 10, 'unit')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates a real rejection unchanged (not as a timeout)', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, 1000, 'unit')).rejects.toThrow('boom');
  });

  it('runs cleanup when the deadline fires', async () => {
    let cleaned = false;
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));

    await expect(
      withTimeoutCleanup(slow, 10, 'unit', () => {
        cleaned = true;
      }),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(cleaned).toBe(true);
  });
});

describe('TimeoutError', () => {
  it('names the label and the deadline in seconds', () => {
    const err = new TimeoutError('build planner', 300_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('build planner');
    expect(err.message).toContain('300s');
  });
});
