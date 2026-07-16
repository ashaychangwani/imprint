import { describe, expect, it } from 'bun:test';
import {
  collectDescendantPids,
  createSentinelGraceController,
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
