/** Vertex Anthropic client wrapper — system prompt + JSON-serialized
 *  user payload → raw model text. */

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

interface LLMConfig {
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
      'No Vertex project ID.\n→ export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id\n→ or run `imprint doctor` to see what other env vars are missing.',
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

interface AnalyzeResult {
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

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
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
}

/** Map common Vertex SDK errors to actionable messages. The SDK's
 *  raw error is preserved as the `cause`; it shows under IMPRINT_DEBUG=1. */
function enrichVertexError(err: unknown, config: LLMConfig): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // 404 NOT_FOUND on the model — usually wrong region for the model id,
  // or the model isn't enabled on the project yet.
  if (lc.includes('not_found') || lc.includes('publisher model') || lc.includes('404')) {
    return new Error(
      `Vertex Anthropic call failed (${msg.split('\n')[0]?.slice(0, 200)})\n→ check that "${config.model}" is enabled in region "${config.region}" for project "${config.projectId}"\n→ enable models at: https://console.cloud.google.com/vertex-ai/model-garden\n→ run \`imprint doctor\` to verify env vars.`,
      { cause: err },
    );
  }

  // 401 UNAUTHENTICATED — credentials missing or wrong account.
  if (lc.includes('unauthenticated') || lc.includes('401') || lc.includes('credentials')) {
    return new Error(
      `Vertex Anthropic call failed: not authenticated\n→ run \`gcloud auth application-default login\`\n→ ensure the active account has the Vertex AI User role on project "${config.projectId}"`,
      { cause: err },
    );
  }

  // 403 PERMISSION_DENIED — auth worked but role isn't sufficient.
  if (lc.includes('permission_denied') || lc.includes('403')) {
    return new Error(
      `Vertex Anthropic call failed: permission denied\n→ active account needs "roles/aiplatform.user" on project "${config.projectId}"\n→ check IAM at: https://console.cloud.google.com/iam-admin/iam`,
      { cause: err },
    );
  }

  // 429 RESOURCE_EXHAUSTED — quota.
  if (lc.includes('resource_exhausted') || lc.includes('429') || lc.includes('quota')) {
    return new Error(
      'Vertex Anthropic call failed: quota exceeded\n→ check quota at: https://console.cloud.google.com/iam-admin/quotas\n→ or wait + retry; transient quota errors are common at peak',
      { cause: err },
    );
  }

  // Fallback: surface the raw message but prefix it so the user knows
  // it's a Vertex error and not e.g. a JSON parse problem.
  return new Error(`Vertex Anthropic call failed: ${msg}`, { cause: err });
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
