import { describe, expect, it } from 'bun:test';
import {
  collectDescendantPids,
  createSentinelGraceController,
  createTurnActivityTracker,
} from '../src/imprint/codex-cli-compile.ts';

describe('collectDescendantPids', () => {
  it('returns nested compiler descendants deepest-first across process groups', () => {
    expect(
      collectDescendantPids(
        [
          { pid: 20, ppid: 10 },
          { pid: 30, ppid: 20 },
          { pid: 40, ppid: 10 },
          { pid: 99, ppid: 1 },
        ],
        10,
      ),
    ).toEqual([30, 20, 40]);
  });
});

describe('Codex turn activity', () => {
  it('tracks terminal usage independently of whether a tracing span exists', () => {
    const activity = createTurnActivityTracker();
    expect(activity.isActive()).toBe(false);
    activity.started();
    expect(activity.isActive()).toBe(true);
    activity.completed();
    expect(activity.isActive()).toBe(false);
  });
});

describe('createSentinelGraceController', () => {
  it('terminates immediately after the active turn emits terminal usage', () => {
    let activeTurn = true;
    let terminateCalls = 0;
    let fallback: (() => void) | undefined;
    let cancelled = false;
    const controller = createSentinelGraceController({
      hasActiveTurn: () => activeTurn,
      terminate: () => terminateCalls++,
      schedule: (callback) => {
        fallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {
        cancelled = true;
      },
    });

    controller.observeSentinel();
    expect(terminateCalls).toBe(0);
    expect(fallback).toBeDefined();

    activeTurn = false;
    controller.observeTurnCompleted();
    expect(terminateCalls).toBe(1);
    expect(cancelled).toBe(true);
    fallback?.();
    expect(terminateCalls).toBe(1);
  });

  it('preserves the established fifteen-second fallback for a slow terminal turn', () => {
    let scheduledDelay = 0;
    const controller = createSentinelGraceController({
      hasActiveTurn: () => true,
      terminate: () => {},
      schedule: (_callback, delayMs) => {
        scheduledDelay = delayMs;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    controller.observeSentinel();
    expect(scheduledDelay).toBe(15_000);
  });

  it('terminates immediately when the terminal turn already completed before polling', () => {
    let terminateCalls = 0;
    const controller = createSentinelGraceController({
      hasActiveTurn: () => false,
      terminate: () => terminateCalls++,
    });

    controller.observeSentinel();
    controller.observeSentinel();
    expect(terminateCalls).toBe(1);
  });

  it('uses the bounded fallback when Codex never emits turn.completed', () => {
    let terminateCalls = 0;
    let fallback: (() => void) | undefined;
    const controller = createSentinelGraceController({
      hasActiveTurn: () => true,
      terminate: () => terminateCalls++,
      schedule: (callback) => {
        fallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });

    controller.observeSentinel();
    fallback?.();
    expect(terminateCalls).toBe(1);
  });
});
