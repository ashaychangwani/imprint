import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import {
  ProviderDeadlineError,
  ProviderReportedError,
  ProviderUnavailableError,
  RunDeadline,
  type RunDeadlineRef,
} from './provider-retry.ts';

const CONTROL_ENV = 'IMPRINT_COMPILE_PROVIDER_CONTROL';
type ExtensionDecision = {
  deadlineMs: number;
  outcome: 'accepted' | 'declined';
};
type ControlRecord = {
  version: 3;
  token: string;
  deadlineMs: number;
  sessionId?: string;
  extension: {
    pendingDeadlineMs?: number;
    decision?: ExtensionDecision;
  };
};
type CompileProviderInterruption = ControlRecord & {
  kind: 'provider_interruption';
  reason: 'deadline' | 'unavailable';
};

export function compileProviderInterruptionError(
  value: Pick<CompileProviderInterruption, 'reason' | 'deadlineMs'>,
): ProviderReportedError {
  const cause =
    value.reason === 'deadline'
      ? new ProviderDeadlineError(value.deadlineMs)
      : new ProviderUnavailableError(new Error('Nested provider unavailable'));
  return new ProviderReportedError(
    'nested-live-verifier',
    { codes: [value.reason === 'deadline' ? 'provider_deadline' : 'provider_unavailable'] },
    cause,
    'capacity_or_overload',
  );
}

function atomicJson(path: string, value: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readControl(path: string): ControlRecord {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ControlRecord>;
  const pendingDeadlineMs = value.extension?.pendingDeadlineMs;
  const decision = value.extension?.decision;
  if (
    value.version !== 3 ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9]{48}$/.test(value.token) ||
    typeof value.deadlineMs !== 'number' ||
    !Number.isFinite(value.deadlineMs) ||
    !value.extension ||
    (pendingDeadlineMs !== undefined &&
      (typeof pendingDeadlineMs !== 'number' || !Number.isFinite(pendingDeadlineMs))) ||
    (decision !== undefined &&
      (typeof decision.deadlineMs !== 'number' ||
        !Number.isFinite(decision.deadlineMs) ||
        (decision.outcome !== 'accepted' && decision.outcome !== 'declined'))) ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== 'string' || value.sessionId.length > 1_024))
  ) {
    throw new Error('Invalid compile provider control record');
  }
  return value as ControlRecord;
}

function asDeadline(deadline: RunDeadlineRef | number): RunDeadlineRef {
  return typeof deadline === 'number' ? new RunDeadline(deadline) : deadline;
}

