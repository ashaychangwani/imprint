/** Multi-provider LLM client — system prompt + JSON-serialized
 *  user payload → raw model text. */

import Anthropic from '@anthropic-ai/sdk';
import { Codex, type Thread } from '@openai/codex-sdk';
import { runOwnedCli } from './compiler-process.ts';
import {
  ProviderReportedError,
  type ProviderRetryEvent,
  type RunDeadlineRef,
  boundedRunDeadline,
  providerControlError,
  providerReportedError,
  resolvedRunDeadline,
  retryTransientProviderFailure,
} from './provider-retry.ts';
import { parseClaudeTerminalOutput } from './provider-terminal.ts';
import {
  llmSpanAttributes,
  resolveTraceTokenCount,
  setSpanAttributes,
  totalPromptTokens,
  traceLlmIoEnabled,
  traceLlmMessages,
  traced,
} from './tracing.ts';

export type ProviderName = 'anthropic-api' | 'claude-cli' | 'codex-cli' | 'cursor-cli';

interface AnalyzeResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Prompt-cache token counts, when the provider reports them. `inputTokens` is
   * the *uncached* input only (the Anthropic/CLI `usage.input_tokens`); the bulk
   * of a cache-hit call lives here. Threaded through so `llm.analyze` cost is
   * cache-aware (cache reads bill at 0.1×, writes at 1.25×) instead of charging
   * the whole prompt at the full input rate. Null/undefined for providers that
   * don't expose usage (codex-cli, cursor-cli).
   */
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  durationMs: number;
  stopReason: string | null;
}

interface LLMProvider {
  readonly name: ProviderName;
  analyze(
    systemPrompt: string,
    userPayload: unknown,
    opts?: AnalyzeInvocationOptions,
  ): Promise<AnalyzeResult>;
}

interface AnalyzeInvocationOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  timeoutLabel?: string;
  signal?: AbortSignal;
  onEvent?: (event: AnalyzeInvocationEvent) => void;
  onProviderRetry?: (event: ProviderRetryEvent) => void;
  onDeadlineReached?: () => Promise<number | null | undefined>;
  /** Stable logical conversation. Providers that support threads append this
   * turn to the same agent context instead of reconstructing it from a summary. */
  conversationKey?: string;
}

type AnalyzeInvocationEvent = {
  type: string;
  timestamp: string;
  [key: string]: unknown;
};

interface TraceAnalyzeDetails {
  inputText: string;
  inputMessages: Array<{ role: string; content: string }>;
  invocationParameters?: Record<string, unknown>;
}

/** Subset of providers that support the Anthropic tool-use protocol.
 *  anthropic-api qualifies. CLI providers use separate orchestration
 *  paths for agentic compile when supported. */
export interface ToolUseProvider extends LLMProvider {
  messageWithTools(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<Anthropic.Message>;
}

export function isToolUseProvider(p: LLMProvider): p is ToolUseProvider {
  return typeof (p as Partial<ToolUseProvider>).messageWithTools === 'function';
}

/** Some Claude models (opus-4-7+) reject the `temperature` parameter as
 *  deprecated. This returns a fragment to spread into messages.create()
 *  that includes temperature only when the model accepts it. */
function temperatureFragment(model: string, temperature: number): { temperature?: number } {
  if (/claude-opus-4-[7-9]/.test(model) || /claude-opus-[5-9]/.test(model)) return {};
  return { temperature };
}

export interface LLMOptions {
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

class AnthropicApiProvider implements LLMProvider {
  readonly name: ProviderName = 'anthropic-api';
  private client: Anthropic;
  private config: {
    model: string;
    temperature: number;
    maxTokens: number;
  };

  constructor({
    model,
    temperature,
    maxTokens,
  }: {
    model: string;
    temperature: number;
    maxTokens: number;
  }) {
    this.config = { model, temperature, maxTokens };
    this.client = new Anthropic();
  }

  async analyze(
    systemPrompt: string,
    userPayload: unknown,
    opts: AnalyzeInvocationOptions = {},
  ): Promise<AnalyzeResult> {
    const userText = JSON.stringify(userPayload);
    const invocationParameters = {
      max_tokens: this.config.maxTokens,
      ...temperatureFragment(this.config.model, this.config.temperature),
    };
    return await traceAnalyze(
      this.name,
      this.config.model,
      systemPrompt,
      userText.length,
      async () => {
        const t0 = Date.now();

        let response: Awaited<ReturnType<typeof this.client.messages.create>>;
        try {
          response = await this.client.messages.create(
            {
              model: this.config.model,
              max_tokens: invocationParameters.max_tokens,
              ...(invocationParameters.temperature === undefined
                ? {}
                : { temperature: invocationParameters.temperature }),
              system: systemPrompt,
              messages: [{ role: 'user', content: userText }],
            },
            { signal: opts.signal },
          );
        } catch (err) {
          if (opts.signal?.aborted && opts.signal.reason instanceof Error) {
            throw opts.signal.reason;
          }
          throw enrichAnthropicApiError(err, this.config);
        }

        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => ('text' in block ? block.text : ''))
          .join('');

        return {
          text,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? null,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? null,
          durationMs: Date.now() - t0,
          stopReason: response.stop_reason ?? null,
        };
      },
      chatTraceDetails(systemPrompt, userText, invocationParameters),
    );
  }

