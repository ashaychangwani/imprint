import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiResearchBlockedError,
  copyApiResearchEvidence,
  researchApiMvpCall,
} from '../src/imprint/api-research-agent.ts';
import {
  type ApiResearchCandidate,
  ApiResearchHandoffSchema,
} from '../src/imprint/master-teach-agent-contracts.ts';
import {
  SemanticAgentOutputError,
  apiResearchCandidateSha256,
  apiResearchInputsSha256,
  parseApiResearchOutput,
  requestApiResearchStep,
} from '../src/imprint/master-teach-agents.ts';
import { teachingPlanContentSha256 as digest } from '../src/imprint/master-teach-plan.ts';
import { PromptEvidenceProjectionSchema } from '../src/imprint/master-teach-prompt-projections.ts';
import { NativeTeachAgents } from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import { TeachResearchMemory } from '../src/imprint/teach-research-memory.ts';

const recordingSha256 = `sha256:${'1'.repeat(64)}`;
const evidencePayload = { entries: [] };
const evidence = PromptEvidenceProjectionSchema.parse({
  ref: { path: 'objects/evidence.json', sha256: digest(evidencePayload) },
  payload: evidencePayload,
});
const candidateTool = {
  toolName: 'search_fixture',
  description: 'Search a fixture API',
  rationale: 'Recorded request 12 returns the fixture results.',
  confidence: 0.99,
  requestSeqs: [12],
  representativeSeqs: [12],
  eventSeqs: [],
  expectedOutput: 'Fixture records',
  likelyParams: [{ name: 'query', type: 'string' as const, description: 'Search text' }],
  dependencySeqs: [],
  dependsOnTools: [],
};
const baseTool = {
  id: 'search_fixture',
  candidate: candidateTool,
  compileContext: {
    loginRequestSeqs: [],
    credentialNames: [],
    tokenExtractionNotes: '',
    sharedHelperNotes: '',
    authRequestSeqs: [],
    authNotes: '',
  },
  evidenceRefs: [evidence.ref],
  strategy: { kind: 'api' as const, reason: 'A recorded API request exists.' },
};
const compileInputsSha256 = apiResearchInputsSha256(baseTool);
const tool = baseTool;
const run = {
  runId: 'research-run',
  site: 'fixture.invalid',
  recordingSha256,
};
const recordingIndex = { recordingSha256, requestSeqs: [12], eventSeqs: [] };
const session = {
  site: 'fixture.invalid',
  startedAt: '2026-01-01T00:00:00.000Z',
  url: 'https://fixture.invalid',
  imprintVersion: 'test',
  requests: [
    {
      seq: 12,
      timestamp: 1,
      method: 'GET',
      url: 'https://fixture.invalid/search?APIKey=recorded-secret&variant=recorded',
      headers: { 'x-recorded': 'recorded-header-secret' },
      resourceType: 'xhr',
    },
  ],
  events: [],
  narration: [],
  cookieSnapshots: [],
  storageSnapshots: [],
};
const apiCandidate = (
  variant: string,
  testBackend?: ApiResearchCandidate['testBackend'],
): ApiResearchCandidate => ({
  workflow: {
    toolName: 'search_fixture',
    intent: { description: 'Search fixture records' },
    parameters: [{ name: 'query', type: 'string', description: 'Search text' }],
    requests: [
      {
        method: 'GET',
        url: `https://fixture.invalid/search?q=\${param.query}&variant=${variant}`,
        headers: {},
        recordingRequestSeq: 12,
      },
    ],
    site: 'fixture.invalid',
  },
  parameterValues: { query: 'alpha' },
  ...(testBackend ? { testBackend } : {}),
});
const binding = {
  runId: run.runId,
  recordingSha256,
  toolName: tool.candidate.toolName,
  compileInputsSha256,
};

