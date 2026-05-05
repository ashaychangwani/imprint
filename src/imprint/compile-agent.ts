/**
 * Agentic compilation pipeline: session → workflow.json + parser.ts + parser.test.ts.
 *
 * The agent loop inspects the captured session, writes code, tests it, and
 * iterates until external verification passes. See prompts/compile-agent.md
 * for the system prompt.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type AgentTool,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import {
  type LLMOptions,
  type ProviderName,
  type ToolUseProvider,
  isToolUseProvider,
  preferredAgentModel,
  resolveProvider,
} from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { redactSession } from './redact.ts';
import { type CapturedRequest, type Session, SessionSchema, WorkflowSchema } from './types.ts';

const log = createLog('compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

/** Re-exported for callers (cli, teach) that need to display the selected
 *  model before kicking off the agent loop. */
export function resolveCompileAgentModel(provider: ProviderName): string {
  return preferredAgentModel(provider);
}

export interface CompileAgentProgress extends AgentProgress {
  /** 1-based verification cycle. Cycle 1 is the initial agent run. Subsequent cycles
   *  happen when the agent claims done() but external verification fails. */
  verificationCycle: number;
  /** Hard cap on verification cycles (typically 5). */
  maxVerificationCycles: number;
}

interface CompileAgentOptions {
  /** Path to the recorded session JSON (absolute or relative). */
  sessionPath: string;
  /** Hard wall-clock budget. Default 30 minutes. */
  maxDurationMs?: number;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** For testing only — inject a pre-configured provider instead of using llmConfig.
   *  Production callers omit this and use llmConfig. */
  llmProvider?: ToolUseProvider;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
}

interface CompileAgentResult {
  /** True only if external verification passed. */
  success: boolean;
  /** Why we stopped — done, give_up, timeout, soft_cap, error. */
  outcome: 'done' | 'give_up' | 'timeout' | 'soft_cap' | 'error';
  /** Path to workflow.json if written. */
  workflowPath?: string;
  /** Path to parser.ts if written. */
  parserPath?: string;
  /** Path to parser.test.ts if written. */
  parserTestPath?: string;
  /** Free-form summary, error message, or give-up reason. */
  message: string;
  /** Conversation log saved to this path. */
  conversationLogPath: string;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export async function compileAgent(opts: CompileAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();

  // 1. Load + validate the session
  let session: Session = loadJsonFile(
    opts.sessionPath,
    SessionSchema,
    {
      notFound: '→ run `imprint record <site>` to create one.',
      notJson: `→ if it's a partial .jsonl, run \`imprint assemble ${opts.sessionPath}\` first.`,
      badSchema: '→ check the file came from `imprint record`.',
    },
    'session',
  );

  // 2. Auto-redact if not already redacted
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const r = redactSession(session);
    session = r.session;
    if (r.stats.totalRedactions > 0) {
      log(
        `redacted ${r.stats.totalRedactions} value(s) before sending to LLM (use \`imprint redact\` to scrub the file on disk too)`,
      );
    }
  }

  // 3. Determine the example dir
  const absoluteExampleDir = pathJoin(REPO_ROOT, 'examples', session.site);

