/** Multi-provider LLM client — system prompt + JSON-serialized
 *  user payload → raw model text. */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import {
  llmSpanAttributes,
  resolveTraceTokenCount,
  setSpanAttributes,
  traceLlmIoEnabled,
  traceLlmMessages,
  traced,
} from './tracing.ts';

export type ProviderName = 'anthropic-api' | 'vertex' | 'claude-cli' | 'codex-cli' | 'cursor-cli';

interface AnalyzeResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  stopReason: string | null;
}

interface LLMProvider {
  readonly name: ProviderName;
  analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult>;
}

interface CliProcessWithOutput {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

interface TraceAnalyzeDetails {
  inputText: string;
  inputMessages: Array<{ role: string; content: string }>;
  invocationParameters?: Record<string, unknown>;
}

/** Subset of providers that support the Anthropic tool-use protocol.
 *  vertex and anthropic-api qualify. CLI providers use separate orchestration
 *  paths for agentic compile when supported. */
export interface ToolUseProvider extends LLMProvider {
  messageWithTools(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
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
  projectId?: string;
  region?: string;
}

class VertexProvider implements LLMProvider {
  readonly name: ProviderName = 'vertex';
  private client: AnthropicVertex;
  private config: {
    projectId: string;
    region: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };

  constructor({
    projectId,
    region,
    model,
    temperature,
    maxTokens,
  }: {
    projectId: string;
    region: string;
    model: string;
    temperature: number;
    maxTokens: number;
  }) {
    this.config = { projectId, region, model, temperature, maxTokens };
    this.client = new AnthropicVertex({
      projectId,
      region,
    });
  }

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
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
          response = await this.client.messages.create({
            model: this.config.model,
            max_tokens: invocationParameters.max_tokens,
            ...(invocationParameters.temperature === undefined
              ? {}
              : { temperature: invocationParameters.temperature }),
            system: systemPrompt,
            messages: [{ role: 'user', content: userText }],
          });
        } catch (err) {
          throw enrichVertexError(err, this.config);
        }

        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => ('text' in block ? block.text : ''))
          .join('');

        return {
          text,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
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
  }): Promise<Anthropic.Message> {
    return await traceMessageWithTools(this.name, this.config.model, opts, async () => {
      try {
        const response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: opts.maxTokens ?? this.config.maxTokens,
          ...temperatureFragment(this.config.model, this.config.temperature),
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
        });
        return response as unknown as Anthropic.Message;
      } catch (err) {
        throw enrichVertexError(err, this.config);
      }
    });
  }
}

function enrichVertexError(
  err: unknown,
  config: { projectId: string; region: string; model: string },
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('not_found') || lc.includes('publisher model') || lc.includes('404')) {
    return new Error(
      `Vertex Anthropic call failed (${msg.split('\n')[0]?.slice(0, 200)})\n→ check that "${config.model}" is enabled in region "${config.region}" for project "${config.projectId}"\n→ enable models at: https://console.cloud.google.com/vertex-ai/model-garden\n→ run \`imprint doctor\` to verify env vars.`,
      { cause: err },
    );
  }

  if (lc.includes('unauthenticated') || lc.includes('401') || lc.includes('credentials')) {
    return new Error(
      `Vertex Anthropic call failed: not authenticated\n→ run \`gcloud auth application-default login\`\n→ ensure the active account has the Vertex AI User role on project "${config.projectId}"`,
      { cause: err },
    );
  }

  if (lc.includes('permission_denied') || lc.includes('403')) {
    return new Error(
      `Vertex Anthropic call failed: permission denied\n→ active account needs "roles/aiplatform.user" on project "${config.projectId}"\n→ check IAM at: https://console.cloud.google.com/iam-admin/iam`,
      { cause: err },
    );
  }

  if (lc.includes('resource_exhausted') || lc.includes('429') || lc.includes('quota')) {
    return new Error(
      'Vertex Anthropic call failed: quota exceeded\n→ check quota at: https://console.cloud.google.com/iam-admin/quotas\n→ or wait + retry; transient quota errors are common at peak',
      { cause: err },
    );
  }

  return new Error(`Vertex Anthropic call failed: ${msg}`, { cause: err });
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

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
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
          response = await this.client.messages.create({
            model: this.config.model,
            max_tokens: invocationParameters.max_tokens,
            ...(invocationParameters.temperature === undefined
              ? {}
              : { temperature: invocationParameters.temperature }),
            system: systemPrompt,
            messages: [{ role: 'user', content: userText }],
          });
        } catch (err) {
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
  }): Promise<Anthropic.Message> {
    return await traceMessageWithTools(this.name, this.config.model, opts, async () => {
      try {
        const response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: opts.maxTokens ?? this.config.maxTokens,
          ...temperatureFragment(this.config.model, this.config.temperature),
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
        });
        return response;
      } catch (err) {
        throw enrichAnthropicApiError(err, this.config);
      }
    });
  }
}