describe('focused API research', () => {
  it('allows isolated sibling research calls to overlap without a site file lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-research-overlap-'));
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondEntered = false;
    const pools = new Set<unknown>();
    const execute = (name: string) => {
      const candidate = apiCandidate('overlap', 'fetch');
      candidate.workflow.toolName = name;
      const ownTool = { ...tool, id: name, candidate: { ...tool.candidate, toolName: name } };
      const ownBinding = {
        ...binding,
        toolName: name,
        compileInputsSha256: apiResearchInputsSha256(ownTool),
      };
      return researchApiMvpCall({
        run,
        recordingIndex,
        tool: ownTool,
        evidence,
        toolDir: join(root, name),
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 3000),
        dependencies: {
          requestStep: async (input) =>
            input.observations.length
              ? {
                  binding: ownBinding,
                  action: 'proven',
                  candidate,
                  basedOnObservationId: input.observations[0]?.id,
                  reason: 'Exact isolated evidence.',
                }
              : { binding: ownBinding, action: 'test', candidate, reason: 'Recorded fixture.' },
          runApiTool: async ({ cdpPool }) => {
            pools.add(cdpPool);
            if (name === 'first_fixture') {
              firstStarted();
              await gate;
            } else secondEntered = true;
            return { result: { ok: true, data: { name } }, executionMechanism: 'fetch' };
          },
        },
      });
    };
    const first = execute('first_fixture');
    await started;
    const second = execute('second_fixture');
    try {
      await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect(secondEntered).toBe(true);
      expect(pools.size).toBe(2);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps validated actions, repairs, memory and fresh producer calls in one native assignment per pass', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-native-research-integration-'));
    const candidate = apiCandidate('native', 'fetch');
    const deadline = new RunDeadline(Date.now() + 10_000);
    const objects = new Map<string, unknown>();
    const memory = new TeachResearchMemory(run.runId, {
      put: (value) => {
        const sha256 = digest(value);
        objects.set(sha256, value);
        return { path: `objects/${sha256}.json`, sha256 };
      },
      read: (ref) => {
        if (!objects.has(ref.sha256)) throw new Error('Unknown object');
        return objects.get(ref.sha256);
      },
    });
    let assignments = 0;
    const invocations: Array<{ workflowPath: string; query: unknown }> = [];
    const family = new NativeTeachAgents(
      { root: join(toolDir, 'native'), model: 'fixture', deadline },
      async (native, signal) => {
        while (!signal.aborted) {
          const offered = (await native.handle('assignments', {})) as {
            stopped: boolean;
            tasks: Array<{ id: string; retainedAgentId?: string }>;
          };
          if (offered.stopped) break;
          for (const task of offered.tasks) {
            assignments++;
            if (assignments === 2) expect(task.retainedAgentId).toBe('/root/researcher');
            const call = (name: string, args: Record<string, unknown>) =>
              native.handle('call_assignment_tool', { id: task.id, name, args });
            await native.handle('read_assignment', { id: task.id, agentId: '/root/researcher' });
            let step = 1;
            const respond = async (value: unknown) => {
              const page = (await call('respond', { step, text: JSON.stringify(value) })) as {
                complete: boolean;
                step: number;
                prompt?: string;
                nextOffset?: number | null;
              };
              if (page.complete) return page;
              step = page.step;
              let text = page.prompt ?? '';
              let offset = page.nextOffset;
              while (offset !== null && offset !== undefined) {
                const more = (await call('read_context', { step, offset })) as {
                  prompt: string;
                  nextOffset: number | null;
                };
                text += more.prompt;
                offset = more.nextOffset;
              }
              const payload = JSON.parse(
                text.split('<user_payload_json>')[1]?.split('</user_payload_json>')[0] ?? '{}',
              );
              return payload;
            };
            const invalid = await respond({ action: 'test' });
            expect(invalid.parseErrors.length).toBeGreaterThan(0);
            const shared = await respond({
              sharedResearch: { runId: run.runId, query: { action: 'list' } },
            });
            expect(shared.sharedResearchResult).toBeDefined();
            const tested = await respond({
              binding,
              action: 'test',
              candidate,
              testCases: [
                {
                  parameterValues: { query: 'alpha' },
                  recordingRequestSeqs: [12],
                  freshnessChanges: 'Synthetic recorded fixture, no freshness change.',
                },
                {
                  parameterValues: { query: 'beta' },
                  recordingRequestSeqs: [12],
                  freshnessChanges: 'Synthetic recorded fixture, no freshness change.',
                },
              ],
              reason: 'Check the two synthetic recorded values.',
            });
            const observations = tested.input.batchObservations;
            expect(observations).toHaveLength(2);
            const inspected = await respond({
              binding,
              action: 'inspect_result',
              resultQuery: {
                observationId: observations[0].id,
                project: 'text => ({value: text})',
              },
              reason: 'Inspect the retained output without another call.',
            });
            expect(inspected.input.resultInspection.projection).toBeDefined();
            const invalidProof = await respond({
              binding,
              action: 'proven',
              candidate: { ...candidate, parameterValues: { query: 'beta' } },
              basedOnObservationId: observations[0].id,
              reason: 'Deliberately mismatched test proof.',
            });
            expect(invalidProof.parseErrors.length).toBeGreaterThan(0);
            const producer = await respond({
              binding,
              action: 'call_producer',
              producerCall: { toolName: 'source_fixture', parameters: { query: 'alpha' } },
              reason: 'Obtain the current upstream value.',
            });
            expect(producer.input.latestObservation.producerToolName).toBe('source_fixture');
            const fresh = {
              ...candidate,
              parameterValues: { query: producer.input.latestObservation.result.preview },
            };
            const consumed = await respond({
              binding,
              action: 'test',
              candidate: fresh,
              reason: 'Use the actual current producer value.',
            });
            expect(
              await respond({
                binding,
                action: 'proven',
                candidate: fresh,
                basedOnObservationId: consumed.input.latestObservation.id,
                reason: 'Exact fresh consumer invocation succeeded.',
              }),
            ).toEqual({ complete: true });
            await native.handle('submit', {
              id: task.id,
              text: 'Host-validated research pass complete.',
            });
          }
        }
      },
    );
    try {
      await family.run(async () => {
        let previousProgress: ReturnType<typeof ApiResearchHandoffSchema.parse> | undefined;
        for (let pass = 0; pass < 2; pass++) {
          const result = await researchApiMvpCall({
            run,
            recordingIndex,
            tool,
            evidence,
            toolDir,
            agent: { provider: 'codex-cli', sharedResearch: memory, runDeadline: deadline },
            runDeadline: deadline,
            previousProgress,
            ...(pass
              ? {
                  followUp: {
                    masterDirection: 'Repeat with fresh upstream evidence.',
                    missingProof: ['Fresh repeat'],
                    siblingResearch: [],
                    relevantRequestSeqs: [12],
                  },
                }
              : {}),
            producers: () => [
              {
                toolName: 'source_fixture',
                candidate: {
                  ...candidate,
                  workflow: { ...candidate.workflow, toolName: 'source_fixture' },
                },
                toolDir: join(toolDir, 'source'),
                summary: 'Synthetic upstream source.',
              },
            ],
            dependencies: {
              requestStep: requestApiResearchStep,
              runApiTool: async ({ workflowPath, parameters }) => {
                invocations.push({ workflowPath, query: parameters.query });
                return {
                  executionMechanism: 'fetch',
                  result: {
                    ok: true,
                    data: workflowPath.includes('producer-calls')
                      ? `fresh-${invocations.length}`
                      : String(parameters.query),
                  },
                };
              },
            },
          });
          expect(result.parameters.query).toBe(`fresh-${pass * 4 + 3}`);
          expect(result.observation.result.ok).toBeTrue();
          previousProgress = ApiResearchHandoffSchema.parse({
            toolName: tool.candidate.toolName,
            researchInputsSha256: result.researchInputsSha256,
            status: 'proven',
            summary: result.summary,
            candidate: result.candidate,
            observation: result.observation,
            observations: result.observations,
          });
        }
      });
      expect(assignments).toBe(2);
      expect(invocations).toHaveLength(8);
      expect(invocations[2]?.workflowPath).toContain('/producer-calls/source_fixture/');
      expect(invocations[6]?.workflowPath).toContain('/producer-calls/source_fixture/');
      expect(invocations[2]?.workflowPath).not.toBe(invocations[6]?.workflowPath);
    } finally {
      await family.close();
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
  it('inspects retained failed responses without another call and rejects unrelated references as proof', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-failed-evidence-'));
    const compilerDir = mkdtempSync(join(tmpdir(), 'imprint-failed-copy-'));
    const candidate = apiCandidate('failed', 'fetch');
    let turns = 0;
    let calls = 0;
    try {
      const outcome = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          runApiTool: async ({ onResponseEvidence }) => {
            calls++;
            onResponseEvidence?.({
              attemptId: `attempt-${calls}`,
              backend: 'fetch',
              requestIndex: 0,
              status: calls === 1 ? 400 : 200,
              receivedAt: new Date().toISOString(),
              bodyText: `retained-${calls}`,
            });
            // Persistence must already be complete before this invocation returns.
            expect(readFileSync(join(toolDir, 'live-results/responses.jsonl'), 'utf8')).toContain(
              `attempt-${calls}`,
            );
            return {
              executionMechanism: 'fetch',
              result:
                calls === 1
                  ? { ok: false, error: 'BAD_RESPONSE', message: 'Downstream fixture failure' }
                  : { ok: true, data: 'success' },
            };
          },
          requestStep: async (input) => {
            turns++;
            if (turns === 1) return { binding, action: 'test', candidate, reason: 'Run fixture.' };
            if (turns === 4) {
              expect(input.resultInspection).toMatchObject({
                text: '{"value":"retained-1"}',
                projection: { source: 'text => ({value: text})', outputCharacters: 22 },
              });
              expect(input.observations[0]?.result.ok).toBeFalse();
              expect(input.observations[0]?.resultInspections?.at(-1)?.projection?.source).toBe(
                'text => ({value: text})',
              );
              expect(calls).toBe(1);
              return { binding, action: 'test', candidate, reason: 'Run fixture.' };
            }
            const observation = input.observations[0];
            const evidenceRef = observation?.responseEvidence?.[0]?.evidenceRef;
            if (!observation || !evidenceRef) throw new Error('Missing retained fixture evidence');
            const query = {
              binding,
              action: 'inspect_result',
              resultQuery: { observationId: observation.id, evidenceRef },
              reason: 'Read failure evidence.',
            };
            if (turns === 2) {
              expect(observation.result.ok).toBeFalse();
              expect(observation.resultTextLength).toBeUndefined();
              for (const resultQuery of [
                { observationId: 'another-observation', evidenceRef },
                { observationId: observation.id, evidenceRef: 'unknown' },
                { observationId: observation.id, evidenceRef, offset: 100 },
              ])
                expect(() =>
                  parseApiResearchOutput(JSON.stringify({ ...query, resultQuery }), input),
                ).toThrow();
              expect(() =>
                parseApiResearchOutput(
                  JSON.stringify({
                    binding,
                    action: 'proven',
                    candidate,
                    basedOnObservationId: observation.id,
                    reason: 'Invalid success claim.',
                  }),
                  input,
                ),
              ).toThrow();
              return parseApiResearchOutput(JSON.stringify(query), input);
            }
            if (turns === 3) {
              expect(input.resultInspection).toMatchObject({ evidenceRef, text: 'retained-1' });
              expect(calls).toBe(1);
              return parseApiResearchOutput(
                JSON.stringify({
                  ...query,
                  resultQuery: { ...query.resultQuery, project: 'text => ({value: text})' },
                }),
                input,
              );
            }
            const second = input.observations[1];
            if (!second) throw new Error('Missing second observation');
            expect(() =>
              parseApiResearchOutput(
                JSON.stringify({
                  ...query,
                  resultQuery: { observationId: second.id, evidenceRef },
                }),
                input,
              ),
            ).toThrow();
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: second.id,
              reason: 'Second invocation succeeds.',
            };
          },
        },
      });
      expect(calls).toBe(2);
      expect(outcome.observation.result.ok).toBeTrue();
      const files = copyApiResearchEvidence(toolDir, compilerDir);
      if (!files?.historyFile) throw new Error('Missing fixture history');
      const history = JSON.parse(readFileSync(join(compilerDir, files.historyFile), 'utf8'));
      expect(history.observations).toHaveLength(2);
      const failed = history.observations.find(
        (entry: { observationId: string }) => entry.observationId !== outcome.observation.id,
      );
      expect(readFileSync(join(compilerDir, failed.responseEvidence[0].responseFile), 'utf8')).toBe(
        'retained-1',
      );
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
      rmSync(compilerDir, { recursive: true, force: true });
    }
  });
  it('keeps selected and contrasting chains distinct with protected login values', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-chain-'));
    const compilerDir = mkdtempSync(join(tmpdir(), 'imprint-compiler-chain-'));
    const first = apiCandidate('chain', 'fetch');
    first.workflow.requests.push({
      method: 'GET',
      url: 'https://fixture.invalid/detail',
      headers: {},
      recordingRequestSeq: 12,
    });
    const second = { ...first, parameterValues: { query: 'beta' } };
    const password = 'fixture-"password"-with-escapes';
    try {
      await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) =>
            input.observations.length < 2
              ? {
                  binding,
                  action: 'test',
                  candidate: input.observations.length ? second : first,
                  reason: 'Inspect two cases.',
                }
              : {
                  binding,
                  action: 'proven',
                  candidate: first,
                  basedOnObservationId: input.observations[0]?.id,
                  reason: 'Select the first case.',
                },
          runApiTool: async ({ parameters, onRawResponses }) => {
            const last = `<main>${parameters.query} ${password}</main>`;
            onRawResponses?.([{ items: [{ id: parameters.query, password }] }, last]);
            return {
              result: { ok: true, data: last },
              executionMechanism: 'fetch',
              credentialValues: { password },
            };
          },
        },
      });
      const files = copyApiResearchEvidence(toolDir, compilerDir);
      expect(files?.responsesFile).toBeDefined();
      if (!files?.responsesFile) throw new Error('Missing selected chain fixture');
      const responses = JSON.parse(readFileSync(join(compilerDir, files.responsesFile), 'utf8'));
      expect(responses).toEqual([
        { items: [{ id: 'alpha', password: '${credential.password}' }] },
        '<main>alpha ${credential.password}</main>',
      ]);
      expect(readFileSync(join(compilerDir, files.responseFile), 'utf8')).toBe(responses[1]);
      if (!files.historyFile) throw new Error('Missing contrast evidence index');
      const history = JSON.parse(readFileSync(join(compilerDir, files.historyFile), 'utf8'));
      expect(history.observations).toHaveLength(1);
      const contrast = history.observations[0];
      const metadata = JSON.parse(readFileSync(join(compilerDir, files.observationFile), 'utf8'));
      expect(contrast.observationId).toBe(metadata.observations[1].id);
      expect(JSON.parse(readFileSync(join(compilerDir, contrast.responsesFile), 'utf8'))).toEqual([
        { items: [{ id: 'beta', password: '${credential.password}' }] },
        '<main>beta ${credential.password}</main>',
      ]);
      expect(readFileSync(join(compilerDir, contrast.responseFile), 'utf8')).toBe(
        '<main>beta ${credential.password}</main>',
      );
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
      rmSync(compilerDir, { recursive: true, force: true });
    }
  });
  it('indexes only listed observations and preserves missing or failed evidence without substitution', () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-history-'));
    const compilerDir = mkdtempSync(join(tmpdir(), 'imprint-compiler-history-'));
    const stem = (id: string) => createHash('sha256').update(id).digest('hex');
    try {
      mkdirSync(join(toolDir, 'live-results'));
      writeFileSync(
        join(toolDir, 'api-research.json'),
        JSON.stringify({
          observation: { id: 'selected' },
          observations: [{ id: 'selected' }, { id: 'failed' }, { id: 'missing' }, { id: 'failed' }],
        }),
      );
      for (const [id, body] of [
        ['selected', 'selected-result'],
        ['failed', 'failure-body'],
        ['unlisted', 'unrelated'],
      ] as const) {
        writeFileSync(join(toolDir, 'live-results', `${stem(id)}.txt`), body);
      }
      const files = copyApiResearchEvidence(toolDir, compilerDir);
      if (!files?.historyFile) throw new Error('Missing history index');
      const { observations } = JSON.parse(
        readFileSync(join(compilerDir, files.historyFile), 'utf8'),
      );
      expect(observations).toHaveLength(2);
      expect(observations[0].observationId).toBe('failed');
      expect(readFileSync(join(compilerDir, observations[0].responseFile), 'utf8')).toBe(
        'failure-body',
      );
      expect(observations[0].responsesFile).toBeUndefined();
      expect(observations[1]).toEqual({ observationId: 'missing' });
      expect(existsSync(join(compilerDir, 'api-research-history', `${stem('unlisted')}.txt`))).toBe(
        false,
      );
      expect(readFileSync(join(compilerDir, files.responseFile), 'utf8')).toBe('selected-result');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
      rmSync(compilerDir, { recursive: true, force: true });
    }
  });
  it('retains actual contrast results and inputs under the same request definition', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-contrasts-'));
    const first = apiCandidate('working', 'fetch');
    const second = { ...first, parameterValues: { query: 'beta' } };
    try {
      const outcome = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) =>
            input.observations.length < 2
              ? {
                  binding,
                  action: 'test',
                  candidate: input.observations.length ? second : first,
                  reason: 'Compare results under changed inputs.',
                }
              : {
                  binding,
                  action: 'proven',
                  candidate: second,
                  basedOnObservationId: input.observations[1]?.id,
                  reason: 'Both inputs returned distinct actual records.',
                },
          runApiTool: async ({ parameters }) => ({
            result: { ok: true, data: { records: [{ id: parameters.query === 'alpha' ? 1 : 2 }] } },
            executionMechanism: 'fetch',
          }),
        },
      });
      expect(outcome.observations).toHaveLength(2);
      expect(outcome.observations?.map((entry) => entry.invocationParameters)).toEqual([
        { query: 'alpha' },
        { query: 'beta' },
      ]);
      expect(outcome.observations?.[0]?.requestDefinitionSha256).toBe(
        outcome.observations?.[1]?.requestDefinitionSha256,
      );
      expect(outcome.observations?.[0]?.candidateSha256).not.toBe(
        outcome.observations?.[1]?.candidateSha256,
      );
      expect(outcome.observations?.[0]?.result.preview).toContain('1');
      expect(outcome.observations?.[1]?.result.preview).toContain('2');
      expect(
        JSON.parse(readFileSync(join(toolDir, 'api-research.json'), 'utf8')).observations,
      ).toHaveLength(2);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
  it('calls a working producer with fresh agent-selected inputs before testing its consumer', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-fresh-producer-'));
    const producer = apiCandidate('producer', 'fetch');
    producer.workflow.toolName = 'lookup_fixture';
    const consumer = apiCandidate('consumer', 'fetch');
    consumer.parameterValues = { query: 'fresh-token' };
    let calls = 0;
    let turn = 0;
    try {
      const outcome = await researchApiMvpCall({
        run,
        recordingIndex,
        session,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        producers: () => [
          {
            toolName: 'lookup_fixture',
            candidate: producer,
            toolDir: join(toolDir, 'lookup'),
            summary: 'Returns a live continuation.',
          },
        ],
        dependencies: {
          requestStep: async (input) => {
            turn++;
            if (turn === 1) {
              expect(input.availableProducers?.[0]?.toolName).toBe('lookup_fixture');
              return parseApiResearchOutput(
                JSON.stringify({
                  binding,
                  action: 'call_producer',
                  producerCall: {
                    toolName: 'lookup_fixture',
                    parameters: { query: 'current-query' },
                  },
                  reason: 'Get a fresh continuation.',
                }),
                input,
              );
            }
            if (turn === 2) {
              expect(input.observations[0]?.producerToolName).toBe('lookup_fixture');
              expect(input.observations[0]?.result.preview).toContain('fresh-token');
              expect(() =>
                parseApiResearchOutput(
                  JSON.stringify({
                    binding,
                    action: 'proven',
                    candidate: consumer,
                    basedOnObservationId: input.observations[0]?.id,
                    reason: 'Producer alone is insufficient.',
                  }),
                  input,
                ),
              ).toThrow();
              return {
                binding,
                action: 'test',
                candidate: consumer,
                reason: 'Use the fresh continuation.',
              };
            }
            return parseApiResearchOutput(
              JSON.stringify({
                binding,
                action: 'proven',
                candidate: consumer,
                basedOnObservationId: input.observations.at(-1)?.id,
                reason: 'The consumer returned real records.',
              }),
              input,
            );
          },
          runApiTool: async ({ parameters, workflowPath }) => {
            calls++;
            expect(parameters.query).toBe(calls === 1 ? 'current-query' : 'fresh-token');
            expect(workflowPath.includes('lookup')).toBe(calls === 1);
            return {
              result: {
                ok: true,
                data: calls === 1 ? { token: 'fresh-token' } : { records: [{ id: 1 }] },
              },
              executionMechanism: 'fetch',
            };
          },
        },
      });
      expect(calls).toBe(2);
      expect(outcome.observation.producerToolName).toBeUndefined();
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
  it('keeps request testing separate and hands only the proven request to compilation', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-'));
    const first = apiCandidate('diagnostic');
    const second = apiCandidate('working', 'cdp-replay');
    let agentTurn = 0;
    let execution = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        session,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test baseline.' };
            if (agentTurn === 2) {
              expect(input.observations[0]?.result.preview).toContain('protocol error');
              expect(input.observations[0]?.requestComparisons?.[0]).toEqual(
                expect.objectContaining({
                  backend: 'fetch',
                  recordingRequestSeq: 12,
                  status: 'checked',
                }),
              );
              expect(input.observations[0]?.responseObservations[0]?.redactedBodyPreview).toBe(
                '{"bootstrap":{"continuation":"current-value"}}',
              );
              expect(retainedTurnDelta).toMatchObject({
                kind: 'observation',
                latestObservation: {
                  responseObservations: [
                    { redactedBodyPreview: '{"bootstrap":{"continuation":"current-value"}}' },
                  ],
                },
              });
              return { binding, action: 'test', candidate: second, reason: 'Test repair.' };
            }
            const observed = input.observations[1];
            if (!observed) throw new Error('missing successful observation');
            expect(observed.result.preview).toContain('${credential.password}');
            expect(observed.result.preview).toContain('ordinary-continuation');
            expect(observed.result.preview).not.toContain('typed-fixture-password');
            expect(observed).not.toHaveProperty('credentialValues');
            return {
              binding,
              action: 'proven',
              candidate: second,
              basedOnObservationId: observed.id,
              reason: 'The response contains fixture records.',
            };
          },
          runApiTool: async ({ backend, onPreparedRequest }) => {
            execution += 1;
            expect(backend).toBe(execution === 1 ? undefined : 'cdp-replay');
            onPreparedRequest?.({
              backend: backend && backend !== 'auto' ? backend : 'fetch',
              requestIndex: 0,
              method: 'GET',
              url: 'https://fixture.invalid/search?apikey=live-secret',
              headers: { 'x-live': 'live-header-secret' },
            });
            return {
              executionMechanism: backend ?? 'fetch',
              credentialValues: { password: 'typed-fixture-password' },
              responseObservations:
                execution === 1
                  ? [
                      {
                        backend: 'fetch' as const,
                        requestIndex: 0,
                        status: 200,
                        bodyByteLength: 46,
                        redactedBodyPreview: '{"bootstrap":{"continuation":"current-value"}}',
                        contentType: 'application/json',
                        valueType: 'object' as const,
                        topLevelKeys: ['bootstrap'],
                      },
                    ]
                  : [],
              result:
                execution === 1
                  ? { ok: true as const, data: 'protocol error: no records' }
                  : {
                      ok: true as const,
                      data: {
                        items: [{ id: 'item-1' }],
                        password: 'typed-fixture-password',
                        token: 'ordinary-continuation',
                      },
                    },
            };
          },
        },
      });

      expect(agentTurn).toBe(3);
      expect(execution).toBe(2);
      expect(result.observation.candidateSha256).toBe(apiResearchCandidateSha256(second));
      expect(result.observation.requestComparisons).toEqual([
        expect.objectContaining({
          backend: 'cdp-replay',
          requestIndex: 0,
          recordingRequestSeq: 12,
          status: 'checked',
          methodEqual: true,
          originPathEqual: true,
          recordedQueryKeyCount: 2,
          preparedQueryKeyCount: 1,
          recordedOnlyQueryKeys: ['APIKey', 'variant'],
          preparedOnlyQueryKeys: ['apikey'],
          recordedOnlyHeaderNames: ['x-recorded'],
          preparedOnlyHeaderNames: ['x-live'],
        }),
      ]);
      expect(JSON.stringify(result.observation.requestComparisons)).not.toContain('live-secret');
      expect(JSON.stringify(result.observation.requestComparisons)).not.toContain(
        'recorded-secret',
      );
      expect(JSON.stringify(result.observation.requestComparisons)).not.toContain('header-secret');
      expect(result.parameters).toEqual({ query: 'alpha' });
      expect(result.backend).toBe('cdp-replay');
      expect(JSON.parse(readFileSync(join(toolDir, 'workflow.json'), 'utf8'))).toEqual(
        second.workflow,
      );
      expect(existsSync(join(toolDir, 'parser.ts'))).toBe(false);
      expect(existsSync(join(toolDir, 'api-research.json'))).toBe(true);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('lets the retained researcher inspect another catalog request after a live test', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-inspect-'));
    const first = apiCandidate('needs-neighbor');
    const revised = apiCandidate('with-neighbor');
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/evidence-expanded.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    let turn = 0;
    let executions = 0;
    let inspected: readonly number[] = [];
    const retainedTurnDeltas: unknown[] = [];
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool,
        evidence,
        requestCatalog: [
          {
            recordingRequestSeq: 13,
            method: 'POST',
            urlShape: 'https://fixture.invalid/bootstrap',
            resourceType: 'fetch',
            responseStatus: 200,
            responseMimeType: 'application/json',
            requestBodyBytes: 24,
            responseBodyBytes: 48,
          },
        ],
        inspectRequests: (requestSeqs) => {
          inspected = requestSeqs;
          return { delta: expandedEvidence, accumulated: expandedEvidence };
        },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            turn += 1;
            if (turn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test the direct call.' };
            if (turn === 2) {
              expect(input.observations).toHaveLength(1);
              expect(input.requestCatalog?.[0]?.recordingRequestSeq).toBe(13);
              return {
                binding,
                action: 'inspect',
                requestedRequestSeqs: [13],
                reason: 'Inspect the neighboring bootstrap response before revising the call.',
              };
            }
            if (turn === 3) {
              expect(input.inspectedRequestSeqs).toEqual([13]);
              expect(input.evidence.ref.path).toBe(expandedEvidence.ref.path);
              return {
                binding,
                action: 'test',
                candidate: revised,
                reason: 'Test the request revised from the inspected bootstrap facts.',
              };
            }
            const observation = input.observations.at(-1);
            if (!observation) throw new Error('missing revised observation');
            return {
              binding,
              action: 'proven',
              candidate: revised,
              basedOnObservationId: observation.id,
              reason: 'The revised call returned the real records.',
            };
          },
          runApiTool: async () => {
            executions += 1;
            return {
              executionMechanism: 'fetch',
              result: {
                ok: true as const,
                data:
                  executions === 1 ? { bootstrap_required: true } : { items: [{ id: 'item-1' }] },
              },
            };
          },
        },
      });

      expect(inspected).toEqual([13]);
      expect(executions).toBe(2);
      expect(result.candidate).toEqual(revised);
      expect(
        retainedTurnDeltas.map((delta) =>
          delta === undefined ? undefined : (delta as { kind: string }).kind,
        ),
      ).toEqual([undefined, 'observation', 'inspection', 'observation']);
      expect(retainedTurnDeltas[1]).not.toHaveProperty('requestCatalog');
      expect(retainedTurnDeltas[1]).not.toHaveProperty('relevantEvidence');
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'inspection',
        inspectedRequestSeqs: [13],
        relevantEvidence: expandedEvidence,
      });
      const saved = JSON.parse(readFileSync(join(toolDir, 'api-research.json'), 'utf8'));
      expect(saved.inspectedRequestSeqs).toEqual([13]);
      inspected = [];
      const continued = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool,
        evidence,
        inspectRequests: (requestSeqs) => {
          inspected = requestSeqs;
          return { delta: expandedEvidence, accumulated: expandedEvidence };
        },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) => {
            expect(input.previousProgress).toBeUndefined();
            expect(input.inspectedRequestSeqs).toEqual([13]);
            expect(input.evidence).toEqual(expandedEvidence);
            return {
              binding,
              action: 'proven',
              candidate: revised,
              basedOnObservationId: result.observation.id,
              reason: 'Retained evidence still supports the unchanged request.',
            };
          },
          runApiTool: async () => {
            throw new Error('Restoring inspected evidence must not repeat a live request');
          },
        },
      });
      expect(inspected).toEqual([13]);
      expect(continued.observation.id).toBe(result.observation.id);
      expect(continued.observations).toHaveLength(2);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('sends each newly paged catalog and inspection exactly once', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-page-delta-'));
    const candidate = apiCandidate('paged-evidence');
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/paged-evidence.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    const firstCatalogEntry = {
      recordingRequestSeq: 12,
      method: 'GET',
      urlShape: 'https://fixture.invalid/search',
      resourceType: 'fetch',
      responseStatus: 200,
      responseMimeType: 'application/json',
      requestBodyBytes: 0,
      responseBodyBytes: 48,
    };
    const secondCatalogEntry = {
      ...firstCatalogEntry,
      recordingRequestSeq: 13,
      urlShape: 'https://fixture.invalid/bootstrap',
    };
    const retainedTurnDeltas: unknown[] = [];
    let turn = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool,
        evidence,
        requestCatalog: [firstCatalogEntry],
        requestCatalogPage: { offset: 0, totalEntries: 2, hasMore: true },
        loadNextRequestCatalogPage: (offset) => {
          expect(offset).toBe(1);
          return {
            entries: [secondCatalogEntry],
            page: { offset: 1, totalEntries: 2, hasMore: false },
          };
        },
        inspectRequests: (requestSeqs) => {
          expect(requestSeqs).toEqual([13]);
          return { delta: expandedEvidence, accumulated: expandedEvidence };
        },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (_input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            turn += 1;
            if (turn === 1)
              return { binding, action: 'catalog', reason: 'Read the next catalog page.' };
            if (turn === 2)
              return {
                binding,
                action: 'inspect',
                requestedRequestSeqs: [13],
                reason: 'Inspect the newly listed bootstrap request.',
              };
            if (turn === 3)
              return { binding, action: 'test', candidate, reason: 'Test the inspected request.' };
            const observation = _input.observations.at(-1);
            if (!observation) throw new Error('missing paged-evidence observation');
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: observation.id,
              reason: 'The inspected request returned fixture records.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
          }),
        },
      });

      expect(result.candidate).toEqual(candidate);
      expect(retainedTurnDeltas[0]).toBeUndefined();
      expect(retainedTurnDeltas[1]).toEqual({
        kind: 'catalog_page',
        requestCatalog: [secondCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 1, totalEntries: 2, hasMore: false },
      });
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'inspection',
        inspectedRequestSeqs: [13],
        relevantEvidence: expandedEvidence,
      });
      expect(retainedTurnDeltas[3]).toMatchObject({ kind: 'observation' });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('returns malformed research handoffs to the master with the actual test history', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-handoff-error-'));
    let calls = 0;
    let blocked: ApiResearchBlockedError | undefined;
    try {
      try {
        await researchApiMvpCall({
          run,
          recordingIndex,
          tool,
          evidence,
          toolDir,
          agent: {},
          runDeadline: new RunDeadline(Date.now() + 60_000),
          dependencies: {
            requestStep: async () => {
              if (calls++ === 0)
                return {
                  binding,
                  action: 'test',
                  candidate: apiCandidate('baseline'),
                  reason: 'Test.',
                };
              throw new SemanticAgentOutputError(
                'API researcher',
                ['candidate: partial candidate differs from the tested request'],
                2,
              );
            },
            runApiTool: async () => ({
              result: { ok: true, data: { items: [{ name: 'fixture item' }] } },
              executionMechanism: 'fetch',
            }),
          },
        });
      } catch (error) {
        if (!(error instanceof ApiResearchBlockedError)) throw error;
        blocked = error;
      }
      expect(blocked?.message).toContain('not an API failure');
      expect(blocked?.message).toContain('partial candidate differs');
      expect(blocked?.observations).toHaveLength(1);
      expect(blocked?.observations[0]?.result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('returns an exact repeated evidence inspection to master review', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-repeat-inspect-'));
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/repeated-inspection.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    let inspectCalls = 0;
    let blocked: ApiResearchBlockedError | undefined;
    try {
      try {
        await researchApiMvpCall({
          run,
          recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
          tool,
          evidence,
          requestCatalog: [
            {
              recordingRequestSeq: 13,
              method: 'POST',
              urlShape: 'https://fixture.invalid/bootstrap',
              resourceType: 'fetch',
              responseStatus: 200,
              responseMimeType: 'application/json',
              requestBodyBytes: 24,
              responseBodyBytes: 48,
            },
          ],
          inspectRequests: () => {
            inspectCalls += 1;
            return { delta: expandedEvidence, accumulated: expandedEvidence };
          },
          toolDir,
          agent: {},
          runDeadline: new RunDeadline(Date.now() + 60_000),
          dependencies: {
            requestStep: async () => ({
              binding,
              action: 'inspect',
              requestedRequestSeqs: [13],
              reason: 'Inspect the bootstrap request.',
            }),
            runApiTool: async () => {
              throw new Error('a repeated inspection must not execute a request');
            },
          },
        });
      } catch (error) {
        if (!(error instanceof ApiResearchBlockedError)) throw error;
        blocked = error;
      }
      expect(inspectCalls).toBe(1);
      expect(blocked?.message).toContain('already inspected');
      expect(blocked?.observations).toEqual([]);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('returns bounded visible facts from a large rendered HTML response', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-html-'));
    const candidate = apiCandidate('rendered', 'cdp-replay');
    const request = candidate.workflow.requests[0];
    if (!request) throw new Error('missing rendered request fixture');
    candidate.workflow.requests[0] = {
      ...request,
      mode: 'navigate',
      navigation: { resultSelector: 'body' },
    };
    let agentTurn = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) => {
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate, reason: 'Test rendered result.' };
            const observation = input.observations[0];
            if (!observation) throw new Error('missing rendered observation');
            expect(Buffer.byteLength(observation.result.preview, 'utf8')).toBeLessThanOrEqual(
              12_000,
            );
            expect(observation.result.preview).toContain('[rendered HTML text]');
            expect(observation.result.preview).toContain('18 results Alaska Airlines $117');
            expect(observation.result.preview).not.toContain('opaque-script-noise');
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: observation.id,
              reason: 'The rendered page contains real result facts.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'cdp-replay',
            result: {
              ok: true as const,
              data: `<!doctype html><html><head><script>${'opaque-script-noise '.repeat(20_000)}</script></head><body><h1>18 results</h1><div>Alaska Airlines $117</div>${'é'.repeat(20_000)}</body></html>`,
            },
          }),
        },
      });

      expect(agentTurn).toBe(2);
      expect(result.backend).toBe('cdp-replay');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('inspects retained live text beyond the preview without another API call, including a follow-up', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-text-'));
    const candidate = apiCandidate('text');
    const html = `<!doctype html><html><script>${'padding'.repeat(4_000)}</script><a href="/search?state=fixture-state">Results</a><input value="fixture-password"><script>fixture-hidden-state</script>${'é'.repeat(3_000)}</html>`;
    let calls = 0;
    let turns = 0;
    try {
      const first = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          runApiTool: async () => {
            calls += 1;
            return {
              executionMechanism: 'fetch',
              result: { ok: true, data: html },
              credentialValues: { password: 'fixture-password' },
            };
          },
          requestStep: async (input, _agent, delta) => {
            turns += 1;
            if (turns === 1)
              return { binding, action: 'test', candidate, reason: 'Get the fixture response.' };
            const observation = input.observations[0];
            if (!observation) throw new Error('missing observation');
            const query = {
              binding,
              action: 'inspect_result',
              resultQuery: { observationId: observation.id, search: 'href=' },
              reason: 'Inspect an attribute beyond the preview.',
            };
            if (turns === 2) {
              expect(observation.result.preview).not.toContain('fixture-state');
              for (const resultQuery of [
                { observationId: 'unknown' },
                { observationId: observation.id, offset: (observation.resultTextLength ?? 0) + 1 },
                { observationId: observation.id, length: 2_001 },
              ])
                expect(() =>
                  parseApiResearchOutput(JSON.stringify({ ...query, resultQuery }), input),
                ).toThrow();
              return parseApiResearchOutput(JSON.stringify(query), input);
            }
            expect(delta?.kind).toBe('result_inspection');
            if (turns === 3) {
              expect(input.resultInspection?.offset).toBeGreaterThan(12_000);
              expect(input.resultInspection?.text).toContain('state=fixture-state');
              expect(observation.resultInspections?.[0]?.text).toContain('state=fixture-state');
              expect(input.resultInspection?.text).toContain('fixture-hidden-state');
              expect(input.resultInspection?.text).toContain('${credential.password}');
              expect(input.resultInspection?.text).not.toContain('fixture-password');
              expect(Buffer.byteLength(input.resultInspection?.text ?? '')).toBeLessThanOrEqual(
                8_000,
              );
              return parseApiResearchOutput(
                JSON.stringify({
                  ...query,
                  resultQuery: { observationId: observation.id, search: 'absent-marker' },
                }),
                input,
              );
            }
            expect(input.resultInspection).toMatchObject({
              matchFound: false,
              text: '',
              nextOffset: null,
            });
            return {
              binding,
              action: 'partial',
              candidate,
              basedOnObservationId: observation.id,
              missingProof: ['Fixture meaning still needs review.'],
              reason: 'Retain the response for follow-up.',
            };
          },
        },
      });
      let followUpTurns = 0;
      await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        previousProgress: {
          toolName: tool.candidate.toolName,
          researchInputsSha256: first.researchInputsSha256,
          status: 'partial',
          summary: first.summary,
          candidate,
          observation: first.observation,
          missingProof: ['Fixture meaning still needs review.'],
        },
        followUp: {
          masterDirection: 'Inspect the saved response.',
          missingProof: ['Read retained text.'],
          relevantRequestSeqs: [],
          siblingResearch: [],
        },
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          runApiTool: async () => {
            throw new Error('Inspection must not make another API call');
          },
          requestStep: async (input) => {
            followUpTurns += 1;
            if (followUpTurns === 1)
              return parseApiResearchOutput(
                JSON.stringify({
                  binding,
                  action: 'inspect_result',
                  resultQuery: { observationId: first.observation.id, offset: 0, length: 15 },
                  reason: 'Read the opening text.',
                }),
                input,
              );
            expect(input.resultInspection?.text).toBe('<!doctype html>');
            expect(input.resultInspection?.nextOffset).toBe(15);
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: first.observation.id,
              reason: 'The fixture evidence is now inspected.',
            };
          },
        },
      });
      expect(calls).toBe(1);
      expect(turns).toBe(4);
      expect(followUpTurns).toBe(2);
      const compilerDir = mkdtempSync(join(tmpdir(), 'imprint-research-handoff-'));
      try {
        const files = copyApiResearchEvidence(toolDir, compilerDir);
        expect(files).toBeDefined();
        if (!files) throw new Error('Selected research evidence was not copied');
        const copied = readFileSync(join(compilerDir, files.responseFile), 'utf8');
        expect(copied.startsWith('<!doctype html>')).toBe(true);
        expect(copied.length).toBeGreaterThan(12_000);
        expect(copied).toContain('fixture-hidden-state');
        expect(copied).not.toContain('fixture-password');
        const selected = JSON.parse(readFileSync(join(compilerDir, files.observationFile), 'utf8'));
        expect(selected.observation.id).toBe(first.observation.id);
        expect(selected.decision.candidate.parameterValues).toEqual(candidate.parameterValues);
        expect(selected.decision.action).toBe('proven');
      } finally {
        rmSync(compilerDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('queries a whole retained response and repairs projection errors without another live call', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-projection-'));
    const candidate = apiCandidate('projection');
    const body = JSON.stringify({
      rows: Array.from({ length: 1000 }, (_, id) => ({ id, padding: 'x'.repeat(100) })),
    });
    let calls = 0;
    let turns = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          runApiTool: async () => {
            calls++;
            return { executionMechanism: 'fetch', result: { ok: true, data: body } };
          },
          requestStep: async (input) => {
            turns++;
            if (turns === 1)
              return { binding, action: 'test', candidate, reason: 'Fetch synthetic rows.' };
            const observation = input.observations[0];
            if (!observation) throw new Error('Missing observation');
            const query = (project: string) =>
              parseApiResearchOutput(
                JSON.stringify({
                  binding,
                  action: 'inspect_result',
                  resultQuery: { observationId: observation.id, project },
                  reason: 'Query saved data.',
                }),
                input,
              );
            if (turns === 2) {
              for (const extra of [{ search: 'rows' }, { offset: 1 }])
                expect(() =>
                  parseApiResearchOutput(
                    JSON.stringify({
                      binding,
                      action: 'inspect_result',
                      resultQuery: {
                        observationId: observation.id,
                        project: 'text => text',
                        ...extra,
                      },
                      reason: 'Ambiguous query.',
                    }),
                    input,
                  ),
                ).toThrow();
              return query('() => process.env');
            }
            if (turns === 3) {
              expect(input.resultInspection?.projection?.error).toContain('process');
              expect(input.resultInspection?.text).toBe('');
              expect(input.resultInspection?.nextOffset).toBeNull();
              return query(
                'text => { const rows = JSON.parse(text).rows; return {count: rows.length, last: rows.at(-1).id}; }',
              );
            }
            if (turns === 4) {
              expect(JSON.parse(input.resultInspection?.text ?? '')).toEqual({
                count: 1000,
                last: 999,
              });
              expect(input.resultInspection?.totalCharacters).toBe(body.length);
              expect(input.resultInspection?.projection?.outputCharacters).toBe(25);
              return query('text => text');
            }
            expect(input.resultInspection?.text.length).toBe(2000);
            expect(input.resultInspection?.projection?.outputCharacters).toBeGreaterThan(2000);
            expect(input.resultInspection?.nextOffset).toBeNull();
            expect(observation.resultInspections?.at(-1)?.projection?.source).toBe('text => text');
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: observation.id,
              reason: 'Synthetic data inspected; actual test binding unchanged.',
            };
          },
        },
      });
      expect(result.observation.result.ok).toBeTrue();
      expect(calls).toBe(1);
      expect(turns).toBe(5);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('rejects a proven handoff that differs from the cited tested bytes', () => {
    const tested = apiCandidate('tested');
    const changed = apiCandidate('changed');
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'proven',
          candidate: changed,
          basedOnObservationId: 'observation-1',
          reason: 'Claimed proven.',
        }),
        {
          run,
          recordingIndex,
          tool,
          evidence,
          observations: [
            {
              id: 'observation-1',
              candidateSha256: apiResearchCandidateSha256(tested),
              executionMechanism: 'fetch',
              backendAttempts: [],
              responseObservations: [],
              result: { ok: true, preview: '{"items":[{"id":"item-1"}]}' },
            },
          ],
        },
      ),
    ).toThrow('proven candidate differs from the tested request');
  });

  it('admits bounded inspection from any shown catalog page but rejects unknown requests', () => {
    const input = {
      run,
      recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
      tool,
      evidence,
      observations: [],
      requestCatalog: [
        {
          recordingRequestSeq: 13,
          method: 'GET',
          urlShape: 'https://fixture.invalid/neighbor',
          resourceType: 'fetch',
          responseStatus: 200,
          responseMimeType: 'application/json',
          requestBodyBytes: 0,
          responseBodyBytes: 48,
        },
      ],
      requestCatalogPage: { offset: 256, totalEntries: 300, hasMore: true },
    };
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'inspect',
          requestedRequestSeqs: [12],
          reason: 'Inspect a relevant request remembered from an earlier catalog page.',
        }),
        input,
      ).requestedRequestSeqs,
    ).toEqual([12]);
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'catalog',
          reason: 'Read the next compact catalog page.',
        }),
        input,
      ).action,
    ).toBe('catalog');
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'inspect',
          requestedRequestSeqs: [999],
          reason: 'Request evidence absent from this recording.',
        }),
        input,
      ),
    ).toThrow('request is absent from the recording');
  });

  it('retains same-run history when a boundary refresh has no previous handoff', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-boundary-history-'));
    const first = apiCandidate('before-revision');
    const revised = apiCandidate('after-revision');
    const common = {
      run,
      recordingIndex,
      tool,
      evidence,
      toolDir,
      agent: {},
      runDeadline: new RunDeadline(Date.now() + 60_000),
    };
    try {
      const original = await researchApiMvpCall({
        ...common,
        dependencies: {
          requestStep: async (input) =>
            input.observations.length === 0
              ? { binding, action: 'test', candidate: first, reason: 'Test original request.' }
              : {
                  binding,
                  action: 'proven',
                  candidate: first,
                  basedOnObservationId: input.observations[0]?.id,
                  reason: 'Original request returned records.',
                },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true, data: { items: [{ id: 'original' }] } },
          }),
        },
      });
      const historyPath = join(toolDir, 'api-research.json');
      const saved = JSON.parse(readFileSync(historyPath, 'utf8'));
      saved.observations = Array.from({ length: 65 }, (_, index) => ({
        ...original.observation,
        id: `saved-${index}`,
      }));
      writeFileSync(historyPath, JSON.stringify(saved));
      const revisedTool = {
        ...tool,
        candidate: { ...tool.candidate, description: 'Revised public contract' },
      };
      const revisedBinding = {
        ...binding,
        compileInputsSha256: apiResearchInputsSha256(revisedTool),
      };
      let tested = false;
      const result = await researchApiMvpCall({
        ...common,
        tool: revisedTool,
        dependencies: {
          requestStep: async (input) => {
            expect(input.previousProgress).toBeUndefined();
            expect(input.observations[0]?.id).toBe('saved-0');
            if (!tested) {
              expect(input.observations).toHaveLength(65);
              expect(() =>
                parseApiResearchOutput(
                  JSON.stringify({
                    binding: revisedBinding,
                    action: 'proven',
                    candidate: revised,
                    basedOnObservationId: 'saved-0',
                    reason: 'Incorrect old proof.',
                  }),
                  input,
                ),
              ).toThrow();
              tested = true;
              return {
                binding: revisedBinding,
                action: 'test',
                candidate: revised,
                reason: 'Test revised request.',
              };
            }
            return {
              binding: revisedBinding,
              action: 'proven',
              candidate: revised,
              basedOnObservationId: input.observations.at(-1)?.id,
              reason: 'Revised request has its own successful observation.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true, data: { items: [{ id: 'revised' }] } },
          }),
        },
      });
      // The handoff stays bounded; the private history retains every attempt.
      expect(result.observations).toHaveLength(64);
      expect(result.observation.candidateSha256).toBe(apiResearchCandidateSha256(revised));
      expect(JSON.parse(readFileSync(historyPath, 'utf8')).observations).toHaveLength(66);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('keeps a working partial candidate and resumes it with a master follow-up', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-partial-'));
    const mvp = apiCandidate('mvp');
    const completed = apiCandidate('completed');
    try {
      const partial = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) =>
            input.observations.length === 0
              ? { binding, action: 'test', candidate: mvp, reason: 'Test the first MVP.' }
              : {
                  binding,
                  action: 'partial',
                  candidate: mvp,
                  basedOnObservationId: input.observations[0]?.id,
                  missingProof: ['Prove the public query controls the returned records.'],
                  reason: 'Core records work; alternate-query control is not proven yet.',
                },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
          }),
        },
      });
      expect('status' in partial && partial.status).toBe('partial');
      if (!('status' in partial) || partial.status !== 'partial')
        throw new Error('fixture expected partial research');
      const firstObservationId = partial.observation.id;

      const previousProgress = {
        toolName: tool.candidate.toolName,
        researchInputsSha256: partial.researchInputsSha256,
        status: 'partial' as const,
        summary: partial.summary,
        candidate: partial.candidate,
        observation: { ...partial.observation, id: firstObservationId },
        missingProof: partial.missingProof,
      };
      const revisedTool = {
        ...tool,
        candidate: { ...tool.candidate, dependencySeqs: [13] },
      };
      const revisedCatalogEntry = {
        recordingRequestSeq: 13,
        method: 'GET',
        urlShape: 'https://fixture.invalid/bootstrap',
        resourceType: 'fetch',
        responseStatus: 200,
        responseMimeType: 'application/json',
        requestBodyBytes: 0,
        responseBodyBytes: 48,
      };
      let testedFollowUp = false;
      const followUpDeltas: unknown[] = [];
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool: revisedTool,
        evidence,
        followUp: {
          masterDirection: 'Test a different query and verify the returned record changes.',
          missingProof: partial.missingProof,
          relevantRequestSeqs: [12],
          siblingResearch: [],
        },
        previousProgress,
        requestCatalog: [revisedCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 0, totalEntries: 1, hasMore: false },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            followUpDeltas.push(retainedTurnDelta);
            expect(input.researchPhase).toBe('follow_up');
            expect(input.followUp?.masterDirection).toContain('different query');
            expect(input.observations[0]?.id).toBe(firstObservationId);
            expect(input.previousProgress?.candidate).toEqual(mvp);
            expect(input.previousProgress?.observation?.id).toBe(firstObservationId);
            if (!testedFollowUp) {
              testedFollowUp = true;
              return {
                binding,
                action: 'test',
                candidate: completed,
                reason: 'Test the master-requested alternate query.',
              };
            }
            const observation = input.observations.at(-1);
            if (!observation) throw new Error('missing follow-up observation');
            return {
              binding,
              action: 'proven',
              candidate: completed,
              basedOnObservationId: observation.id,
              reason: 'The alternate query returned the corresponding records.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-2' }] } },
          }),
        },
      });
      expect('status' in result).toBeFalse();
      expect(result.candidate).toEqual(completed);
      expect(followUpDeltas[0]).toMatchObject({
        kind: 'master_follow_up',
        followUp: {
          masterDirection: 'Test a different query and verify the returned record changes.',
        },
        currentTool: { candidate: { dependencySeqs: [13] } },
        requestCatalog: [revisedCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 0, totalEntries: 1, hasMore: false },
      });
      expect(followUpDeltas[0]).not.toHaveProperty('previousProgress');
      expect(followUpDeltas[1]).toMatchObject({ kind: 'observation' });
      expect(followUpDeltas[1]).not.toHaveProperty('requestCatalog');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('rejects partial research backed only by a failed transport observation', () => {
    const tested = apiCandidate('failed-partial');
    const failedObservation = {
      id: 'failed-observation',
      candidateSha256: apiResearchCandidateSha256(tested),
      executionMechanism: 'fetch',
      backendAttempts: [],
      responseObservations: [],
      result: { ok: false, error: 'REQUEST_FAILED', message: 'HTTP 500', preview: '' },
    };
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'partial',
          candidate: tested,
          basedOnObservationId: 'failed-observation',
          missingProof: ['The operation has not returned core records.'],
          reason: 'This request failed but is the best attempt so far.',
        }),
        {
          run,
          recordingIndex,
          tool,
          evidence,
          observations: [failedObservation],
        },
      ),
    ).toThrow('failed transport observation cannot support partial research');
    expect(() =>
      ApiResearchHandoffSchema.parse({
        toolName: tool.candidate.toolName,
        researchInputsSha256: compileInputsSha256,
        status: 'partial',
        summary: 'The failed call is the best current attempt.',
        candidate: tested,
        observation: failedObservation,
        missingProof: ['Core records are still missing.'],
      }),
    ).toThrow('partial API research must preserve a working candidate');
  });

  it('does not impose an arbitrary research-attempt limit before the run deadline', () => {
    const tested = apiCandidate('many-observations');
    const observations = Array.from({ length: 65 }, (_, index) => ({
      id: `observation-${index}`,
      candidateSha256: apiResearchCandidateSha256(tested),
      executionMechanism: 'fetch',
      backendAttempts: [],
      responseObservations: [],
      result: { ok: false, error: 'REQUEST_FAILED', message: `Attempt ${index}`, preview: '' },
    }));
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'blocked',
          reason: 'Every evidence-backed construction is exhausted at the shared deadline.',
        }),
        { run, recordingIndex, tool, evidence, observations },
      ).action,
    ).toBe('blocked');
  });

  it('returns a proposed blocker to the same researcher for self-review', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-block-review-'));
    const first = apiCandidate('failed');
    const second = apiCandidate('overlooked');
    let agentTurn = 0;
    let execution = 0;
    const retainedTurnDeltas: unknown[] = [];
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test baseline.' };
            if (agentTurn === 2)
              return { binding, action: 'blocked', reason: 'No request can work.' };
            if (agentTurn === 3) {
              expect(input.blockReview?.proposedReason).toBe('No request can work.');
              return {
                binding,
                action: 'test',
                candidate: second,
                reason: 'Self-review found an untested coherent candidate.',
              };
            }
            const observed = input.observations[1];
            if (!observed) throw new Error('missing self-review observation');
            return {
              binding,
              action: 'proven',
              candidate: second,
              basedOnObservationId: observed.id,
              reason: 'The overlooked candidate returned fixture records.',
            };
          },
          runApiTool: async () => {
            execution += 1;
            return {
              executionMechanism: 'fetch',
              result:
                execution === 1
                  ? { ok: true as const, data: 'protocol error: no records' }
                  : { ok: true as const, data: { items: [{ id: 'item-1' }] } },
            };
          },
        },
      });

      expect(agentTurn).toBe(4);
      expect(execution).toBe(2);
      expect(result.observation.candidateSha256).toBe(apiResearchCandidateSha256(second));
      expect(
        retainedTurnDeltas.map((delta) =>
          delta === undefined ? undefined : (delta as { kind: string }).kind,
        ),
      ).toEqual([undefined, 'observation', 'block_review', 'observation']);
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'block_review',
        blockReview: { proposedReason: 'No request can work.' },
      });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('preserves bounded structured failed attempts when research is factually blocked', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-blocked-facts-'));
    const failed = apiCandidate('failed-with-facts');
    let turn = 0;
    let blocked: ApiResearchBlockedError | undefined;
    try {
      try {
        await researchApiMvpCall({
          run,
          recordingIndex,
          tool,
          evidence,
          toolDir,
          agent: {},
          runDeadline: new RunDeadline(Date.now() + 60_000),
          dependencies: {
            requestStep: async (input) => {
              turn += 1;
              if (turn === 1) {
                return {
                  binding,
                  action: 'test',
                  candidate: failed,
                  reason: 'Test the recorded request before concluding anything.',
                };
              }
              if (turn === 2) {
                expect(input.observations[0]?.result.message).toBe('HTTP 403');
                expect(input.observations[0]?.result.pageDiagnostic?.bodyText).toBe(
                  'Results for ${credential.password}',
                );
                return {
                  binding,
                  action: 'blocked',
                  reason: 'The recorded request is rejected and no distinct evidence remains.',
                };
              }
              expect(input.blockReview?.proposedReason).toContain('rejected');
              return {
                binding,
                action: 'blocked',
                reason: 'Self-review found no other evidence-backed request construction.',
              };
            },
            runApiTool: async () => ({
              executionMechanism: 'fetch',
              credentialValues: { password: 'fixture-password' },
              backendAttempts: [
                {
                  backend: 'fetch',
                  outcome: 'failed',
                  detail: 'HTTP 403',
                  durationMs: 7,
                },
              ],
              result: {
                ok: false as const,
                error: 'FORBIDDEN',
                message: 'HTTP 403',
                pageDiagnostic: {
                  url: 'https://fixture.invalid/results',
                  title: 'Results',
                  bodyText: 'Results for fixture-password',
                  truncated: false,
                },
              },
            }),
          },
        });
      } catch (error) {
        if (!(error instanceof ApiResearchBlockedError)) throw error;
        blocked = error;
      }

      expect(blocked).toBeDefined();
      expect(blocked?.observations).toHaveLength(1);
      expect(blocked?.observations[0]?.result).toEqual({
        ok: false,
        error: 'FORBIDDEN',
        message: 'HTTP 403',
        preview: '',
        pageDiagnostic: {
          url: 'https://fixture.invalid/results',
          title: 'Results',
          bodyText: 'Results for ${credential.password}',
          truncated: false,
        },
      });
      const handoff = ApiResearchHandoffSchema.parse({
        toolName: tool.candidate.toolName,
        researchInputsSha256: compileInputsSha256,
        status: 'blocked',
        summary: blocked?.message,
        observations: blocked?.observations,
      });
      expect(handoff.observations?.[0]?.backendAttempts[0]?.detail).toBe('HTTP 403');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
});