  async messageWithTools(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<Anthropic.Message> {
    return await traceMessageWithTools(this.name, this.config.model, opts, async () => {
      try {
        const response = await this.client.messages.create(
          {
            model: this.config.model,
            max_tokens: opts.maxTokens ?? this.config.maxTokens,
            ...temperatureFragment(this.config.model, this.config.temperature),
            system: opts.system,
            messages: opts.messages,
            tools: opts.tools,
          },
          { signal: opts.signal },
        );
        return response;
      } catch (err) {
        if (opts.signal?.aborted && opts.signal.reason instanceof Error) {
          throw opts.signal.reason;
        }
        throw enrichAnthropicApiError(err, this.config);
      }
    });
  }
}

function enrichAnthropicApiError(err: unknown, config: { model: string }): Error {
  const control = providerControlError(err);
  if (control) return control;
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();
  const value =
    err && typeof err === 'object'
      ? (err as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const nested =
    value.error && typeof value.error === 'object'
      ? (value.error as Record<string, unknown>)
      : undefined;
  const reported = new ProviderReportedError(
    'anthropic-api',
    {
      statuses: [Number(value.status), Number(value.statusCode)].filter(Number.isInteger),
      codes: [value.code, value.type, nested?.code, nested?.type].filter(
        (item): item is string => typeof item === 'string',
      ),
      messages: [msg],
    },
    err,
  );

  if (lc.includes('401') || lc.includes('authentication') || lc.includes('api key')) {
    return new Error(
      'Anthropic API call failed: invalid API key\n→ check ANTHROPIC_API_KEY is set correctly\n→ get your key at: https://console.anthropic.com/settings/keys',
      { cause: reported },
    );
  }

  if (lc.includes('429') || lc.includes('rate limit')) {
    return new Error(
      'Anthropic API call failed: rate limit exceeded\n→ wait a moment and retry\n→ check usage limits at: https://console.anthropic.com/settings/limits',
      { cause: reported },
    );
  }

  if (lc.includes('400') || lc.includes('invalid') || lc.includes('model')) {
    return new Error(
      `Anthropic API call failed: bad request (model="${config.model}")\n→ check model ID is valid\n→ see available models at: https://docs.anthropic.com/en/docs/about-claude/models`,
      { cause: reported },
    );
  }

  return new Error(`Anthropic API call failed: ${msg}`, { cause: reported });
}

class ClaudeCliProvider implements LLMProvider {
  readonly name: ProviderName = 'claude-cli';
  private model: string;

  constructor({ model }: { model: string }) {
    this.model = model;
  }

  async analyze(
    systemPrompt: string,
    userPayload: unknown,
    opts: AnalyzeInvocationOptions = {},
  ): Promise<AnalyzeResult> {
    const userText = JSON.stringify(userPayload);
    return await traceAnalyze(
      this.name,
      this.model,
      systemPrompt,
      userText.length,
      async () => {
        const t0 = Date.now();

        // NOTE: no --bare. Without it claude-cli reads OAuth from the keychain,
        // so Pro/Max subscribers spend subscription tokens instead of needing
        // ANTHROPIC_API_KEY. Same rationale as claude-cli-compile.ts.
        const args = [
          'claude',
          '-p',
          '--system-prompt',
          systemPrompt,
          '--output-format',
          'json',
          '--model',
          this.model,
        ];

        opts.onEvent?.({
          type: 'process.started',
          timestamp: new Date().toISOString(),
          provider: this.name,
          command: args[0],
          args: args.slice(1),
        });
        let output: Awaited<ReturnType<typeof runOwnedCli>>;
        try {
          output = await runOwnedCli({
            command: args[0] as string,
            args: args.slice(1),
            input: userText,
            signal: opts.signal,
          });
        } catch (err) {
          opts.onEvent?.({
            type: 'process.spawn_failed',
            timestamp: new Date().toISOString(),
            provider: this.name,
            error: err instanceof Error ? err.message : String(err),
          });
          throw enrichClaudeCliError(err, { model: this.model });
        }
        const { stdout, stderr, exitCode } = output;

        let parsed: {
          type?: string;
          is_error?: boolean;
          result?: string;
          errors?: string[];
          api_error_status?: number | string;
          terminal_reason?: string;
          error?: {
            message?: string;
            type?: string;
            code?: string;
            status?: number;
            status_code?: number;
          };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        const terminal = parseClaudeTerminalOutput(stdout, stderr);
        if (terminal.providerError) throw terminal.providerError;
        if (exitCode !== 0) throw cliExitError('claude-cli', exitCode ?? -1, stderr);
        try {
          parsed = JSON.parse(stdout) as typeof parsed;
        } catch (parseErr) {
          throw enrichClaudeCliError(parseErr, { model: this.model });
        }

        if (!parsed.result) {
          throw new Error(
            'claude-cli output missing "result" field\n→ ensure you are using a compatible claude CLI version',
          );
        }

        return {
          text: parsed.result,
          inputTokens: parsed.usage?.input_tokens ?? null,
          outputTokens: parsed.usage?.output_tokens ?? null,
          cacheReadInputTokens: parsed.usage?.cache_read_input_tokens ?? null,
          cacheCreationInputTokens: parsed.usage?.cache_creation_input_tokens ?? null,
          durationMs: Date.now() - t0,
          stopReason: null,
        };
      },
      chatTraceDetails(systemPrompt, userText, {
        command: 'claude -p',
        output_format: 'json',
      }),
    );
  }
}

function enrichClaudeCliError(err: unknown, _config: { model: string }): Error {
  const control = providerControlError(err);
  if (control) return control;
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('enoent') || lc.includes('not found') || lc.includes('command not found')) {
    return new Error(
      'claude-cli not found\n→ install Claude Code CLI: https://docs.anthropic.com/claude/docs/claude-code',
      { cause: err },
    );
  }

  if (lc.includes('json') || lc.includes('parse')) {
    return new Error(`claude-cli returned invalid JSON: ${msg}`, { cause: err });
  }

  return new Error(`claude-cli failed: ${msg}`, { cause: err });
}

class CodexCliProvider implements LLMProvider {
  readonly name: ProviderName = 'codex-cli';
  private model: string;
  private readonly codex: Codex;
  private readonly conversations = new Map<
    string,
    { thread: Thread; systemPrompt: string; initialized: boolean; threadId?: string }
  >();

  constructor({ model }: { model: string }) {
    this.model = model;
    this.codex = new Codex({
      // Codex owns retained-history compaction. Imprint only asks it to compact
      // early enough that the next ordinary agent message still fits.
      // The largest normal research delta is a newly inspected evidence slice.
      // Compacting at 80k leaves ample room for that next bounded turn inside
      // the current 258k model window, even though Codex only checks between
      // turns and does not include the incoming message in that decision.
      config: {
        model_auto_compact_token_limit: 80_000,
        model_auto_compact_token_limit_scope: 'total',
      },
    });
  }

  async analyze(
    systemPrompt: string,
    userPayload: unknown,
    opts: AnalyzeInvocationOptions = {},
  ): Promise<AnalyzeResult> {
    const existing = opts.conversationKey
      ? this.conversations.get(opts.conversationKey)
      : undefined;
    const thread =
      existing?.thread ??
      this.codex.startThread({
        model: this.model,
        sandboxMode: 'read-only',
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        threadSource: 'imprint-teach',
      });
    if (opts.conversationKey && !existing) {
      // Keep the same SDK thread even when its first turn is interrupted. A
      // provider retry should continue this conversation, not silently fork it.
      this.conversations.set(opts.conversationKey, {
        thread,
        systemPrompt,
        initialized: false,
      });
    }
    const systemUpdate = existing?.initialized
      ? systemPrompt === existing.systemPrompt
        ? ''
        : systemPrompt.startsWith(existing.systemPrompt)
          ? `<additional_turn_instructions>\n${systemPrompt.slice(existing.systemPrompt.length).trim()}\n</additional_turn_instructions>\n\n`
          : `<updated_role_instructions>\n${systemPrompt}\n</updated_role_instructions>\n\n`
      : `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n`;
    const combinedPrompt = `${systemUpdate}<user_payload_json>
${JSON.stringify(userPayload)}
</user_payload_json>

${cliFinalArtifactInstruction()}`;
    return await traceAnalyze(
      this.name,
      this.model,
      systemPrompt,
      combinedPrompt.length,
      async () => {
        const t0 = Date.now();

        opts.onEvent?.({
          type: 'process.started',
          timestamp: new Date().toISOString(),
          provider: this.name,
          command: '@openai/codex-sdk',
          conversationKey: opts.conversationKey,
          threadId: existing?.threadId,
        });
        let turn: Awaited<ReturnType<Thread['run']>>;
        try {
          turn = await runCodexTurnWithWatchdog(
            (signal) => thread.run(combinedPrompt, { signal }),
            { signal: opts.signal },
          );
        } catch (err) {
          opts.onEvent?.({
            type: 'process.spawn_failed',
            timestamp: new Date().toISOString(),
            provider: this.name,
            error: err instanceof Error ? err.message : String(err),
          });
          throw enrichCodexCliError(err, { model: this.model });
        }
        if (!turn.finalResponse) {
          throw new Error('codex-cli output missing a final agent message');
        }
        const threadId = thread.id ?? existing?.threadId;
        if (opts.conversationKey)
          this.conversations.set(opts.conversationKey, {
            thread,
            systemPrompt,
            initialized: true,
            threadId,
          });
        opts.onEvent?.({
          type: 'thread.available',
          timestamp: new Date().toISOString(),
          provider: this.name,
          conversationKey: opts.conversationKey,
          threadId,
        });

        const text = normalizeCliAnalyzeOutput(turn.finalResponse, systemPrompt);
        const usage = turn.usage;

        return {
          text,
          inputTokens: usage ? Math.max(0, usage.input_tokens - usage.cached_input_tokens) : null,
          outputTokens: usage?.output_tokens ?? null,
          cacheReadInputTokens: usage?.cached_input_tokens ?? null,
          cacheCreationInputTokens: usage?.cache_write_input_tokens ?? null,
          durationMs: Date.now() - t0,
          stopReason: null,
        };
      },
      promptTraceDetails(combinedPrompt, {
        command: '@openai/codex-sdk',
        sandbox: 'read-only',
        conversationKey: opts.conversationKey,
      }),
    );
  }
}

const DEFAULT_CODEX_TURN_WATCHDOG_MS = 5 * 60_000;

export function codexTurnWatchdogMs(value = process.env.IMPRINT_CODEX_TURN_TIMEOUT_MS): number {
  if (value === undefined || value.trim() === '') return DEFAULT_CODEX_TURN_WATCHDOG_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CODEX_TURN_WATCHDOG_MS;
}

/**
 * The Codex SDK can occasionally leave `Thread.run()` pending after its child
 * process has already exited. Bound one SDK turn so the ordinary provider
 * retry loop can continue the retained conversation instead of parking the
 * complete teach run until its outer deadline.
 */
export async function runCodexTurnWithWatchdog<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? codexTurnWatchdogMs();
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException('Codex turn cancelled', 'AbortError'),
    );
  };
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once: true });

  const timeoutError = new ProviderReportedError(
    'codex-cli',
    {
      codes: ['codex_turn_stalled'],
      messages: [`Codex turn did not settle within ${timeoutMs}ms`],
    },
    undefined,
    'provider_process_interrupted',
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectWithReason = (): void =>
      reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DOMException('Codex turn cancelled', 'AbortError'),
      );
    if (controller.signal.aborted) rejectWithReason();
    else controller.signal.addEventListener('abort', rejectWithReason, { once: true });
  });
  const pending = run(controller.signal);
  // A broken SDK promise may remain pending even after its child is aborted.
  // The race must not leave a later rejection unobserved.
  void pending.catch(() => {});
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

