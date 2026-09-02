/**
 * Stdio MCP server that exposes the compile-agent's tools to claude-cli.
 *
 * Spawned by `claude-cli-compile.ts` via `--mcp-config`. The server registers
 * the same 8 read/write tools the in-process loop uses, plus a custom `done`
 * tool that runs external verification inline and writes a sentinel file when
 * complete. claude-cli polls the sentinel and SIGTERMs us when it appears.
 *
 * Why in-tool verification: the in-process loop (agent.ts) restarts after a
 * verification failure with a continuation message. Doing the same here would
 * require killing claude-cli and re-spawning, losing context. Instead, we
 * return the failure list as the tool_result content so claude continues
 * iterating in the same conversation — same up-to-5-cycle bound, no context
 * loss.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  authExternalVerification,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
} from './auth-compile-tools.ts';
import type { AuthToolPlan, SharedModuleManifestEntry } from './build-plan.ts';
import {
  type CompileVerificationMode,
  advanceIncompleteSemanticVerificationRuns,
  advanceSemanticVerificationCycle,
} from './compile-agent-types.ts';
import { inheritedCompileProviderControl } from './compile-provider-control.ts';
import type { CompileStrategyKind } from './compile-strategy.ts';
import {
  applyIrreversibleVerificationWaiver,
  applyLiveVerification,
  applyParamVerification,
  buildCompileTools,
  externalVerification,
} from './compile-tools.ts';
import { terminateOwnedCompilerProcesses } from './compiler-process.ts';
import { extractCredentials } from './credential-extract.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import {
  mergeSemanticParamVerification,
  runLiveSemanticVerification,
  semanticVerificationFailures,
} from './live-verifier.ts';
import { DEFAULT_VERIFICATION_PROVIDER } from './llm.ts';
import type { ProviderName } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { rebindExistingBackendsCacheToWorkflow } from './probe-backends.ts';
import {
  ProviderDeadlineError,
  ProviderUnavailableError,
  combinedDeadlineSignal,
  providerControlError,
} from './provider-retry.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type SharedTriageSelection, applySharedTriageSelection } from './triage-selection.ts';
import { type Session, SessionSchema, type Workflow, WorkflowSchema } from './types.ts';

const log = createLog('mcp-compile');

interface RunCompileMcpServerOptions {
  /** Agent-facing focused/redacted recording. */
  sessionPath: string;
  /** Absolute path to the generated tool directory where artifacts go. */
  toolDir: string;
  /** Data-tool cap on done() verification failures. Auth is deadline-bounded. */
  maxVerificationCycles?: number;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Master-accepted execution strategy for this focused compile. */
  strategyKind?: CompileStrategyKind;
  /** Present → run in AUTH mode: register the auth checkpoint toolset
   *  and run authExternalVerification in done() instead of the data-tool
   *  verification. */
  authToolPlan?: NonNullable<AuthToolPlan>;
  /** Site slug (required in auth mode) — used to load credentials for the live
   *  auth-test tools. */
  site?: string;
  /** Compile provider. The independent verifier uses the same provider family
   * with its dedicated review model (Terra for Codex, latest Sonnet for Claude). */
  provider?: ProviderName;
  /** Bounded resume of an already-generated data tool. */
  revisionMode?: boolean;
  /** Master-only deterministic MVP boundary. */
  verificationMode?: CompileVerificationMode;
  /** Shared triage result from teach. Applied before compile tools and done()
   *  verification so CLI-backed compilers see irreversible effects. */
  sharedTriageSelection?: SharedTriageSelection;
}

const DONE_SENTINEL = '.compile-done.json';
const GIVE_UP_SENTINEL = '.compile-give-up.json';
const VERIFICATION_STATE_SENTINEL = '.compile-verification-state.json';
// Keep the compile watchdog from charging live verification against the model's
// reasoning budget, while retaining a hard bound if the MCP server dies during
// done(). This matches the longest supported MCP tool call.
/** Auth mode only: a mid-loop checkpoint the agent reaches. The tool records
 *  the request here and the
 *  agent STOPS; the orchestrator (teach) performs the action and resumes the
 *  agent (`claude --resume`) with the result. One pending checkpoint per segment. */