it('batches recorded cases without extra agent turns and closes the owned browser after research', async () => {
  const toolDir = mkdtempSync(join(tmpdir(), 'imprint-research-batch-'));
  const candidate = apiCandidate('batch');
  let turns = 0;
  let closed = 0;
  const pools: unknown[] = [];
  const outcome = await researchApiMvpCall({
    run,
    recordingIndex,
    tool,
    evidence,
    toolDir,
    agent: {},
    runDeadline: new RunDeadline(Date.now() + 60_000),
    dependencies: {
      requestStep: async (input, _agent, delta) => {
        turns++;
        if (turns === 1)
          return {
            binding,
            action: 'test',
            candidate,
            testCases: [
              {
                parameterValues: { query: 'first' },
                recordingRequestSeqs: [12],
                freshnessChanges: 'none',
              },
              {
                parameterValues: { query: 'second' },
                recordingRequestSeqs: [12],
                freshnessChanges: 'none',
              },
            ],
            reason: 'Two fixture cases',
          };
        expect(input.observations).toHaveLength(2);
        expect(input.observations[0]?.result.ok).toBe(false);
        expect(delta?.kind === 'observation' && delta.batchObservations?.length).toBe(2);
        return {
          binding,
          action: 'proven',
          candidate: { ...candidate, parameterValues: { query: 'second' } },
          basedOnObservationId: input.observations[1]?.id,
          reason: 'Selected the successful call; earlier failure retained',
        };
      },
      runApiTool: async ({ cdpPool, parameters, onRawResponses }) => {
        pools.push(cdpPool);
        if (!cdpPool?.size)
          cdpPool?.set('fixture', {
            close: async () => {
              closed++;
            },
          } as never);
        onRawResponses?.([{ query: parameters.query }]);
        return {
          executionMechanism: 'cdp-replay',
          result:
            parameters.query === 'first'
              ? { ok: false, error: 'BAD_RESPONSE', message: 'fixture failure' }
              : { ok: true, data: { query: parameters.query } },
        };
      },
    },
  });
  expect(turns).toBe(2);
  expect(pools[0]).toBe(pools[1]);
  expect(closed).toBe(1);
  expect(outcome.observations).toHaveLength(2);
});

