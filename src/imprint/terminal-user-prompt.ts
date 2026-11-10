import * as p from '@clack/prompts';
import { abortSignalError } from './concurrency.ts';
import { pauseLogsForPrompt } from './log.ts';
import type { OnUserPrompt } from './user-interaction.ts';

/** The parent terminal owns input; model/stdio child processes never read it. */
export const terminalUserPrompt: OnUserPrompt = async (prompt, signal) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return {
      status: 'unavailable',
      reason:
        'User input requires an interactive terminal. Run imprint teach without --no-interactive in a terminal, or provide an onPrompt callback.',
    };
  }
  if (signal?.aborted) throw abortSignalError(signal);
  const resumeLogs = pauseLogsForPrompt();
  try {
    const common = {
      message: prompt.message,
      signal,
      input: process.stdin,
      output: process.stderr,
    };
    const answer = prompt.options
      ? await p.select({
          ...common,
          options: prompt.options.map((value) => ({ value, label: value })),
        })
      : prompt.sensitive
        ? await p.password({
            ...common,
            validate: (value) => (value?.length ? undefined : 'Enter a value or cancel.'),
          })
        : await p.text(common);
    if (signal?.aborted) throw abortSignalError(signal);
    if (p.isCancel(answer))
      return { status: 'cancelled', reason: 'The user cancelled the question.' };
    return { status: 'answered', value: String(answer) };
  } finally {
    resumeLogs();
  }
};
