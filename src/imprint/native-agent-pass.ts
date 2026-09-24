import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { abortSignalError } from './concurrency.ts';
import type { MasterTeachAnalyzer } from './master-teach-agents.ts';
import { type NativeTeachAgents, nativeAssignmentPage } from './native-teach-agents.ts';

const instructions = `This assignment is one complete focused agent pass. Use its assignment tools throughout the pass. Call respond with the current step and the exact JSON role response as text; the host validates it, executes accepted actions, and returns the next input directly. Do not submit to the native family between actions. Read every page of a returned input using read_context before responding. Repair feedback, observations, and shared-research replies all continue in this same assignment. When respond returns complete=true, submit a short acknowledgement to the native family and stop. That acknowledgement is not proof; only the host's validated handoff determines the outcome. Native helpers may assist with bounded questions; you remain responsible for this assignment's actions and evidence.`;

type Frame = { complete: true } | { complete: false; step: number; prompt: string };
function nextFrame() {
  let resolve!: (frame: Frame) => void;
  const promise = new Promise<Frame>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One native child drives a host role loop, including actions, repairs and queries.
 * This is a single request/response channel, with no worker admission policy. */
export async function runNativeAgentPass<T>(options: {
  family: Pick<NativeTeachAgents, 'submit'>;
  conversation: string;
  signal?: AbortSignal;
  logPath: string;
  run: (analyzer: MasterTeachAnalyzer, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const log = (type: string, fields: Record<string, unknown> = {}) =>
    appendFileSync(
      options.logPath,
      `${JSON.stringify({ type, timestamp: new Date().toISOString(), ...fields })}\n`,
      { mode: 0o600 },
    );
  const owned = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, owned.signal]) : owned.signal;
  let next = nextFrame();
  let current: Extract<Frame, { complete: false }> | undefined;
  let answer:
    | { resolve: (value: { text: string }) => void; reject: (error: unknown) => void }
    | undefined;
  let step = 0;
  let responding = false;
  let finished = false;
  let priorInstructions: string | undefined;
  const analyzer: MasterTeachAnalyzer = {
    analyze: async (prompt, payload, invocation = {}) => {
      if (signal.aborted) throw abortSignalError(signal);
      if (answer) throw new Error('Native agent already awaits an action');
      const active = invocation.signal ? AbortSignal.any([signal, invocation.signal]) : signal;
      if (active.aborted) throw abortSignalError(active);
      const role =
        priorInstructions === prompt
          ? ''
          : `<system_instructions>${prompt}</system_instructions>\n`;
      priorInstructions = prompt;
      const frame: Extract<Frame, { complete: false }> = {
        complete: false,
        step: ++step,
        prompt: `${role}<user_payload_json>${JSON.stringify(payload)}</user_payload_json>`,
      };
      current = frame;
      log('step.input', frame);
      return await new Promise<{ text: string }>((resolve, reject) => {
        const abort = () => {
          owned.abort(abortSignalError(active));
          answer = undefined;
          reject(abortSignalError(active));
        };
        const settle = (done: () => void) => {
          active.removeEventListener('abort', abort);
          done();
        };
        answer = {
          resolve: (value) =>
            settle(() => {
              try {
                log('step.output', { step, text: value.text });
                invocation.onEvent?.({
                  type: 'native.agent.response',
                  timestamp: new Date().toISOString(),
                  conversationKey: options.conversation,
                  step,
                });
                resolve(value);
              } catch (error) {
                reject(error);
              }
            }),
          reject: (error) => settle(() => reject(error)),
        };
        active.addEventListener('abort', abort, { once: true });
        next.resolve(frame);
      });
    },
  };
  // Observe both outcomes immediately; release the tool call before waiting for
  // the child's acknowledgement, including factual blocks and cancellation.
  const work = options
    .run(analyzer, signal)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .then((outcome) => {
      finished = true;
      try {
        log(
          'pass.completed',
          outcome.ok ? { ok: true } : { ok: false, error: String(outcome.error) },
        );
        return outcome;
      } catch (error) {
        return outcome.ok ? { ok: false as const, error } : outcome;
      } finally {
        next.resolve({ complete: true });
      }
    });
  let transportError: unknown;
  try {
    const first = await next.promise;
    if (!first.complete) {
      await options.family.submit(
        `${instructions}\n\nCurrent step: ${first.step}. Read its input with read_context at offset 0, then follow nextOffset until complete.`,
        {
          conversation: options.conversation,
          signal,
          beforeSubmit: () => {
            if (!finished)
              throw new Error(
                `Host validation still awaits step ${current?.step ?? step}. Read its remaining pages and call_assignment_tool respond; do not submit role JSON to the family yet.`,
              );
          },
          call: async (name, args) => {
            if (name === '__list')
              return {
                tools: [
                  {
                    name: 'respond',
                    description:
                      'Validate and execute the current role response, then receive the next input.',
                    inputSchema: {
                      type: 'object',
                      properties: { step: { type: 'integer' }, text: { type: 'string' } },
                      required: ['step', 'text'],
                      additionalProperties: false,
                    },
                  },
                  {
                    name: 'read_context',
                    description: 'Read another page of the current role input.',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        step: { type: 'integer' },
                        offset: { type: 'integer', minimum: 0 },
                      },
                      required: ['step', 'offset'],
                      additionalProperties: false,
                    },
                  },
                ],
              };
            if (signal.aborted) throw abortSignalError(signal);
            if (finished) throw new Error('Agent pass completed; acknowledge the assignment');
            const binding = z.object({ step: z.number().int() }).parse(args);
            if (binding.step !== current?.step) throw new Error('Stale or duplicate agent step');
            if (name === 'read_context') {
              const { offset } = z.object({ offset: z.number().int().nonnegative() }).parse(args);
              return {
                complete: false,
                step: current.step,
                ...nativeAssignmentPage(current.prompt, offset),
              };
            }
            if (name !== 'respond') throw new Error(`Unknown agent tool: ${name}`);
            const { text } = z.object({ text: z.string().min(1) }).parse(args);
            if (responding || !answer) throw new Error('Agent action is already executing');
            responding = true;
            const pending = answer;
            answer = undefined;
            // Validation can synchronously request another turn. Install its
            // receiver before releasing the current action into the host loop.
            next = nextFrame();
            try {
              pending.resolve({ text });
              const frame = await next.promise;
              return frame.complete
                ? frame
                : { complete: false, step: frame.step, ...nativeAssignmentPage(frame.prompt, 0) };
            } finally {
              responding = false;
            }
          },
        },
      );
      if (!finished)
        throw new Error('Native agent acknowledged before completing its host-validated pass');
    }
  } catch (error) {
    transportError = error;
    owned.abort(error);
    answer?.reject(error);
    answer = undefined;
  }
  const outcome = await work;
  if (!outcome.ok) throw outcome.error;
  if (transportError !== undefined) throw transportError;
  return outcome.value;
}
