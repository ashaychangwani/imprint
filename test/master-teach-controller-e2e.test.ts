import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriageResult } from '../src/imprint/compile.ts';
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
import { requestMasterDecision as requestValidatedMasterDecision } from '../src/imprint/master-teach-agents.ts';
import { runFreshMasterTeach } from '../src/imprint/master-teach-controller.ts';
import {
  type DesiredTeachingPlan,
  ImplementationPlanPayloadSchema,
} from '../src/imprint/master-teach-plan.ts';
import { FreshTeachJournalStateSchema } from '../src/imprint/master-teach-store.ts';
import { ProviderDeadlineError, ProviderUnavailableError } from '../src/imprint/provider-retry.ts';
import {
  buildToolCandidatePayload,
  validateToolCandidateDetection,
} from '../src/imprint/tool-candidates.ts';
import { type Session, SessionSchema, WorkflowSchema } from '../src/imprint/types.ts';

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

function syntheticSessionPath(root: string, includeTelemetryShapedRequest = false): string {
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
      ...(includeTelemetryShapedRequest
        ? [
            {
              seq: 4,
              timestamp: 250,
              method: 'POST',
              url: 'https://telemetry.invalid/collect',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ marker: 'master-can-overrule-telemetry' }),
              resourceType: 'Fetch' as const,
              response: {
                status: 200,
                headers: { 'content-type': 'application/json' },
                mimeType: 'application/json',
                body: JSON.stringify({ accepted: true }),
              },
            },
          ]
        : []),
    ],
    events: [],
    narration: [{ seq: 3, timestamp: 150, text: 'Fixture narration remains visible.' }],
    cookieSnapshots: [],
    storageSnapshots: [],
  });
  const path = join(root, 'recording.json');
  writeFileSync(path, `${JSON.stringify(session)}\n`);
  return path;
}

function preparedSession(
  session: Session,
  selectedSeqs = session.requests.map(({ seq }) => seq),
): TriageResult {
  const selected = new Set(selectedSeqs);
  return {
    session: { ...session, requests: session.requests.filter(({ seq }) => selected.has(seq)) },
    selectedSeqs,
    replaySafeSeqs: selectedSeqs,
    irreversibleSeqs: [],
    coveredOutboundEventSeqs: session.events
      .filter(({ type }) => type === 'ws-sent')
      .map(({ seq }) => seq),
    irreversibleEventSeqs: [],
    consideredCount: session.requests.length,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };
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
    const candidate =
      candidates.get(name) ?? (name === CONSUMER_NAME ? structuredClone(consumerCandidate) : null);
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
    candidateCoverage: input.discovery.discoveryCandidates.map(({ toolName }) => ({
      discoveryCandidateName: toolName,
      plannedToolIds: [toolId(toolName)],
      unresolvedReason: null,
    })),
    buildWaves: [[PRODUCER_ID], [CONSUMER_ID]],
    chainEdges: [chainEdge],
  };
}