function enrichAnthropicApiError(err: unknown, config: { model: string }): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('401') || lc.includes('authentication') || lc.includes('api key')) {
    return new Error(
      'Anthropic API call failed: invalid API key\n→ check ANTHROPIC_API_KEY is set correctly\n→ get your key at: https://console.anthropic.com/settings/keys',
      { cause: err },
    );
  }

  if (lc.includes('429') || lc.includes('rate limit')) {
    return new Error(
      'Anthropic API call failed: rate limit exceeded\n→ wait a moment and retry\n→ check usage limits at: https://console.anthropic.com/settings/limits',
      { cause: err },
    );
  }

  if (lc.includes('400') || lc.includes('invalid') || lc.includes('model')) {
    return new Error(
      `Anthropic API call failed: bad request (model="${config.model}")\n→ check model ID is valid\n→ see available models at: https://docs.anthropic.com/en/docs/about-claude/models`,
      { cause: err },
    );
  }

  return new Error(`Anthropic API call failed: ${msg}`, { cause: err });
}

class ClaudeCliProvider implements LLMProvider {
  readonly name: ProviderName = 'claude-cli';
  private model: string;

  constructor({ model }: { model: string }) {
    this.model = model;
  }

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
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

        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(args, {
            stdin: new Blob([userText]),
            stdout: 'pipe',
            stderr: 'pipe',
          });
        } catch (err) {
          throw enrichClaudeCliError(err, { model: this.model });
        }

        if (
          typeof proc.stdout === 'number' ||
          typeof proc.stderr === 'number' ||
          !proc.stdout ||
          !proc.stderr
        ) {
          throw new Error('Failed to capture claude-cli output streams');
        }

        const { stdout, stderr, exitCode } = await collectCliProcessOutput({
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: proc.exited,
        });

        if (exitCode !== 0) {
          throw enrichClaudeCliError(
            new Error(`claude-cli exited with code ${exitCode}\n${stderr}`),
            {
              model: this.model,
            },
          );
        }

        let parsed: { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        try {
          parsed = JSON.parse(stdout);
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

  constructor({ model }: { model: string }) {
    this.model = model;
  }

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
    const combinedPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

<user_payload_json>
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

        const args = codexAnalyzeArgs(this.model);

        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(args, {
            stdin: new Blob([combinedPrompt]),
            stdout: 'pipe',
            stderr: 'pipe',
          });
        } catch (err) {
          throw enrichCodexCliError(err, { model: this.model });
        }

        if (
          typeof proc.stdout === 'number' ||
          typeof proc.stderr === 'number' ||
          !proc.stdout ||
          !proc.stderr
        ) {
          throw new Error('Failed to capture codex-cli output streams');
        }

        const { stdout, stderr, exitCode } = await collectCliProcessOutput({
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: proc.exited,
        });

        if (exitCode !== 0) {
          throw enrichCodexCliError(
            new Error(`codex-cli exited with code ${exitCode}\n${stderr}`),
            {
              model: this.model,
            },
          );
        }

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
        command: 'codex exec',
        sandbox: 'read-only',
      }),
    );
  }
}

export function codexAnalyzeArgs(model: string): string[] {
  return [
    'codex',
    '-a',
    'never',
    'exec',
    '-m',
    model,
    '-s',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
  ];
}