it.each([
  ['unsupported', 'plain fixture request'],
  ['decode limit', JSON.stringify({ payload: 'x'.repeat(512 * 1024) })],
  ['nested decode limit', JSON.stringify({ payload: JSON.stringify(Array(2_000).fill(1)) })],
])('omits structural comparisons when body decoding hits %s', async (_label, body) => {
  const toolDir = mkdtempSync(join(tmpdir(), 'imprint-body-diagnostic-'));
  const candidate = apiCandidate('bounded-diagnostic');
  let turn = 0;
  try {
    const result = await researchApiMvpCall({
      run,
      recordingIndex,
      session: { ...session, requests: session.requests.map((request) => ({ ...request, body })) },
      tool,
      evidence,
      toolDir,
      agent: {},
      runDeadline: new RunDeadline(Date.now() + 60_000),
      dependencies: {
        requestStep: async (input) =>
          ++turn === 1
            ? { binding, action: 'test', candidate, reason: 'Test bounded diagnostics.' }
            : {
                binding,
                action: 'proven',
                candidate,
                basedOnObservationId: input.observations[0]?.id,
                reason: 'Synthetic response contains a record.',
              },
        runApiTool: async ({ onPreparedRequest }) => {
          onPreparedRequest?.({
            backend: 'fetch',
            requestIndex: 0,
            method: 'POST',
            url: 'https://fixture.invalid/search',
            headers: {},
            body,
          });
          return {
            result: { ok: true, data: { records: [{ id: 'fixture-row' }] } },
            executionMechanism: 'fetch',
          };
        },
      },
    });
    const comparison = result.observation.requestComparisons?.[0];
    expect(comparison).toMatchObject({
      status: 'checked',
      preparedBodyBytes: Buffer.byteLength(body),
    });
    expect(comparison).not.toHaveProperty('bodyStructureComparison');
  } finally {
    rmSync(toolDir, { recursive: true, force: true });
  }
});

