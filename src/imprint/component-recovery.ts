import { abortSignalError, withAbortSignal } from './concurrency.ts';
import type { ToolResult } from './types.ts';

interface RecoveryComponent {
  id: string;
  kind: string;
  label: string;
  /** Explicit consumers; an empty list does not make an owner global. */
  toolIds: readonly string[];
}

export interface ComponentRecoveryOwner extends RecoveryComponent {
  /** Repair and verify owned state before reporting success. Artifact owners
   * also commit their dependency/build changes through their normal host. */
  recover: (input: {
    failure: Extract<ToolResult<unknown>, { ok: false }>;
    previousRecoveries: number;
    reason: string;
  }) => Promise<boolean>;
}

/** Ownership and change observations are scoped to an explicit component id. */
export class ComponentRecoveryQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.revisions);
  }
  revision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }
  recovered(id: string): void {
    this.revisions.set(id, this.revision(id) + 1);
  }

  async run<T>(id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => finished);
    this.tails.set(id, tail);
    try {
      await withAbortSignal(() => previous, signal);
      if (signal?.aborted) throw abortSignalError(signal);
      return await work();
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(id) === tail) this.tails.delete(id);
      });
    }
  }
}

/** Agents select declared owners. The engine never infers cause from a site,
 * error code, message, cookie name, module name, or HTTP status. */
export async function runWithComponentRecovery<T extends { result: ToolResult<unknown> }>(options: {
  invoke: () => Promise<T>;
  select: (
    failed: T,
    previousRecoveries: number,
  ) => Promise<
    | {
        owner: ComponentRecoveryOwner;
        reason: string;
      }
    | undefined
  >;
  onAttempt: (observed: T, previousRecoveries: number) => void;
  queue?: ComponentRecoveryQueue;
  signal?: AbortSignal;
}): Promise<T> {
  const queue = options.queue ?? new ComponentRecoveryQueue();
  let previousRecoveries = 0;
  let observedRevisions = queue.snapshot();
  const invoke = async () => {
    if (options.signal?.aborted) throw abortSignalError(options.signal);
    observedRevisions = queue.snapshot();
    const result = await options.invoke();
    options.onAttempt(result, previousRecoveries);
    return result;
  };
  let observed = await invoke();
  while (!observed.result.ok) {
    const selection = await options.select(observed, previousRecoveries);
    if (!selection) return observed;
    const revision = observedRevisions.get(selection.owner.id) ?? 0;
    let declined = false;
    await queue.run(
      selection.owner.id,
      async () => {
        if (queue.revision(selection.owner.id) !== revision) {
          previousRecoveries += queue.revision(selection.owner.id) - revision;
          observed = await invoke();
          return;
        }
        if (observed.result.ok) return;
        if (
          !(await selection.owner.recover({
            failure: observed.result,
            previousRecoveries,
            reason: selection.reason,
          }))
        ) {
          declined = true;
          return;
        }
        queue.recovered(selection.owner.id);
        previousRecoveries++;
        observed = await invoke();
      },
      options.signal,
    );
    if (declined) return observed;
  }
  return observed;
}