export function normalizeCliAnalyzeOutput(stdout: string, systemPrompt: string): string {
  if (!promptRequestsJsonObject(systemPrompt)) return stdout;
  return extractJsonObject(stdout) ?? stdout;
}

const CLI_STDERR_TAIL_LIMIT = 2000;

export function cliExitError(provider: ProviderName, exitCode: number, stderr: string): Error {
  if (provider === 'codex-cli' && exitCode === 101) {
    const diagnostic = stderr.trim();
    return new ProviderReportedError(
      provider,
      {
        codes: ['cli_exit_101'],
        messages: [
          diagnostic
            ? `${provider} process exited 101: ${cliStderrTail(diagnostic)}`
            : `${provider} process exited 101 without a diagnostic`,
        ],
      },
      undefined,
      'provider_process_interrupted',
    );
  }
  return new Error(
    `${provider} exited ${exitCode}${stderr ? `: ${cliStderrTail(stderr)}` : ' without provider diagnostics'}`,
  );
}

export function cliStderrTail(stderr: string, limit = CLI_STDERR_TAIL_LIMIT): string {
  if (stderr.length <= limit) return stderr;
  return stderr.slice(stderr.length - limit);
}

async function traceAnalyze(
  provider: ProviderName,
  model: string,
  systemPrompt: string,
  payloadChars: number,
  fn: () => Promise<AnalyzeResult>,
  details?: TraceAnalyzeDetails,
): Promise<AnalyzeResult> {
  const captureIo = traceLlmIoEnabled();
  return await traced(
    'llm.analyze',
    'LLM',
    {
      'imprint.llm.provider': provider,
      'imprint.llm.model': model,
      'imprint.llm.system_prompt_chars': systemPrompt.length,
      'imprint.llm.payload_chars': payloadChars,
      ...(captureIo
        ? llmSpanAttributes({
            provider,
            model,
            inputMessages: details?.inputMessages
              ? traceLlmMessages(details.inputMessages)
              : undefined,
            inputValue: details?.inputText,
            invocationParameters: details?.invocationParameters,
          })
        : {}),
    },
    async (span) => {
      const result = await fn();
      // Providers report `inputTokens` as the *uncached* input only; the cached
      // portion lives in the cache fields. Phoenix expects the TOTAL prompt plus
      // the cache breakdown so it can calculate cost server-side, so sum them
      // here. A real total is also large enough to clear the
      // resolveTraceTokenCount sanity check, so cache-hit calls stop falling back
      // to the chars/4 estimate.
      const cacheReadTokens = result.cacheReadInputTokens ?? undefined;
      const cacheWriteTokens = result.cacheCreationInputTokens ?? undefined;
      const totalInputTokens = totalPromptTokens(
        result.inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      );
      const inputTokens = resolveTraceTokenCount(totalInputTokens, details?.inputText);
      const outputTokens = resolveTraceTokenCount(result.outputTokens, result.text);
      setSpanAttributes(span, {
        ...llmSpanAttributes({
          provider,
          model,
          inputTokens: inputTokens.tokens,
          outputTokens: outputTokens.tokens,
          cacheReadTokens,
          cacheWriteTokens,
          tokenCountsEstimated:
            inputTokens.source === 'estimated' || outputTokens.source === 'estimated',
          inputTokenSource: inputTokens.source,
          outputTokenSource: outputTokens.source,
          stopReason: result.stopReason,
          outputMessages: captureIo
            ? traceLlmMessages([{ role: 'assistant', content: result.text }])
            : undefined,
          outputValue: captureIo ? result.text : undefined,
          invocationParameters: details?.invocationParameters,
        }),
        'imprint.llm.duration_ms': result.durationMs,
        'imprint.llm.output_chars': result.text.length,
      });
      return result;
    },
  );
}

