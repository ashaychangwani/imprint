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

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
import {
  type AuthToolPlan,
  type SharedModuleManifestEntry,
  resolvePlanSliceFromFile,
} from './build-plan.ts';
import {
  applyLiveVerification,
  applyParamVerification,
  buildCompileTools,
  externalVerification,
} from './compile-tools.ts';
import {
  mergeSemanticParamVerification,
  runLiveSemanticVerification,
  semanticVerificationFailures,
} from './live-verifier.ts';
import type { ProviderName } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { rebindExistingBackendsCacheToWorkflow } from './probe-backends.ts';
import { redactSession } from './redact.ts';
import { loadCredentialStore } from './runtime.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type Session, SessionSchema } from './types.ts';

const log = createLog('mcp-compile');

interface RunCompileMcpServerOptions {
  /** Path to the recorded session JSON. */
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
}

const DONE_SENTINEL = '.compile-done.json';
const GIVE_UP_SENTINEL = '.compile-give-up.json';
const VERIFICATION_STATE_SENTINEL = '.compile-verification-state.json';
// Keep the compile watchdog from charging live verification against the model's
// reasoning budget, while retaining a hard bound if the MCP server dies during
// done(). This matches the longest supported MCP tool call.
const MAX_VERIFICATION_WALL_TIME_MS = 30 * 60_000;
/** Auth mode only: a mid-loop checkpoint the agent reaches. The tool records
 *  the request here and the
 *  agent STOPS; the orchestrator (teach) performs the action and resumes the
 *  agent (`claude --resume`) with the result. One pending checkpoint per segment. */
const CHECKPOINT_SENTINEL = '.compile-checkpoint.json';

const COMPILE_ARTIFACT_FILES = [
  'workflow.json',
  'parser.ts',
  'parser.test.ts',
  'integration.test.ts',
  'request-transform.ts',
  'playbook.yaml',
] as const;

interface PendingInconclusiveDecision {
  artifactFingerprint: string;
  report: Awaited<ReturnType<typeof runLiveSemanticVerification>>;
}

interface CompileVerificationState {
  excludedMs: number;
  activeSinceMs?: number;
  activeUntilMs?: number;
}

function readCompileVerificationState(toolDir: string): CompileVerificationState {
  try {
    const parsed = JSON.parse(
      readFileSync(pathJoin(toolDir, VERIFICATION_STATE_SENTINEL), 'utf8'),
    ) as Partial<CompileVerificationState>;
    return {
      excludedMs:
        typeof parsed.excludedMs === 'number' && Number.isFinite(parsed.excludedMs)
          ? Math.max(0, parsed.excludedMs)
          : 0,
      activeSinceMs:
        typeof parsed.activeSinceMs === 'number' && Number.isFinite(parsed.activeSinceMs)
          ? parsed.activeSinceMs
          : undefined,
      activeUntilMs:
        typeof parsed.activeUntilMs === 'number' && Number.isFinite(parsed.activeUntilMs)
          ? parsed.activeUntilMs
          : undefined,
    };
  } catch {
    return { excludedMs: 0 };
  }
}

