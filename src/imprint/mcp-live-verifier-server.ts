import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type LiveIntegrationEvidence,
  runCapturedIntegrationCase,
} from './compile-verification.ts';
import {
  LIVE_VERIFICATION_EVIDENCE_FILE,
  LiveVerificationReportSchema,
  appendLiveVerifierLog,
  assertReportCoversWorkflowParameters,
  effectiveParamsForEvidence,
  hasSuiteReceiptForSession,
  persistLiveVerificationEvidence,
  prepareLiveVerificationBackend,
  readPersistedLiveVerificationEvidence,
  runLiveIntegrationSuite,
} from './live-verifier.ts';
import { loadCredentialStore } from './runtime.ts';
import { buildZodValidator } from './tool-loader.ts';
import { WorkflowSchema } from './types.ts';

export function joinBackendPreparation<T>(
  state: { current?: Promise<T> },
  start: () => Promise<T>,
): { promise: Promise<T>; joined: boolean } {
  if (state.current) return { promise: state.current, joined: true };
  const started = start();
  const promise = started.finally(() => {
    if (state.current === promise) state.current = undefined;
  });
  state.current = promise;
  return { promise, joined: false };
}

const RUN_TOOL: Tool = {
  name: 'run_live_integration_test',
  description:
    'Run a targeted live call for a specific unresolved semantic question. Repeated parameters are allowed when the reason explains why.',
  inputSchema: {
    type: 'object',
    properties: {
      params: { type: 'object', additionalProperties: true },
      reason: { type: 'string' },
    },
    required: ['params', 'reason'],
  },
};

const PREPARE_BACKEND_TOOL: Tool = {
  name: 'prepare_live_backend',
  description:
    'Reuse the preferred backend and probe only when no valid preference exists. Set forceReprobe only after a transport, network, or browser-infrastructure failure from that backend; never reprobe for empty, incorrect, or otherwise semantic output failures.',
  inputSchema: {
    type: 'object',
    properties: {
      params: { type: 'object', additionalProperties: true },
      reason: { type: 'string' },
      forceReprobe: { type: 'boolean' },
    },
    required: ['params', 'reason'],
  },
};

const RUN_SUITE_TOOL: Tool = {
  name: 'run_live_integration_suite',
  description:
    'Run the compiler-proposed final integration suite. A justified rerun is allowed after failure, timeout, or backend reprobe.',
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string' } },
    additionalProperties: false,
  },
};

const SUBMIT_TOOL: Tool = {
  name: 'submit_verification_report',
  description: 'Submit the final structured semantic verification report exactly once.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['approved', 'approved_with_gaps', 'changes_required', 'inconclusive'],
      },
      summary: { type: 'string' },
      baseline: {
        type: 'object',
        properties: {
          verdict: {
            type: 'string',
            enum: ['semantically_correct', 'tool_broken', 'bad_parameters', 'infrastructure'],
          },
          reason: { type: 'string' },
        },
        required: ['verdict', 'reason'],
      },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            verdict: {
              type: 'string',
              enum: ['works', 'no_op', 'broken', 'untestable'],
            },
            reason: { type: 'string' },
          },
          required: ['name', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            expected: { type: 'string' },
            observed: { type: 'string' },
            suggestedFix: { type: 'string' },
          },
          required: ['summary', 'expected', 'observed', 'suggestedFix'],
          additionalProperties: false,
        },
      },
      gaps: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'summary', 'baseline', 'parameters', 'issues', 'gaps'],
  },
};