  // 4. Load the system prompt
  const systemPromptPath = pathJoin(PROMPTS_DIR, 'compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(
      `System prompt not found at ${systemPromptPath}\n→ this is an Imprint installation problem; please file an issue at https://github.com/ashaychangwani/imprint/issues with the steps you ran.`,
    );
  }
  const systemPrompt = readFileSync(systemPromptPath, 'utf8');

  // 5. Build the toolset
  const tools = buildTools(session, absoluteExampleDir);

  // 6. Build the initial user message
  const initialUserMessage = `A new compile task is starting.

Session path: ${pathJoin(REPO_ROOT, opts.sessionPath)}
Example directory: ${absoluteExampleDir}
You will write artifacts into the example directory.

Begin by calling read_session_summary to orient yourself, then proceed per the system prompt.`;

  // 7. Compute deadline
  const deadlineMs = Date.now() + (opts.maxDurationMs ?? 30 * 60 * 1000);

  // 8. Instantiate provider (or use injected one for testing)
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolvedProvider = resolveProvider(opts.llmConfig);
    if (!isToolUseProvider(resolvedProvider)) {
      throw new Error(
        [
          `provider "${resolvedProvider.name}" does not support tool use, which the compile-agent requires.`,
          '→ use one of: anthropic-api, vertex (set ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID)',
        ].join('\n'),
      );
    }
    provider = resolvedProvider;
  }

  // 9. Run the agent loop with verification sub-loop
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let outcome: AgentResult['outcome'] = 'error';
  let message = '';
  let conversationLog: AgentResult['conversationLog'] = [];

  const MAX_VERIFICATION_CYCLES = 5;
  let verificationCycle = 0;
  let result: AgentResult | null = null;
  let currentInitialMessage = initialUserMessage;

  while (verificationCycle < MAX_VERIFICATION_CYCLES) {
    verificationCycle++;

    // Wrap the user's onProgress callback to inject verification cycle info
    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle,
            maxVerificationCycles: MAX_VERIFICATION_CYCLES,
          })
      : undefined;

    // Run the agent loop
    result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs,
      llm: provider,
      onProgress: wrappedOnProgress,
    });

    totalTurns += result.turns;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    conversationLog = [...conversationLog, ...result.conversationLog];

    outcome = result.outcome;

    // If not done, break out
    if (result.outcome !== 'done') {
      message = buildMessageFromOutcome(result);
      break;
    }

    // Perform external verification
    const failures = await externalVerification(absoluteExampleDir, session);

    if (failures.length === 0) {
      // Success
      message = result.doneSummary ?? 'Task completed';
      break;
    }

    // Verification failed — re-enter the loop with a continuation message
    if (verificationCycle >= MAX_VERIFICATION_CYCLES) {
      outcome = 'error';
      message = `Verification failed after ${MAX_VERIFICATION_CYCLES} cycles. Final failures:\n${failures.join('\n')}`;
      break;
    }

    log(`verification failed (cycle ${verificationCycle}), resuming agent loop...`);
    currentInitialMessage = `You called done but verification failed:

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (workflow.json, parser.ts, parser.test.ts), fix the issues, re-run tests, and call done again when fixed.`;
  }

  // 10. Persist conversation log
  mkdirSync(absoluteExampleDir, { recursive: true });
  const conversationLogPath = pathJoin(absoluteExampleDir, '.compile-log.json');
  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  // 11. Return the result
  const workflowPath = pathJoin(absoluteExampleDir, 'workflow.json');
  const parserPath = pathJoin(absoluteExampleDir, 'parser.ts');
  const parserTestPath = pathJoin(absoluteExampleDir, 'parser.test.ts');

  return {
    success: outcome === 'done',
    outcome,
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    parserPath: existsSync(parserPath) ? parserPath : undefined,
    parserTestPath: existsSync(parserTestPath) ? parserTestPath : undefined,
    message,
    conversationLogPath,
    turns: totalTurns,
    durationMs: Date.now() - startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

function buildMessageFromOutcome(result: AgentResult): string {
  switch (result.outcome) {
    case 'give_up':
      return `Agent gave up: ${result.giveUpReason ?? 'unknown reason'}\n${result.giveUpDetail ?? ''}`;
    case 'timeout':
      return 'Agent loop timed out before completion';
    case 'soft_cap':
      return 'Agent loop exceeded soft turn cap (100 turns)';
    case 'error':
      return `Agent loop error: ${result.errorMessage ?? 'unknown error'}`;
    default:
      return 'Unknown outcome';
  }
}

function buildTools(session: Session, exampleDir: string): AgentTool[] {
  return [
    buildReadSessionSummaryTool(session),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    buildSearchResponseBodyTool(session),
    buildWriteFileTool(exampleDir),
    buildReadFileTool(exampleDir),
    buildRunBashTool(exampleDir),
    buildRunTestsTool(exampleDir),
    doneTool(),
    giveUpTool(),
  ];
}

// ─── Tool: read_session_summary ──────────────────────────────────────────────

function buildReadSessionSummaryTool(session: Session): AgentTool {
  return {
    name: 'read_session_summary',
    description:
      'Get a high-level summary of the session including narration and load-bearing requests.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const loadBearing = identifyLoadBearingRequests(session);
      const summary = {
        site: session.site,
        url: session.url,
        narration: session.narration.map((n) => ({ timestamp: n.timestamp, text: n.text })),
        requestCount: session.requests.length,
        loadBearingRequests: loadBearing.map((r) => ({
          seq: r.seq,
          method: r.method,
          url: r.url,
          status: r.response?.status,
          mimeType: r.response?.mimeType,
          bodySize: r.response?.body?.length,
        })),
      };
      return { result: JSON.stringify(summary, null, 2) };
    },
  };
}