it('exposes nested prepared-body differences after an earlier intentional scalar change', async () => {
  const toolDir = mkdtempSync(join(tmpdir(), 'imprint-body-diagnostic-'));
  const wire = (token: string | null, origin: unknown): string =>
    `payload=${encodeURIComponent(JSON.stringify([token, JSON.stringify({ legs: [{ origin }] })]))}`;
  const recordedBody = wire('recorded-state-fixture', [[['AAA', 0]]]);
  const preparedBody = wire(null, [[[[['AAA', 0]]]]]);
  const requestSession = {
    ...session,
    requests: session.requests.map((request) => ({
      ...request,
      method: 'POST',
      body: recordedBody,
    })),
  };
  const candidate = apiCandidate('structural-diagnostic');
  let turn = 0;
  try {
    const result = await researchApiMvpCall({
      run,
      recordingIndex,
      session: requestSession,
      tool,
      evidence,
      toolDir,
      agent: {},
      runDeadline: new RunDeadline(Date.now() + 60_000),
      dependencies: {
        requestStep: async (input) => {
          if (++turn === 1)
            return {
              binding,
              action: 'test',
              candidate,
              reason: 'Inspect fixture request construction.',
            };
          const comparison = input.observations[0]?.requestComparisons?.[0];
          expect(comparison?.bodyStructureComparison).toMatchObject({
            differences: expect.arrayContaining([
              expect.objectContaining({
                kind: 'type',
                path: '/payload/0',
                leftType: 'string',
                rightType: 'null',
              }),
              expect.objectContaining({
                kind: 'type',
                path: '/payload/1/legs/0/origin/0/0/0',
                leftType: 'string',
                rightType: 'array',
              }),
            ]),
          });
          expect(JSON.stringify(comparison)).not.toContain('recorded-state-fixture');
          expect(JSON.stringify(comparison)).not.toContain('AAA');
          return {
            binding,
            action: 'proven',
            candidate,
            basedOnObservationId: input.observations[0]?.id,
            reason: 'Synthetic response contains a record.',
          };
        },
        runApiTool: async ({ onPreparedRequest }) => {
          onPreparedRequest?.({
            backend: 'fetch',
            requestIndex: 0,
            method: 'POST',
            url: 'https://fixture.invalid/search',
            headers: {},
            body: preparedBody,
          });
          return {
            result: { ok: true, data: { records: [{ id: 'fixture-row' }] } },
            executionMechanism: 'fetch',
          };
        },
      },
    });
    expect(result.observation.requestComparisons?.[0]?.bodyStructureComparison).toBeDefined();
  } finally {
    rmSync(toolDir, { recursive: true, force: true });
  }
});
