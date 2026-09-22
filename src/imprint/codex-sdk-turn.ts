import type { RunResult, Thread, TurnOptions } from '@openai/codex-sdk';
import { ProviderReportedError } from './provider-retry.ts';

type SdkThread = Pick<Thread, 'runStreamed'>;
interface TurnLifecycleOptions {
  cleanupTimeoutMs?: number;
  onEvent?: (event: { type: string; timestamp: string; [key: string]: unknown }) => void;
}
const pendingTurns = new WeakMap<SdkThread, Promise<void>>();

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A terminal SDK event completes the semantic turn. Stream teardown is bounded
 * separately; a retained thread cannot start again until its prior cleanup settles. */
export async function runCodexSdkTurn(
  thread: SdkThread,
  input: string,
  options: TurnOptions = {},
  lifecycle: TurnLifecycleOptions = {},
): Promise<RunResult> {
  const cleanupTimeoutMs = lifecycle.cleanupTimeoutMs ?? 1_000;
  const pending = pendingTurns.get(thread);
  if (pending && !(await settlesWithin(pending, cleanupTimeoutMs)))
    throw new Error('Codex SDK previous turn cleanup is unfinished; no new turn was started.');
  // Reserve synchronously, before runStreamed can yield to another caller.
  if (pendingTurns.has(thread))
    throw new Error('Codex SDK thread already has an active turn; no new turn was started.');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingTurns.set(thread, gate);
  const owned = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, owned.signal]) : owned.signal;
  const emit = (type: string, detail: Record<string, unknown> = {}) => {
    try {
      lifecycle.onEvent?.({ type, timestamp: new Date().toISOString(), ...detail });
    } catch {
      /* telemetry only */
    }
  };
  const finish = () => {
    if (pendingTurns.get(thread) === gate) pendingTurns.delete(thread);
    release();
  };
  let iterator: AsyncIterator<import('@openai/codex-sdk').ThreadEvent> | undefined;
  const result: RunResult = { items: [], finalResponse: '', usage: null };
  try {
    const { events } = await thread.runStreamed(input, { ...options, signal });
    iterator = events[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      emit('sdk.stream_event', { event });
      if (event.type === 'item.completed') {
        result.items.push(event.item);
        if (event.item.type === 'agent_message') result.finalResponse = event.item.text;
      } else if (event.type === 'turn.completed') {
        result.usage = event.usage;
        emit('sdk.turn_completed');
        break;
      } else if (event.type === 'turn.failed') {
        emit('sdk.turn_failed');
        throw new ProviderReportedError(
          'codex-cli',
          { messages: [event.error.message] },
          event.error,
        );
      }
    }
    return result;
  } finally {
    const started = Date.now();
    emit('sdk.cleanup_started');
    // The installed SDK forwards this signal to its owned child process. Do not
    // abort the caller or wait for an additional stream read after completion.
    owned.abort();
    const cleanup = Promise.resolve()
      .then(() => iterator?.return?.())
      .then(
        () => emit('sdk.cleanup_completed', { durationMs: Date.now() - started }),
        (error) =>
          emit('sdk.cleanup_failed', { durationMs: Date.now() - started, error: String(error) }),
      )
      .finally(finish);
    if (!(await settlesWithin(cleanup, cleanupTimeoutMs)))
      emit('sdk.cleanup_pending', { durationMs: Date.now() - started });
  }
}
