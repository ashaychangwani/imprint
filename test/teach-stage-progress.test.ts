import { describe, expect, it } from 'bun:test';
import { withTeachStageProgress } from '../src/imprint/teach-stage-progress.ts';

describe('teach stage progress', () => {
  it('reports a pending stage and stops its timer when the result arrives', async () => {
    const result = Promise.withResolvers<string>();
    const pending = Promise.withResolvers<void>();
    const messages: string[] = [];
    const work = withTeachStageProgress(
      {
        label: 'fixture_search: implementation planning',
        intervalMs: 5,
        report(message) {
          messages.push(message);
          if (message.includes(' pending ')) pending.resolve();
        },
      },
      () => result.promise,
    );
    await pending.promise;
    expect(messages[0]).toBe('fixture_search: implementation planning started');
    expect(messages.at(-1)).toMatch(/planning pending \(\d+s elapsed\)/);
    result.resolve('fixture plan');
    expect(await work).toBe('fixture plan');
    expect(messages.at(-1)).toMatch(/planning finished \(\d+s elapsed\)/);
    const settledCount = messages.length;
    await Bun.sleep(20);
    expect(messages).toHaveLength(settledCount);
  });

  it('preserves the original failure and stops reporting after rejection', async () => {
    const result = Promise.withResolvers<never>();
    const pending = Promise.withResolvers<void>();
    const failure = new Error('fixture agent failure');
    const messages: string[] = [];
    const work = withTeachStageProgress(
      {
        label: 'master: implementation plan review',
        intervalMs: 5,
        report(message) {
          messages.push(message);
          if (message.includes(' pending ')) pending.resolve();
          if (message.includes(' stopped ')) throw new Error('fixture reporting failure');
        },
      },
      () => result.promise,
    );
    await pending.promise;
    result.reject(failure);
    await expect(work).rejects.toBe(failure);
    expect(messages.at(-1)).toMatch(/review stopped \(\d+s elapsed\)/);
    expect(messages.some((message) => message.includes('finished'))).toBe(false);
    const settledCount = messages.length;
    await Bun.sleep(20);
    expect(messages).toHaveLength(settledCount);
  });

  it('keeps concurrent tool stages separate when one finishes first', async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const secondPending = Promise.withResolvers<void>();
    const messages: string[] = [];
    const report = (message: string) => {
      messages.push(message);
      if (message.startsWith('second pending')) secondPending.resolve();
    };
    const firstWork = withTeachStageProgress(
      { label: 'first', report, intervalMs: 5 },
      () => first.promise,
    );
    const secondWork = withTeachStageProgress(
      { label: 'second', report, intervalMs: 5 },
      () => second.promise,
    );
    first.resolve('first result');
    expect(await firstWork).toBe('first result');
    await secondPending.promise;
    expect(messages.some((message) => message.startsWith('first finished'))).toBe(true);
    expect(messages.some((message) => message.startsWith('second finished'))).toBe(false);
    second.resolve('second result');
    expect(await secondWork).toBe('second result');
  });
});