export async function runLiveVerifierMcpServer(opts: {
  workflowPath: string;
  reportPath: string;
  sessionLabel: string;
  logPath?: string;
  attempt?: number;
}): Promise<void> {
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowPath, 'utf8')));
  const validator = buildZodValidator(workflow.parameters);
  const credentials = (await loadCredentialStore(workflow.site)) ?? undefined;
  let submitted = false;
  const backendPreparation: {
    current?: Promise<Awaited<ReturnType<typeof prepareLiveVerificationBackend>>>;
  } = {};
  const evidencePath = pathJoin(dirname(opts.reportPath), LIVE_VERIFICATION_EVIDENCE_FILE);
  const hasSuiteReceipt = (): boolean => hasSuiteReceiptForSession(evidencePath, opts.sessionLabel);

  const server = new Server(
    { name: 'imprint-live-verifier', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [PREPARE_BACKEND_TOOL, RUN_SUITE_TOOL, RUN_TOOL, SUBMIT_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === 'prepare_live_backend') {
      const input = request.params.arguments as {
        params?: unknown;
        reason?: unknown;
        forceReprobe?: unknown;
      };
      if (typeof input.reason !== 'string' || !input.reason.trim()) {
        return errorResult('reason must explain the backend preparation or reprobe');
      }
      const parsed = validator.safeParse(input.params ?? {});
      if (!parsed.success) return errorResult(`invalid tool params: ${parsed.error.message}`);
      try {
        const preparation = joinBackendPreparation(backendPreparation, () =>
          prepareLiveVerificationBackend({
            workflowPath: opts.workflowPath,
            params: parsed.data as Record<string, string | number | boolean>,
            reason: input.reason as string,
            forceReprobe: input.forceReprobe === true,
            logPath: opts.logPath,
            attempt: opts.attempt,
          }),
        );
        if (preparation.joined) {
          appendLiveVerifierLog(opts.logPath, {
            type: 'backend.prepare.joined',
            attempt: opts.attempt,
            reason: input.reason,
            forceReprobe: input.forceReprobe === true,
          });
        }
        const result = await preparation.promise;
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
    if (request.params.name === 'run_live_integration_suite') {
      const input = request.params.arguments as { reason?: unknown };
      try {
        const suite = await runLiveIntegrationSuite({
          toolDir: dirname(opts.workflowPath),
          logPath: opts.logPath,
          attempt: opts.attempt,
          reason: typeof input.reason === 'string' ? input.reason : undefined,
          sessionLabel: opts.sessionLabel,
        });
        return { content: [{ type: 'text', text: JSON.stringify(suite) }] };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
    if (request.params.name === 'run_live_integration_test') {
      if (!hasSuiteReceipt())
        return errorResult('run the final integration suite before a targeted call');
      const input = request.params.arguments as { params?: unknown; reason?: unknown };
      if (typeof input.reason !== 'string' || !input.reason.trim()) {
        return errorResult('reason must explain the unresolved semantic question');
      }
      const parsed = validator.safeParse(input.params ?? {});
      if (!parsed.success) return errorResult(`invalid tool params: ${parsed.error.message}`);
      const existingCalls = readPersistedLiveVerificationEvidence(evidencePath).filter((item) =>
        item.label.startsWith('targeted-call-'),
      ).length;
      const label = `targeted-call-${existingCalls + 1}`;
      const startedAt = Date.now();
      appendLiveVerifierLog(opts.logPath, {
        type: 'targeted-call.started',
        attempt: opts.attempt,
        label,
        reason: input.reason,
        params: parsed.data,
      });
      let run: Awaited<ReturnType<typeof runCapturedIntegrationCase>>;
      try {
        run = await runCapturedIntegrationCase({
          caseName: label,
          workflowPath: opts.workflowPath,
          params: parsed.data as Record<string, string | number | boolean>,
          credentials,
          preferredOnlyBackend: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLiveVerifierLog(opts.logPath, {
          type: 'targeted-call.failed',
          attempt: opts.attempt,
          label,
          error: message,
        });
        return errorResult(message);
      }
      const supplemental: LiveIntegrationEvidence = {
        schemaVersion: 1 as const,
        kind: 'call',
        label,
        caseName: label,
        toolName: workflow.toolName,
        requestedParams: parsed.data as Record<string, string | number | boolean>,
        effectiveParams: effectiveParamsForEvidence(
          workflow.parameters,
          parsed.data as Record<string, string | number | boolean>,
        ),
        result: run.result,
        usedBackend: run.usedBackend,
        attempts: run.attempts,
        durationMs: Date.now() - startedAt,
      };
      persistLiveVerificationEvidence(evidencePath, [supplemental]);
      appendLiveVerifierLog(opts.logPath, {
        type: 'targeted-call.completed',
        attempt: opts.attempt,
        record: supplemental,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              label: supplemental.label,
              toolName: workflow.toolName,
              requestedParams: parsed.data,
              result: run.result,
              usedBackend: run.usedBackend,
              attempts: run.attempts,
            }),
          },
        ],
      };
    }
    if (request.params.name === 'submit_verification_report') {
      if (submitted) return errorResult('verification report was already submitted');
      const parsed = LiveVerificationReportSchema.safeParse(request.params.arguments);
      if (!parsed.success)
        return errorResult(`invalid verification report: ${parsed.error.message}`);
      if (!hasSuiteReceipt()) {
        return errorResult('run the final integration suite before submitting');
      }
      try {
        assertReportCoversWorkflowParameters(parsed.data, workflow.parameters);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      submitted = true;
      appendLiveVerifierLog(opts.logPath, {
        type: 'report.submitted',
        attempt: opts.attempt,
        report: parsed.data,
      });
      writeFileSync(opts.reportPath, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return {
        content: [{ type: 'text', text: 'Report accepted. End the verification session now.' }],
      };
    }
    return errorResult(`unknown tool: ${request.params.name}`);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Server.connect() resolves after initialization; it does not own the
  // process lifetime. Keep stdio alive until the verifier disconnects, just
  // like the compile MCP server does, or Codex can lose the server during its
  // initialize handshake.
  await new Promise<void>((resolve) => {
    const close = (): void => resolve();
    transport.onclose = close;
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