function writeCompileVerificationState(toolDir: string, state: CompileVerificationState): void {
  const destination = pathJoin(toolDir, VERIFICATION_STATE_SENTINEL);
  const temporary = pathJoin(
    toolDir,
    `${VERIFICATION_STATE_SENTINEL}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, destination);
  } finally {
    // rename removes the source on success; clean up a partial temp file if a
    // write or rename fails without disturbing the last complete state.
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function beginCompileVerification(toolDir: string): () => void {
  const previous = readCompileVerificationState(toolDir);
  const startedAt = Date.now();
  writeCompileVerificationState(toolDir, {
    excludedMs: previous.excludedMs,
    activeSinceMs: startedAt,
    activeUntilMs: startedAt + MAX_VERIFICATION_WALL_TIME_MS,
  });
  return () => {
    const finishedAt = Date.now();
    writeCompileVerificationState(toolDir, {
      excludedMs:
        previous.excludedMs +
        Math.min(MAX_VERIFICATION_WALL_TIME_MS, Math.max(0, finishedAt - startedAt)),
    });
  };
}

/** Effective compiler deadline after excluding bounded time spent inside done()
 * verification. Exported for the CLI watchdogs and focused lifecycle tests. */
export function compileDeadlineAfterVerification(
  toolDir: string,
  compilerDeadlineMs: number,
  now = Date.now(),
): number {
  const state = readCompileVerificationState(toolDir);
  const activeElapsedMs =
    state.activeSinceMs === undefined
      ? 0
      : Math.max(
          0,
          Math.min(now, state.activeUntilMs ?? state.activeSinceMs) - state.activeSinceMs,
        );
  return compilerDeadlineMs + state.excludedMs + activeElapsedMs;
}

export function compileArtifactFingerprint(toolDir: string): string {
  const hash = createHash('sha256');
  for (const relativePath of COMPILE_ARTIFACT_FILES) {
    const absolutePath = pathJoin(toolDir, relativePath);
    hash.update(relativePath);
    hash.update('\0');
    if (existsSync(absolutePath)) hash.update(readFileSync(absolutePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function canAcceptInconclusiveDecision(opts: {
  pendingFingerprint?: string;
  currentFingerprint: string;
  acceptInconclusive?: boolean;
  inconclusiveReason?: string;
}): boolean {
  return (
    opts.acceptInconclusive === true &&
    Boolean(opts.inconclusiveReason?.trim()) &&
    opts.pendingFingerprint === opts.currentFingerprint
  );
}

export async function runCompileMcpServer(opts: RunCompileMcpServerOptions): Promise<void> {
  const isAuthMode = !!opts.authToolPlan;
  const maxVerificationCycles = opts.maxVerificationCycles ?? 5;
  let pendingInconclusive: PendingInconclusiveDecision | undefined;

  // Load + auto-redact the session, exactly as compile-agent.ts does.
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
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    session = redactSession(session).session;
  }

  // Build the toolset. Auth mode swaps the data tools (parser/test-oriented)
  // for the auth toolset, which lives in auth-compile-tools.ts so the in-process
  // loop and this MCP path stay byte-for-byte identical.
  type PlanSlice = ReturnType<typeof resolvePlanSliceFromFile>;
  let compileTools: ReturnType<typeof buildCompileTools>;
  let assignedSharedModules: PlanSlice['assignedSharedModules'] = [];
  let tokenParams: PlanSlice['tokenParams'] = [];
  let tokenParamShapes: PlanSlice['tokenParamShapes'] = [];
  let emittedTokens: PlanSlice['emittedTokens'] = [];
  let requiredInputs: PlanSlice['requiredInputs'] = [];
  let credentialValues: Record<string, string> = {};

  if (isAuthMode) {
    const site = opts.site ?? session.site;
    // Credentials power the orchestrator-owned live verifier. Load them here
    // rather than passing secrets on the command line.
    const creds = await loadCredentialStore(site);
    const teachCredentials = { site, values: creds?.values ?? {} };
    compileTools = buildAuthCompileTools(session, opts.toolDir, opts.sessionPath, teachCredentials);
  } else {
    // When a build plan is present, buildCompileTools also exposes read_build_plan.
    compileTools = buildCompileTools(session, opts.toolDir, opts.sessionPath, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
      buildPlanPath: opts.buildPlanPath,
      sharedModules: opts.sharedModules,
      revisionMode: opts.revisionMode,
    });

    // Resolve the shared modules + producer→consumer token contracts + the general
    // dependency contract the plan assigned this tool, so verification can assert
    // modules are imported, require a chained test for each producer-sourced token
    // param, and inject/gate the contracted inputs.
    ({ assignedSharedModules, tokenParams, tokenParamShapes, emittedTokens, requiredInputs } =
      resolvePlanSliceFromFile(opts.buildPlanPath, opts.candidate?.toolName, opts.sharedModules));
    // Credential values for the emit-time secret guard (loaded for the data path,
    // never passed on argv).
    const creds = await loadCredentialStore(opts.site ?? session.site);
    credentialValues = creds?.values ?? {};
  }

  // The custom done/give_up tools live alongside in MCP space.
  const doneTool: Tool = {
    name: 'done',
    description:
      'Call this when you have successfully completed the task. Triggers external verification of the artifacts. If verification fails, the result will list the issues and you should fix them and call done again.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was accomplished' },
        accept_inconclusive: {
          type: 'boolean',
          description:
            'After an infrastructure-only inconclusive verifier result, explicitly ship the unchanged deterministic artifact without a liveVerified stamp.',
        },
        inconclusive_reason: {
          type: 'string',
          description:
            'Compiler reasoning for accepting the unchanged artifact after reviewing the inconclusive verifier evidence.',
        },
      },
      required: ['summary'],
    },
  };
  const giveUpTool: Tool = {
    name: 'give_up',
    description:
      'Call this when you have encountered a categorical impossibility and cannot proceed.',
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
              action: { type: 'string', description: 'An action declared in authConfig.actions.' },
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

  let verificationFailures = 0;
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
      const doneArgs = args as {
        summary?: string;
        accept_inconclusive?: boolean;
        inconclusive_reason?: string;
      };
      const summary = doneArgs.summary ?? 'Task completed';
      log(`done() called: ${summary}`);

      // Auth mode: lightweight structural verification (the agent already proved
      // the workflow works live via run_verification). No param/live stamps.
      if (isAuthMode) {
        const failures = authExternalVerification(
          opts.toolDir,
          (opts.authToolPlan?.captures ?? []).map((c) => ({ name: c.name, usedAs: c.usedAs })),
          { requireLiveAttempt: true },
        );
        if (failures.length === 0) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              { summary, verification: 'passed', warnings: [], timestamp: Date.now() },
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
                text: 'DONE_VERIFIED — verification passed. The orchestrator will exit shortly. Do not call any more tools.',
              },
            ],
          };
        }

        verificationFailures++;
        log(`auth verification failed (cycle ${verificationFailures})`);

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `You called done but verification failed (cycle ${verificationFailures}):

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with run_verification, and call done again when fixed.`,
            },
          ],
        };
      }

      const finishVerification = beginCompileVerification(opts.toolDir);
      try {
        const { failures, warnings, paramVerification, integrationEvidence } =
          await externalVerification(opts.toolDir, session, opts.sessionPath, {
            expectedToolName: opts.candidate?.toolName,
            likelyParams: opts.candidate?.likelyParams,
            candidateRequestSeqs: opts.candidate?.requestSeqs,
            // Widen Fix B's variation pool to dependency requests so a token that
            // varies only across them and is frozen as a literal in the tool's
            // request is caught (the cross-request session-token leak case).
            dependencyRequestSeqs: opts.candidate?.dependencySeqs,
            assignedSharedModules,
            tokenParams,
            tokenParamShapes,
            emittedTokens,
            requiredInputs,
            credentialValues,
            credentialNames: opts.sharedContext?.credentialNames,
            deferLiveIntegrationToSemanticAgent: true,
          });
        if (warnings.length > 0) {
          log(`verification warnings (non-blocking):\n${warnings.join('\n')}`);
        }
        if (failures.length === 0) {
          if (!opts.provider) {
            failures.push('compile provider was not supplied to the independent semantic verifier');
          } else {
            const currentFingerprint = compileArtifactFingerprint(opts.toolDir);
            if (
              pendingInconclusive &&
              canAcceptInconclusiveDecision({
                pendingFingerprint: pendingInconclusive.artifactFingerprint,
                currentFingerprint,
                acceptInconclusive: doneArgs.accept_inconclusive,
                inconclusiveReason: doneArgs.inconclusive_reason,
              })
            ) {
              const semantic = pendingInconclusive.report;
              const semanticParams = mergeSemanticParamVerification(
                paramVerification,
                semantic.report,
              );
              const inconclusiveReason = doneArgs.inconclusive_reason?.trim() ?? '';
              applyLiveVerification(opts.toolDir, {
                kind: 'waived-infra',
                firstError: inconclusiveReason,
                exhaustedBackends: [],
              });
              const paramWarnings = applyParamVerification(opts.toolDir, semanticParams);
              // The unverified stamp and parameter annotations are metadata-only,
              // so carry the already-proven preference to the final workflow hash.
              rebindExistingBackendsCacheToWorkflow(opts.toolDir);
              const allWarnings = [
                ...warnings,
                `independent semantic verification was inconclusive: ${semantic.report.summary}`,
                ...paramWarnings,
              ];
              const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
              writeFileSync(
                sentinel,
                JSON.stringify(
                  {
                    summary,
                    verification: 'passed',
                    liveVerified: false,
                    semanticVerification: {
                      status: semantic.report.status,
                      provider: semantic.provider,
                      model: semantic.model,
                      attempts: semantic.attempts,
                      evidenceArtifact: semantic.report.evidenceArtifact,
                      logArtifact: semantic.report.logArtifact,
                    },
                    compilerDecision: {
                      decision: 'ship_unverified',
                      reason: inconclusiveReason,
                    },
                    warnings: allWarnings,
                    timestamp: Date.now(),
                  },
                  null,
                  2,
                ),
                'utf8',
              );
              log(`compiler accepted unchanged inconclusive artifact; wrote ${sentinel}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: `DONE_UNVERIFIED — deterministic verification passed and the compiler explicitly accepted the unchanged artifact after an infrastructure-only inconclusive live review. Evidence: ${semantic.report.evidenceArtifact ?? '.live-verification-evidence.json'}. Verifier log: ${semantic.report.logArtifact ?? '.live-verifier-log.jsonl'}. The orchestrator will exit shortly. Do not call any more tools.`,
                  },
                ],
              };
            }

            if (
              pendingInconclusive &&
              pendingInconclusive.artifactFingerprint !== currentFingerprint
            ) {
              log(
                'compile artifacts changed after inconclusive review; running verification again',
              );
              pendingInconclusive = undefined;
            }
            const semantic = await runLiveSemanticVerification({
              provider: opts.provider,
              toolDir: opts.toolDir,
              evidence: integrationEvidence,
            });
            if (semantic.report.status === 'inconclusive') {
              pendingInconclusive = {
                artifactFingerprint: compileArtifactFingerprint(opts.toolDir),
                report: semantic,
              };
            } else {
              pendingInconclusive = undefined;
            }
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
              // Only the independent semantic agent can mint liveVerified=true.
              applyLiveVerification(opts.toolDir, undefined);
              const paramWarnings = applyParamVerification(opts.toolDir, semanticParams);
              // liveVerified/parameter annotations are metadata-only, but they
              // change the hash-strict workflow cache key. Keep the verifier's
              // already-proven backend preference current without probing again.
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
                    verification: 'passed',
                    semanticVerification: {
                      status: semantic.report.status,
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
                    text: `DONE_VERIFIED — deterministic checks and independent live semantic verification passed (${semantic.report.status}). Evidence: ${semantic.report.evidenceArtifact ?? '.live-verification-evidence.json'}. Verifier log: ${semantic.report.logArtifact ?? '.live-verifier-log.jsonl'}. The orchestrator will exit shortly. Do not call any more tools.`,
                  },
                ],
              };
            }
          }
        }
        verificationFailures++;
        log(`verification failed (cycle ${verificationFailures}/${maxVerificationCycles})`);
        if (verificationFailures >= maxVerificationCycles) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'failed',
                cycles: verificationFailures,
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
                text: `Verification failed after ${maxVerificationCycles} cycles. Giving up. Final failures:\n${failures.map((f) => `- ${f}`).join('\n')}`,
              },
            ],
          };
        }

        const continuationMessage = `You called done but verification failed (cycle ${verificationFailures}/${maxVerificationCycles}):

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (workflow.json, parser.ts, parser.test.ts), fix the issues, re-run tests, and call done again when fixed.`;
        const compilerDecisionGuidance = `\n\nUse the verifier's semantic evidence, not a requirement for 100% of the original candidate inputs. If the core intent works but a secondary parameter cannot be supported from the recording and live evidence without guessing, remove that parameter and add workflow.limitations with omittedParameters and a specific reason. Close that omission over its dependencies: also remove dependent public inputs and narrow parameter/intent descriptions so callers cannot still enter the unsupported branch indirectly. Do not use a limitation to hide a broken core tool, and do not keep a known broken or ignored public input.`;
        const inconclusiveDecisionGuidance = pendingInconclusive
          ? '\n\nThe live verifier was infrastructure-only inconclusive. Review its evidence and log. If they expose a tool defect, revise the artifacts and call done normally so verification reruns. If they expose no tool-level defect and the deterministic artifact should ship explicitly unverified, call done again without changing compile artifacts, set accept_inconclusive=true, and provide your concrete reasoning in inconclusive_reason. This compiler decision is persisted and does not mint liveVerified.'
          : '';
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: continuationMessage + compilerDecisionGuidance + inconclusiveDecisionGuidance,
            },
          ],
        };
      } finally {
        finishVerification();
      }
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
  await server.connect(transport);
  log(`stdio transport ready (${compileTools.length + 2} tools)`);

  // Block until the orchestrator closes us. Mirrors mcp-server.ts:230.
  await new Promise<void>((resolve) => {
    const close = (reason: string): void => {
      log(`closing: ${reason}`);
      resolve();
    };
    transport.onclose = () => close('client disconnected');
    process.once('SIGINT', () => close('SIGINT'));
    process.once('SIGTERM', () => close('SIGTERM'));
  });
}

/** Sentinel file names exposed for the orchestrator to poll. */
export const COMPILE_SENTINELS = {
  done: DONE_SENTINEL,
  giveUp: GIVE_UP_SENTINEL,
  checkpoint: CHECKPOINT_SENTINEL,
  verificationState: VERIFICATION_STATE_SENTINEL,
} as const;
