import type { CompileAgentResult } from './compile-agent-types.ts';
import { abortSignalError } from './concurrency.ts';
import {
  type ProviderInterruptionReason,
  ProviderReportedError,
  type ProviderRetryEvent,
  type ProviderRetryOptions,
  ProviderUnavailableError,
  type RunDeadlineRef,
  providerControlError,
  resolvedRunDeadline,
  retryTransientProviderFailure,
} from './provider-retry.ts';

export interface CompilerResume {
  sessionId: string;
  message: string;
}

interface CompileProviderRetryEvent extends Omit<ProviderRetryEvent, 'reason'> {
  reason: ProviderInterruptionReason;
  sessionId?: string;
}

interface Options {
  run: (
    resume: CompilerResume | undefined,
    runDeadline: RunDeadlineRef | undefined,
  ) => Promise<CompileAgentResult>;
  runDeadline?: RunDeadlineRef;
  deadlineMs?: number;
  initialResume?: CompilerResume;
  signal?: AbortSignal;
  onDeadlineReached?: () => Promise<number | null | undefined>;
  onRetry?: (event: CompileProviderRetryEvent) => void;
  retry?: Pick<ProviderRetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'random' | 'now' | 'sleep'>;
}

const CONTINUE =
  'The provider interruption has cleared. Continue this same compile from where it stopped. Preserve existing work and use the normal completion protocol.';

type Totals = Pick<
  CompileAgentResult,
  'turns' | 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>;

function add(total: Totals, result: CompileAgentResult): Totals {
  return {
    turns: total.turns + result.turns,
    inputTokens: total.inputTokens + result.inputTokens,
    outputTokens: total.outputTokens + result.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + result.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + result.cacheCreationInputTokens,
  };
}

export async function runCompileWithProviderRecovery(
  options: Options,
): Promise<CompileAgentResult> {
  const now = options.retry?.now ?? Date.now;
  const startedAt = now();
  const runDeadline = resolvedRunDeadline(options.runDeadline, options.deadlineMs);

  let resume = options.initialResume;
  let sessionId = resume?.sessionId;
  let last: CompileAgentResult | undefined;
  let interruption: ProviderInterruptionReason = 'capacity_or_overload';
  let totals: Totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  try {
    return await retryTransientProviderFailure(
      async () => {
        const result = await options.run(resume, runDeadline);
        if (options.signal?.aborted) throw abortSignalError(options.signal);
        totals = add(totals, result);
        if (result.sessionId) {
          if (sessionId && result.sessionId !== sessionId) {
            return {
              ...result,
              ...totals,
              success: false,
              outcome: 'error',
              message: `Compiler session changed from ${sessionId} to ${result.sessionId}.\n${result.message}`,
              sessionId,
              durationMs: Math.max(result.durationMs, now() - startedAt),
            };
          }
          sessionId ??= result.sessionId;
        }
        const aggregate = {
          ...result,
          ...totals,
          sessionId,
          durationMs: Math.max(result.durationMs, now() - startedAt),
        };
        if (!result.providerError) return aggregate;
        if (!result.providerInterruption) throw result.providerError;

        interruption = result.providerInterruption;
        last = aggregate;
        if (!sessionId) {
          throw new ProviderUnavailableError(
            result.providerError,
            'Provider interrupted compiler work but did not return a resumable session id; same-session continuation is impossible and the artifact was not treated as the cause.',
          );
        }
        resume = { sessionId, message: CONTINUE };
        if (providerControlError(result.providerError) instanceof ProviderUnavailableError) {
          throw new ProviderReportedError(
            result.providerError.provider,
            result.providerError.facts(),
            undefined,
            result.providerInterruption,
          );
        }
        throw result.providerError;
      },
      {
        runDeadline,
        signal: options.signal,
        onDeadlineReached: options.onDeadlineReached,
        ...options.retry,
        onRetry: (event) => options.onRetry?.({ ...event, reason: interruption, sessionId }),
      },
    );
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError) || !last) throw error;
    throw new ProviderUnavailableError(
      last.providerError ?? error,
      `${last.message}\n\nThe provider remained unavailable until the compile deadline; the artifact was not treated as the cause and no artifact failure was recorded.`,
    );
  }
}
