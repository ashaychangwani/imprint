/** Vertex Anthropic client wrapper — system prompt + JSON-serialized
 *  user payload → raw model text. */

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

export interface LLMConfig {
  projectId: string;
  region: string;
  model: string;
  /** 0 = deterministic — we want stable artifacts. */
  temperature: number;
  maxTokens: number;
}

export function loadConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  const projectId =
    overrides.projectId ??
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    '';
  if (!projectId) {
    throw new Error(
      'No Vertex project ID. Set ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT, ' +
        'or pass `projectId` explicitly.',
    );
  }
  return {
    projectId,
    region: overrides.region ?? process.env.CLOUD_ML_REGION ?? 'us-east5',
    // Vertex resolves bare ids to latest; pass `@DATE` suffix to pin.
    model: overrides.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    temperature: overrides.temperature ?? 0,
    maxTokens: overrides.maxTokens ?? 8192,
  };
}

export interface AnalyzeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** end_turn | max_tokens | stop_sequence | tool_use | … */
  stopReason: string | null;
}

export class LLM {
  private client: AnthropicVertex;
  constructor(public readonly config: LLMConfig) {
    this.client = new AnthropicVertex({
      projectId: config.projectId,
      region: config.region,
    });
  }

  async analyze(systemPrompt: string, userPayload: unknown): Promise<AnalyzeResult> {
    const t0 = Date.now();
    const userText = JSON.stringify(userPayload);

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });

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