function identifyLoadBearingRequests(session: Session): CapturedRequest[] {
  const startUrl = safeUrl(session.url);
  const startRoot = startUrl ? registrableDomain(startUrl.hostname) : null;

  return session.requests.filter((r) => {
    // Same-origin check
    const url = safeUrl(r.url);
    if (!url) return false;
    if (startRoot && !isSameRegistrableDomain(url.hostname, startRoot)) return false;

    // XHR/Fetch only
    if (r.resourceType !== 'XHR' && r.resourceType !== 'Fetch') return false;

    // Status 2xx
    if (!r.response || r.response.status < 200 || r.response.status >= 300) return false;

    // Has response body
    if (!r.response.body) return false;

    return true;
  });
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

// ─── Tool: read_request ──────────────────────────────────────────────────────

function buildReadRequestTool(session: Session): AgentTool {
  return {
    name: 'read_request',
    description: 'Get the full request including method, URL, headers, and body for a given seq.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
      },
      required: ['seq'],
    },
    handler: async (input: unknown) => {
      const { seq } = input as { seq: number };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req) {
        return { result: `Request seq ${seq} not found`, isError: true };
      }

      const summary = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        response: req.response
          ? {
              status: req.response.status,
              headers: req.response.headers,
              mimeType: req.response.mimeType,
              bodyLength: req.response.body?.length,
            }
          : undefined,
      };

      return { result: JSON.stringify(summary, null, 2) };
    },
  };
}

// ─── Tool: read_response_body ────────────────────────────────────────────────

function buildReadResponseBodyTool(session: Session): AgentTool {
  return {
    name: 'read_response_body',
    description:
      'Get the response body for a given seq, with optional pagination via offset/length.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
        offset: { type: 'number', description: 'Starting byte offset (default 0)' },
        length: {
          type: 'number',
          description: 'Number of bytes to read (default 50000, max 100000)',
        },
      },
      required: ['seq'],
    },
    handler: async (input: unknown) => {
      const {
        seq,
        offset = 0,
        length = 50000,
      } = input as {
        seq: number;
        offset?: number;
        length?: number;
      };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req) {
        return { result: `Request seq ${seq} not found`, isError: true };
      }
      if (!req.response?.body) {
        return { result: `no response body captured for seq ${seq}`, isError: true };
      }

      const body = req.response.body;
      const totalLength = body.length;
      const cappedLength = Math.min(length, 100000);
      const slice = body.slice(offset, offset + cappedLength);

      let isJson = false;
      try {
        JSON.parse(body);
        isJson = true;
      } catch {
        // not JSON
      }

      return {
        result: JSON.stringify(
          {
            body: slice,
            totalLength,
            isJson,
            offset,
            returnedLength: slice.length,
          },
          null,
          2,
        ),
      };
    },
  };
}

// ─── Tool: search_response_body ──────────────────────────────────────────────

function buildSearchResponseBodyTool(session: Session): AgentTool {
  return {
    name: 'search_response_body',
    description:
      'Search for a substring in a response body and return matching offsets with context.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
        query: { type: 'string', description: 'Search string (case-sensitive)' },
        contextChars: {
          type: 'number',
          description: 'Characters to include before and after match (default 80)',
        },
        maxMatches: {
          type: 'number',
          description: 'Maximum number of matches to return (default 20)',
        },
      },
      required: ['seq', 'query'],
    },
    handler: async (input: unknown) => {
      const {
        seq,
        query,
        contextChars = 80,
        maxMatches = 20,
      } = input as {
        seq: number;
        query: string;
        contextChars?: number;
        maxMatches?: number;
      };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req || !req.response?.body) {
        return { result: `no response body for seq ${seq}`, isError: true };
      }

      const body = req.response.body;
      const matches: { offset: number; snippet: string }[] = [];
      let searchStart = 0;

      while (matches.length < maxMatches) {
        const idx = body.indexOf(query, searchStart);
        if (idx === -1) break;

        const start = Math.max(0, idx - contextChars);
        const end = Math.min(body.length, idx + query.length + contextChars);
        const snippet = body.slice(start, end);

        matches.push({ offset: idx, snippet });
        searchStart = idx + query.length;
      }

      return { result: JSON.stringify(matches, null, 2) };
    },
  };
}

// ─── Tool: write_file ────────────────────────────────────────────────────────