async function traceMessageWithTools(
  provider: ProviderName,
  model: string,
  opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
  },
  fn: () => Promise<Anthropic.Message>,
): Promise<Anthropic.Message> {
  const captureIo = traceLlmIoEnabled();
  return await traced(
    'llm.message_with_tools',
    'LLM',
    {
      'imprint.llm.provider': provider,
      'imprint.llm.model': model,
      'imprint.llm.message_count': opts.messages.length,
      'imprint.llm.tool_count': opts.tools.length,
      'imprint.llm.tool_names': opts.tools.map((t) => t.name).join(', '),
      ...(captureIo
        ? llmSpanAttributes({
            provider,
            model,
            inputMessages: traceLlmMessages(flattenAnthropicMessages(opts.system, opts.messages)),
            inputValue: JSON.stringify({
              system: opts.system,
              messages: opts.messages,
              tools: opts.tools.map((t) => t.name),
            }),
            inputMimeType: 'application/json',
          })
        : {}),
    },
    async (span) => {
      const t0 = Date.now();
      const response = await fn();
      const toolUseNames = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => b.name);
      const outputText = response.content
        .map((b) => {
          if (b.type === 'text') return b.text;
          if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
          return `[${b.type}]`;
        })
        .join('\n');
      const cacheReadTokens = response.usage.cache_read_input_tokens ?? undefined;
      const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? undefined;
      setSpanAttributes(span, {
        ...llmSpanAttributes({
          provider,
          model,
          inputTokens: totalPromptTokens(
            response.usage.input_tokens,
            cacheReadTokens,
            cacheWriteTokens,
          ),
          outputTokens: response.usage.output_tokens,
          cacheReadTokens,
          cacheWriteTokens,
          stopReason: response.stop_reason,
          outputMessages: captureIo
            ? traceLlmMessages([{ role: 'assistant', content: outputText }])
            : undefined,
          outputValue: captureIo ? outputText : undefined,
        }),
        'imprint.llm.duration_ms': Date.now() - t0,
        'imprint.llm.tools_called': toolUseNames.join(', '),
        'imprint.llm.tools_called_count': toolUseNames.length,
      });
      return response;
    },
  );
}

