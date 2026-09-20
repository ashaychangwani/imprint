/** Runs only in the isolated IMPRINT_HOME created by `imprint refine`. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runAudit } from './audit.ts';
import { runWorkflowWithLadder } from './backend-ladder.ts';
import { generate } from './compile.ts';
import { extractCredentials } from './credential-extract.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import { emit } from './emit.ts';
import { requestRefinementPlan } from './master-teach-agents.ts';
import { extractJsonResultPath } from './master-teach-checks.ts';
import { localSiteDir } from './paths.ts';
import { RunDeadline } from './provider-retry.ts';
import {
  type RecordingFixture,
  parseRecordedResponses,
  verifyRecordingEvidence,
} from './recording-verification.ts';
import { redactSession } from './redact.ts';
import { assertRefinementContract } from './refine.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { shutdownTracing, traced } from './tracing.ts';
import { SessionSchema, WorkflowSchema } from './types.ts';

const Params = z.record(z.union([z.string(), z.number(), z.boolean()]));
const Plan = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            instruction: z.string().min(1),
            parameters: z.array(
              z
                .object({
                  name: z.string(),
                  type: z.enum(['string', 'number', 'boolean']),
                  description: z.string(),
                })
                .strict(),
            ),
            requestSeqs: z.array(z.number().int().nonnegative()).min(1),
            cases: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-z0-9_-]+$/),
                    requestSeqs: z.array(z.number().int().nonnegative()).min(1).optional(),
                    recordedParameters: Params,
                    liveParameters: Params,
                    freshnessChanges: z.string().min(1),
                    bindings: z.array(
                      z
                        .object({
                          producerTool: z.string(),
                          path: z.string(),
                          parameter: z.string(),
                        })
                        .strict(),
                    ),
                  })
                  .strict(),
              )
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
const Config = z.object({
  site: z.string(),
  tool: z.string(),
  issue: z.string(),
  recordingPath: z.string(),
  runRoot: z.string(),
  stagedHome: z.string(),
  deadlineMs: z.number(),
  provider: z.enum(['codex-cli', 'claude-cli']),
  model: z.string().optional(),
});

async function refineStage(config: z.infer<typeof Config>): Promise<string[]> {
  ensureImprintRuntimeLink(config.stagedHome);
  const runDeadline = new RunDeadline(config.deadlineMs);
  const signal = AbortSignal.timeout(Math.max(1, config.deadlineMs - Date.now()));
  const agent = { provider: config.provider, model: config.model, runDeadline, signal };
  const original = SessionSchema.parse(JSON.parse(readFileSync(config.recordingPath, 'utf8')));
  const { session } = redactSession(original, {
    replacements: extractCredentials(original).replacements,
  });
  const sessionPath = join(config.runRoot, 'recording.redacted.json');
  writeFileSync(sessionPath, JSON.stringify(session));
  const siteDir = localSiteDir(config.site);
  const installed = readdirSync(siteDir)
    .filter((name) => existsSync(join(siteDir, name, 'workflow.json')))
    .map((name) => ({
      name,
      workflow: WorkflowSchema.parse(
        JSON.parse(readFileSync(join(siteDir, name, 'workflow.json'), 'utf8')),
      ),
    }));
  const plan = await requestRefinementPlan(
    {
      issue: config.issue,
      target: config.tool,
      installed,
      recordingPath: sessionPath,
      requests: session.requests.map(({ seq, method, url }) => ({ seq, method, url })),
    },
    Plan,
    agent,
  );
  writeFileSync(join(config.runRoot, 'plan.json'), JSON.stringify(plan, null, 2));
  if (!plan.tools.length) throw new Error('Recording does not support the requested refinement');
  if (
    !plan.tools.some(({ name }) => name === config.tool) ||
    new Set(plan.tools.map(({ name }) => name)).size !== plan.tools.length
  )
    throw new Error('Refinement plan must include the target exactly once');
  const outputs = new Map<string, unknown>();
  for (const tool of plan.tools) {
    const before = installed.find(({ name }) => name === tool.name)?.workflow;
    if (!before) throw new Error(`Unknown installed tool ${tool.name}`);
    if (
      before.toolKind === 'authenticate' ||
      before.authConfig ||
      workflowHasIrreversibleEffect(before)
    )
      throw new Error(
        'Refine currently supports data tools without irreversible effects; authentication programs require teach',
      );
    if (tool.requestSeqs.some((seq) => !session.requests.some((request) => request.seq === seq)))
      throw new Error('Refinement references unavailable recording requests');
    for (const test of tool.cases)
      for (const binding of test.bindings)
        if (!outputs.has(binding.producerTool))
          throw new Error('Refinement dependencies must run producer first');
    const toolDir = join(siteDir, tool.name);
    // Seeded runtime files are available only in this refinement. Fresh teach
    // never enters this path or sees installed artifacts.
    const generated = await generate({
      sessionPath,
      outDir: toolDir,
      llmConfig: { provider: config.provider, model: config.model },
      runDeadline,
      signal,
      keepTest: true,
      revisionMode: true,
      verificationMode: 'master_mvp',
      candidate: {
        toolName: tool.name,
        description: before.intent.description,
        rationale: tool.instruction,
        confidence: 1,
        requestSeqs: tool.requestSeqs,
        representativeSeqs: tool.requestSeqs,
        eventSeqs: [],
        expectedOutput: tool.instruction,
        likelyParams: tool.parameters,
        dependencySeqs: [],
        dependsOnTools: tool.cases.flatMap(({ bindings }) =>
          bindings.map(({ producerTool }) => producerTool),
        ),
      },
      toolPlan: JSON.stringify({
        mode: 'refine',
        issue: config.issue,
        instruction: tool.instruction,
        previousWorkflow: before,
        fixedCases: tool.cases,
        preserveExistingBehavior: true,
      }),
    });
    assertRefinementContract(before, generated.workflow);
    emit({ workflowPath: generated.workflowPath, outDir: toolDir, force: true });
    const fixtures: RecordingFixture[] = [];
    for (const test of tool.cases) {
      const requestSeqs = test.requestSeqs ?? tool.requestSeqs;
      const responses = requestSeqs.map((seq) => {
        const body = session.requests.find((request) => request.seq === seq)?.response?.body;
        if (body === undefined) throw new Error(`Recording response ${seq} is unavailable`);
        try {
          return JSON.parse(body);
        } catch {
          return body;
        }
      });
      fixtures.push({
        id: `${test.id}_recording`,
        origin: 'recording',
        requestSeqs,
        parameters: test.recordedParameters,
        responses,
        actual: await parseRecordedResponses(
          generated.workflowPath,
          generated.workflow,
          responses,
          test.recordedParameters,
        ),
      });
      const parameters = { ...test.liveParameters };
      for (const binding of test.bindings) {
        const value = extractJsonResultPath(outputs.get(binding.producerTool), binding.path);
        if (!value.ok || !['string', 'number', 'boolean'].includes(typeof value.value))
          throw new Error('Fresh producer value is unavailable or not a scalar parameter');
        parameters[binding.parameter] = value.value as string | number | boolean;
      }
      let rawResponses: unknown[] | undefined;
      const live = await runWorkflowWithLadder({
        workflowPath: generated.workflowPath,
        params: parameters,
        signal,
        onRawResponses: (responses) => {
          rawResponses = responses;
        },
      });
      if (!live.result.ok || !rawResponses)
        throw new Error(`Refined live case ${test.id} failed: ${JSON.stringify(live.result)}`);
      if (!outputs.has(tool.name)) outputs.set(tool.name, live.result.data);
      fixtures.push({
        id: `${test.id}_live`,
        origin: 'live',
        requestSeqs,
        parameters,
        responses: rawResponses,
        actual: live.result.data,
        freshnessChanges: test.freshnessChanges,
      });
    }
    const reviewed = await verifyRecordingEvidence({
      operation: {
        name: tool.name,
        description: before.intent.description,
        expectedOutput: tool.instruction,
      },
      fixtures,
      directory: join(config.runRoot, 'verification', tool.name),
      agent,
    });
    if (reviewed.status !== 'passed') throw new Error(reviewed.reason);
  }
  const audit = await runAudit({
    site: config.site,
    strict: true,
    minScore: 100,
    outPath: join(config.runRoot, 'audit.json'),
    provider: config.provider,
    model: config.model,
    timeoutMs: Math.max(1, config.deadlineMs - Date.now()),
    json: true,
  });
  if (audit.verdict !== 'pass')
    throw new Error(`Staged strict audit ${audit.verdict}; originals preserved`);
  return plan.tools.map(({ name }) => name);
}

if (import.meta.main) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Refinement worker requires a configuration path');
  const config = Config.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  try {
    const tools = await traced(
      'imprint.refine',
      'AGENT',
      { 'imprint.site': config.site, 'imprint.tool_name': config.tool },
      () => refineStage(config),
    );
    writeFileSync(
      join(config.runRoot, 'result.json'),
      JSON.stringify({ status: 'completed', tools }),
    );
  } catch (error) {
    writeFileSync(
      join(config.runRoot, 'result.json'),
      JSON.stringify({
        status: 'failed',
        tools: [],
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await shutdownTracing();
  }
}
