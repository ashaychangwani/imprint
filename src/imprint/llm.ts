/** Multi-provider LLM client — system prompt + JSON-serialized
 *  user payload → raw model text. */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

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

/** Subset of providers that support the Anthropic tool-use protocol.
 *  vertex and anthropic-api qualify. claude-cli, codex-cli, and cursor-cli
 *  do not expose tool-use in their CLI interfaces. */
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
    const t0 = Date.now();
    const userText = JSON.stringify(userPayload);

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        ...temperatureFragment(this.config.model, this.config.temperature),
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
  }

  async messageWithTools(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
  }): Promise<Anthropic.Message> {
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
      throw enrichVertexError(err, this.config);
    }
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
    const t0 = Date.now();
    const userText = JSON.stringify(userPayload);

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        ...temperatureFragment(this.config.model, this.config.temperature),
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
  }

  async messageWithTools(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens?: number;
  }): Promise<Anthropic.Message> {
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
    const t0 = Date.now();
    const userText = JSON.stringify(userPayload);

    const args = [
      'claude',
      '-p',
      '--system-prompt',
      systemPrompt,
      '--output-format',
      'json',
      '--model',
      this.model,
      '--bare',
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

    const stdout = await Bun.readableStreamToText(proc.stdout);
    const stderr = await Bun.readableStreamToText(proc.stderr);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw enrichClaudeCliError(new Error(`claude-cli exited with code ${exitCode}\n${stderr}`), {
        model: this.model,
      });
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
    const t0 = Date.now();
    const combinedPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

<session>
${JSON.stringify(userPayload)}
</session>

Respond with ONLY the JSON object described in the system instructions. No additional text.`;

    const args = ['codex', 'exec', '-m', this.model, '-s', 'read-only', '--ephemeral'];

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

    const stdout = await Bun.readableStreamToText(proc.stdout);
    const stderr = await Bun.readableStreamToText(proc.stderr);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw enrichCodexCliError(new Error(`codex-cli exited with code ${exitCode}\n${stderr}`), {
        model: this.model,
      });
    }

    const extractedJson = extractJsonObject(stdout);
    const text = extractedJson ?? stdout;

    return {
      text,
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - t0,
      stopReason: null,
    };
  }
}

function enrichCodexCliError(err: unknown, _config: { model: string }): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes('enoent') || lc.includes('not found') || lc.includes('command not found')) {
    return new Error('codex-cli not found\n→ install Codex CLI: https://codex.anthropic.com', {
      cause: err,
    });
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
    const t0 = Date.now();
    const combinedPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

<session>
${JSON.stringify(userPayload)}
</session>

Respond with ONLY the JSON object described in the system instructions. No additional text.`;

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

    const stdout = await Bun.readableStreamToText(proc.stdout);
    const stderr = await Bun.readableStreamToText(proc.stderr);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw enrichCursorCliError(new Error(`cursor-cli exited with code ${exitCode}\n${stderr}`));
    }

    const extractedJson = extractJsonObject(stdout);
    const text = extractedJson ?? stdout;

    return {
      text,
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - t0,
      stopReason: null,
    };
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

export function isValidProvider(s: string): s is ProviderName {
  return (VALID_PROVIDERS as readonly string[]).includes(s);
}

export function detectProvider(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
  if (process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT) return 'vertex';
  if (Bun.which('claude')) return 'claude-cli';
  if (Bun.which('codex')) return 'codex-cli';
  if (Bun.which('cursor')) return 'cursor-cli';
  throw new Error(
    'No LLM provider detected. Set up one of:\n' +
      '  • export ANTHROPIC_API_KEY=sk-...        (Anthropic API)\n' +
      '  • export ANTHROPIC_VERTEX_PROJECT_ID=...  (Vertex AI)\n' +
      '  • Install Claude Code CLI                 (claude-cli)\n' +
      '  • Install Codex CLI                       (codex-cli)\n' +
      '  • Install Cursor with CLI enabled         (cursor-cli)\n' +
      '→ run `imprint doctor` for more details.',
  );
}

function createProvider(name: ProviderName, opts: LLMOptions = {}): LLMProvider {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
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
      return new CodexCliProvider({ model: opts.model ?? 'o4-mini' });
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
  const override = process.env.ANTHROPIC_MODEL_AGENT ?? process.env.ANTHROPIC_MODEL;
  if (override) return override;
  switch (provider) {
    case 'anthropic-api':
    case 'vertex':
    case 'claude-cli':
      return 'claude-opus-4-7';
    case 'codex-cli':
      return 'o4-mini'; // codex's existing default
    case 'cursor-cli':
      return 'claude-opus-4-7'; // best-effort; cursor passes through
  }
}

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