export function normalizeCliAnalyzeOutput(stdout: string, systemPrompt: string): string {
  if (!promptRequestsJsonObject(systemPrompt)) return stdout;
  return extractJsonObject(stdout) ?? stdout;
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
      const inputTokens = resolveTraceTokenCount(result.inputTokens, details?.inputText);
      const outputTokens = resolveTraceTokenCount(result.outputTokens, result.text);
      setSpanAttributes(span, {
        ...llmSpanAttributes({
          provider,
          model,
          inputTokens: inputTokens.tokens,
          outputTokens: outputTokens.tokens,
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
            inputMessages: traceLlmMessages(
              flattenAnthropicMessages(opts.system, opts.messages),
            ),
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
      setSpanAttributes(span, {
        ...llmSpanAttributes({
          provider,
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
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
  const out: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
  ];
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
                      ? b.content
                          .map((c) => ('text' in c ? c.text : `[${c.type}]`))
                          .join('\n')
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

export async function collectCliProcessOutput(proc: CliProcessWithOutput): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const stdoutPromise = Bun.readableStreamToText(proc.stdout);
  const stderrPromise = Bun.readableStreamToText(proc.stderr);
  const exitPromise = proc.exited;
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, exitPromise]);
  return { stdout, stderr, exitCode };
}

function promptRequestsJsonObject(systemPrompt: string): boolean {
  const lc = systemPrompt.toLowerCase();
  if (/\byaml\b/.test(lc)) return false;
  if (/\bjson\s+array\b/.test(lc) || /\barray\s+of\b/.test(lc)) return false;
  return /\bjson\b/.test(lc) && /\bobject\b/.test(lc);
}

function enrichCodexCliError(err: unknown, _config: { model: string }): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('enoent') || lc.includes('not found') || lc.includes('command not found')) {
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

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
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

        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(args, {
            stdin: new Blob([combinedPrompt]),
            stdout: 'pipe',
            stderr: 'pipe',
          });
        } catch (err) {
          throw enrichCursorCliError(err);
        }

        if (
          typeof proc.stdout === 'number' ||
          typeof proc.stderr === 'number' ||
          !proc.stdout ||
          !proc.stderr
        ) {
          throw new Error('Failed to capture cursor-cli output streams');
        }

        const { stdout, stderr, exitCode } = await collectCliProcessOutput({
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: proc.exited,
        });

        if (exitCode !== 0) {
          throw enrichCursorCliError(
            new Error(`cursor-cli exited with code ${exitCode}\n${stderr}`),
          );
        }

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
  'vertex',
  'claude-cli',
  'codex-cli',
  'cursor-cli',
];

export interface ProviderStatus {
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
  return (
    name === 'anthropic-api' || name === 'vertex' || name === 'claude-cli' || name === 'codex-cli'
  );
}

export function getProviderStatuses(): ProviderStatus[] {
  const claudePath = Bun.which('claude');
  const codexPath = Bun.which('codex');
  const cursorPath = Bun.which('cursor');
  const hasAnthropicApiKey = !!process.env.ANTHROPIC_API_KEY;
  const vertexProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;

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
    {
      name: 'vertex',
      detected: !!vertexProject,
      availableForTeach: !!vertexProject,
      reason: vertexProject
        ? `Vertex project detected (${vertexProject})`
        : 'ANTHROPIC_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT is not set',
      setupHint:
        'Set `ANTHROPIC_VERTEX_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT`, authenticate with `gcloud auth application-default login`, and enable Anthropic Claude models in Vertex AI Model Garden for that project.',
    },
  ];

  return statuses;
}

export function detectProvider(): ProviderName {
  if (Bun.which('claude')) return 'claude-cli';
  if (Bun.which('codex')) return 'codex-cli';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
  if (process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT) return 'vertex';
  if (Bun.which('cursor')) return 'cursor-cli';
  throw new Error(
    'No LLM provider detected. Set up one of:\n' +
      '  • Install Claude Code CLI                 (claude-cli)\n' +
      '  • Install Codex CLI                       (codex-cli)\n' +
      '  • Install Cursor with CLI enabled         (cursor-cli)\n' +
      '  • export ANTHROPIC_API_KEY=sk-...        (Anthropic API)\n' +
      '  • export ANTHROPIC_VERTEX_PROJECT_ID=...  (Vertex AI)\n' +
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
      '  • export ANTHROPIC_VERTEX_PROJECT_ID=...  (Vertex AI)\n' +
      'Cursor CLI is available for generic prompt calls but not for teach/generate compile-agent runs yet.\n' +
      '→ run `imprint doctor` for more details.',
  );
}

function createProvider(name: ProviderName, opts: LLMOptions = {}): LLMProvider {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 8192;

  switch (name) {
    case 'anthropic-api':
      return new AnthropicApiProvider({ model, temperature, maxTokens });
    case 'vertex': {
      const projectId =
        opts.projectId ??
        process.env.ANTHROPIC_VERTEX_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        '';
      if (!projectId)
        throw new Error(
          'Vertex provider requires a project ID.\n→ export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id',
        );
      const region = opts.region ?? process.env.CLOUD_ML_REGION ?? 'us-east5';
      return new VertexProvider({ projectId, region, model, temperature, maxTokens });
    }
    case 'claude-cli':
      return new ClaudeCliProvider({ model });
    case 'codex-cli':
      return new CodexCliProvider({
        model: opts.model ?? process.env.CODEX_MODEL ?? 'gpt-5.4',
      });
    case 'cursor-cli':
      return new CursorCliProvider({ model: opts.model });
  }
}

export function resolveProvider(opts: LLMOptions = {}): LLMProvider {
  const name = opts.provider ?? detectProvider();
  return createProvider(name, opts);
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
    case 'vertex':
    case 'claude-cli':
      return 'claude-opus-4-7';
    case 'codex-cli':
      return 'gpt-5.4';
    case 'cursor-cli':
      return 'claude-opus-4-7'; // best-effort; cursor passes through
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