function buildWriteFileTool(exampleDir: string): AgentTool {
  return {
    name: 'write_file',
    description:
      'Write a file to the example directory. Allowed paths: workflow.json, parser.ts, parser.test.ts, notes/*.md',
    input_schema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: 'Relative path within the example directory' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['relativePath', 'content'],
    },
    handler: async (input: unknown) => {
      const { relativePath, content } = input as { relativePath: string; content: string };

      // Security checks
      if (relativePath.includes('..') || relativePath.startsWith('/')) {
        return {
          result: `invalid relativePath: "${relativePath}" — must not contain ".." or start with "/"`,
          isError: true,
        };
      }

      const allowed = ['workflow.json', 'parser.ts', 'parser.test.ts'];
      const isNotes = relativePath.startsWith('notes/') && relativePath.endsWith('.md');
      if (!allowed.includes(relativePath) && !isNotes) {
        return {
          result: `relativePath "${relativePath}" not allowed — must be one of: ${allowed.join(', ')}, or notes/*.md`,
          isError: true,
        };
      }

      const absolutePath = pathJoin(exampleDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, 'utf8');

      return {
        result: JSON.stringify({
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          absolutePath,
        }),
      };
    },
  };
}

// ─── Tool: read_file ─────────────────────────────────────────────────────────

function buildReadFileTool(exampleDir: string): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from allowed roots: examples/<site>/, prompts/, src/imprint/.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to read' },
      },
      required: ['path'],
    },
    handler: async (input: unknown) => {
      const { path } = input as { path: string };

      // Resolve relative paths against repo root
      let absolutePath = path;
      if (!path.startsWith('/')) {
        absolutePath = pathJoin(REPO_ROOT, path);
      }

      // Check allowed roots
      const allowedRoots = [
        exampleDir,
        pathJoin(REPO_ROOT, 'prompts'),
        pathJoin(REPO_ROOT, 'src', 'imprint'),
        pathJoin(REPO_ROOT, 'test'),
      ];

      const isAllowed = allowedRoots.some((root) => absolutePath.startsWith(root));
      if (!isAllowed) {
        return {
          result: `path "${absolutePath}" not allowed — must be in examples/<site>/, prompts/, src/imprint/, or test/`,
          isError: true,
        };
      }

      if (!existsSync(absolutePath)) {
        return { result: `file not found: ${absolutePath}`, isError: true };
      }

      let content = readFileSync(absolutePath, 'utf8');
      const MAX_SIZE = 100 * 1024; // 100KB
      if (content.length > MAX_SIZE) {
        content = `${content.slice(0, MAX_SIZE)}\n[…truncated…]`;
      }

      return {
        result: JSON.stringify({
          content,
          size: content.length,
        }),
      };
    },
  };
}

// ─── Tool: run_bash ──────────────────────────────────────────────────────────

function buildRunBashTool(exampleDir: string): AgentTool {
  return {
    name: 'run_bash',
    description: 'Run a shell command in the example directory with a timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds (default 60, max 300)' },
      },
      required: ['command'],
    },
    handler: async (input: unknown) => {
      const { command, timeoutSec = 60 } = input as { command: string; timeoutSec?: number };

      // Block destructive commands
      if (command.match(/rm\s+-rf\s+\//) || command.includes('sudo')) {
        return {
          result: 'blocked destructive command — rm -rf / and sudo are not allowed',
          isError: true,
        };
      }

      const cappedTimeout = Math.min(timeoutSec, 300) * 1000;

      return await runCommand(command, exampleDir, cappedTimeout);
    },
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ result: string; isError?: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const TRUNCATE_LIMIT = 16 * 1024; // 16KB

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);

      if (stdout.length > TRUNCATE_LIMIT) {
        stdout = `${stdout.slice(0, TRUNCATE_LIMIT)}\n[…truncated…]`;
      }
      if (stderr.length > TRUNCATE_LIMIT) {
        stderr = `${stderr.slice(0, TRUNCATE_LIMIT)}\n[…truncated…]`;
      }

      resolve({
        result: JSON.stringify({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          timedOut,
        }),
        isError: (exitCode ?? -1) !== 0 || timedOut,
      });
    });
  });
}

// ─── Tool: run_tests ─────────────────────────────────────────────────────────