const CHECKPOINT_SENTINEL = '.compile-checkpoint.json';

/** An irreversible workflow may skip live execution only after every
 * deterministic artifact check passed. Keep this conjunction explicit: the
 * waiver changes only live applicability, never deterministic correctness. */
export function canWaiveIrreversibleLiveVerification(
  failures: readonly string[],
  workflow: Workflow | undefined,
): workflow is Workflow {
  return failures.length === 0 && workflow !== undefined && workflowHasIrreversibleEffect(workflow);
}

export function compileDoneToolDescription(mode?: CompileVerificationMode): string {
  return mode === 'master_mvp'
    ? 'Call this after completing the artifact and its offline tests. Validates deterministic artifact, schema, test, and type facts, then hands the artifact back to the master for live verification. Fix any returned deterministic failures and call done again.'
    : 'Call this when you have successfully completed the task. Continues through independent external verification of the artifacts. If verification fails, the result will list the issues and you should fix them and call done again.';
}

export async function runCompileMcpServer(opts: RunCompileMcpServerOptions): Promise<void> {
  const providerControl = inheritedCompileProviderControl();
  const lifetime = new AbortController();
  const active = combinedDeadlineSignal(providerControl?.deadline, undefined, lifetime.signal);
  const lifetimeHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = (): void => {
      lifetime.abort(new DOMException(`Compile MCP received ${signal}`, 'AbortError'));
      void terminateOwnedCompilerProcesses(signal).then(() => {
        if (signal === 'SIGINT') return;
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      });
    };
    lifetimeHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const isAuthMode = !!opts.authToolPlan;
    const maxVerificationCycles = opts.maxVerificationCycles ?? 5;
    const maxIncompleteVerifierRuns = 2;
    let incompleteVerifierRuns = 0;

    // Load the recording supplied by the compile host. Teach normally passes a
    // redacted session; direct compilation still applies ordinary in-memory
    // redaction before exposing request evidence through compile tools.
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
    if (!JSON.stringify(session).includes('[REDACTED:')) {
      session = redactSession(session, {
        replacements: extractCredentials(session).replacements,
        keepHeaders: detectPageMintedHeaders(session),
      }).session;
    }
    if (opts.sharedTriageSelection) {
      session = applySharedTriageSelection(session, opts.sharedTriageSelection, {
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
      });
    }

    // Build the toolset. Auth mode swaps the data tools (parser/test-oriented)
    // for the auth toolset, which lives in auth-compile-tools.ts so the in-process
    // loop and this MCP path stay byte-for-byte identical.
    let compileTools: ReturnType<typeof buildCompileTools>;
    if (isAuthMode) {
      const site = opts.site ?? session.site;
      const teachCredentials = { site, values: {} };
      compileTools = buildAuthCompileTools(
        session,
        opts.toolDir,
        opts.sessionPath,
        teachCredentials,
      );
    } else {
      // When a build plan is present, buildCompileTools also exposes read_build_plan.
      compileTools = buildCompileTools(session, opts.toolDir, opts.sessionPath, {
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
        buildPlanPath: opts.buildPlanPath,
        sharedModules: opts.sharedModules,
        strategyKind: opts.strategyKind,
        revisionMode: opts.revisionMode,
      });
    }

    // The custom done/give_up tools live alongside in MCP space.
    const doneTool: Tool = {
      name: 'done',
      description: compileDoneToolDescription(opts.verificationMode),
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Brief summary of what was accomplished' },
        },
        required: ['summary'],
      },
    };
    const giveUpTool: Tool = {
      name: 'give_up',
      description:
        'Use for a categorical impossibility or an exact accepted-plan contradiction that only the master can revise.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you cannot complete the task' },
          what_was_tried: {
            type: 'string',
            description: 'Summary of approaches you tried before giving up',
          },
        },
        required: ['reason', 'what_was_tried'],
      },
    };

    // Auth mode only: checkpoint tools. Each records its request to the checkpoint
    // sentinel and instructs the agent to STOP; the orchestrator performs the
    // action live (it owns the persistent browser session + the user TUI) and
    // resumes the agent with the result. The agent never runs a live login itself.
    const checkpointTools: Tool[] = isAuthMode
      ? [
          {
            name: 'run_verification',
            description:
              'Run one action from the current workflow.json live in the verification browser. Supply the action name and only its declared parameters. Set freshSession only when observed evidence means the prior browser and continuation state must be discarded. Set cleanSession only when evidence requires also withholding stored cookies and browser storage. After calling this, stop; the orchestrator resumes you with the observed result.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: 'An action declared in authConfig.actions.',
                },
                parameters: {
                  type: 'object',
                  description:
                    'Scalar values required by this action, keyed by workflow parameter name.',
                },
                freshSession: {
                  type: 'boolean',
                  description:
                    'Close and discard the prior verification browser and continuation state before running this action. Defaults to false.',
                },
                cleanSession: {
                  type: 'boolean',
                  description:
                    'Also withhold stored cookies and browser storage for this fresh run. Credential values remain available.',
                },
              },
              required: ['action'],
            },
          },
          {
            name: 'inspect_verification_page',
            description:
              'Inspect the currently rendered page in the existing verification browser without navigating, resetting state, or running another auth action. Returns rendered body text, final URL, title, and optional cookie metadata (never cookie values). Use when observed verification evidence warrants inspecting the page. After calling this, stop; the orchestrator resumes you with the snapshot.',
            inputSchema: {
              type: 'object',
              properties: {
                maxChars: {
                  type: 'number',
                  description: 'Maximum rendered body-text characters to return (256–20000).',
                },
                includeCookies: {
                  type: 'boolean',
                  description:
                    'Include cookie names, domains, paths, expirations, and flags. Cookie values are never returned. Defaults to true.',
                },
              },
            },
          },
          {
            name: 'prompt_user',
            description:
              'Ask the human for input or an external action required by the compiled auth program. After calling this, stop; the orchestrator collects the answer and resumes you with it.',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'What to ask the user to do.' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional fixed choices; omit for free-text (e.g. the OTP code).',
                },
              },
              required: ['message'],
            },
          },
          {
            name: 'wait_for_cooldown',
            description:
              'Request a delay without running any live action. Use only when the observed site response justifies waiting. After calling this, stop.',
            inputSchema: {
              type: 'object',
              properties: {
                minutes: { type: 'number', description: 'Cool-off minutes (5–10 typical).' },
                reason: {
                  type: 'string',
                  description: 'Why you believe it is a cool-off, not a defect.',
                },
              },
              required: ['minutes'],
            },
          },
        ]
      : [];

    let semanticVerificationCycles = 0;
    /** One pending checkpoint per segment — refuse a second so the orchestrator
     *  acts on exactly one request. Cleared implicitly: each segment is a fresh
     *  process with the sentinel removed before spawn. */
    let checkpointWritten = false;

    const server = new Server(
      { name: 'imprint-compile', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: isAuthMode
          ? 'Compile the recorded login into an auth action program in workflow.json. Define the actions, evidence, state carry, retries, and success criteria from the recording; run those actions live with run_verification, then call done after a declared success action passes.'
          : 'These tools let you reverse-engineer the captured session into workflow.json + parser.ts + parser.test.ts. Read the recording, write the artifacts, run tests, and call done() when verified. The done tool runs external verification and will tell you what to fix if anything is wrong.',
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...compileTools.map(
          (t): Tool => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema as Tool['inputSchema'],
          }),
        ),
        ...checkpointTools,
        doneTool,
        giveUpTool,
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
      const name = req.params.name;
      const args = req.params.arguments ?? {};

      // Custom done — runs verification inline.
      if (name === 'done') {
        const doneArgs = args as { summary?: string };
        const summary = doneArgs.summary ?? 'Task completed';
        log(`done() called: ${summary}`);

        // Auth mode: lightweight structural verification (the agent already proved
        // the workflow works live via run_verification). No param/live stamps.
        if (isAuthMode) {
          const failures = authExternalVerification(
            opts.toolDir,
            (opts.authToolPlan?.captures ?? []).map((c) => ({
              name: c.name,
              usedAs: c.usedAs,
            })),
            { requireLiveAttempt: true },
          );
          if (failures.length === 0) {
            const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
            writeFileSync(
              sentinel,
              JSON.stringify(
                {
                  summary,
                  verification: 'mechanical_passed',
                  warnings: [],
                  timestamp: Date.now(),
                },
                null,
                2,
              ),
              'utf8',
            );
            log(`auth verification passed; wrote ${sentinel}`);
            return {
              content: [
                {
                  type: 'text',
                  text: 'DONE — verification passed. Do not call any more tools.',
                },
              ],
            };
          }

          semanticVerificationCycles++;
          log(`auth verification failed (cycle ${semanticVerificationCycles})`);

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `You called done but verification failed (cycle ${semanticVerificationCycles}):

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with run_verification, and call done again when fixed.`,
              },
            ],
          };
        }

        let semanticReviewCompleted = false;
        let semanticReviewAttempted = false;
        const { failures, warnings, paramVerification, integrationEvidence } =
          await externalVerification(opts.toolDir, session, opts.sessionPath, {
            expectedToolName: opts.candidate?.toolName,
            candidateRequestSeqs: opts.candidate?.requestSeqs,
            // Include bootstrap and shared login dependencies in provenance checks.
            dependencyRequestSeqs: [
              ...(opts.candidate?.dependencySeqs ?? []),
              ...(opts.sharedContext?.loginRequestSeqs ?? []),
            ],
            credentialNames: opts.sharedContext?.credentialNames,
            strategyKind: opts.strategyKind,
            deferLiveIntegrationToSemanticAgent: true,
            expectedPublicParameters:
              opts.verificationMode === 'master_mvp' ? opts.candidate?.likelyParams : undefined,
          });
        if (warnings.length > 0) {
          log(`verification warnings (non-blocking):\n${warnings.join('\n')}`);
        }
        let workflow: ReturnType<typeof WorkflowSchema.parse> | undefined;
        if (failures.length === 0) {
          workflow = WorkflowSchema.parse(
            JSON.parse(readFileSync(pathJoin(opts.toolDir, 'workflow.json'), 'utf8')),
          );
        }
        if (
          failures.length === 0 &&
          workflow &&
          opts.strategyKind === 'playbook_fallback' &&
          opts.verificationMode === 'master_mvp'
        ) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'mechanical_passed',
                verificationMode: opts.verificationMode ?? 'full',
                liveVerified: false,
                liveVerificationOwner: 'master',
                semanticVerification: { status: 'not_run' },
                warnings,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          log(`browser artifact contract passed; wrote ${sentinel}`);
          return {
            content: [
              {
                type: 'text',
                text: 'DONE — browser artifact contract passed. The master owns live playbook verification. Do not call any more tools.',
              },
            ],
          };
        }
        if (canWaiveIrreversibleLiveVerification(failures, workflow)) {
          const allWarnings = [
            ...warnings,
            ...applyIrreversibleVerificationWaiver(opts.toolDir, workflow),
          ];
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'not_applicable',
                verificationMode: opts.verificationMode ?? 'full',
                liveVerified: false,
                safetyWaiver: 'irreversible',
                semanticVerification: { status: 'not_applicable' },
                warnings: allWarnings,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          return {
            content: [
              {
                type: 'text',
                text: 'DONE_LIVE_NA — deterministic checks passed; live verification is not applicable because the workflow is irreversible.',
              },
            ],
          };
        }
        if (failures.length === 0 && opts.verificationMode === 'master_mvp') {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'mechanical_passed',
                verificationMode: 'master_mvp',
                liveVerified: false,
                semanticVerification: { status: 'not_run' },
                warnings,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          log(`minimum viable artifact verification passed; wrote ${sentinel}`);
          return {
            content: [
              {
                type: 'text',
                text: 'DONE — deterministic artifact checks passed. Live semantic verification is deferred to the master. Do not call any more tools.',
              },
            ],
          };
        }
        if (failures.length === 0) {
          if (!opts.provider) {
            failures.push('compile provider was not supplied to the independent semantic verifier');
          } else {
            semanticReviewAttempted = true;
            const verifierDeadlineMs = providerControl?.deadlineMs;
            if (
              providerControl &&
              verifierDeadlineMs !== undefined &&
              Date.now() >= verifierDeadlineMs
            ) {
              const error = new ProviderDeadlineError(verifierDeadlineMs);
              providerControl.report(error);
              throw error;
            }
            let semantic: Awaited<ReturnType<typeof runLiveSemanticVerification>>;
            try {
              semantic = await runLiveSemanticVerification({
                provider: DEFAULT_VERIFICATION_PROVIDER,
                toolDir: opts.toolDir,
                evidence: integrationEvidence,
                deadlineMs: verifierDeadlineMs,
                runDeadline: providerControl?.deadline,
                signal: active.signal,
              });
            } catch (error) {
              const control = providerControlError(error);
              if (
                providerControl &&
                (control instanceof ProviderDeadlineError ||
                  control instanceof ProviderUnavailableError)
              )
                providerControl.report(control);
              throw error;
            }
            semanticReviewCompleted = semantic.completedReview;
            const semanticFailures = semanticVerificationFailures(semantic.report);
            failures.push(...semanticFailures);
            if (semantic.report.status === 'approved_with_gaps') {
              warnings.push(
                `independent semantic verification approved with gaps: ${semantic.report.gaps.join('; ')}`,
              );
            }
            if (semanticFailures.length === 0) {
              const semanticParams = mergeSemanticParamVerification(
                paramVerification,
                semantic.report,
              );
              applyLiveVerification(opts.toolDir, undefined);
              const paramWarnings = applyParamVerification(opts.toolDir, semanticParams);
              rebindExistingBackendsCacheToWorkflow(opts.toolDir);
              if (paramWarnings.length > 0) {
                log(`parameter verification:\n${paramWarnings.join('\n')}`);
              }
              const allWarnings = [...warnings, ...paramWarnings];
              const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
              writeFileSync(
                sentinel,
                JSON.stringify(
                  {
                    summary,
                    verification: 'mechanical_passed',
                    verificationMode: 'full',
                    liveVerified: true,
                    semanticVerification: {
                      status: semantic.report.status,
                      completed: semantic.completedReview,
                      provider: semantic.provider,
                      model: semantic.model,
                      attempts: semantic.attempts,
                      evidenceArtifact: semantic.report.evidenceArtifact,
                      logArtifact: semantic.report.logArtifact,
                    },
                    warnings: allWarnings,
                    timestamp: Date.now(),
                  },
                  null,
                  2,
                ),
                'utf8',
              );
              log(`verification passed; wrote ${sentinel}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: `DONE — deterministic checks and independent live semantic verification passed. Evidence: ${semantic.report.evidenceArtifact ?? '.live-verification-evidence.json'}. Verifier log: ${semantic.report.logArtifact ?? '.live-verifier-log.jsonl'}. Do not call any more tools.`,
                  },
                ],
              };
            }
          }
        }
        semanticVerificationCycles = advanceSemanticVerificationCycle(
          semanticVerificationCycles,
          semanticReviewCompleted,
        );
        incompleteVerifierRuns = advanceIncompleteSemanticVerificationRuns(
          incompleteVerifierRuns,
          semanticReviewAttempted,
          semanticReviewCompleted,
        );
        if (incompleteVerifierRuns >= maxIncompleteVerifierRuns) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'failed',
                incompleteVerifierRuns,
                failures,
                warnings,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Independent semantic verifier failed to complete after ${maxIncompleteVerifierRuns} bounded runs. Final failures:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
              },
            ],
          };
        }
        const failurePhase = semanticReviewCompleted
          ? `semantic verification failed (cycle ${semanticVerificationCycles}/${maxVerificationCycles})`
          : semanticReviewAttempted
            ? 'semantic verifier did not complete a review (semantic cycle unchanged)'
            : 'deterministic verification failed (semantic cycle unchanged)';
        log(failurePhase);
        if (semanticVerificationCycles >= maxVerificationCycles) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'failed',
                cycles: semanticVerificationCycles,
                failures,
                warnings,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Semantic verification failed after ${maxVerificationCycles} cycles. Giving up. Final failures:\n${failures.map((f) => `- ${f}`).join('\n')}`,
              },
            ],
          };
        }

        const repairFiles =
          opts.strategyKind === 'playbook_fallback'
            ? 'workflow.json and playbook.yaml'
            : 'workflow.json, parser.ts, and parser.test.ts';
        const continuationMessage = `You called done but ${failurePhase}:

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (${repairFiles}), fix the issues, re-run the applicable checks, and call done again when fixed.`;
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: continuationMessage,
            },
          ],
        };
      }

      // Auth-mode checkpoint tools — record the request and end the segment. The
      // orchestrator performs the action live and resumes the agent with the result.
      if (
        name === 'run_verification' ||
        name === 'inspect_verification_page' ||
        name === 'prompt_user' ||
        name === 'wait_for_cooldown'
      ) {
        if (name === 'run_verification') {
          const failures = authWorkflowPreflightFailures(
            opts.toolDir,
            session,
            opts.authToolPlan?.credentialNames,
          );
          if (failures.length > 0) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `run_verification blocked by auth workflow preflight. Fix workflow.json before requesting live verification:\n${failures
                    .map((failure) => `- ${failure}`)
                    .join('\n')}`,
                },
              ],
            };
          }
        }
        if (checkpointWritten) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'A checkpoint is already pending this turn. STOP now — do not call another tool; the orchestrator will act and resume you.',
              },
            ],
          };
        }
        const checkpoint: Record<string, unknown> = { kind: name, ...args, timestamp: Date.now() };
        const sentinel = pathJoin(opts.toolDir, CHECKPOINT_SENTINEL);
        writeFileSync(sentinel, JSON.stringify(checkpoint, null, 2), 'utf8');
        checkpointWritten = true;
        log(`checkpoint(${name}) recorded; wrote ${sentinel}`);
        return {
          content: [
            {
              type: 'text',
              text: `CHECKPOINT_RECORDED (${name}) — STOP now and reply briefly that you are waiting. The orchestrator will perform this and resume you with the result as a new message. Do not call any more tools.`,
            },
          ],
        };
      }

      // Custom give_up — writes sentinel and exits.
      if (name === 'give_up') {
        const reason = (args as { reason?: string }).reason ?? 'unknown';
        const whatWasTried = (args as { what_was_tried?: string }).what_was_tried ?? '';
        log(`give_up() called: ${reason}`);
        const sentinel = pathJoin(opts.toolDir, GIVE_UP_SENTINEL);
        writeFileSync(
          sentinel,
          JSON.stringify({ reason, what_was_tried: whatWasTried, timestamp: Date.now() }, null, 2),
          'utf8',
        );
        return {
          content: [
            {
              type: 'text',
              text: 'GIVE_UP_RECORDED — the orchestrator will exit shortly. Do not call any more tools.',
            },
          ],
        };
      }

      // Standard read/write tools — delegate to the shared handlers.
      const tool = compileTools.find((t) => t.name === name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
      }

      let result: { result: string; isError?: boolean };
      try {
        result = await tool.handler(args);
      } catch (err) {
        const control = providerControlError(err);
        if (control) throw control;
        result = {
          result: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: result.result }],
        isError: result.isError ?? false,
      };
    });

    const transport = new StdioServerTransport();
    let closeLifetime: (() => void) | undefined;
    try {
      await server.connect(transport);
      log(`stdio transport ready (${compileTools.length + 2} tools)`);
      await new Promise<void>((resolve) => {
        const close = (reason: string): void => {
          log(`closing: ${reason}`);
          resolve();
        };
        transport.onclose = () => close('client disconnected');
        closeLifetime = () => close('process signal');
        active.signal?.addEventListener('abort', closeLifetime, { once: true });
      });
    } finally {
      if (closeLifetime) active.signal?.removeEventListener('abort', closeLifetime);
      transport.onclose = undefined;
      await server.close().catch(() => undefined);
    }
  } finally {
    active.dispose();
    providerControl?.dispose();
    for (const [signal, handler] of lifetimeHandlers) process.removeListener(signal, handler);
  }
}

/** Sentinel file names exposed for the orchestrator to poll. */
export const COMPILE_SENTINELS = {
  done: DONE_SENTINEL,
  giveUp: GIVE_UP_SENTINEL,
  checkpoint: CHECKPOINT_SENTINEL,
  verificationState: VERIFICATION_STATE_SENTINEL,
} as const;
