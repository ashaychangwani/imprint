import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriageResult } from '../src/imprint/compile.ts';
import {
  type BaselineMvpReviewInput,
  BaselineMvpReviewOutputSchema,
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
const LEAF_ID = 'render_item_tool';
const PRODUCER_NAME = 'search_items';
const CONSUMER_NAME = 'get_item';
const LEAF_NAME = 'render_item';
const EDGE_ID = 'search-item-id';
const LEAF_EDGE_ID = 'get-rendered-item-id';
const FIXED_NOW = new Date('2026-08-29T12:00:00.000Z');

function baselineMvpReview(
  input: BaselineMvpReviewInput,
  status: 'credible' | 'revision_required',
) {
  const proof = input.snapshot.payload.tools.find(({ toolId }) => toolId === input.toolId);
  const liveReceipt = proof?.receipts.find(
    ({ check, status }) => check === 'live' && status === 'passed',
  );
  if (!proof || !liveReceipt) throw new Error('fixture expected current live MVP proof');
  return BaselineMvpReviewOutputSchema.parse({
    binding: {
      ...input.run,
      toolId: input.toolId,
      compileInputsSha256: proof.executionBinding.compileInputsSha256,
      currentBuildRef: proof.currentBuildRef,
      executionBindingSha256: proof.executionBindingSha256,
      resultReceiptRef: liveReceipt.ref,
      resultEvidenceRef: input.resultEvidence.ref,
    },
    status,
    reason:
      status === 'credible'
        ? 'The current default result demonstrates the fixture operation.'
        : 'The current default result does not demonstrate the fixture operation.',
    evidenceRefs: [input.resultEvidence.ref],
  });
}

function credibleBaselineMvpReview(input: BaselineMvpReviewInput) {
  return baselineMvpReview(input, 'credible');
}

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

const leafCandidate = {
  toolName: LEAF_NAME,
  description: 'Render one fixture item summary by identifier.',
  rationale: 'Request 5 consumes the identifier returned by request 2.',
  confidence: 1,
  requestSeqs: [5],
  representativeSeqs: [5],
  eventSeqs: [],
  expectedOutput: 'The rendered item summary.',
  likelyParams: [
    { name: 'item_id', type: 'string' as const, description: 'Identifier from item detail.' },
  ],
  dependencySeqs: [2],
  dependsOnTools: [CONSUMER_NAME],
};

const chainEdge = {
  id: EDGE_ID,
  producerToolId: PRODUCER_ID,
  producerResultPath: 'items[0].id',
  consumerToolId: CONSUMER_ID,
  consumerParameter: 'item_id',
};

const leafChainEdge = {
  id: LEAF_EDGE_ID,
  producerToolId: CONSUMER_ID,
  producerResultPath: 'id',
  consumerToolId: LEAF_ID,
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

function threeToolSyntheticSessionPath(root: string): string {
  const path = syntheticSessionPath(root);
  const session = SessionSchema.parse(readJson(path));
  session.requests.push({
    seq: 5,
    timestamp: 300,
    method: 'GET',
    url: 'https://fixture.invalid/api/render/item-1',
    headers: { accept: 'application/json' },
    resourceType: 'Fetch',
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      mimeType: 'application/json',
      body: JSON.stringify({ rendered: 'item-1' }),
    },
  });
  writeFileSync(path, `${JSON.stringify(SessionSchema.parse(session))}\n`);
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
  if (name === LEAF_NAME) return LEAF_ID;
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

function initialThreeToolDesiredPlan(input: MasterDecisionInput): DesiredTeachingPlan {
  const desired = initialDesiredPlan(input);
  const candidate = input.discovery.discoveryCandidates.find(
    ({ toolName }) => toolName === LEAF_NAME,
  );
  if (!candidate) throw new Error('missing discovery candidate render_item');
  desired.tools.push({
    id: LEAF_ID,
    candidate,
    compileContext: input.discovery.detectorSharedContext,
    evidenceRefs: [input.discovery.evidence.ref],
    strategy: { kind: 'api', reason: 'The recording contains one replayable request.' },
  });
  desired.buildWaves = [[PRODUCER_ID], [CONSUMER_ID], [LEAF_ID]];
  desired.chainEdges = [chainEdge, leafChainEdge];
  return desired;
}

function initialSingleToolDesiredPlan(input: MasterDecisionInput): DesiredTeachingPlan {
  const candidate = input.discovery.discoveryCandidates.find(
    ({ toolName }) => toolName === PRODUCER_NAME,
  );
  if (!candidate) throw new Error('missing discovery candidate search_items');
  return {
    site: input.discovery.run.site,
    recordingSha256: input.discovery.run.recordingSha256,
    tools: [
      {
        id: PRODUCER_ID,
        candidate,
        compileContext: input.discovery.detectorSharedContext,
        evidenceRefs: [input.discovery.evidence.ref],
        strategy: { kind: 'api', reason: 'The recording contains one replayable request.' },
      },
    ],
    candidateCoverage: [
      {
        discoveryCandidateName: candidate.toolName,
        plannedToolIds: [PRODUCER_ID],
        unresolvedReason: null,
      },
    ],
    buildWaves: [[PRODUCER_ID]],
    chainEdges: [],
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

function unavailableReplayImplementation(input: FocusedPlannerInput) {
  const implementation = focusedImplementation(input);
  return ImplementationPlanPayloadSchema.parse({
    ...implementation,
    verificationCases: implementation.verificationCases.map((verificationCase) =>
      verificationCase.check === 'replay'
        ? {
            ...verificationCase,
            parameterValueOrigin: 'unavailable',
            parameterValues: [],
          }
        : verificationCase,
    ),
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

type FreshTeachOverrides = NonNullable<Parameters<typeof runFreshMasterTeach>[1]>;

function lifecycleFailureFixture(input: {
  runId: string;
  events: string[];
  promotionBatches: string[][];
  requestBaselineMvpReview: (
    reviewInput: BaselineMvpReviewInput,
  ) => ReturnType<typeof credibleBaselineMvpReview>;
  failCompileToolId?: string;
  installedTools?: Set<string>;
}): FreshTeachOverrides {
  return {
    now: () => FIXED_NOW,
    runId: () => input.runId,
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
      message: 'The deterministic fixture does not run an independent browser replay.',
    }),
    requestToolSelectionAdvice: async (advisorInput) =>
      ToolSelectionAdvisorOutputSchema.parse({
        binding: advisorInput.run,
        boundaries: advisorInput.discoveryCandidates.map(
          ({ likelyParams: _likelyParams, ...candidate }) => candidate,
        ),
        concerns: [],
        reason: 'Both fixture requests have explicit operation boundaries.',
      }),
    requestMasterDecision: async (decisionInput) => {
      if (decisionInput.verificationFindings) {
        throw new ProviderUnavailableError(new Error('fixture stops after the lifecycle failure'));
      }
      const desiredPlan =
        decisionInput.phase === 'discovery'
          ? initialDesiredPlan(decisionInput)
          : decisionInput.plannerProposals.length > 0
            ? proposalDesiredPlan(decisionInput)
            : desiredFromCurrent(decisionInput);
      const output = MasterDecisionOutputSchema.parse({
        binding: decisionInput.current?.run ?? decisionInput.discovery.run,
        outcome: 'accepted',
        reason: 'The complete dependency-ordered fixture plan remains supported.',
        desiredPlan,
      });
      return requestValidatedMasterDecision(decisionInput, {
        analyzer: {
          async analyze() {
            return { text: JSON.stringify(output) };
          },
        },
      });
    },
    requestFocusedPlan: async (plannerInput) =>
      FocusedPlannerOutputSchema.parse({
        binding: {
          runId: plannerInput.run.runId,
          site: plannerInput.run.site,
          recordingSha256: plannerInput.run.recordingSha256,
          toolId: plannerInput.tool.id,
        },
        tool: {
          ...plannerInput.tool,
          strategy: {
            kind: 'api',
            reason: 'The focused recording contains one replayable API request.',
          },
        },
        chainEdges: plannerInput.incomingChainEdges,
        implementationPlan: focusedImplementation(plannerInput),
        reason: 'The focused request and expected result are explicit.',
      }),
    compileFocusedTool: async ({ tool, stagingDir }) => {
      input.events.push(`compile:${tool.id}`);
      if (tool.id === input.failCompileToolId) {
        throw new ProviderUnavailableError(
          new Error(`fixture compiler unavailable for ${tool.id}`),
        );
      }
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
                : tool.id === CONSUMER_ID
                  ? 'https://fixture.invalid/api/items/${param.item_id}'
                  : 'https://fixture.invalid/api/render/${param.item_id}',
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
      const leaf = workflowPath.includes(`/${LEAF_ID}/`);
      return {
        result: producer
          ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
          : leaf
            ? { ok: true as const, data: { rendered: parameters.item_id } }
            : { ok: true as const, data: { id: parameters.item_id, name: 'Fixture item' } },
        executionMechanism: 'fixture-api',
      };
    },
    requestBaselineMvpReview: async (reviewInput) => {
      input.events.push(`review:${reviewInput.toolId}`);
      return input.requestBaselineMvpReview(reviewInput);
    },
    requestParameterSelectionAdvice: async () => {
      throw new Error('Optional fixture parameter advice is unavailable.');
    },
    runLiveFinesse: async ({ provider }) => ({
      status: 'inconclusive',
      provider,
      attempts: 0,
      completedReview: false,
      artifacts: {},
      message: 'Optional fixture live finesse is unavailable.',
      durationMs: 1,
    }),
    requestCompletionReview: async () => {
      throw new Error('fixture must stop before completion review');
    },
    promote: async ({ tools }) => {
      const names = tools.map(({ workflow }) => workflow.toolName);
      input.events.push(`promote:${names.join(',')}`);
      input.promotionBatches.push(names);
      for (const name of names) input.installedTools?.add(name);
    },
  };
}

describe('fresh foreground master controller end to end', () => {
  it('settles both dependency waves, every check, completion review, and promotion', async () => {
    await withTemporaryImprintHome(async (root, home) => {
      const recordingPath = syntheticSessionPath(root, true);
      const events: string[] = [];
      let checksSeenByReviewer = new Map<string, string[]>();
      let resultEvidenceCount = 0;
      let completionChainEdgeIds: Array<string | undefined> = [];
      let statusDuringPromotion: string | undefined;
      let reviewWasRecordedDuringPromotion = false;
      let promotedTools: string[] = [];
      const promotionBatches: string[][] = [];
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
      let detectorEventCitationsWereGrounded = false;
      let groundedCandidateRemainedAdvisory = false;
      let narrationRemainedInEvidence = false;
      const parameterAdvisorCalls: string[] = [];
      const liveFinesseCalls: string[] = [];
      const parameterAdvisorChecks = new Map<string, string[]>();
      const pendingParameterAdvice: Array<() => void> = [];
      let parameterAdviceHadToBeReleased = false;
      let parameterAdviceGuard: ReturnType<typeof setTimeout> | undefined;
      const plannerGuidance: string[] = [];
      let focusedProposalDecisions = 0;
      let revisedProducerWasReplanned = false;
      let producerBuildVisibleWhenConsumerCompileStarted = false;
      let consumerMvpPreview = '';
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
                candidates: [{ ...producerCandidate, eventSeqs: [1, 3, 999] }],
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
            const groundedCandidate = input.discoveryCandidates[0];
            detectorEventCitationsWereGrounded = groundedCandidate?.eventSeqs.length === 0;
            groundedCandidateRemainedAdvisory =
              groundedCandidate?.toolName === producerCandidate.toolName &&
              JSON.stringify(groundedCandidate.requestSeqs) ===
                JSON.stringify(producerCandidate.requestSeqs) &&
              groundedCandidate.rationale === producerCandidate.rationale;
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
              implementationPlan:
                input.tool.id === CONSUMER_ID
                  ? unavailableReplayImplementation(input)
                  : focusedImplementation(input),
              reason: 'The focused request and expected result are explicit.',
            });
          },
          compileFocusedTool: async ({ tool, triage, sessionPath, stagingDir }) => {
            events.push(`compile:${tool.id}`);
            if (tool.id === CONSUMER_ID) {
              const state = FreshTeachJournalStateSchema.parse(
                readJson(
                  join(home, SITE, '.teach-runs', 'run-e2e-completed', 'journal', 'current.json'),
                ),
              );
              producerBuildVisibleWhenConsumerCompileStarted =
                state.tools.find(({ toolId }) => toolId === PRODUCER_ID)?.buildRef !== undefined;
            }
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
          requestBaselineMvpReview: async (input) => {
            if (input.toolId === CONSUMER_ID) {
              consumerMvpPreview = input.resultEvidence.payload.actualResult.preview;
            }
            return credibleBaselineMvpReview(input);
          },
          requestParameterSelectionAdvice: async (input: ParameterSelectionAdvisorInput) => {
            parameterAdviceGuard ??= setTimeout(() => {
              parameterAdviceHadToBeReleased = true;
              for (const reject of pendingParameterAdvice) reject();
            }, 1_000);
            parameterAdvisorCalls.push(input.toolId);
            events.push(`finesse:${input.toolId}`);
            parameterAdvisorChecks.set(
              input.toolId,
              input.snapshot.payload.tools
                .find(({ toolId }) => toolId === input.toolId)
                ?.receipts.map(({ check, status }) => `${check}:${status}`) ?? [],
            );
            return await new Promise<never>((_resolve, reject) => {
              const rejectAdvice = () => reject(new Error('optional fixture advice stopped'));
              pendingParameterAdvice.push(rejectAdvice);
              if (parameterAdviceHadToBeReleased) rejectAdvice();
            });
          },
          runLiveFinesse: async ({ provider, toolDir }) => {
            const toolId = toolDir.includes(`/${PRODUCER_ID}`) ? PRODUCER_ID : CONSUMER_ID;
            liveFinesseCalls.push(toolId);
            events.push(`finesse-live:${toolId}`);
            return {
              status: 'completed',
              provider,
              model: 'fixture',
              attempts: 1,
              completedReview: true,
              artifacts: {},
              message: 'Fixture breadth review completed.',
              durationMs: 1,
            };
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
            completionChainEdgeIds = (input.toolResultEvidence ?? []).map(
              ({ payload }) => payload.chainEdgeId,
            );
            return CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'Both planned tools have current factual and semantic evidence.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
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
            promotionBatches.push(promotedTools);
            const state = FreshTeachJournalStateSchema.parse(
              readJson(join(runRoot, 'journal', 'current.json')),
            );
            statusDuringPromotion = state.status;
            reviewWasRecordedDuringPromotion = state.completionReviewRef !== undefined;
          },
        },
      );
      if (parameterAdviceGuard) clearTimeout(parameterAdviceGuard);

      expect(terminal.status).toBe('completed');
      expect(['active', 'paused']).not.toContain(terminal.status);
      expect(terminal.readyTools).toBe(2);
      expect(terminal.failedTools).toBe(0);
      expect(terminal.message).toContain('usable MVP');
      expect(terminal.message).toContain('unfinished work is recorded there as deferred');
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
      expect(producerBuildVisibleWhenConsumerCompileStarted).toBe(true);
      expect(consumerMvpPreview).toContain('item-1');
      expect(events.filter((event) => event === `live:${CONSUMER_ID}`)).toHaveLength(2);
      expect(plan.buildWaves).toEqual([[PRODUCER_ID], [CONSUMER_ID]]);
      expect(state.tools.every(({ buildRef }) => buildRef !== undefined)).toBe(true);
      expect(state.status).toBe('completed');
      expect(statusDuringPromotion).toBe('active');
      expect(reviewWasRecordedDuringPromotion).toBe(false);
      expect(promotedTools).toEqual([CONSUMER_NAME]);
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [CONSUMER_NAME]]);

      expect(checksSeenByReviewer.get(PRODUCER_ID)).toEqual(['contract:passed', 'live:passed']);
      expect(checksSeenByReviewer.get(CONSUMER_ID)).toEqual([
        'contract:passed',
        'live:passed',
        'chain:passed',
      ]);
      expect(resultEvidenceCount).toBe(3);
      expect(completionChainEdgeIds).toEqual([undefined, undefined, EDGE_ID]);
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
      expect(detectorEventCitationsWereGrounded).toBe(true);
      expect(groundedCandidateRemainedAdvisory).toBe(true);
      expect(narrationRemainedInEvidence).toBe(true);
      expect(parameterAdviceHadToBeReleased).toBe(false);
      // Optional provider work is bounded independently from the core path,
      // while both tools can still begin their post-publication review.
      expect(parameterAdvisorCalls).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(liveFinesseCalls).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(events.indexOf(`finesse:${PRODUCER_ID}`)).toBeLessThan(
        events.indexOf(`compile:${CONSUMER_ID}`),
      );
      expect(events.indexOf(`finesse-live:${PRODUCER_ID}`)).toBeLessThan(
        events.indexOf(`compile:${CONSUMER_ID}`),
      );
      expect(parameterAdvisorChecks.get(PRODUCER_ID)).toEqual(['contract:passed', 'live:passed']);
      expect(parameterAdvisorChecks.get(CONSUMER_ID)).toEqual([
        'contract:passed',
        'live:passed',
        'chain:passed',
      ]);
      expect(events.indexOf(`finesse:${CONSUMER_ID}`)).toBeLessThan(
        events.indexOf('completion-review'),
      );
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
      expect(events.indexOf('promotion')).toBeLessThan(events.indexOf(`compile:${CONSUMER_ID}`));
      expect(events.lastIndexOf('promotion')).toBeLessThan(events.lastIndexOf('completion-review'));
      expect(events.at(-1)).toBe('completion-review');

      const buildsAtCompletion = state.tools.map(({ toolId, buildRef }) => ({ toolId, buildRef }));
      for (const { toolId, buildRef } of buildsAtCompletion) {
        if (!buildRef) throw new Error(`missing MVP build for ${toolId}`);
        const finesseDir = join(terminal.runRoot, 'finesse', toolId);
        const finesseFile = readdirSync(finesseDir).find((name) => name.endsWith('.json'));
        if (!finesseFile) throw new Error(`missing finesse record for ${toolId}`);
        const finesseRecord = readJson(join(finesseDir, finesseFile));
        expect(finesseRecord).toEqual(
          expect.objectContaining({
            toolId,
            buildRef,
            status: 'deferred',
          }),
        );
        expect(finesseRecord).toEqual(
          expect.objectContaining({
            liveFinesse: expect.objectContaining({
              status: 'completed',
              completedReview: true,
            }),
          }),
        );
      }
      for (const reject of pendingParameterAdvice) reject();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterAdviceFailure = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      expect(afterAdviceFailure.status).toBe('completed');
      expect(
        afterAdviceFailure.tools.map(({ toolId, buildRef }) => ({ toolId, buildRef })),
      ).toEqual(buildsAtCompletion);
    });
  });

  it('reports a thrown completion-review failure as a host failure instead of revising tools', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let repairCalls = 0;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-completion-review-host-failure',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseMasterDecision = base.requestMasterDecision;
      if (!baseMasterDecision) throw new Error('fixture master decision is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          requestMasterDecision: async (input) => {
            if (input.verificationFindings) repairCalls += 1;
            return await baseMasterDecision(input);
          },
          requestCompletionReview: async () => {
            throw new Error('fixture completion reviewer host failure');
          },
        },
      );

      expect(terminal.status).toBe('failed');
      expect(terminal.message).toContain('fixture completion reviewer host failure');
      expect(repairCalls).toBe(0);
    });
  });

  it('does not publish or unblock a dependent after the same MVP build needs revision', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const reviewAttempts = new Map<string, number>();
      const recordingPath = syntheticSessionPath(root);

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        lifecycleFailureFixture({
          runId: 'run-e2e-rejected-mvp',
          events,
          promotionBatches,
          requestBaselineMvpReview: (reviewInput) => {
            const proof = reviewInput.snapshot.payload.tools.find(
              ({ toolId }) => toolId === reviewInput.toolId,
            );
            if (!proof) throw new Error('fixture expected a current MVP build');
            const key = `${reviewInput.toolId}:${proof.currentBuildRef.sha256}`;
            const attempt = (reviewAttempts.get(key) ?? 0) + 1;
            reviewAttempts.set(key, attempt);
            return baselineMvpReview(
              reviewInput,
              reviewInput.toolId === PRODUCER_ID && attempt === 1
                ? 'revision_required'
                : 'credible',
            );
          },
        }),
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(terminal.readyTools).toBe(0);
      expect(promotionBatches).toEqual([]);
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(1);
      expect(events).not.toContain(`compile:${CONSUMER_ID}`);
      expect([...reviewAttempts.values()]).toEqual([1]);

      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      const producerState = state.tools.find(({ toolId }) => toolId === PRODUCER_ID);
      const producerBuild = producerState?.buildRef;
      const producerLiveReceipt = producerState?.currentReceiptRefs.find(
        ({ key }) => key === 'live',
      )?.ref;
      if (!producerBuild || !producerLiveReceipt)
        throw new Error('fixture expected the rejected producer build and live receipt');
      expect(
        readJson(
          join(
            terminal.runRoot,
            'mvp-reviews',
            PRODUCER_ID,
            `${producerLiveReceipt.sha256.slice('sha256:'.length)}.json`,
          ),
        ),
      ).toEqual(
        expect.objectContaining({
          review: expect.objectContaining({ status: 'revision_required' }),
        }),
      );
    });
  });

  it('keeps an invalid optional event citation nonfatal through verification repair', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let repairReached = false;
      let repairedPlanEventSeqs: number[] | undefined;
      let repairReceiptEvidence:
        | Extract<
            NonNullable<MasterDecisionInput['verificationFindings']>['payload']['entries'][number],
            { kind: 'mechanical_fact' }
          >
        | undefined;
      let repairFailureQuote = '';
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-invalid-optional-event-repair',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseMasterDecision = base.requestMasterDecision;
      if (!baseMasterDecision) throw new Error('fixture master decision is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          requestMasterDecision: async (decisionInput) => {
            if (decisionInput.verificationFindings) {
              repairReached = true;
              repairedPlanEventSeqs = decisionInput.current?.plan.payload.tools.find(
                ({ id }) => id === PRODUCER_ID,
              )?.candidate.eventSeqs;
              repairReceiptEvidence = decisionInput.verificationFindings.payload.entries.find(
                (entry): entry is NonNullable<typeof repairReceiptEvidence> =>
                  entry.kind === 'mechanical_fact',
              );
              repairFailureQuote =
                decisionInput.verificationFindings.payload.entries.find(
                  (entry) => entry.kind === 'untrusted_redacted_quote',
                )?.quote ?? '';
              throw new ProviderUnavailableError(
                new Error('fixture stops after reaching the valid repair master call'),
              );
            }

            const output = await baseMasterDecision(decisionInput);
            const producer = output.desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
            if (!producer) throw new Error('fixture expected the producer plan');
            producer.candidate.eventSeqs = [999];
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          runApiTool: async () => ({
            result: {
              ok: false as const,
              error: 'BAD_RESPONSE' as const,
              message: 'The fixture live check failed before semantic review.',
            },
            executionMechanism: 'fixture-api',
          }),
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairReached).toBe(true);
      expect(repairedPlanEventSeqs).toEqual([999]);
      expect(repairReceiptEvidence).toEqual(
        expect.objectContaining({
          requestSeqs: [1],
          eventSeqs: [],
          toolId: PRODUCER_ID,
        }),
      );
      expect(repairFailureQuote).toContain('BAD_RESPONSE');
      expect(repairFailureQuote).toContain('The fixture live check failed before semantic review.');
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(0);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('lets the master review two distinct returned failures on the same build', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const repairQuotes: string[] = [];
      let liveAttempts = 0;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-distinct-live-failures',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseMasterDecision = base.requestMasterDecision;
      if (!baseMasterDecision) throw new Error('fixture master decision is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestMasterDecision: async (decisionInput) => {
            if (!decisionInput.verificationFindings) return await baseMasterDecision(decisionInput);
            repairQuotes.push(
              decisionInput.verificationFindings.payload.entries
                .filter((entry) => entry.kind === 'untrusted_redacted_quote')
                .map(({ quote }) => quote)
                .join('\n'),
            );
            if (repairQuotes.length === 2) {
              throw new ProviderUnavailableError(
                new Error('fixture stops after the second distinct repair reached the master'),
              );
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: 'accepted',
              reason: 'Retry the same current artifact once because the returned failure changed.',
              desiredPlan: desiredFromCurrent(decisionInput),
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          runApiTool: async () => {
            liveAttempts += 1;
            return {
              result: {
                ok: false as const,
                error: 'BAD_RESPONSE' as const,
                message: 'The fixture returned the same top-level failure.',
                status: liveAttempts === 1 ? 400 : 503,
                requestStageFacts: [
                  {
                    requestIndex: 0,
                    stage: liveAttempts === 1 ? ('preparation' as const) : ('send' as const),
                    outcome: 'failed' as const,
                    ...(liveAttempts === 2 ? { httpStatus: 503 } : {}),
                  },
                ],
                responseBodyPreview:
                  liveAttempts === 1 ? 'fixture-invalid-input' : 'fixture-upstream-unavailable',
              },
              executionMechanism: 'fixture-api',
            };
          },
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairQuotes).toHaveLength(2);
      expect(repairQuotes[0]).toContain('HTTP status: 400');
      expect(repairQuotes[0]).toContain('preparation');
      expect(repairQuotes[0]).toContain('fixture-invalid-input');
      expect(repairQuotes[1]).toContain('HTTP status: 503');
      expect(repairQuotes[1]).toContain('send');
      expect(repairQuotes[1]).toContain('fixture-upstream-unavailable');
    });
  });

  it('keeps the standalone consumer result canonical and reviews its chain independently', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      let chainPreview = '';
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-empty-dependency-backed-result',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          if (reviewInput.toolId === CONSUMER_ID) {
            if (!reviewInput.resultEvidence.payload.chainEdgeId)
              return credibleBaselineMvpReview(reviewInput);
            chainPreview = reviewInput.resultEvidence.payload.actualResult.preview;
            return baselineMvpReview(reviewInput, 'revision_required');
          }
          return credibleBaselineMvpReview(reviewInput);
        },
      });

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          runApiTool: async ({ workflowPath }) => ({
            result: workflowPath.includes(`/${PRODUCER_ID}/`)
              ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
              : { ok: true as const, data: [] },
            executionMechanism: 'fixture-api',
          }),
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(chainPreview).toBe('[]');
      expect(events.filter((event) => event === `review:${CONSUMER_ID}`)).toHaveLength(2);
      expect(events.filter((event) => event === `compile:${CONSUMER_ID}`)).toHaveLength(1);
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [CONSUMER_NAME]]);
    });
  });

  it('hands a final chain-result rejection to the master after the edge review passed', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let baselineChainEvidenceRef = '';
      let completionChainEvidenceRef = '';
      let repairFacts: Array<Record<string, unknown>> = [];
      const rejection = 'The exact chained consumer result is not credible.';
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-completion-rejects-chain-result',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          if (reviewInput.resultEvidence.payload.chainEdgeId === EDGE_ID) {
            baselineChainEvidenceRef = reviewInput.resultEvidence.ref.sha256;
          }
          return credibleBaselineMvpReview(reviewInput);
        },
      });
      const baseMasterDecision = base.requestMasterDecision;
      if (!baseMasterDecision) throw new Error('fixture master decision is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          requestMasterDecision: async (decisionInput) => {
            if (!decisionInput.verificationFindings) return await baseMasterDecision(decisionInput);
            repairFacts = decisionInput.verificationFindings.payload.entries.flatMap((entry) =>
              entry.kind === 'untrusted_redacted_quote'
                ? [JSON.parse(entry.quote) as Record<string, unknown>]
                : [],
            );
            throw new ProviderUnavailableError(
              new Error('fixture stops after the chain rejection reaches master repair'),
            );
          },
          requestCompletionReview: async (reviewInput) => {
            const chainResult = reviewInput.toolResultEvidence?.find(
              ({ payload }) => payload.chainEdgeId === EDGE_ID,
            );
            if (!chainResult) throw new Error('fixture expected exact chain result evidence');
            completionChainEvidenceRef = chainResult.ref.sha256;
            return CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: 'failed',
              summary: 'The standalone results passed, but the exact chain result needs revision.',
              findings: [
                {
                  severity: 'blocking',
                  toolId: CONSUMER_ID,
                  message: rejection,
                  evidenceRefs: [chainResult.ref],
                },
              ],
              toolResultReviews: (reviewInput.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: result.payload.chainEdgeId === EDGE_ID ? 'revision_required' : 'credible',
                reason:
                  result.payload.chainEdgeId === EDGE_ID
                    ? rejection
                    : 'The standalone result remains credible.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: reviewInput.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports this claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            });
          },
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(baselineChainEvidenceRef).toBeTruthy();
      expect(completionChainEvidenceRef).toBe(baselineChainEvidenceRef);
      expect(repairFacts).toContainEqual(
        expect.objectContaining({
          stage: 'completion_review_finding',
          toolId: CONSUMER_ID,
          message: rejection,
          evidenceRefs: [expect.objectContaining({ sha256: completionChainEvidenceRef })],
        }),
      );
      expect(repairFacts).toContainEqual(
        expect.objectContaining({
          stage: 'completion_tool_result_review',
          toolId: CONSUMER_ID,
          chainEdgeId: EDGE_ID,
          status: 'revision_required',
          evidenceRefs: [expect.objectContaining({ sha256: completionChainEvidenceRef })],
        }),
      );
    });
  });

  it('does not publish a retained leaf whose cached MVP review requires revision', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      let repairAttempts = 0;
      let completionReviewCalls = 0;
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-retained-leaf-rejected',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) =>
          baselineMvpReview(reviewInput, 'revision_required'),
      });

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestMasterDecision: async (decisionInput) => {
            if (decisionInput.verificationFindings) {
              repairAttempts += 1;
            }
            const desiredPlan =
              decisionInput.phase === 'discovery'
                ? initialSingleToolDesiredPlan(decisionInput)
                : decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: 'accepted',
              reason: 'Keep the exact retained leaf build while considering the factual finding.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestCompletionReview: async (reviewInput) => {
            completionReviewCalls += 1;
            return CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: 'passed',
              summary: 'The retained mechanical result looks credible in this independent review.',
              findings: [],
              toolResultReviews: (reviewInput.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The bounded result has the expected fixture shape.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: reviewInput.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports the claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            });
          },
        },
      );

      expect(terminal.status).toBe('failed');
      expect(terminal.readyTools).toBe(0);
      expect(terminal.failedTools).toBe(1);
      expect(terminal.message).toContain('same unresolved tool plan');
      expect(repairAttempts).toBe(1);
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(1);
      expect(completionReviewCalls).toBe(0);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('tests a fresh repaired plan without attaching the prior build findings to its proposal', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const repairReason =
        'Build A returned the wrong core result; compile and verify a fresh Build B plan.';
      const reviewStatuses: Array<'credible' | 'revision_required'> = [];
      const compilerRevisionGuidance: Array<string | undefined> = [];
      let sawBuildAFinding = false;
      let plannerReceivedRepairGuidance = false;
      let sawPlanBProposalWithoutStaleFinding = false;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-fresh-plan-after-result-rejection',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          const status = reviewStatuses.length === 0 ? 'revision_required' : 'credible';
          reviewStatuses.push(status);
          return baselineMvpReview(reviewInput, status);
        },
      });
      const baseCompileFocusedTool = base.compileFocusedTool;
      if (!baseCompileFocusedTool) throw new Error('fixture compiler is missing');
      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          compileFocusedTool: async (compileInput) => {
            compilerRevisionGuidance.push(compileInput.revisionGuidance);
            return await baseCompileFocusedTool(compileInput);
          },
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestFocusedPlan: async (plannerInput) => {
            if (plannerInput.masterGuidance === repairReason) {
              plannerReceivedRepairGuidance = true;
            }
            return FocusedPlannerOutputSchema.parse({
              binding: {
                runId: plannerInput.run.runId,
                site: plannerInput.run.site,
                recordingSha256: plannerInput.run.recordingSha256,
                toolId: plannerInput.tool.id,
              },
              tool: {
                ...plannerInput.tool,
                strategy: {
                  kind: 'api',
                  reason: 'The focused recording contains one replayable API request.',
                },
              },
              chainEdges: plannerInput.incomingChainEdges,
              implementationPlan: focusedImplementation(plannerInput),
              reason: 'The focused request and expected result are explicit.',
            });
          },
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'rejected' | 'revised' = 'accepted';
            let reason = 'The current focused proposal is ready for compilation and verification.';
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialSingleToolDesiredPlan(decisionInput);
            } else if (decisionInput.verificationFindings) {
              expect(decisionInput.plannerProposals).toHaveLength(0);
              sawBuildAFinding = true;
              desiredPlan = desiredFromCurrent(decisionInput);
              const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!tool) throw new Error('fixture expected the producer plan');
              tool.compileContext.sharedHelperNotes = 'Build B must repair the rejected result.';
              outcome = 'revised';
              reason = repairReason;
            } else {
              desiredPlan =
                decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
              if (sawBuildAFinding && decisionInput.plannerProposals.length > 0) {
                expect(decisionInput.verificationFindings).toBeUndefined();
                expect(decisionInput.current?.plan.payload.decision.reason).toBe(repairReason);
                sawPlanBProposalWithoutStaleFinding = true;
              }
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome,
              reason,
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestCompletionReview: async (reviewInput) =>
            CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: 'passed',
              summary: 'Build B passed its own checks and demonstrates the fixture operation.',
              findings: [],
              toolResultReviews: (reviewInput.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The fresh Build B result has the expected fixture shape.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: reviewInput.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports the claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
        },
      );

      expect(terminal.status).toBe('completed');
      expect(terminal.readyTools).toBe(1);
      expect(terminal.failedTools).toBe(0);
      expect(sawBuildAFinding).toBe(true);
      expect(plannerReceivedRepairGuidance).toBe(true);
      expect(sawPlanBProposalWithoutStaleFinding).toBe(true);
      expect(reviewStatuses).toEqual(['revision_required', 'credible']);
      expect(compilerRevisionGuidance[1]).toContain(repairReason);
      expect(compilerRevisionGuidance[1]).toContain('Exact prior failure facts for this tool');
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(2);
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(2);
      expect(promotionBatches).toEqual([[PRODUCER_NAME]]);
    });
  });

  it('keeps the last working artifact after a repair violates the accepted contract', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const compileAttempts: Array<{
        stagingDir: string;
        priorToolDir?: string;
        revisionGuidance?: string;
      }> = [];
      let repairDecisions = 0;
      let baselineReviews = 0;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-retain-seed-after-failed-repair',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          baselineReviews += 1;
          return baselineMvpReview(
            reviewInput,
            baselineReviews === 1 ? 'credible' : 'revision_required',
          );
        },
      });
      const baseCompileFocusedTool = base.compileFocusedTool;
      if (!baseCompileFocusedTool) throw new Error('fixture compiler is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          compileFocusedTool: async (compileInput) => {
            compileAttempts.push({
              stagingDir: compileInput.stagingDir,
              priorToolDir: compileInput.priorToolDir,
              revisionGuidance: compileInput.revisionGuidance,
            });
            if (compileAttempts.length === 3)
              throw new ProviderUnavailableError(
                new Error('fixture stops after checking the retained seed'),
              );
            const focused = await baseCompileFocusedTool(compileInput);
            if (compileAttempts.length !== 2) return focused;
            return {
              ...focused,
              workflow: WorkflowSchema.parse({
                ...focused.workflow,
                requests: focused.workflow.requests.map((request, index) =>
                  index === 0 ? { ...request, recordingRequestSeq: 999 } : request,
                ),
              }),
            };
          },
          requestMasterDecision: async (decisionInput) => {
            const desiredPlan =
              decisionInput.phase === 'discovery'
                ? initialSingleToolDesiredPlan(decisionInput)
                : decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            if (decisionInput.verificationFindings) {
              repairDecisions += 1;
              const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!tool) throw new Error('fixture expected the producer plan');
              tool.compileContext.sharedHelperNotes = `repair attempt ${repairDecisions}`;
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: decisionInput.verificationFindings ? 'revised' : 'accepted',
              reason: decisionInput.verificationFindings
                ? `Repair the producer from factual failure ${repairDecisions}.`
                : 'Keep the current focused producer plan.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestCompletionReview: async (reviewInput) =>
            CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: 'failed',
              summary: 'Exercise a fresh repair after the first credible build.',
              findings: [
                {
                  severity: 'blocking',
                  message: 'Revise the fixture plan once before completion.',
                  evidenceRefs: [reviewInput.evidence.ref],
                },
              ],
              toolResultReviews: (reviewInput.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The first artifact is the last known-good repair seed.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: reviewInput.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The fixture retains supplied evidence.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairDecisions).toBe(2);
      expect(compileAttempts).toHaveLength(3);
      expect(compileAttempts[0]?.priorToolDir).toBeUndefined();
      expect(compileAttempts[1]?.priorToolDir).toBe(compileAttempts[0]?.stagingDir);
      expect(compileAttempts[2]?.priorToolDir).toBe(compileAttempts[0]?.stagingDir);
      expect(compileAttempts[2]?.revisionGuidance).toContain(
        'workflow request provenance does not match the accepted plan',
      );
    });
  });

  it('gives the first rejected artifact to the next fresh same-strategy repair', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const compileAttempts: Array<{ stagingDir: string; priorToolDir?: string }> = [];
      let repairDecisions = 0;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-seed-first-rejected-artifact',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseCompileFocusedTool = base.compileFocusedTool;
      if (!baseCompileFocusedTool) throw new Error('fixture compiler is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          compileFocusedTool: async (compileInput) => {
            compileAttempts.push({
              stagingDir: compileInput.stagingDir,
              priorToolDir: compileInput.priorToolDir,
            });
            if (compileAttempts.length === 2)
              throw new ProviderUnavailableError(
                new Error('fixture stops after observing the rejected draft seed'),
              );
            const focused = await baseCompileFocusedTool(compileInput);
            return {
              ...focused,
              workflow: WorkflowSchema.parse({
                ...focused.workflow,
                requests: focused.workflow.requests.map((request, index) =>
                  index === 0 ? { ...request, recordingRequestSeq: 999 } : request,
                ),
              }),
            };
          },
          requestMasterDecision: async (decisionInput) => {
            const desiredPlan =
              decisionInput.phase === 'discovery'
                ? initialSingleToolDesiredPlan(decisionInput)
                : decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            if (decisionInput.verificationFindings) {
              repairDecisions += 1;
              const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!tool) throw new Error('fixture expected the producer plan');
              tool.compileContext.sharedHelperNotes = 'Repair the rejected first draft in place.';
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: decisionInput.verificationFindings ? 'revised' : 'accepted',
              reason: decisionInput.verificationFindings
                ? 'Correct only the exact provenance defect in the rejected draft.'
                : 'Keep the focused producer plan.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairDecisions).toBe(1);
      expect(compileAttempts).toHaveLength(2);
      expect(compileAttempts[0]?.priorToolDir).toBeUndefined();
      expect(compileAttempts[1]?.priorToolDir).toBe(compileAttempts[0]?.stagingDir);
      expect(events).not.toContain(`review:${PRODUCER_ID}`);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('stops repeated executable proposals but reviews changed implementation plans', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const revisedDescription = 'Search the revised fixture catalog.';
      let repairDecisions = 0;
      let repairPlannerCalls = 0;
      let reviewedFocusedProposals = 0;
      const repairPlannerGuidance: string[] = [];
      const repairPlanDescriptions: string[] = [];
      const reviewedImplementationHashes: string[] = [];
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-focused-plan-no-progress',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) =>
          baselineMvpReview(reviewInput, 'revision_required'),
      });

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestFocusedPlan: async (plannerInput) => {
            let implementationPlan = focusedImplementation(plannerInput);
            if (plannerInput.tool.candidate.description === revisedDescription) {
              repairPlannerCalls += 1;
              repairPlannerGuidance.push(plannerInput.masterGuidance ?? '');
              repairPlanDescriptions.push(plannerInput.tool.candidate.description);
              if (repairPlannerCalls >= 2) {
                implementationPlan = ImplementationPlanPayloadSchema.parse({
                  ...implementationPlan,
                  outputGuidance: 'Return the revised current fixture catalog result.',
                });
              }
            }
            return FocusedPlannerOutputSchema.parse({
              binding: {
                runId: plannerInput.run.runId,
                site: plannerInput.run.site,
                recordingSha256: plannerInput.run.recordingSha256,
                toolId: plannerInput.tool.id,
              },
              tool: {
                ...plannerInput.tool,
                strategy: {
                  kind: 'api',
                  reason: 'The focused recording contains one replayable API request.',
                },
              },
              chainEdges: plannerInput.incomingChainEdges,
              implementationPlan,
              reason: 'The focused request and expected result are explicit.',
            });
          },
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'rejected' | 'revised' = 'accepted';
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialSingleToolDesiredPlan(decisionInput);
            } else if (decisionInput.verificationFindings) {
              expect(decisionInput.plannerProposals).toHaveLength(0);
              desiredPlan = desiredFromCurrent(decisionInput);
              repairDecisions += 1;
              outcome = 'revised';
              const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!tool) throw new Error('fixture expected the producer plan');
              tool.candidate.description = revisedDescription;
            } else if (repairDecisions > 0 && decisionInput.plannerProposals.length > 0) {
              desiredPlan = desiredFromCurrent(decisionInput);
              reviewedFocusedProposals += 1;
              const proposal = decisionInput.plannerProposals[0];
              if (!proposal) throw new Error('fixture expected a focused proposal');
              reviewedImplementationHashes.push(proposal.payload.implementationPlan.ref.sha256);
              const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!tool) throw new Error('fixture expected the producer plan');
              tool.candidate.rationale = `Paraphrased rationale ${reviewedFocusedProposals} with no compile-input change.`;
              tool.candidate.confidence = reviewedFocusedProposals === 1 ? 0.61 : 0.62;
              outcome = 'rejected';
            } else {
              desiredPlan =
                decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome,
              reason:
                outcome === 'revised'
                  ? 'Revise the tool description and request a fresh focused plan.'
                  : outcome === 'rejected'
                    ? `Paraphrased guidance ${reviewedFocusedProposals}: keep the public tool unchanged and propose a corrected implementation.`
                    : 'The fixture plan remains supported.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
        },
      );

      expect(terminal.status).toBe('failed');
      expect(terminal.message).toContain('focused planning stopped');
      expect(terminal.readyTools).toBe(0);
      expect(terminal.failedTools).toBe(1);
      expect(repairDecisions).toBe(1);
      expect(repairPlannerCalls).toBe(3);
      expect(reviewedFocusedProposals).toBe(2);
      expect(repairPlanDescriptions).toEqual([
        revisedDescription,
        revisedDescription,
        revisedDescription,
      ]);
      expect(repairPlannerGuidance[1]).not.toBe(repairPlannerGuidance[2]);
      expect(reviewedImplementationHashes).toHaveLength(2);
      expect(reviewedImplementationHashes[0]).not.toBe(reviewedImplementationHashes[1]);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(1);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('keeps a published producer MVP when its dependent compiler loses the provider', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const installedTools = new Set<string>();
      const recordingPath = syntheticSessionPath(root);

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        lifecycleFailureFixture({
          runId: 'run-e2e-dependent-provider-failure',
          events,
          promotionBatches,
          installedTools,
          failCompileToolId: CONSUMER_ID,
          requestBaselineMvpReview: credibleBaselineMvpReview,
        }),
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(terminal.readyTools).toBe(1);
      expect(terminal.failedTools).toBe(1);
      expect(promotionBatches).toEqual([[PRODUCER_NAME]]);
      expect(installedTools).toEqual(new Set([PRODUCER_NAME]));
      expect(events.indexOf(`review:${PRODUCER_ID}`)).toBeLessThan(
        events.indexOf(`promote:${PRODUCER_NAME}`),
      );
      expect(events.indexOf(`promote:${PRODUCER_NAME}`)).toBeLessThan(
        events.indexOf(`compile:${CONSUMER_ID}`),
      );
      expect(readJson(join(terminal.runRoot, 'terminal.json'))).toEqual(terminal);
    });
  });

  it('retains downstream artifacts without republishing them after a revised producer is rejected', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const producerReviewStatuses: Array<'credible' | 'revision_required'> = [];
      const producerCompileRevisions: Array<{
        stagingDir: string;
        priorToolDir?: string;
        revisionGuidance?: string;
      }> = [];
      let repairDecisions = 0;
      const recordingPath = threeToolSyntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-rebound-producer-rejected',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          const status =
            reviewInput.toolId === PRODUCER_ID && producerReviewStatuses.length > 0
              ? 'revision_required'
              : 'credible';
          if (reviewInput.toolId === PRODUCER_ID) producerReviewStatuses.push(status);
          return baselineMvpReview(reviewInput, status);
        },
      });
      const baseCompileFocusedTool = base.compileFocusedTool;
      if (!baseCompileFocusedTool) throw new Error('fixture compiler is missing');

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          compileFocusedTool: async (compileInput) => {
            if (compileInput.tool.id === PRODUCER_ID)
              producerCompileRevisions.push({
                stagingDir: compileInput.stagingDir,
                priorToolDir: compileInput.priorToolDir,
                revisionGuidance: compileInput.revisionGuidance,
              });
            return await baseCompileFocusedTool(compileInput);
          },
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate, consumerCandidate, leafCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestMasterDecision: async (decisionInput) => {
            const repairingWithoutPlans =
              decisionInput.verificationFindings && decisionInput.plannerProposals.length === 0;
            if (repairingWithoutPlans) {
              repairDecisions += 1;
              if (repairDecisions > 1) {
                throw new ProviderUnavailableError(
                  new Error('fixture stops after the rebound producer rejection'),
                );
              }
            }
            const desiredPlan =
              decisionInput.phase === 'discovery'
                ? initialThreeToolDesiredPlan(decisionInput)
                : decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            if (repairingWithoutPlans) {
              const producer = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!producer) throw new Error('fixture expected the producer plan');
              producer.compileContext.sharedHelperNotes =
                'Recompile the producer while retaining its downstream tool designs.';
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: repairingWithoutPlans ? 'revised' : 'accepted',
              reason: repairingWithoutPlans
                ? 'Recompile only the producer and recheck retained downstream tools.'
                : 'The dependency-ordered fixture plan remains supported.',
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          runApiTool: async ({ workflowPath, parameters }) => {
            if (workflowPath.includes(`/${PRODUCER_ID}/`)) {
              return {
                result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
                executionMechanism: 'fixture-api',
              };
            }
            if (workflowPath.includes(`/${LEAF_ID}/`)) {
              return {
                result: {
                  ok: false as const,
                  error: 'BAD_RESPONSE' as const,
                  message: 'Fixture leaf requests a producer revision.',
                },
                executionMechanism: 'fixture-api',
              };
            }
            return {
              result: {
                ok: true as const,
                data: { id: parameters.item_id, name: 'Fixture item' },
              },
              executionMechanism: 'fixture-api',
            };
          },
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairDecisions).toBe(2);
      expect(producerReviewStatuses).toEqual(['credible', 'revision_required']);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(2);
      expect(producerCompileRevisions).toHaveLength(2);
      expect(producerCompileRevisions[0]?.priorToolDir).toBeUndefined();
      expect(producerCompileRevisions[1]?.priorToolDir).toBe(
        producerCompileRevisions[0]?.stagingDir,
      );
      expect(producerCompileRevisions[1]?.revisionGuidance).toBeTruthy();
      expect(events.filter((event) => event === `compile:${CONSUMER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `compile:${LEAF_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `review:${CONSUMER_ID}`)).toHaveLength(2);
      expect(events).not.toContain(`review:${LEAF_ID}`);
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [CONSUMER_NAME]]);

      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      expect(state.tools.find(({ toolId }) => toolId === CONSUMER_ID)?.buildRef).toBeDefined();
      expect(state.tools.find(({ toolId }) => toolId === LEAF_ID)?.buildRef).toBeDefined();
    });
  });

  it('does not let one rejected incoming chain poison an independent downstream chain', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      let completionReviewCalls = 0;
      let repairDecisions = 0;
      let consumerChainReviews = 0;
      let revisedConsumerPreview = '';
      const recordingPath = threeToolSyntheticSessionPath(root);
      const revisedChainEdge = {
        ...chainEdge,
        producerResultPath: 'items[0].alternative_id',
      };
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-published-middle-revised-chain-fails',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          if (reviewInput.toolId !== CONSUMER_ID) return credibleBaselineMvpReview(reviewInput);
          if (!reviewInput.resultEvidence.payload.chainEdgeId)
            return credibleBaselineMvpReview(reviewInput);
          consumerChainReviews += 1;
          if (consumerChainReviews === 1) return credibleBaselineMvpReview(reviewInput);
          revisedConsumerPreview = reviewInput.resultEvidence.payload.actualResult.preview;
          return baselineMvpReview(reviewInput, 'revision_required');
        },
      });

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate, consumerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'revised' = 'accepted';
            let reason = 'Keep the current dependency-ordered fixture plan.';
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(decisionInput);
            } else if (decisionInput.verificationFindings) {
              repairDecisions += 1;
              desiredPlan = desiredFromCurrent(decisionInput);
              if (repairDecisions === 1) {
                desiredPlan.tools.push({
                  id: LEAF_ID,
                  candidate: structuredClone(leafCandidate),
                  compileContext: decisionInput.discovery.detectorSharedContext,
                  evidenceRefs: [decisionInput.discovery.evidence.ref],
                  strategy: {
                    kind: 'api',
                    reason: 'The recording contains one replayable request.',
                  },
                });
                desiredPlan.buildWaves = [[PRODUCER_ID], [CONSUMER_ID], [LEAF_ID]];
                desiredPlan.chainEdges = [revisedChainEdge, leafChainEdge];
                outcome = 'revised';
                reason =
                  'Add the leaf while changing only the already-published middle tool incoming chain.';
              } else {
                reason = 'Keep the unchanged plan while retaining the exact rejected edge review.';
              }
            } else {
              desiredPlan =
                decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome,
              reason,
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: {
                async analyze() {
                  return { text: JSON.stringify(output) };
                },
              },
            });
          },
          requestCompletionReview: async (reviewInput) => {
            completionReviewCalls += 1;
            return CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: 'failed',
              summary: 'The fixture asks the master to add the discovered leaf operation.',
              findings: [
                {
                  severity: 'blocking',
                  message: 'Add the leaf tool and revise the middle tool incoming chain.',
                  evidenceRefs: [reviewInput.evidence.ref],
                },
              ],
              toolResultReviews: (reviewInput.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The current two-tool MVP result is credible.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: reviewInput.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports the current-tool claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            });
          },
          runApiTool: async ({ workflowPath, parameters }) => {
            if (workflowPath.includes(`/${PRODUCER_ID}/`)) {
              return {
                result: {
                  ok: true as const,
                  data: { items: [{ id: 'item-1', alternative_id: 'empty-item' }] },
                },
                executionMechanism: 'fixture-api',
              };
            }
            if (workflowPath.includes(`/${LEAF_ID}/`)) {
              return {
                result: { ok: true as const, data: { rendered: parameters.item_id } },
                executionMechanism: 'fixture-api',
              };
            }
            return {
              result:
                parameters.item_id === 'empty-item'
                  ? { ok: true as const, data: [] }
                  : {
                      ok: true as const,
                      data: { id: parameters.item_id, name: 'Fixture item' },
                    },
              executionMechanism: 'fixture-api',
            };
          },
        },
      );

      expect(terminal.status).toBe('failed');
      expect(terminal.message).toContain('same unresolved tool plan');
      expect(completionReviewCalls).toBe(1);
      expect(repairDecisions).toBe(2);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `compile:${CONSUMER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `compile:${LEAF_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `review:${CONSUMER_ID}`)).toHaveLength(3);
      expect(events.filter((event) => event === `review:${LEAF_ID}`)).toHaveLength(2);
      expect(revisedConsumerPreview).toBe('[]');
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [CONSUMER_NAME], [LEAF_NAME]]);

      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      const consumerState = state.tools.find(({ toolId }) => toolId === CONSUMER_ID);
      const leafState = state.tools.find(({ toolId }) => toolId === LEAF_ID);
      expect(consumerState?.buildRef).toBeDefined();
      expect(leafState?.buildRef).toBeDefined();
      const currentChainRef = consumerState?.currentReceiptRefs.find(
        ({ key }) => key === `chain:${EDGE_ID}`,
      )?.ref;
      if (!currentChainRef) throw new Error('fixture expected the revised chain receipt');
      expect(readJson(join(terminal.runRoot, 'journal', currentChainRef.path))).toEqual(
        expect.objectContaining({
          check: 'chain',
          chainEdgeId: EDGE_ID,
          status: 'passed',
          facts: expect.arrayContaining([
            expect.objectContaining({ kind: 'invocation', status: 'passed' }),
          ]),
        }),
      );
      const archivedReceipts = state.supersededReceiptRefs.map((ref) =>
        readJson(join(terminal.runRoot, 'journal', ref.path)),
      ) as Array<{ check?: string; chainEdgeId?: string; status?: string }>;
      expect(
        archivedReceipts.some(
          (receipt) => receipt.check === 'chain' && receipt.chainEdgeId === EDGE_ID,
        ),
      ).toBe(true);
    });
  });

  it('records a timed-out browser chain and revises wiring without rebuilding the tool', async () => {
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
          requestBaselineMvpReview: async (input) => credibleBaselineMvpReview(input),
          requestParameterSelectionAdvice: async () => {
            throw new Error('Optional fixture parameter advice is unavailable.');
          },
          runLiveFinesse: async ({ provider }) => ({
            status: 'inconclusive',
            provider,
            attempts: 0,
            completedReview: false,
            artifacts: {},
            message: 'Fixture live finesse is intentionally unavailable.',
            durationMs: 1,
          }),
          requestCompletionReview: async (input) =>
            CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'The revised tools have current factual receipts.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
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
      expect(playbookCalls).toBe(2);
      expect(consumerCompiles).toBe(1);

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