function flattenAnthropicMessages(
  system: string,
  messages: Anthropic.MessageParam[],
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [{ role: 'system', content: system }];
  for (const msg of messages) {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .map((b) => {
              if (b.type === 'text') return b.text;
              if (b.type === 'tool_result') {
                const inner =
                  typeof b.content === 'string'
                    ? b.content
                    : Array.isArray(b.content)
                      ? b.content.map((c) => ('text' in c ? c.text : `[${c.type}]`)).join('\n')
                      : `[tool_result: ${b.tool_use_id}]`;
                return inner;
              }
              if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
              return `[${b.type}]`;
            })
            .join('\n');
    out.push({ role: msg.role, content: text });
  }
  return out;
}

function chatTraceDetails(
  systemPrompt: string,
  userText: string,
  invocationParameters?: Record<string, unknown>,
): TraceAnalyzeDetails {
  return {
    inputText: JSON.stringify({
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
    inputMessages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    invocationParameters,
  };
}

function promptTraceDetails(
  prompt: string,
  invocationParameters?: Record<string, unknown>,
): TraceAnalyzeDetails {
  return {
    inputText: prompt,
    inputMessages: [{ role: 'user', content: prompt }],
    invocationParameters,
  };
}

function promptRequestsJsonObject(systemPrompt: string): boolean {
  const lc = systemPrompt.toLowerCase();
  if (/\byaml\b/.test(lc)) return false;
  if (/\bjson\s+array\b/.test(lc) || /\barray\s+of\b/.test(lc)) return false;
  return /\bjson\b/.test(lc) && /\bobject\b/.test(lc);
}

export function enrichCodexCliError(err: unknown, _config: { model: string }): Error {
  const control = providerControlError(err);
  if (control) return control;
  const reported = providerReportedError(err);
  if (reported) return reported;
  const msg = err instanceof Error ? err.message : String(err);

  // @openai/codex-sdk reports process exits as ordinary Error objects instead
  // of the structured provider error used by the older CLI adapter. Normalize
  // that exact adapter-owned shape so a blank exit 101 gets the same bounded
  // provider retry as every other interrupted Codex call. Keep diagnostics and
  // all other exit codes deterministic.
  const sdkExit = /^Codex Exec exited with code (\d+):([\s\S]*)$/.exec(msg);
  if (sdkExit) return cliExitError('codex-cli', Number(sdkExit[1]), sdkExit[2] ?? '');

  const errorCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  if (
    errorCode === 'ENOENT' ||
    errorCode === 'ENOTDIR' ||
    /^Unable to locate Codex CLI binaries\b/.test(msg)
  ) {
    return new Error(
      'codex-cli not found\n→ install Codex CLI, run `codex login`, and make sure `codex` is on PATH',
      { cause: err },
    );
  }

  return new Error(`codex-cli failed: ${msg}`, { cause: err });
}

class CursorCliProvider implements LLMProvider {
  readonly name: ProviderName = 'cursor-cli';
  private model: string | undefined;

  constructor({ model }: { model?: string }) {
    this.model = model;
  }

  async analyze(
    systemPrompt: string,
    userPayload: unknown,
    opts: AnalyzeInvocationOptions = {},
  ): Promise<AnalyzeResult> {
    const combinedPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

<user_payload_json>
${JSON.stringify(userPayload)}
</user_payload_json>

${cliFinalArtifactInstruction()}`;
    return await traceAnalyze(
      this.name,
      this.model ?? 'default',
      systemPrompt,
      combinedPrompt.length,
      async () => {
        const t0 = Date.now();

        const args = ['cursor', 'agent', '-p', '--mode', 'ask'];
        if (this.model) {
          args.push('--model', this.model);
        }

        opts.onEvent?.({
          type: 'process.started',
          timestamp: new Date().toISOString(),
          provider: this.name,
          command: args[0],
          args: args.slice(1),
        });
        let output: Awaited<ReturnType<typeof runOwnedCli>>;
        try {
          output = await runOwnedCli({
            command: args[0] as string,
            args: args.slice(1),
            input: combinedPrompt,
            signal: opts.signal,
          });
        } catch (err) {
          opts.onEvent?.({
            type: 'process.spawn_failed',
            timestamp: new Date().toISOString(),
            provider: this.name,
            error: err instanceof Error ? err.message : String(err),
          });
          throw enrichCursorCliError(err);
        }
        const { stdout, stderr, exitCode } = output;

        if (exitCode !== 0) throw cliExitError('cursor-cli', exitCode ?? -1, stderr);

        const text = normalizeCliAnalyzeOutput(stdout, systemPrompt);

        return {
          text,
          inputTokens: null,
          outputTokens: null,
          durationMs: Date.now() - t0,
          stopReason: null,
        };
      },
      promptTraceDetails(combinedPrompt, {
        command: 'cursor agent',
        mode: 'ask',
      }),
    );
  }
}

function enrichCursorCliError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('enoent') || lc.includes('not found') || lc.includes('command not found')) {
    return new Error(
      'cursor-cli not found\n→ install Cursor and enable the CLI: https://www.cursor.com',
      { cause: err },
    );
  }

  return new Error(`cursor-cli failed: ${msg}`, { cause: err });
}

const VALID_PROVIDERS: readonly ProviderName[] = [
  'anthropic-api',
  'claude-cli',
  'codex-cli',
  'cursor-cli',
];

interface ProviderStatus {
  name: ProviderName;
  detected: boolean;
  availableForTeach: boolean;
  reason: string;
  setupHint: string;
}

export function isValidProvider(s: string): s is ProviderName {
  return (VALID_PROVIDERS as readonly string[]).includes(s);
}

export function isTeachCompatibleProvider(name: ProviderName): boolean {
  return name === 'anthropic-api' || name === 'claude-cli' || name === 'codex-cli';
}

export function getProviderStatuses(): ProviderStatus[] {
  const claudePath = Bun.which('claude');
  const codexPath = Bun.which('codex');
  const cursorPath = Bun.which('cursor');
  const hasAnthropicApiKey = !!process.env.ANTHROPIC_API_KEY;

  const statuses: ProviderStatus[] = [
    {
      name: 'claude-cli',
      detected: !!claudePath,
      availableForTeach: !!claudePath,
      reason: claudePath ? `claude found at ${claudePath}` : 'claude not found on PATH',
      setupHint:
        'Install Claude Code, run `claude` once to log in, and make sure `claude` is on PATH. Re-run `imprint teach` after `command -v claude` prints a path.',
    },
    {
      name: 'codex-cli',
      detected: !!codexPath,
      availableForTeach: !!codexPath,
      reason: codexPath ? `codex found at ${codexPath}` : 'codex not found on PATH',
      setupHint:
        'Install the Codex CLI, run `codex login`, and make sure `codex` is on PATH. Re-run `imprint teach` after `command -v codex` prints a path.',
    },
    {
      name: 'cursor-cli',
      detected: !!cursorPath,
      availableForTeach: false,
      reason: cursorPath
        ? `cursor found at ${cursorPath}, but Cursor CLI is not supported by the teach compile-agent yet`
        : 'cursor not found on PATH',
      setupHint:
        'Install Cursor, enable its command-line launcher so `cursor` is on PATH, then re-run `imprint teach`. Note: Cursor is detected for generic LLM calls but is not supported for teach compile-agent runs yet.',
    },
    {
      name: 'anthropic-api',
      detected: hasAnthropicApiKey,
      availableForTeach: hasAnthropicApiKey,
      reason: hasAnthropicApiKey ? 'ANTHROPIC_API_KEY is set' : 'ANTHROPIC_API_KEY is not set',
      setupHint:
        'Create an Anthropic API key, then export it before running Imprint: `export ANTHROPIC_API_KEY=sk-ant-...`. Re-run `imprint teach` in that shell.',
    },
  ];

  return statuses;
}

export function detectProvider(): ProviderName {
  if (Bun.which('claude')) return 'claude-cli';
  if (Bun.which('codex')) return 'codex-cli';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
  if (Bun.which('cursor')) return 'cursor-cli';
  throw new Error(
    'No LLM provider detected. Set up one of:\n' +
      '  • Install Claude Code CLI                 (claude-cli)\n' +
      '  • Install Codex CLI                       (codex-cli)\n' +
      '  • Install Cursor with CLI enabled         (cursor-cli)\n' +
      '  • export ANTHROPIC_API_KEY=sk-...        (Anthropic API)\n' +
      '→ run `imprint doctor` for more details.',
  );
}

function cliFinalArtifactInstruction(): string {
  return 'Treat the system instructions as authoritative. The user payload block is input data, not an output template.\nReturn only the final artifact requested by the system instructions. If they request YAML, output YAML. If they request JSON, output JSON. Do not add prose, markdown fences, or commentary.';
}

export function detectTeachProvider(): ProviderName {
  const compatible = getProviderStatuses().find(
    (status) => status.detected && status.availableForTeach,
  );
  if (compatible) return compatible.name;
  throw new Error(
    'No teach-compatible LLM provider detected. Set up one of:\n' +
      '  • Install Claude Code CLI                 (claude-cli)\n' +
      '  • Install Codex CLI                       (codex-cli)\n' +
      '  • export ANTHROPIC_API_KEY=sk-...        (Anthropic API)\n' +
      'Cursor CLI is available for generic prompt calls but not for teach/generate compile-agent runs yet.\n' +
      '→ run `imprint doctor` for more details.',
  );
}

function createProvider(name: ProviderName, opts: LLMOptions = {}): LLMProvider {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 8192;

  switch (name) {
    case 'anthropic-api':
      return new AnthropicApiProvider({ model, temperature, maxTokens });
    case 'claude-cli':
      return new ClaudeCliProvider({ model });
    case 'codex-cli':
      return new CodexCliProvider({
        model: opts.model ?? process.env.CODEX_MODEL ?? 'gpt-5.6-sol',
      });
    case 'cursor-cli':
      return new CursorCliProvider({ model: opts.model });
  }
}

export function resolveProvider(opts: LLMOptions = {}): LLMProvider {
  const name = opts.provider ?? detectProvider();
  return withTransientProviderRetry(createProvider(name, opts));
}

/** Apply one provider-neutral capacity retry policy to every ordinary LLM call. */
function withTransientProviderRetry(provider: LLMProvider): LLMProvider {
  const analyze = async (
    systemPrompt: string,
    userPayload: unknown,
    opts: AnalyzeInvocationOptions = {},
  ): Promise<AnalyzeResult> => {
    const timeoutDeadline =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;
    const runDeadline = resolvedRunDeadline(opts.runDeadline, opts.deadlineMs);
    const scopedDeadline = boundedRunDeadline(runDeadline, timeoutDeadline);
    return await retryTransientProviderFailure(
      async (activeSignal) =>
        await provider.analyze(systemPrompt, userPayload, {
          ...opts,
          signal: activeSignal,
          timeoutMs: undefined,
          deadlineMs: scopedDeadline?.deadlineMs,
          runDeadline: scopedDeadline,
        }),
      {
        runDeadline,
        phaseDeadlineMs: timeoutDeadline,
        signal: opts.signal,
        onDeadlineReached: opts.onDeadlineReached,
        onRetry: (event) => {
          opts.onProviderRetry?.(event);
          opts.onEvent?.({
            type: 'provider.retry_scheduled',
            timestamp: new Date().toISOString(),
            provider: provider.name,
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason,
          });
        },
      },
    );
  };

  if (isToolUseProvider(provider)) {
    const wrapped: ToolUseProvider = {
      name: provider.name,
      analyze,
      messageWithTools: provider.messageWithTools.bind(provider),
    };
    return wrapped;
  }
  return { name: provider.name, analyze };
}

/** The model to use for the compile-agent (the agentic, tool-using compile
 *  loop) on each provider. Defaults to Opus on Claude-capable backends —
 *  the iterative reverse-engineering benefits significantly from the stronger
 *  model, and Pro/Max claude-cli subscribers already pay for Opus access.
 *  Honors $ANTHROPIC_MODEL_AGENT (preferred) or $ANTHROPIC_MODEL (fallback)
 *  for explicit overrides. */
export function preferredAgentModel(provider: ProviderName): string {
  const override =
    provider === 'codex-cli'
      ? (process.env.CODEX_MODEL_AGENT ??
        process.env.CODEX_MODEL ??
        process.env.ANTHROPIC_MODEL_AGENT ??
        process.env.ANTHROPIC_MODEL)
      : (process.env.ANTHROPIC_MODEL_AGENT ?? process.env.ANTHROPIC_MODEL);
  if (override) return override;
  switch (provider) {
    case 'anthropic-api':
    case 'claude-cli':
      return 'claude-opus-4-8';
    case 'codex-cli':
      return 'gpt-5.6-sol';
    case 'cursor-cli':
      return 'claude-opus-4-8'; // best-effort; cursor passes through
  }
}

/** Model policy for the independent live semantic verifier. Keep this separate
 * from the compile-agent preference so the reviewer is intentionally a fresh,
 * differently configured agent. No fallback is allowed: an unavailable model
 * makes verification inconclusive and the compile fails closed. */
export function preferredVerificationModel(provider: ProviderName): string {
  if (provider === 'codex-cli') return 'gpt-5.6-terra';
  if (provider === 'claude-cli' || provider === 'anthropic-api') {
    const latestSonnet = availableModelsForProvider(provider).find((option) =>
      option.model.startsWith('claude-sonnet-'),
    );
    if (latestSonnet) return latestSonnet.model;
    throw new Error(`No Sonnet model is available for verification on ${provider}`);
  }
  throw new Error(`Provider ${provider} does not support live semantic verification`);
}

/** The semantic reviewer intentionally uses a provider independent from the
 * compiler. Claude/Sonnet compilation therefore still receives a Terra review. */
export const DEFAULT_VERIFICATION_PROVIDER: ProviderName = 'codex-cli';

interface ModelOption {
  model: string;
  isDefault: boolean;
}

export function availableModelsForProvider(provider: ProviderName): ModelOption[] {
  switch (provider) {
    case 'anthropic-api':
    case 'claude-cli':
      return [
        { model: 'claude-opus-4-8', isDefault: true },
        { model: 'claude-opus-4-7', isDefault: false },
        { model: 'claude-sonnet-4-6', isDefault: false },
        { model: 'claude-haiku-4-5', isDefault: false },
        { model: 'claude-opus-4-6', isDefault: false },
        { model: 'claude-sonnet-4-5', isDefault: false },
        { model: 'claude-opus-4-5', isDefault: false },
      ];
    case 'codex-cli':
      return [
        { model: 'gpt-5.6-sol', isDefault: true },
        { model: 'gpt-5.6-terra', isDefault: false },
        { model: 'gpt-5.6-luna', isDefault: false },
        { model: 'gpt-5.5', isDefault: false },
        { model: 'gpt-5.4', isDefault: false },
        { model: 'gpt-5.4-mini', isDefault: false },
        { model: 'gpt-5.2', isDefault: false },
        { model: 'gpt-5.2-pro', isDefault: false },
        { model: 'gpt-5.1', isDefault: false },
        { model: 'gpt-5', isDefault: false },
        { model: 'gpt-4.1', isDefault: false },
        { model: 'gpt-4.1-mini', isDefault: false },
        { model: 'o4-mini', isDefault: false },
        { model: 'o3', isDefault: false },
        { model: 'o3-mini', isDefault: false },
        { model: 'o1', isDefault: false },
      ];
    case 'cursor-cli':
      return [
        { model: 'claude-opus-4-8', isDefault: true },
        { model: 'claude-opus-4-7', isDefault: false },
        { model: 'claude-sonnet-4-6', isDefault: false },
        { model: 'claude-haiku-4-5', isDefault: false },
        { model: 'gpt-5.5', isDefault: false },
        { model: 'gpt-5.4', isDefault: false },
        { model: 'gpt-5.4-mini', isDefault: false },
        { model: 'o3', isDefault: false },
        { model: 'gemini-2.5-pro', isDefault: false },
        { model: 'gemini-2.5-flash', isDefault: false },
      ];
  }
}

/** Extract the first balanced top-level JSON array — handles fenced
 *  code blocks and preamble text. Returns null if no array is found. */
export function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf('[');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Extract the first balanced top-level JSON object — handles fenced
 *  code blocks and preamble text. Returns null if no object is found. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}
