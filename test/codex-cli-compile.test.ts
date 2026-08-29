import { describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  createSentinelGraceController,
  createTurnActivityTracker,
} from '../src/imprint/codex-cli-compile.ts';
import {
  collectOwnedProcess,
  registerCompilerProcessCleanup,
  spawnOwnedProcess,
  terminateCompilerProcessTree,
} from '../src/imprint/compiler-process.ts';
import { parseCodexTerminalOutput } from '../src/imprint/provider-terminal.ts';

const interruption = (event: Record<string, unknown>) =>
  parseCodexTerminalOutput(JSON.stringify(event)).interruption;

describe('Codex terminal provider facts', () => {
  it('marks structured provider overload but ignores arbitrary terminal target-site text', () => {
    expect(
      interruption({
        type: 'turn.failed',
        status: 529,
        error: { code: 'rate_limited', status: 529, message: 'provider overloaded' },
      }),
    ).toBe('capacity_or_overload');
    for (const type of ['turn.failed', 'error'] as const) {
      for (const status of [429, 503, 529]) {
        expect(
          interruption({
            type,
            is_error: true,
            message: `target-site live verification returned HTTP ${status}`,
          }),
        ).toBeUndefined();
      }
    }
  });

  it('does not retry a transient status contradicted by deterministic provider facts', () => {
    expect(
      interruption({
        type: 'turn.failed',
        status: 429,
        error_code: 'insufficient_quota',
      }),
    ).toBeUndefined();
  });

  it('ignores target and MCP text placed in Codex failure message fields', () => {
    for (const event of [
      { type: 'turn.failed', message: 'target returned 529 provider overloaded' },
      {
        type: 'turn.failed',
        error: { code: 'overloaded' },
      },
      {
        type: 'turn.failed',
        error: { message: 'MCP tool returned 429 rate_limited' },
      },
      {
        type: 'turn.failed',
        error: {
          message: JSON.stringify({ error: { status: 529, message: 'site overloaded' } }),
        },
      },
    ]) {
      expect(interruption(event)).toBeUndefined();
    }
  });
});

describe('compiler process ownership', () => {
  it('registers and removes parent-exit cleanup without leaking listeners', () => {
    const before = process.listenerCount('exit');
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeHup = process.listenerCount('SIGHUP');
    const child = Object.assign(new EventEmitter(), { kill: () => true }) as ChildProcess;
    const unregister = registerCompilerProcessCleanup(child);
    expect(process.listenerCount('exit')).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    expect(process.listenerCount('SIGHUP')).toBe(beforeHup + 1);
    unregister();
    expect(process.listenerCount('exit')).toBe(before);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(process.listenerCount('SIGHUP')).toBe(beforeHup);
  });
});

describe('compiler process termination', () => {
  it('keeps delayed SIGKILL armed when only the root exits', async () => {
    const received: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: (signal: NodeJS.Signals) => {
        received.push(signal);
        return true;
      },
    }) as ChildProcess;
    terminateCompilerProcessTree(child, 'SIGTERM', 1);
    child.emit('exit', 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('never signals a child that was already reaped', () => {
    const received: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      kill: (signal: NodeJS.Signals) => {
        received.push(signal);
        return true;
      },
    }) as ChildProcess;
    terminateCompilerProcessTree(child, 'SIGTERM', 1);
    expect(received).toEqual([]);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('collects an already-reaped child without waiting for a missed exit event', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      stdout: null,
      stderr: null,
      kill: () => true,
    }) as ChildProcess;
    const output = await collectOwnedProcess(child);
    expect(output.exitCode).toBe(0);
  });

  for (const detachedGrandchild of [false, true]) {
    it(`reaps ${detachedGrandchild ? 'detached ' : ''}TERM-ignoring grandchildren in 20 hostile repetitions`, async () => {
      for (let repetition = 0; repetition < 20; repetition++) {
        const grandchildScript =
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)";
        const rootScript = [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: ${detachedGrandchild}, stdio: ['ignore', 'inherit', 'inherit'] })`,
          "process.stdout.write(String(child.pid) + '\\n')",
          'setTimeout(() => process.exit(0), 50)',
        ].join(';');
        const root = spawnOwnedProcess(process.execPath, ['-e', rootScript], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = await collectOwnedProcess(root, { shutdownGraceMs: 5 });
        const grandchildPid = Number(output.stdout.trim().split(/\s+/)[0]);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      }
    });
  }
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
