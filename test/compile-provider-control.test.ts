import { afterEach, describe, expect, it } from 'bun:test';
import {
  createCompileProviderControl,
  inheritedCompileProviderControl,
  watchCompileProviderDeadline,
} from '../src/imprint/compile-provider-control.ts';
import {
  ProviderDeadlineError,
  ProviderUnavailableError,
  RunDeadline,
  combinedDeadlineSignal,
} from '../src/imprint/provider-retry.ts';

const ENV = 'IMPRINT_COMPILE_PROVIDER_CONTROL';
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('nested compile provider control', () => {
  it('turns a nested verifier deadline into a validated run-level interruption', () => {
    const deadlineMs = Date.now() + 60_000;
    const parent = createCompileProviderControl(deadlineMs);
    process.env[ENV] = parent.env[ENV];
    const nested = inheritedCompileProviderControl();
    try {
      expect(nested?.deadlineMs).toBe(deadlineMs);
      nested?.report(new ProviderDeadlineError(deadlineMs));
      expect(() => parent.throwIfInterrupted()).toThrow(ProviderUnavailableError);
    } finally {
      nested?.dispose();
      parent.dispose();
    }
  });

  it('keeps an active nested verifier alive while the parent accepts a delayed extension', async () => {
    const firstDeadline = Date.now() + 30;
    const extendedDeadline = firstDeadline + 150;
    const runDeadline = new RunDeadline(firstDeadline);
    const parent = createCompileProviderControl(runDeadline);
    process.env[ENV] = parent.env[ENV];
    const nested = inheritedCompileProviderControl();
    const active = combinedDeadlineSignal(nested?.deadline, undefined, undefined);
    let decide: ((extensionMs: number | null) => void) | undefined;
    let markAsked: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const watch = watchCompileProviderDeadline(
      parent,
      () => {
        markAsked?.();
        return new Promise<number | null>((resolve) => {
          decide = resolve;
        });
      },
      () => {},
    );
    try {
      await asked;
      await Bun.sleep(20);
      expect(active.signal?.aborted).toBe(false);
      decide?.(extendedDeadline - firstDeadline);
      for (let attempt = 0; attempt < 20 && nested?.deadlineMs !== extendedDeadline; attempt++) {
        await Bun.sleep(5);
      }
      expect(nested?.deadlineMs).toBe(extendedDeadline);
      expect(active.signal?.aborted).toBe(false);
      expect(watch.expired).toBe(false);
    } finally {
      watch.dispose();
      active.dispose();
      nested?.dispose();
      parent.dispose();
    }
  });

  it('aborts an active nested verifier after the parent declines a delayed extension', async () => {
    const firstDeadline = Date.now() + 30;
    const parent = createCompileProviderControl(new RunDeadline(firstDeadline));
    process.env[ENV] = parent.env[ENV];
    const nested = inheritedCompileProviderControl();
    const active = combinedDeadlineSignal(nested?.deadline, undefined, undefined);
    let decide: ((extensionMs: number | null) => void) | undefined;
    let markAsked: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const watch = watchCompileProviderDeadline(
      parent,
      () => {
        markAsked?.();
        return new Promise<number | null>((resolve) => {
          decide = resolve;
        });
      },
      () => {},
    );
    try {
      await asked;
      await Bun.sleep(20);
      expect(active.signal?.aborted).toBe(false);
      decide?.(null);
      for (let attempt = 0; attempt < 20 && !active.signal?.aborted; attempt++) await Bun.sleep(5);
      expect(active.signal?.reason).toBeInstanceOf(ProviderDeadlineError);
      expect(watch.expired).toBe(true);
    } finally {
      watch.dispose();
      active.dispose();
      nested?.dispose();
      parent.dispose();
    }
  });

  it('unwatches only the disposed mirror while another mirror keeps receiving extensions', async () => {
    const firstDeadline = Date.now() + 60_000;
    const extendedDeadline = firstDeadline + 1_000;
    const runDeadline = new RunDeadline(firstDeadline);
    const parent = createCompileProviderControl(runDeadline);
    process.env[ENV] = parent.env[ENV];
    const disposed = inheritedCompileProviderControl();
    const remaining = inheritedCompileProviderControl();
    try {
      disposed?.dispose();
      runDeadline.extend(extendedDeadline - firstDeadline);
      for (let attempt = 0; attempt < 20 && remaining?.deadlineMs !== extendedDeadline; attempt++) {
        await Bun.sleep(5);
      }
      expect(remaining?.deadlineMs).toBe(extendedDeadline);
      expect(disposed?.deadlineMs).toBe(firstDeadline);
    } finally {
      disposed?.dispose();
      remaining?.dispose();
      parent.dispose();
    }
  });

  for (const decision of ['accept', 'decline'] as const) {
    it(`settles a pending mirror when its parent is removed before delayed ${decision}`, async () => {
      const firstDeadline = Date.now() + 30;
      const parent = createCompileProviderControl(new RunDeadline(firstDeadline));
      process.env[ENV] = parent.env[ENV];
      const nested = inheritedCompileProviderControl();
      const active = combinedDeadlineSignal(nested?.deadline, undefined, undefined);
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => {
        unhandled.push(error);
      };
      process.on('unhandledRejection', onUnhandled);
      let decide: ((extensionMs: number | null) => void) | undefined;
      let markAsked: (() => void) | undefined;
      const asked = new Promise<void>((resolve) => {
        markAsked = resolve;
      });
      let expired = false;
      const watch = watchCompileProviderDeadline(
        parent,
        () => {
          markAsked?.();
          return new Promise<number | null>((resolve) => {
            decide = resolve;
          });
        },
        () => {
          expired = true;
        },
      );
      try {
        await asked;
        await Bun.sleep(20);
        expect(active.signal?.aborted).toBe(false);
        watch.dispose();
        parent.dispose();
        for (let attempt = 0; attempt < 20 && !active.signal?.aborted; attempt++) {
          await Bun.sleep(5);
        }
        expect(active.signal?.reason).toBeInstanceOf(ProviderDeadlineError);
        decide?.(decision === 'accept' ? 100 : null);
        await Bun.sleep(30);
        expect(expired).toBe(false);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        watch.dispose();
        active.dispose();
        nested?.dispose();
        parent.dispose();
      }
    });
  }

  it('includes the captured outer session in a nested interruption', () => {
    const parent = createCompileProviderControl(Date.now() + 60_000);
    process.env[ENV] = parent.env[ENV];
    const nested = inheritedCompileProviderControl();
    try {
      parent.updateSession('outer-session');
      nested?.report(new ProviderUnavailableError(new Error('provider unavailable')));
      expect(parent.interruption()).toMatchObject({
        sessionId: 'outer-session',
        reason: 'unavailable',
      });
    } finally {
      nested?.dispose();
      parent.dispose();
    }
  });

  it('notifies the parent promptly when the nested verifier reports interruption', async () => {
    const deadlineMs = Date.now() + 60_000;
    const parent = createCompileProviderControl(deadlineMs);
    process.env[ENV] = parent.env[ENV];
    const nested = inheritedCompileProviderControl();
    let notified = false;
    const stop = parent.watch(() => {
      notified = true;
    });
    try {
      nested?.report(new ProviderUnavailableError(new Error('down')));
      for (let attempt = 0; attempt < 20 && !notified; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(notified).toBe(true);
      expect(() => parent.throwIfInterrupted()).toThrow(ProviderUnavailableError);
    } finally {
      stop();
      nested?.dispose();
      parent.dispose();
    }
  });

  it('refuses to create provider work after an expired deadline', () => {
    expect(() => createCompileProviderControl(Date.now() - 1)).toThrow(ProviderUnavailableError);
  });
});
