import type { RunResult, Thread, TurnOptions } from '@openai/codex-sdk';
import { ProviderReportedError } from './provider-retry.ts';

/** Retain SDK terminal events instead of losing their origin in Thread.run(). */
export async function runCodexSdkTurn(
  thread: Pick<Thread, 'runStreamed'>,
  input: string,
  options: TurnOptions = {},
): Promise<RunResult> {
  const { events } = await thread.runStreamed(input, options);
  const result: RunResult = { items: [], finalResponse: '', usage: null };
  for await (const event of events) {
    if (event.type === 'item.completed') {
      result.items.push(event.item);
      if (event.item.type === 'agent_message') result.finalResponse = event.item.text;
    } else if (event.type === 'turn.completed') {
      result.usage = event.usage;
    } else if (event.type === 'turn.failed') {
      // The SDK identifies this as a terminal turn error. Its run() shortcut
      // erases that distinction by throwing an ordinary Error(message).
      throw new ProviderReportedError(
        'codex-cli',
        { messages: [event.error.message] },
        event.error,
      );
    }
  }
  return result;
}