function buildRunTestsTool(exampleDir: string): AgentTool {
  return {
    name: 'run_tests',
    description: 'Run bun test parser.test.ts and parse the output for pass/fail counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const testPath = pathJoin(exampleDir, 'parser.test.ts');
      if (!existsSync(testPath)) {
        return {
          result: 'parser.test.ts does not exist — write it first',
          isError: true,
        };
      }

      const cmdResult = await runCommand('bun test parser.test.ts', exampleDir, 120000);

      // Parse bun test output for pass/fail counts
      // Bun's output format includes lines like:
      //   5 pass
      //   0 fail
      const output = JSON.parse(cmdResult.result) as {
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      };

      const passMatch = output.stdout.match(/(\d+)\s+pass/);
      const failMatch = output.stdout.match(/(\d+)\s+fail/);

      const passed = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0;
      const failed = failMatch?.[1] ? Number.parseInt(failMatch[1], 10) : 0;
      const total = passed + failed;

      return {
        result: JSON.stringify({
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
          passed,
          failed,
          total,
          timedOut: output.timedOut,
        }),
        isError: output.exitCode !== 0 || output.timedOut,
      };
    },
  };
}

// ─── External Verification ──────────────────────────────────────────────────

async function externalVerification(exampleDir: string, session: Session): Promise<string[]> {
  const failures: string[] = [];

  const workflowPath = pathJoin(exampleDir, 'workflow.json');
  const parserPath = pathJoin(exampleDir, 'parser.ts');
  const parserTestPath = pathJoin(exampleDir, 'parser.test.ts');

  // Check 1: workflow.json exists and parses
  if (!existsSync(workflowPath)) {
    failures.push('workflow.json was not written');
  } else {
    try {
      const raw = JSON.parse(readFileSync(workflowPath, 'utf8'));
      WorkflowSchema.parse(raw);
    } catch (err) {
      failures.push(
        `workflow.json schema invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Check 2: parser.ts exists and exports extract function
  if (!existsSync(parserPath)) {
    failures.push('parser.ts was not written');
  } else {
    try {
      // Dynamic import with cache-bust query (file:// URL for Bun)
      const cacheBust = `?t=${Date.now()}`;
      const fileUrl = `file://${parserPath}${cacheBust}`;
      const mod = await import(fileUrl);
      if (typeof mod.extract !== 'function') {
        failures.push('parser.ts must export `extract` function');
      }
    } catch (err) {
      failures.push(`parser.ts import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check 3: parser.test.ts exists and has ≥3 meaningful expect() calls
  if (!existsSync(parserTestPath)) {
    failures.push('parser.test.ts was not written');
  } else {
    const src = readFileSync(parserTestPath, 'utf8');
    const expectMatches = src.match(/expect\s*\(/g) ?? [];
    if (expectMatches.length < 3) {
      failures.push(`parser.test.ts has only ${expectMatches.length} expect() calls; need ≥3`);
    }

    // Detect trivial assertions
    const trivialPatterns = [
      /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/,
      /expect\s*\(\s*1\s*\)\.toBe\s*\(\s*1\s*\)/,
      /expect\s*\(\s*null\s*\)\.toBeNull/,
      /expect\s*\(\s*undefined\s*\)\.toBeUndefined/,
    ];
    for (const pattern of trivialPatterns) {
      if (pattern.test(src)) {
        failures.push(
          'parser.test.ts contains trivial tautological assertions like expect(true).toBe(true) — tests must reference real values',
        );
        break;
      }
    }
  }

  // Check 4: bun test parser.test.ts passes when run independently
  if (existsSync(parserTestPath)) {
    const result = await runCommand('bun test parser.test.ts', exampleDir, 120000);
    const output = JSON.parse(result.result) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    if (output.exitCode !== 0) {
      failures.push(
        `bun test parser.test.ts exited ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }

  // Check 5: extract() called on a captured response body returns non-empty
  const loadBearing = identifyLoadBearingRequests(session);
  if (loadBearing.length > 0 && existsSync(parserPath)) {
    const firstReq = loadBearing[0];
    if (firstReq?.response?.body) {
      try {
        const cacheBust = `?t=${Date.now()}`;
        const fileUrl = `file://${parserPath}${cacheBust}`;
        const mod = await import(fileUrl);
        if (typeof mod.extract === 'function') {
          let raw: unknown;
          const responseBody = firstReq.response.body;
          try {
            raw = JSON.parse(responseBody);
          } catch {
            raw = responseBody;
          }

          const extracted = mod.extract(raw);
          if (
            extracted == null ||
            (typeof extracted === 'object' && Object.keys(extracted).length === 0)
          ) {
            failures.push(
              'parser.extract() returns null or empty when given the captured response body',
            );
          }
        }
      } catch {
        // Already flagged in check 2 if import failed
      }
    }
  }

  return failures;
}