export function createCompileProviderControl(deadline: RunDeadlineRef | number) {
  const runDeadline = asDeadline(deadline);
  if (Date.now() >= runDeadline.deadlineMs) {
    throw new ProviderUnavailableError(new ProviderDeadlineError(runDeadline.deadlineMs));
  }
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-provider-'));
  chmodSync(dir, 0o700);
  const controlPath = pathJoin(dir, 'control.json');
  const interruptionPath = pathJoin(dir, 'interruption.json');
  const token = randomBytes(24).toString('hex');
  let sessionId: string | undefined;
  let disposed = false;
  let publishedDeadlineMs = runDeadline.deadlineMs;
  let extension: ControlRecord['extension'] = { pendingDeadlineMs: publishedDeadlineMs };
  const publish = (): void => {
    if (disposed) return;
    atomicJson(controlPath, {
      version: 3,
      token,
      deadlineMs: runDeadline.deadlineMs,
      ...(sessionId ? { sessionId } : {}),
      extension,
    } satisfies ControlRecord);
  };
  const controlledDeadline: RunDeadlineRef = {
    get deadlineMs(): number {
      return runDeadline.deadlineMs;
    },
    get scope(): 'run' | 'phase' | undefined {
      return runDeadline.scope;
    },
    onChange: (listener) => runDeadline.onChange(listener),
    async requestExtension(request): Promise<boolean> {
      if (disposed) return false;
      const requestedDeadlineMs = runDeadline.deadlineMs;
      extension = { pendingDeadlineMs: requestedDeadlineMs, decision: extension.decision };
      publish();
      let accepted: boolean;
      try {
        accepted = (await runDeadline.requestExtension?.(request)) ?? false;
      } catch (error) {
        if (!disposed) {
          extension = {
            decision: { deadlineMs: requestedDeadlineMs, outcome: 'declined' },
          };
          publish();
        }
        throw error;
      }
      if (disposed) return false;
      const nextDeadlineMs = runDeadline.deadlineMs;
      const extended = accepted && nextDeadlineMs > requestedDeadlineMs;
      publishedDeadlineMs = nextDeadlineMs;
      extension = {
        ...(extended ? { pendingDeadlineMs: nextDeadlineMs } : {}),
        decision: {
          deadlineMs: requestedDeadlineMs,
          outcome: extended ? 'accepted' : 'declined',
        },
      };
      publish();
      return extended;
    },
  };
  const interruption = (): CompileProviderInterruption | undefined => {
    try {
      const value = JSON.parse(
        readFileSync(interruptionPath, 'utf8'),
      ) as Partial<CompileProviderInterruption>;
      return value.version === 3 &&
        value.token === token &&
        value.kind === 'provider_interruption' &&
        (value.reason === 'deadline' || value.reason === 'unavailable') &&
        typeof value.deadlineMs === 'number' &&
        Number.isFinite(value.deadlineMs) &&
        (value.sessionId === undefined ||
          (typeof value.sessionId === 'string' && value.sessionId.length <= 1_024))
        ? (value as CompileProviderInterruption)
        : undefined;
    } catch {
      return undefined;
    }
  };
  publish();
  const stopDeadline = runDeadline.onChange(() => {
    const nextDeadlineMs = runDeadline.deadlineMs;
    if (nextDeadlineMs > publishedDeadlineMs) {
      extension = {
        pendingDeadlineMs: nextDeadlineMs,
        decision: { deadlineMs: publishedDeadlineMs, outcome: 'accepted' },
      };
    }
    publishedDeadlineMs = nextDeadlineMs;
    publish();
  });
  return {
    env: { [CONTROL_ENV]: controlPath } as NodeJS.ProcessEnv,
    deadline: controlledDeadline,
    updateSession(value: string | undefined): void {
      const normalized = value?.trim();
      if (!normalized || normalized === sessionId || normalized.length > 1_024) return;
      sessionId = normalized;
      publish();
    },
    interruption,
    throwIfInterrupted(): void {
      const value = interruption();
      if (!value) return;
      const cause =
        value.reason === 'deadline'
          ? new ProviderDeadlineError(value.deadlineMs)
          : new ProviderUnavailableError(new Error('Nested provider unavailable'));
      throw new ProviderUnavailableError(
        cause,
        `The nested live verifier ${value.reason === 'deadline' ? 'reached the teach deadline' : 'provider remained unavailable'}; no artifact failure was recorded.`,
      );
    },
    watch(onInterruption: (value: CompileProviderInterruption) => void): () => void {
      const timer = setInterval(() => {
        const value = interruption();
        if (!value) return;
        clearInterval(timer);
        onInterruption(value);
      }, 25);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopDeadline();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type CompileProviderControl = ReturnType<typeof createCompileProviderControl>;

export function watchCompileProviderDeadline(
  control: CompileProviderControl,
  onDeadlineReached: (() => Promise<number | null | undefined>) | undefined,
  onExpired: () => void,
): { readonly expired: boolean; dispose(): void } {
  let expired = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      async () => {
        if (disposed) return;
        if (Date.now() < control.deadline.deadlineMs) {
          schedule();
          return;
        }
        let extended = false;
        try {
          extended = (await control.deadline.requestExtension?.(onDeadlineReached)) ?? false;
        } catch {
          if (disposed) return;
        }
        if (disposed) return;
        if (extended) {
          schedule();
          return;
        }
        expired = true;
        onExpired();
      },
      Math.max(0, control.deadline.deadlineMs - Date.now()),
    );
    timer.unref?.();
  };
  const stopChanges = control.deadline.onChange(schedule);
  schedule();
  return {
    get expired(): boolean {
      return expired;
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      stopChanges();
    },
  };
}

class MirroredRunDeadline implements RunDeadlineRef {
  private readonly listeners = new Set<() => void>();
  private readonly recordListeners = new Set<() => void>();
  private readonly watchCallback = (): void => this.refresh();
  private record: ControlRecord;
  private value: number;
  private disposed = false;
  private ownerAvailable = true;

  constructor(
    private readonly path: string,
    initial: ControlRecord,
  ) {
    this.record = initial;
    this.value = initial.deadlineMs;
    watchFile(path, { interval: 25, persistent: false }, this.watchCallback);
  }

  get deadlineMs(): number {
    this.refresh();
    return this.value;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requestExtension(): Promise<boolean> {
    this.refresh();
    if (!this.ownerAvailable) return Promise.resolve(false);
    const requestedDeadlineMs = this.value;
    return new Promise((resolve) => {
      let settled = false;
      const poll = setInterval(() => {
        this.refresh();
        check();
      }, 25);
      poll.unref?.();
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        this.recordListeners.delete(check);
        resolve(value);
      };
      const check = (): void => {
        if (this.disposed || !this.ownerAvailable) {
          finish(false);
          return;
        }
        if (this.value > requestedDeadlineMs) {
          finish(true);
          return;
        }
        const decision = this.record.extension.decision;
        if (decision?.deadlineMs !== requestedDeadlineMs) return;
        finish(decision.outcome === 'accepted');
      };
      this.recordListeners.add(check);
      check();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unwatchFile(this.path, this.watchCallback);
    this.listeners.clear();
    for (const listener of this.recordListeners) listener();
    this.recordListeners.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    try {
      const record = readControl(this.path);
      if (record.token !== this.record.token) return;
      const deadlineChanged = record.deadlineMs !== this.value;
      const recordChanged =
        JSON.stringify(record.extension) !== JSON.stringify(this.record.extension);
      if (!deadlineChanged && !recordChanged) return;
      this.record = record;
      this.value = record.deadlineMs;
      if (deadlineChanged) for (const listener of this.listeners) listener();
      for (const listener of this.recordListeners) listener();
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        this.ownerAvailable = false;
        for (const listener of this.recordListeners) listener();
      }
    }
  }
}

export function inheritedCompileProviderControl() {
  const path = process.env[CONTROL_ENV];
  if (!path) return undefined;
  const initial = readControl(path);
  const deadline = new MirroredRunDeadline(path, initial);
  return {
    deadline,
    get deadlineMs(): number {
      return deadline.deadlineMs;
    },
    report(error: ProviderDeadlineError | ProviderUnavailableError): void {
      const current = readControl(path);
      if (current.token !== initial.token)
        throw new Error('Compile provider control changed owner');
      atomicJson(pathJoin(dirname(path), 'interruption.json'), {
        ...current,
        kind: 'provider_interruption',
        reason: error instanceof ProviderDeadlineError ? 'deadline' : 'unavailable',
      } satisfies CompileProviderInterruption);
    },
    dispose: () => deadline.dispose(),
  };
}
