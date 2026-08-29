import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompletionReviewOutputSchema,
  type FocusedPlannerInput,
  FocusedPlannerOutputSchema,
  type MasterDecisionInput,
  MasterDecisionOutputSchema,
  type ParameterSelectionAdvisorInput,
  type ToolSelectionAdvisorInput,
  ToolSelectionAdvisorOutputSchema,
} from '../src/imprint/master-teach-agent-contracts.ts';
import { runFreshMasterTeach } from '../src/imprint/master-teach-controller.ts';
import {
  type DesiredTeachingPlan,
  ImplementationPlanPayloadSchema,
} from '../src/imprint/master-teach-plan.ts';
import { FreshTeachJournalStateSchema } from '../src/imprint/master-teach-store.ts';
import { validateToolCandidateDetection } from '../src/imprint/tool-candidates.ts';
import { SessionSchema, WorkflowSchema } from '../src/imprint/types.ts';

const SITE = 'foreground-e2e-fixture';
const PRODUCER_ID = 'search_items_tool';
const CONSUMER_ID = 'get_item_tool';
const PRODUCER_NAME = 'search_items';
const CONSUMER_NAME = 'get_item';
const EDGE_ID = 'search-item-id';
const FIXED_NOW = new Date('2026-08-29T12:00:00.000Z');

const sharedContext = {
  loginRequestSeqs: [],
  credentialNames: [],
  tokenExtractionNotes: '',
  sharedHelperNotes: '',
  authRequestSeqs: [],
  authNotes: '',
};

const producerCandidate = {
  toolName: PRODUCER_NAME,
  description: 'Search the fixture item catalog.',
  rationale: 'Request 1 returns item identifiers.',
  confidence: 1,
  requestSeqs: [1],
  representativeSeqs: [1],
  eventSeqs: [],
  expectedOutput: 'Item identifiers from the current catalog.',
  likelyParams: [],
  dependencySeqs: [],
  dependsOnTools: [],
};

const consumerCandidate = {
  toolName: CONSUMER_NAME,
  description: 'Fetch one fixture item by identifier.',
  rationale: 'Request 2 consumes the identifier returned by request 1.',
  confidence: 1,
  requestSeqs: [2],
  representativeSeqs: [2],
  eventSeqs: [],
  expectedOutput: 'The current item detail.',
  likelyParams: [
    { name: 'item_id', type: 'string' as const, description: 'Identifier from search results.' },
  ],
  dependencySeqs: [1],
  dependsOnTools: [PRODUCER_NAME],
};

const chainEdge = {
  id: EDGE_ID,
  producerToolId: PRODUCER_ID,
  producerResultPath: 'items[0].id',
  consumerToolId: CONSUMER_ID,
  consumerParameter: 'item_id',
};

function syntheticSessionPath(root: string): string {
  const session = SessionSchema.parse({
    site: SITE,
    startedAt: '2026-08-29T11:59:00.000Z',
    url: 'https://fixture.invalid/catalog',
    imprintVersion: '0.6.6',
    requests: [
      {
        seq: 1,
        timestamp: 100,
        method: 'GET',
        url: 'https://fixture.invalid/api/items',
        headers: { accept: 'application/json' },
        resourceType: 'Fetch',
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          mimeType: 'application/json',
          body: JSON.stringify({ items: [{ id: 'item-1' }] }),
        },
      },
      {
        seq: 2,
        timestamp: 200,
        method: 'GET',
        url: 'https://fixture.invalid/api/items/item-1',
        headers: { accept: 'application/json' },
        resourceType: 'Fetch',
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          mimeType: 'application/json',
          body: JSON.stringify({ id: 'item-1', name: 'Fixture item' }),
        },
      },
    ],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  });
  const path = join(root, 'recording.json');
  writeFileSync(path, `${JSON.stringify(session)}\n`);
  return path;
}