function proposalDesiredPlan(input: MasterDecisionInput): DesiredTeachingPlan {
  const proposals = new Map(
    input.plannerProposals.map((proposal) => [proposal.payload.tool.id, proposal.payload.tool]),
  );
  const desired = desiredFromCurrent(input);
  const proposedConsumers = new Set(input.plannerProposals.map(({ payload }) => payload.tool.id));
  desired.tools = desired.tools.map((tool) => structuredClone(proposals.get(tool.id) ?? tool));
  desired.chainEdges = [
    ...desired.chainEdges.filter(({ consumerToolId }) => !proposedConsumers.has(consumerToolId)),
    ...input.plannerProposals.flatMap(({ payload }) => payload.chainEdges),
  ];
  return desired;
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

function browserFocusedImplementation(input: FocusedPlannerInput) {
  const parameterValues = input.tool.candidate.likelyParams.map(({ name, type }) => ({
    parameterName: name,
    value: type === 'string' ? 'item-1' : type === 'number' ? 1 : true,
  }));
  return ImplementationPlanPayloadSchema.parse({
    version: 1,
    toolId: input.tool.id,
    strategyKind: 'playbook_fallback',
    requestProvenance: [],
    parameterMappings: input.tool.candidate.likelyParams.map(({ name }) => ({
      parameterName: name,
      artifactRequestIndices: [],
      guidance: `Apply ${name} through the rendered browser flow.`,
    })),
    responseDependencies: [],
    resultSources: [{ artifactRequestIndex: null, source: 'Return the rendered item detail.' }],
    outputGuidance: `Return the current ${input.tool.candidate.toolName} result.`,
    verificationCases: [
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
      const recordingPath = syntheticSessionPath(root, true);
      const events: string[] = [];
      let checksSeenByReviewer = new Map<string, string[]>();
      let resultEvidenceCount = 0;
      let statusDuringPromotion: string | undefined;
      let reviewWasRecordedDuringPromotion = false;
      let promotedTools: string[] = [];
      let discoveryTrustedPreparedScope: boolean | undefined;
      let detectorReusedControllerPayload = false;
      let detectorRequestSeqs: number[] = [];
      let masterRequestSeqs: number[] = [];
      let masterEvidenceIncludedSecondRequest = false;
      let masterEvidenceIncludedTelemetryShapedRequest = false;
      let independentRequestSeqs: number[] = [];
      let compilerRequestSeqs: number[] = [];
      let compilerScopeSeqs: number[] = [];
      let consumerFocusedEvidenceWasComplete = false;
      let narrationCitationWasGrounded = false;
      let narrationRemainedInEvidence = false;
      const parameterAdvisorCalls: string[] = [];
      const plannerGuidance: string[] = [];
      let focusedProposalDecisions = 0;
      let revisedProducerWasReplanned = false;
      const revisedProducerDescription = 'Search the revised fixture item catalog.';

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
          prepareSession: async (session) => preparedSession(session, [1]),
          detectToolCandidates: async (_session, _llm, options) => {
            detectorRequestSeqs = _session.requests.map(({ seq }) => seq);
            discoveryTrustedPreparedScope = options?.trustSessionScope;
            detectorReusedControllerPayload =
              JSON.stringify(options?.candidatePayload) ===
              JSON.stringify(buildToolCandidatePayload(_session, { trustSessionScope: true }));
            return {
              ...validateToolCandidateDetection({
                sharedContext,
                candidates: [{ ...producerCandidate, eventSeqs: [3] }],
              }),
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            };
          },
          observeIndependentExecution: async ({ session }) => {
            independentRequestSeqs = session.requests.map(({ seq }) => seq);
            return {
              status: 'unavailable',
              requests: [],
              unmatchedRecordingRequestSeqs: [],
              message: 'The deterministic fixture does not run a browser replay.',
            };
          },
          requestToolSelectionAdvice: async (input: ToolSelectionAdvisorInput) => {
            masterRequestSeqs = input.recordingIndex.requestSeqs;
            masterEvidenceIncludedSecondRequest = JSON.stringify(input.evidence).includes(
              'fixture.invalid/api/items/item-1',
            );
            masterEvidenceIncludedTelemetryShapedRequest = JSON.stringify(input.evidence).includes(
              'telemetry.invalid/collect',
            );
            narrationCitationWasGrounded = input.discoveryCandidates[0]?.eventSeqs.length === 0;
            narrationRemainedInEvidence = JSON.stringify(input.evidence).includes(
              'Fixture narration remains visible.',
            );
            return ToolSelectionAdvisorOutputSchema.parse({
              binding: input.run,
              boundaries: input.discoveryCandidates.map(
                ({ likelyParams: _params, ...candidate }) => candidate,
              ),
              concerns: [],
              reason: 'Both recorded operations have clear request boundaries.',
            });
          },
          requestMasterDecision: async (input: MasterDecisionInput) => {
            events.push(`master:${input.phase}`);
            if (input.verificationFindings) throw new Error('unexpected fixture repair revision');
            const reviewingFocusedProposals =
              input.phase === 'revision' && input.plannerProposals.length > 0;
            if (reviewingFocusedProposals) focusedProposalDecisions += 1;
            const rejectsFirstFocusedProposal =
              reviewingFocusedProposals && focusedProposalDecisions === 1;
            const revisesWithStalePlan =
              reviewingFocusedProposals && focusedProposalDecisions === 2;
            const desiredPlan =
              input.phase === 'discovery'
                ? initialDesiredPlan(input)
                : rejectsFirstFocusedProposal
                  ? desiredFromCurrent(input)
                  : input.plannerProposals.length > 0
                    ? proposalDesiredPlan(input)
                    : desiredFromCurrent(input);
            if (revisesWithStalePlan) {
              const producer = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!producer?.implementationPlan)
                throw new Error('fixture expected a supplied producer implementation plan');
              producer.candidate.description = revisedProducerDescription;
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: input.current?.run ?? input.discovery.run,
              outcome: rejectsFirstFocusedProposal
                ? 'rejected'
                : revisesWithStalePlan
                  ? 'revised'
                  : 'accepted',
              reason: rejectsFirstFocusedProposal
                ? 'Address why the supplied recording can ground and verify the proposed strategy.'
                : revisesWithStalePlan
                  ? 'Keep the semantic description revision and replan only its stale implementation.'
                  : 'The complete dependency-ordered plan remains supported.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(input, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestFocusedPlan: async (input: FocusedPlannerInput) => {
            events.push(`plan:${input.tool.id}`);
            if (input.tool.id === CONSUMER_ID) {
              consumerFocusedEvidenceWasComplete = JSON.stringify(input.evidence).includes(
                'Fixture item',
              );
            }
            plannerGuidance.push(input.masterGuidance ?? '');
            if (
              input.tool.id === PRODUCER_ID &&
              input.tool.candidate.description === revisedProducerDescription
            ) {
              revisedProducerWasReplanned = true;
            }
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
          compileFocusedTool: async ({ tool, triage, sessionPath, stagingDir }) => {
            events.push(`compile:${tool.id}`);
            compilerScopeSeqs = triage.selectedSeqs;
            compilerRequestSeqs = SessionSchema.parse(readJson(sessionPath)).requests.map(
              ({ seq }) => seq,
            );
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
        tools: Array<{ id: string; candidate: { description: string } }>;
        buildWaves: string[][];
      };
      expect(plan.tools.map(({ id }) => id)).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(plan.tools[0]?.candidate.description).toBe(revisedProducerDescription);
      expect(revisedProducerWasReplanned).toBe(true);
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
      expect(discoveryTrustedPreparedScope).toBe(true);
      expect(detectorReusedControllerPayload).toBe(true);
      expect(detectorRequestSeqs).toEqual([1]);
      expect(masterRequestSeqs).toEqual([1, 2, 4]);
      expect(masterEvidenceIncludedSecondRequest).toBe(true);
      expect(masterEvidenceIncludedTelemetryShapedRequest).toBe(true);
      expect(independentRequestSeqs).toEqual([1, 2, 4]);
      expect(compilerRequestSeqs).toEqual([1, 2, 4]);
      expect(compilerScopeSeqs).toEqual([1, 2, 4]);
      expect(consumerFocusedEvidenceWasComplete).toBe(true);
      expect(narrationCitationWasGrounded).toBe(true);
      expect(narrationRemainedInEvidence).toBe(true);
      expect(parameterAdvisorCalls).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(plannerGuidance).toEqual([
        'The complete dependency-ordered plan remains supported.',
        'The complete dependency-ordered plan remains supported.',
        'Address why the supplied recording can ground and verify the proposed strategy.',
        'Address why the supplied recording can ground and verify the proposed strategy.',
        'Keep the semantic description revision and replan only its stale implementation.',
      ]);
      expect(focusedProposalDecisions).toBe(3);
      expect(events.filter((event) => event.startsWith('compile:'))).toEqual([
        `compile:${PRODUCER_ID}`,
        `compile:${CONSUMER_ID}`,
      ]);
      expect(events.indexOf('completion-review')).toBeLessThan(events.indexOf('promotion'));
      expect(events.at(-1)).toBe('promotion');
    });
  });

  it('records a timed-out browser chain as a host error and continues after revision', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      let playbookCalls = 0;
      let timedOutChainSignal: AbortSignal | undefined;
      let timedOutChainDurationMs: number | undefined;
      let consumerCompiles = 0;
      let removedTimedOutChain = false;

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          now: () => FIXED_NOW,
          runId: () => 'run-e2e-browser-chain-timeout',
          playbookInvocationTimeoutMs: 25,
          playbookCleanupGraceMs: 15,
          prepareSession: async (session) => preparedSession(session),
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate, consumerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          observeIndependentExecution: async () => ({
            status: 'unavailable',
            requests: [],
            unmatchedRecordingRequestSeqs: [],
            message: 'The fixture uses injected tool runners.',
          }),
          requestToolSelectionAdvice: async (input: ToolSelectionAdvisorInput) =>
            ToolSelectionAdvisorOutputSchema.parse({
              binding: input.run,
              boundaries: input.discoveryCandidates.map(
                ({ likelyParams: _params, ...candidate }) => candidate,
              ),
              concerns: [],
              reason: 'The two fixture operations have an explicit producer-consumer boundary.',
            }),
          requestMasterDecision: async (input: MasterDecisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'revised' = 'accepted';
            let reason = 'Keep the focused dependency-ordered fixture plan.';
            if (input.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(input);
            } else if (input.plannerProposals.length > 0) {
              desiredPlan = proposalDesiredPlan(input);
            } else if (input.verificationFindings) {
              desiredPlan = desiredFromCurrent(input);
              desiredPlan.chainEdges = [];
              removedTimedOutChain = true;
              outcome = 'revised';
              reason = 'Remove the chain whose factual host receipt timed out.';
            } else {
              desiredPlan = desiredFromCurrent(input);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: input.current?.run ?? input.discovery.run,
              outcome,
              reason,
              desiredPlan,
            });
            return await requestValidatedMasterDecision(input, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestFocusedPlan: async (input: FocusedPlannerInput) => {
            const browser = input.tool.id === CONSUMER_ID;
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
                  kind: browser ? 'playbook_fallback' : 'api',
                  reason: browser
                    ? 'The fixture exercises the rendered-browser lifecycle.'
                    : 'The producer has one replayable API request.',
                },
              },
              chainEdges: input.incomingChainEdges,
              implementationPlan: browser
                ? browserFocusedImplementation(input)
                : focusedImplementation(input),
              reason: 'The fixture implementation is fully specified.',
            });
          },
          compileFocusedTool: async ({ tool, stagingDir }) => {
            mkdirSync(stagingDir, { recursive: true });
            const browser = tool.id === CONSUMER_ID;
            if (browser) consumerCompiles += 1;
            const workflow = WorkflowSchema.parse({
              toolName: tool.candidate.toolName,
              intent: { description: tool.candidate.description },
              parameters: tool.candidate.likelyParams.map(({ name, type, description }) => ({
                name,
                type,
                description,
              })),
              requests: browser
                ? []
                : [
                    {
                      recordingRequestSeq: 1,
                      method: 'GET',
                      url: 'https://fixture.invalid/api/items',
                      headers: { accept: 'application/json' },
                    },
                  ],
              site: SITE,
            });
            const workflowPath = join(stagingDir, 'workflow.json');
            writeFileSync(workflowPath, `${JSON.stringify(workflow)}\n`);
            if (browser) {
              writeFileSync(
                join(stagingDir, 'playbook.yaml'),
                [
                  `toolName: ${CONSUMER_NAME}`,
                  'summary: Render one fixture item.',
                  'parameters:',
                  '  - name: item_id',
                  '    type: string',
                  '    description: Item identifier.',
                  'steps:',
                  '  - action: navigate',
                  '    url: "https://fixture.invalid/items/${item_id}"',
                  'result:',
                  '  source: dom',
                  '  locators:',
                  '    - by: role',
                  '      value: main',
                  '  extract: text',
                  '  return_as: item',
                  '',
                ].join('\n'),
              );
            }
            return { workflow, workflowPath, toolDir: stagingDir };
          },
          runApiTool: async () => ({
            result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
            executionMechanism: 'fixture-api',
          }),
          runPlaybookTool: async ({ parameters, signal, maxDurationMs }) => {
            playbookCalls += 1;
            if (playbookCalls === 2) {
              timedOutChainSignal = signal;
              timedOutChainDurationMs = maxDurationMs;
              return await new Promise<never>(() => {});
            }
            return {
              result: {
                ok: true as const,
                data: { id: parameters.item_id, name: 'Fixture item' },
              },
              executionMechanism: 'fixture-playbook',
            };
          },
          requestParameterSelectionAdvice: async () => {
            throw new Error('Optional fixture parameter advice is unavailable.');
          },
          requestCompletionReview: async (input) =>
            CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'The revised tools have current factual receipts.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                status: 'credible',
                reason: 'The current result matches the focused fixture expectation.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The current immutable receipts support the claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
          promote: async () => {},
        },
      );

      if (terminal.status !== 'completed') {
        throw new Error(
          `chain-timeout fixture teach failed: ${JSON.stringify({ terminal, playbookCalls, consumerCompiles, removedTimedOutChain, timedOutChainDurationMs })}`,
        );
      }
      expect(terminal.status).toBe('completed');
      expect(removedTimedOutChain).toBe(true);
      expect(timedOutChainSignal?.aborted).toBe(true);
      expect(timedOutChainDurationMs).toBe(25);
      expect(playbookCalls).toBe(3);
      expect(consumerCompiles).toBe(2);

      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      const archivedReceipts = state.supersededReceiptRefs.map((ref) =>
        readJson(join(terminal.runRoot, 'journal', ref.path)),
      ) as Array<{
        check?: string;
        chainEdgeId?: string;
        facts?: Array<{ kind: string; status: string }>;
      }>;
      const timedOutChain = archivedReceipts.find(
        (receipt) => receipt.check === 'chain' && receipt.chainEdgeId === EDGE_ID,
      );
      expect(timedOutChain?.facts).toContainEqual(
        expect.objectContaining({ kind: 'host_error', status: 'failed' }),
      );
    });
  });

  it('falls back to the complete detector scope after an ordinary triage failure', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const hostMessage = `pre-journal fixture failure: ${'x'.repeat(1_200)}`;
      const expectedMessage = hostMessage.slice(0, 1_000);
      let detectorRequestSeqs: number[] = [];

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
            throw new Error('fixture triage schema failure');
          },
          detectToolCandidates: async (session) => {
            detectorRequestSeqs = session.requests.map(({ seq }) => seq);
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
      expect(detectorRequestSeqs).toEqual([1, 2]);
      expect(['active', 'paused']).not.toContain(terminal.status);
      expect(existsSync(join(terminal.runRoot, 'journal'))).toBe(false);
      expect(readJson(join(terminal.runRoot, 'terminal.json'))).toEqual(terminal);
    });
  });

  it('propagates triage cancellation, deadline, and provider-control failures', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const failures = [
        {
          id: 'cancelled',
          error: new DOMException('fixture cancellation', 'AbortError'),
          status: 'cancelled',
        },
        {
          id: 'deadline',
          error: new ProviderDeadlineError(Date.now() + 1_000),
          status: 'failed',
        },
        {
          id: 'provider',
          error: new ProviderUnavailableError(new Error('fixture unavailable')),
          status: 'provider_unavailable',
        },
      ] as const;

      for (const failure of failures) {
        let detectorCalled = false;
        const terminal = await runFreshMasterTeach(
          {
            site: SITE,
            fromSession: recordingPath,
            noInteractive: true,
            provider: 'codex-cli',
          },
          {
            runId: () => `run-e2e-triage-${failure.id}`,
            prepareSession: () => {
              throw failure.error;
            },
            detectToolCandidates: async () => {
              detectorCalled = true;
              throw new Error('detector must not run after a provider-control failure');
            },
          },
        );

        expect(terminal.status).toBe(failure.status);
        expect(detectorCalled).toBe(false);
      }
    });
  });
});
