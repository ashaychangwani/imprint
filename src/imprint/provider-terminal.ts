import {
  type ProviderFailureFacts,
  type ProviderInterruptionReason,
  ProviderReportedError,
  hasDeterministicProviderFailureFacts,
  isTransientProviderFailureFacts,
} from './provider-retry.ts';

type CliProviderName = 'claude-cli' | 'codex-cli';

const MAX_TERMINAL_JSON_CHARS = 256 * 1024;
const CLAUDE_SAFETY_FILTER =
  'I am unable to respond to this request because it appears to violate our Usage Policy.';

type JsonRecord = Record<string, unknown>;
type MutableFacts = { statuses: number[]; codes: string[]; messages: string[] };

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function parseBoundedJsonRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string') return record(value);
  const text = value.trim();
  if (!text.startsWith('{') || !text.endsWith('}') || text.length > MAX_TERMINAL_JSON_CHARS) {
    return undefined;
  }
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function addStatus(out: number[], value: unknown): void {
  const status = Number(value);
  if (Number.isInteger(status) && status >= 100 && status <= 599) out.push(status);
}

function addString(out: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (text) out.push(text.slice(0, MAX_TERMINAL_JSON_CHARS));
}

function addLeadingStatus(out: number[], message: string): void {
  const match = /^(?:(?:api\s+error|error|http(?:\s+status)?)\s*[:=-]?\s*)?([45]\d\d)\b/i.exec(
    message,
  );
  if (match?.[1]) out.push(Number(match[1]));
}

function collectErrorRecord(value: unknown, facts: MutableFacts): void {
  const error = record(value);
  if (!error) return;
  for (const key of ['status', 'status_code', 'statusCode', 'http_status']) {
    addStatus(facts.statuses, error[key]);
  }
  for (const key of ['code', 'error_code', 'errorCode', 'type']) {
    addString(facts.codes, error[key]);
  }
  const message = error.message;
  if (typeof message === 'string') addString(facts.messages, message);
}

function codexProviderEnvelope(event: JsonRecord): JsonRecord | undefined {
  const direct = record(event.provider_error);
  if (direct) {
    const provider = typeof event.provider === 'string' ? event.provider.toLowerCase() : '';
    if (provider === 'openai' || provider === 'codex') return direct;
  }
  const error = record(event.error);
  if (!error) return undefined;
  const provider = typeof error.provider === 'string' ? error.provider.toLowerCase() : '';
  const source = typeof error.source === 'string' ? error.source.toLowerCase() : '';
  if ((provider === 'openai' || provider === 'codex') && source === 'provider') return error;
  return undefined;
}

type TerminalParseResult = {
  text?: string;
  sessionId?: string;
  providerError?: ProviderReportedError;
  interruption?: ProviderInterruptionReason;
};

export class ProviderTerminalAccumulator {
  private readonly facts: MutableFacts = {
    statuses: [],
    codes: [],
    messages: [],
  };
  private failed = false;
  private exactSafety = false;
  private finalText: string | undefined;
  private session: string | undefined;

  constructor(readonly provider: CliProviderName) {}

  ingestLine(line: string): void {
    const event = parseBoundedJsonRecord(line);
    if (event) this.ingest(event);
  }

  ingest(event: JsonRecord): void {
    if (this.provider === 'claude-cli') this.ingestClaude(event);
    else this.ingestCodex(event);
  }

  ingestStderr(_stderr: string): void {
    // Stderr may contain MCP, tool, artifact, or target-site text. It remains diagnostic-only.
  }

  result(cause?: unknown): TerminalParseResult {
    const facts: ProviderFailureFacts = {
      statuses: [...new Set(this.facts.statuses)],
      codes: [...new Set(this.facts.codes)],
      messages: [...new Set(this.facts.messages)],
    };
    let interruption: ProviderInterruptionReason | undefined;
    if (this.failed && !hasDeterministicProviderFailureFacts(facts)) {
      interruption = this.exactSafety
        ? 'transient_safety_filter'
        : isTransientProviderFailureFacts(facts)
          ? 'capacity_or_overload'
          : undefined;
    }
    const providerError = this.failed
      ? new ProviderReportedError(this.provider, facts, cause, interruption)
      : undefined;
    return {
      text: this.finalText,
      sessionId: this.session,
      providerError,
      interruption,
    };
  }

  private ingestClaude(event: JsonRecord): void {
    if (typeof event.session_id === 'string' && event.session_id.trim()) {
      this.session = event.session_id.trim();
    }
    if (event.type !== 'result') return;

    const result = typeof event.result === 'string' ? event.result.trim() : '';
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((item): item is string => typeof item === 'string').map((s) => s.trim())
      : [];
    if (event.is_error !== true && errors.length === 0) {
      if (result) this.finalText = result;
      return;
    }

    this.failed = true;
    addStatus(this.facts.statuses, event.api_error_status);
    addString(this.facts.codes, event.terminal_reason);
    for (const message of [result, ...errors]) {
      addString(this.facts.messages, message);
      addLeadingStatus(this.facts.statuses, message);
      if (message === CLAUDE_SAFETY_FILTER) this.exactSafety = true;
    }
    collectErrorRecord(event.error, this.facts);
  }

  private ingestCodex(event: JsonRecord): void {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      this.session = event.thread_id;
      return;
    }
    const item = record(event.item);
    if (
      event.type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      this.finalText = item.text;
      return;
    }
    if (event.type !== 'error' && event.type !== 'turn.failed') return;

    this.failed = true;
    for (const key of ['status', 'status_code']) addStatus(this.facts.statuses, event[key]);
    addString(this.facts.codes, event.error_code);
    addString(this.facts.codes, event.code);
    const providerEnvelope = codexProviderEnvelope(event);
    if (providerEnvelope) collectErrorRecord(providerEnvelope, this.facts);
  }
}

export function parseClaudeTerminalOutput(stdout: string, stderr = ''): TerminalParseResult {
  const parser = new ProviderTerminalAccumulator('claude-cli');
  const whole = parseBoundedJsonRecord(stdout);
  if (whole) parser.ingest(whole);
  else for (const line of stdout.split(/\r?\n/)) parser.ingestLine(line);
  parser.ingestStderr(stderr);
  return parser.result();
}

export function parseCodexTerminalOutput(stdout: string, stderr = ''): TerminalParseResult {
  const parser = new ProviderTerminalAccumulator('codex-cli');
  for (const line of stdout.split(/\r?\n/)) parser.ingestLine(line);
  parser.ingestStderr(stderr);
  return parser.result();
}