async function withTemporaryImprintHome<T>(run: (root: string, home: string) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), 'imprint-master-controller-e2e-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const previous = process.env.IMPRINT_HOME;
  process.env.IMPRINT_HOME = home;
  try {
    return await run(root, home);
  } finally {
    if (previous === undefined) process.env.IMPRINT_HOME = undefined;
    else process.env.IMPRINT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function toolId(name: string): string {
  if (name === PRODUCER_NAME) return PRODUCER_ID;
  if (name === CONSUMER_NAME) return CONSUMER_ID;
  throw new Error(`unexpected fixture tool ${name}`);
}

function desiredFromCurrent(input: MasterDecisionInput): DesiredTeachingPlan {
  if (!input.current) throw new Error('fixture expected a current plan');
  const {
    version: _version,
    revision: _revision,
    decision: _decision,
    ...desired
  } = input.current.plan.payload;
  return structuredClone(desired);
}

function initialDesiredPlan(input: MasterDecisionInput): DesiredTeachingPlan {
  const candidates = new Map(
    input.discovery.discoveryCandidates.map((candidate) => [candidate.toolName, candidate]),
  );
  const makeTool = (name: string) => {
    const candidate = candidates.get(name);
    if (!candidate) throw new Error(`missing discovery candidate ${name}`);
    return {
      id: toolId(name),
      candidate,
      compileContext: input.discovery.detectorSharedContext,
      evidenceRefs: [input.discovery.evidence.ref],
      strategy: { kind: 'api' as const, reason: 'The recording contains one replayable request.' },
    };
  };
  return {
    site: input.discovery.run.site,
    recordingSha256: input.discovery.run.recordingSha256,
    tools: [makeTool(PRODUCER_NAME), makeTool(CONSUMER_NAME)],
    candidateCoverage: [
      {
        discoveryCandidateName: PRODUCER_NAME,
        plannedToolIds: [PRODUCER_ID],
        unresolvedReason: null,
      },
      {
        discoveryCandidateName: CONSUMER_NAME,
        plannedToolIds: [CONSUMER_ID],
        unresolvedReason: null,
      },
    ],
    buildWaves: [[PRODUCER_ID], [CONSUMER_ID]],
    chainEdges: [chainEdge],
  };
}

function proposalDesiredPlan(input: MasterDecisionInput): DesiredTeachingPlan {
  const proposals = new Map(
    input.plannerProposals.map((proposal) => [proposal.payload.tool.id, proposal.payload.tool]),
  );
  const producer = proposals.get(PRODUCER_ID);
  const consumer = proposals.get(CONSUMER_ID);
  if (!producer || !consumer) throw new Error('fixture expected both focused proposals');
  return {
    site: input.discovery.run.site,
    recordingSha256: input.discovery.run.recordingSha256,
    tools: [producer, consumer],
    candidateCoverage: [
      {
        discoveryCandidateName: PRODUCER_NAME,
        plannedToolIds: [PRODUCER_ID],
        unresolvedReason: null,
      },
      {
        discoveryCandidateName: CONSUMER_NAME,
        plannedToolIds: [CONSUMER_ID],
        unresolvedReason: null,
      },
    ],
    buildWaves: [[PRODUCER_ID], [CONSUMER_ID]],
    chainEdges: [chainEdge],
  };
}

function focusedImplementation(input: FocusedPlannerInput) {
  const requestProvenance = [
    { artifactRequestIndex: 0, recordingRequestSeq: input.tool.candidate.requestSeqs[0] ?? -1 },
  ];
  const parameterValues = input.tool.candidate.likelyParams.map(({ name, type }) => ({
    parameterName: name,
    value: type === 'string' ? 'item-1' : type === 'number' ? 1 : true,
  }));
  return ImplementationPlanPayloadSchema.parse({
    version: 1,
    toolId: input.tool.id,
    strategyKind: 'api',
    requestProvenance,
    parameterMappings: input.tool.candidate.likelyParams.map(({ name }) => ({
      parameterName: name,
      artifactRequestIndices: [0],
      guidance: `Apply ${name} to the recorded request URL.`,
    })),
    responseDependencies: [],
    resultSources: [
      { artifactRequestIndex: 0, source: 'Return the JSON body from the recorded request.' },
    ],
    outputGuidance: `Return the current ${input.tool.candidate.toolName} result.`,
    verificationCases: [
      {
        id: `replay_${input.tool.id}`,
        check: 'replay',
        parameterValueOrigin: 'recorded_baseline',
        parameterValues,
        expectedResult: input.tool.candidate.expectedOutput,
        provenance: {
          recordingRequestSeqs: input.tool.candidate.requestSeqs,
          recordingEventSeqs: [],
          evidenceRefs: [input.evidence.ref],
        },
      },
      {
        id: `live_${input.tool.id}`,
        check: 'live',
        parameterValueOrigin: 'synthetic_live',
        parameterValues,
        expectedResult: input.tool.candidate.expectedOutput,
        provenance: {
          recordingRequestSeqs: input.tool.candidate.requestSeqs,
          recordingEventSeqs: [],
          evidenceRefs: [input.evidence.ref],
        },
      },
    ],
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('fresh foreground master controller end to end', () => {
  it('settles both dependency waves, every check, completion review, and promotion', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const events: string[] = [];
      let checksSeenByReviewer = new Map<string, string[]>();
      let resultEvidenceCount = 0;
      let statusDuringPromotion: string | undefined;
      let reviewWasRecordedDuringPromotion = false;
      let promotedTools: string[] = [];
      let discoveryTrustedPreparedScope: boolean | undefined;
      const parameterAdvisorCalls: string[] = [];

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 30_000,
        },
        {
          now: () => FIXED_NOW,
          runId: () => 'run-e2e-completed',
          detectToolCandidates: async (_session, _llm, options) => {
            discoveryTrustedPreparedScope = options?.trustSessionScope;
            return {
              ...validateToolCandidateDetection({
                sharedContext,
                candidates: [producerCandidate, consumerCandidate],
              }),
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            };
          },
          observeIndependentExecution: async () => ({
            status: 'unavailable',
            requests: [],
            unmatchedRecordingRequestSeqs: [],
            message: 'The deterministic fixture does not run a browser replay.',
          }),
          requestToolSelectionAdvice: async (input: ToolSelectionAdvisorInput) =>
            ToolSelectionAdvisorOutputSchema.parse({
              binding: input.run,
              boundaries: input.discoveryCandidates.map(
                ({ likelyParams: _params, ...candidate }) => candidate,
              ),
              concerns: [],
              reason: 'Both recorded operations have clear request boundaries.',
            }),
          requestMasterDecision: async (input: MasterDecisionInput) => {
            events.push(`master:${input.phase}`);
            if (input.verificationFindings) throw new Error('unexpected fixture repair revision');
            const desiredPlan =
              input.phase === 'discovery'
                ? initialDesiredPlan(input)
                : input.plannerProposals.length > 0
                  ? proposalDesiredPlan(input)
                  : desiredFromCurrent(input);
            return MasterDecisionOutputSchema.parse({
              binding: input.current?.run ?? input.discovery.run,
              outcome: 'accepted',
              reason: 'The complete dependency-ordered plan remains supported.',
              desiredPlan,
            });
          },
          requestFocusedPlan: async (input: FocusedPlannerInput) => {
            events.push(`plan:${input.tool.id}`);
            return FocusedPlannerOutputSchema.parse({
              binding: {
                runId: input.run.runId,
                site: input.run.site,
                recordingSha256: input.run.recordingSha256,
                toolId: input.tool.id,
              },
              tool: {
                ...input.tool,
                strategy: {
                  kind: 'api',
                  reason: 'The focused recording contains one replayable API request.',
                },
              },
              chainEdges: input.incomingChainEdges,
              implementationPlan: focusedImplementation(input),
              reason: 'The focused request and expected result are explicit.',
            });
          },
          compileFocusedTool: async ({ tool, stagingDir }) => {
            events.push(`compile:${tool.id}`);
            mkdirSync(stagingDir, { recursive: true });
            const workflow = WorkflowSchema.parse({
              toolName: tool.candidate.toolName,
              intent: { description: tool.candidate.description },
              parameters: tool.candidate.likelyParams.map(({ name, type, description }) => ({
                name,
                type,
                description,
              })),
              requests: [
                {
                  recordingRequestSeq: tool.candidate.requestSeqs[0],
                  method: 'GET',
                  url:
                    tool.id === PRODUCER_ID
                      ? 'https://fixture.invalid/api/items'
                      : 'https://fixture.invalid/api/items/${param.item_id}',
                  headers: { accept: 'application/json' },
                },
              ],
              site: SITE,
            });
            const workflowPath = join(stagingDir, 'workflow.json');
            writeFileSync(workflowPath, `${JSON.stringify(workflow)}\n`);
            return { workflow, workflowPath, toolDir: stagingDir };
          },
          runApiTool: async ({ workflowPath, parameters }) => {
            const producer = workflowPath.includes(`/${PRODUCER_ID}/`);
            events.push(`live:${producer ? PRODUCER_ID : CONSUMER_ID}`);
            return {
              result: producer
                ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
                : {
                    ok: true as const,
                    data: { id: parameters.item_id, name: 'Fixture item' },
                  },
              executionMechanism: 'fixture-api',
            };
          },
          requestParameterSelectionAdvice: async (input: ParameterSelectionAdvisorInput) => {
            parameterAdvisorCalls.push(input.toolId);
            throw new Error('optional fixture parameter advice is unavailable');
          },
          requestCompletionReview: async (input) => {
            events.push('completion-review');
            checksSeenByReviewer = new Map(
              input.snapshot.payload.tools.map((tool) => [
                tool.toolId,
                tool.receipts.map(({ check, status }) => `${check}:${status}`),
              ]),
            );
            resultEvidenceCount = input.toolResultEvidence?.length ?? 0;
            return CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'Both planned tools have current factual and semantic evidence.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                status: 'credible',
                reason: 'The current live result matches the focused expected result.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports this terminal claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            });
          },
          promote: async ({ runRoot, tools }) => {
            events.push('promotion');
            promotedTools = tools.map(({ workflow }) => workflow.toolName);
            const state = FreshTeachJournalStateSchema.parse(
              readJson(join(runRoot, 'journal', 'current.json')),
            );
            statusDuringPromotion = state.status;
            reviewWasRecordedDuringPromotion = state.completionReviewRef !== undefined;
          },
        },
      );

      expect(terminal.status).toBe('completed');
      expect(['active', 'paused']).not.toContain(terminal.status);
      expect(terminal.readyTools).toBe(2);
      expect(terminal.failedTools).toBe(0);
      expect(readJson(join(terminal.runRoot, 'terminal.json'))).toEqual(terminal);

      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      const plan = readJson(join(terminal.runRoot, 'journal', state.currentPlanRef.path)) as {
        tools: Array<{ id: string }>;
        buildWaves: string[][];
      };
      expect(plan.tools.map(({ id }) => id)).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(plan.buildWaves).toEqual([[PRODUCER_ID], [CONSUMER_ID]]);
      expect(state.tools.every(({ buildRef }) => buildRef !== undefined)).toBe(true);
      expect(state.status).toBe('completed');
      expect(statusDuringPromotion).toBe('active');
      expect(reviewWasRecordedDuringPromotion).toBe(true);
      expect(promotedTools).toEqual([PRODUCER_NAME, CONSUMER_NAME]);

      expect(checksSeenByReviewer.get(PRODUCER_ID)).toEqual([
        'contract:passed',
        'replay:passed',
        'live:passed',
      ]);
      expect(checksSeenByReviewer.get(CONSUMER_ID)).toEqual([
        'contract:passed',
        'replay:passed',
        'live:passed',
        'chain:passed',
      ]);
      expect(resultEvidenceCount).toBe(2);
      expect(discoveryTrustedPreparedScope).toBeUndefined();
      expect(parameterAdvisorCalls).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(events.filter((event) => event.startsWith('compile:'))).toEqual([
        `compile:${PRODUCER_ID}`,
        `compile:${CONSUMER_ID}`,
      ]);
      expect(events.indexOf('completion-review')).toBeLessThan(events.indexOf('promotion'));
      expect(events.at(-1)).toBe('promotion');
    });
  });

  it('writes an exact bounded terminal result for a pre-journal host failure', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const hostMessage = `pre-journal fixture failure: ${'x'.repeat(1_200)}`;
      const expectedMessage = hostMessage.slice(0, 1_000);

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
        },
        {
          runId: () => 'run-e2e-pre-journal-failure',
          prepareSession: () => {
            throw new Error(hostMessage);
          },
        },
      );

      expect(terminal).toEqual({
        status: 'failed',
        readyTools: 0,
        failedTools: 0,
        runRoot: terminal.runRoot,
        message: expectedMessage,
      });
      expect(terminal.message).toHaveLength(1_000);
      expect(['active', 'paused']).not.toContain(terminal.status);
      expect(existsSync(join(terminal.runRoot, 'journal'))).toBe(false);
      expect(readJson(join(terminal.runRoot, 'terminal.json'))).toEqual(terminal);
    });
  });
});
