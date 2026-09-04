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
  type ApiResearchInput,
  type BaselineMvpReviewInput,
  BaselineMvpReviewOutputSchema,
  CompletionReviewOutputSchema,
  type FocusedPlannerInput,
  FocusedPlannerOutputSchema,
  type MasterDecisionInput,
  MasterDecisionOutputSchema,
  type ParameterSelectionAdvisorInput,
  ParameterSelectionAdvisorOutputSchema,
  type ToolSelectionAdvisorInput,
  ToolSelectionAdvisorOutputSchema,
} from '../src/imprint/master-teach-agent-contracts.ts';
import {
  apiResearchInputsSha256,
  requestMasterDecision as requestValidatedMasterDecision,
} from '../src/imprint/master-teach-agents.ts';
import {
  API_RESEARCH_INSPECTION_EVIDENCE_CHARACTER_BUDGET,
  runFreshMasterTeach,
  verificationForResearchParameters,
} from '../src/imprint/master-teach-controller.ts';
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
const PRODUCER_NAME = 'search_items';
const CONSUMER_NAME = 'get_item';
const LEAF_NAME = 'render_item';
const PRODUCER_ID = PRODUCER_NAME;
const CONSUMER_ID = CONSUMER_NAME;
const LEAF_ID = LEAF_NAME;
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

function largeCatalogSyntheticSessionPath(root: string): { path: string; lastRequestSeq: number } {
  const path = syntheticSessionPath(root);
  const session = SessionSchema.parse(readJson(path));
  const extraRequests = Array.from({ length: 300 }, (_, index) => {
    const seq = index + 10;
    return {
      seq,
      timestamp: 300 + index,
      method: 'POST' as const,
      url: `https://fixture.invalid/api/neighbor/${seq}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq }),
      resourceType: 'Fetch' as const,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        body: JSON.stringify({ seq, usable: seq === 309 }),
      },
    };
  });
  session.requests.push(...extraRequests);
  writeFileSync(path, `${JSON.stringify(SessionSchema.parse(session))}\n`);
  return { path, lastRequestSeq: 309 };
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

async function fixtureApiResearchStep(researchInput: ApiResearchInput) {
  const tool = researchInput.tool;
  const requestSeqs = [
    ...tool.candidate.dependencySeqs.filter((seq) => seq === 4),
    tool.candidate.requestSeqs[0],
  ].filter((seq): seq is number => seq !== undefined);
  const candidate = {
    workflow: WorkflowSchema.parse({
      toolName: tool.candidate.toolName,
      intent: { description: tool.candidate.description },
      parameters: tool.candidate.likelyParams.map(({ name, type, description }) => ({
        name,
        type,
        description,
      })),
      requests: requestSeqs.map((recordingRequestSeq) => ({
        recordingRequestSeq,
        method: 'GET',
        url:
          recordingRequestSeq === 4
            ? 'https://fixture.invalid/bootstrap'
            : tool.id === PRODUCER_ID
              ? 'https://fixture.invalid/api/items'
              : tool.id === CONSUMER_ID
                ? 'https://fixture.invalid/api/items/${param.item_id}'
                : 'https://fixture.invalid/api/render/${param.item_id}',
        headers: {
          accept: recordingRequestSeq === 4 ? 'text/html' : 'application/json',
        },
      })),
      site: SITE,
    }),
    parameterValues: Object.fromEntries(
      tool.candidate.likelyParams.map(({ name, type }) => [
        name,
        type === 'number' ? 1 : type === 'boolean' ? true : 'item-1',
      ]),
    ),
  };
  const observation = researchInput.observations.at(-1);
  return {
    binding: {
      runId: researchInput.run.runId,
      recordingSha256: researchInput.run.recordingSha256,
      toolName: tool.candidate.toolName,
      compileInputsSha256: apiResearchInputsSha256(tool),
    },
    action: observation ? ('proven' as const) : ('test' as const),
    candidate,
    ...(observation ? { basedOnObservationId: observation.id } : {}),
    reason: observation
      ? 'The fixture request returned the promised core data.'
      : 'Test the exact recorded fixture request.',
  };
}

async function fixtureApiResearchTool(input: {
  workflowPath: string;
  parameters: Record<string, string | number | boolean>;
}) {
  const producer = input.workflowPath.includes(`/${PRODUCER_ID}/`);
  const leaf = input.workflowPath.includes(`/${LEAF_ID}/`);
  return {
    result: producer
      ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
      : leaf
        ? { ok: true as const, data: { rendered: input.parameters.item_id } }
        : {
            ok: true as const,
            data: { id: input.parameters.item_id, name: 'Fixture item' },
          },
    executionMechanism: 'fixture-api-research',
  };
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
        recallToolNames: [],
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
    requestApiResearchStep: fixtureApiResearchStep,
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
    runApiResearchTool: fixtureApiResearchTool,
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
  it('never labels unmatched researcher parameters as a recorded baseline', () => {
    const implementation = ImplementationPlanPayloadSchema.parse({
      version: 1,
      toolId: 'parameter-case-fixture',
      strategyKind: 'api',
      requestProvenance: [{ artifactRequestIndex: 0, recordingRequestSeq: 1 }],
      parameterMappings: [
        {
          parameterName: 'query',
          artifactRequestIndices: [0],
          guidance: 'Apply the query to the request.',
        },
      ],
      responseDependencies: [],
      resultSources: [{ artifactRequestIndex: 0, source: 'Return the matching items.' }],
      outputGuidance: 'Return matching items.',
      verificationCases: [
        {
          id: 'recorded_case',
          check: 'replay',
          parameterValueOrigin: 'recorded_baseline',
          parameterValues: [{ parameterName: 'query', value: 'recorded' }],
          expectedResult: 'Recorded-query matches.',
          provenance: {
            recordingRequestSeqs: [1],
            recordingEventSeqs: [],
            evidenceRefs: [
              {
                path: `objects/json/${'1'.repeat(64)}.json`,
                sha256: `sha256:${'1'.repeat(64)}`,
              },
            ],
          },
        },
        {
          id: 'live_case',
          check: 'live',
          parameterValueOrigin: 'synthetic_live',
          parameterValues: [{ parameterName: 'query', value: 'synthetic' }],
          expectedResult: 'Live-query matches.',
          provenance: {
            recordingRequestSeqs: [1],
            recordingEventSeqs: [],
            evidenceRefs: [
              {
                path: `objects/json/${'2'.repeat(64)}.json`,
                sha256: `sha256:${'2'.repeat(64)}`,
              },
            ],
          },
        },
      ],
    });

    expect(verificationForResearchParameters(implementation, { query: 'recorded' })?.id).toBe(
      'recorded_case',
    );
    expect(verificationForResearchParameters(implementation, { query: 'synthetic' })?.id).toBe(
      'live_case',
    );
    expect(
      verificationForResearchParameters(implementation, { query: 'researcher-chosen' })?.id,
    ).toBe('live_case');
  });

  it('finishes every request researcher before focused planning starts', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-research-before-planning',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !basePlanner) throw new Error('fixture research roles are missing');
      const proven = new Set<string>();
      let plannerCalls = 0;

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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (decision.action === 'proven') proven.add(input.tool.id);
            return decision;
          },
          requestFocusedPlan: async (input) => {
            plannerCalls += 1;
            expect([...proven].sort()).toEqual([CONSUMER_ID, PRODUCER_ID].sort());
            const apiResearch = input.apiResearch ?? [];
            expect(apiResearch).toHaveLength(2);
            expect(apiResearch.every(({ status }) => status === 'proven')).toBeTrue();
            expect(
              apiResearch.every(({ candidate, observation }) =>
                Boolean(candidate && observation?.result.ok),
              ),
            ).toBeTrue();
            return await basePlanner(input);
          },
        },
      );

      expect(plannerCalls).toBe(2);
      expect(terminal.status).toBe('failed');
    });
  });

  it('pages to omitted requests and sends sequential inspections without repeating prior evidence', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recording = largeCatalogSyntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-research-catalog-pagination',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      if (!baseResearch) throw new Error('fixture API researcher is missing');
      let catalogTurns = 0;
      let inspectedAcrossPages = false;
      let sawEarlierInspectionDelta = false;
      let sawLaterInspectionDelta = false;

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recording.path,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          requestApiResearchStep: async (input, _agent, retainedTurnDelta) => {
            const decision = await baseResearch(input);
            if (retainedTurnDelta?.kind === 'inspection') {
              const deltaJson = JSON.stringify(retainedTurnDelta.relevantEvidence);
              expect(deltaJson.length).toBeLessThanOrEqual(
                API_RESEARCH_INSPECTION_EVIDENCE_CHARACTER_BUDGET,
              );
              if (retainedTurnDelta.inspectedRequestSeqs.includes(2)) {
                expect(retainedTurnDelta.inspectedRequestSeqs).toEqual([2]);
                expect(deltaJson).toContain('https://fixture.invalid/api/items/item-1');
                expect(deltaJson).not.toContain(`/api/neighbor/${recording.lastRequestSeq}`);
                sawEarlierInspectionDelta = true;
              }
              if (retainedTurnDelta.inspectedRequestSeqs.includes(recording.lastRequestSeq)) {
                expect(retainedTurnDelta.inspectedRequestSeqs).toEqual([recording.lastRequestSeq]);
                expect(deltaJson).toContain(`/api/neighbor/${recording.lastRequestSeq}`);
                expect(deltaJson).not.toContain('https://fixture.invalid/api/items/item-1');
                sawLaterInspectionDelta = true;
              }
            }
            if (
              input.tool.candidate.toolName === PRODUCER_NAME &&
              input.observations.length === 0 &&
              !input.inspectedRequestSeqs?.includes(recording.lastRequestSeq)
            ) {
              if (
                !input.requestCatalog?.some(
                  ({ recordingRequestSeq }) => recordingRequestSeq === recording.lastRequestSeq,
                )
              ) {
                expect(input.requestCatalogPage?.hasMore).toBeTrue();
                catalogTurns += 1;
                return {
                  binding: decision.binding,
                  action: 'catalog' as const,
                  reason: 'Read the next compact page to find the relevant neighboring call.',
                };
              }
              expect(input.requestCatalogPage?.offset).toBeGreaterThan(0);
              expect(
                input.requestCatalog?.some(({ recordingRequestSeq }) => recordingRequestSeq === 2),
              ).toBeFalse();
              if (!input.inspectedRequestSeqs?.includes(2)) {
                return {
                  binding: decision.binding,
                  action: 'inspect' as const,
                  requestedRequestSeqs: [2],
                  reason: 'Inspect the relevant call remembered from an earlier catalog page.',
                };
              }
              return {
                binding: decision.binding,
                action: 'inspect' as const,
                requestedRequestSeqs: [recording.lastRequestSeq],
                reason: 'Inspect the newly found call without repeating the earlier evidence.',
              };
            }
            if (
              input.tool.candidate.toolName === PRODUCER_NAME &&
              input.inspectedRequestSeqs?.includes(recording.lastRequestSeq)
            ) {
              expect(input.inspectedRequestSeqs).toContain(2);
              expect(JSON.stringify(input.evidence)).toContain(
                `/api/neighbor/${recording.lastRequestSeq}`,
              );
              inspectedAcrossPages = true;
            }
            return decision;
          },
        },
      );

      expect(catalogTurns).toBeGreaterThan(0);
      expect(inspectedAcrossPages).toBeTrue();
      expect(sawEarlierInspectionDelta).toBeTrue();
      expect(sawLaterInspectionDelta).toBeTrue();
      expect(terminal.status).toBe('failed');
    });
  });

  it('returns a partial MVP to the same researcher with master-selected sibling evidence', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-partial-research-follow-up',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !basePlanner)
        throw new Error('fixture research roles are missing');

      let returnedPartial = false;
      let sawFollowUp = false;
      let requestedNeighborInspection = false;
      let sawNeighborInspection = false;
      let expectedRefreshedProducerHash: string | undefined;
      let sawRefreshedProducer = false;
      let plannerCalls = 0;
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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (
              input.tool.candidate.toolName === PRODUCER_NAME &&
              expectedRefreshedProducerHash &&
              decision.binding.compileInputsSha256 === expectedRefreshedProducerHash
            ) {
              sawRefreshedProducer = true;
            }
            if (
              input.tool.candidate.toolName === CONSUMER_NAME &&
              !input.followUp &&
              input.observations.length === 0
            ) {
              if (!requestedNeighborInspection) {
                requestedNeighborInspection = true;
                expect(
                  input.requestCatalog?.some(
                    ({ recordingRequestSeq }) => recordingRequestSeq === 1,
                  ),
                ).toBeTrue();
                return {
                  binding: decision.binding,
                  action: 'inspect' as const,
                  requestedRequestSeqs: [1],
                  reason: 'Inspect the neighboring producer request before testing the consumer.',
                };
              }
              expect(input.inspectedRequestSeqs).toContain(1);
              expect(JSON.stringify(input.evidence)).toContain('https://fixture.invalid/api/items');
              sawNeighborInspection = true;
            }
            if (
              input.tool.candidate.toolName === CONSUMER_NAME &&
              decision.action === 'proven' &&
              !input.followUp &&
              !returnedPartial
            ) {
              returnedPartial = true;
              return {
                ...decision,
                action: 'partial' as const,
                missingProof: ['Confirm the producer identifier feeds the consumer request.'],
                reason: 'The consumer MVP works, but its producer link still needs proof.',
              };
            }
            if (input.tool.candidate.toolName === CONSUMER_NAME && input.followUp) {
              sawFollowUp = true;
              expect(input.researchPhase).toBe('follow_up');
              expect(input.followUp.masterDirection).toContain('producer');
              expect(input.followUp.siblingResearch.map(({ toolName }) => toolName)).toEqual([
                PRODUCER_NAME,
              ]);
              expect(input.followUp.siblingResearch[0]?.researchInputsSha256).toBe(
                expectedRefreshedProducerHash,
              );
              expect(input.followUp.relevantRequestSeqs).toEqual([1]);
              expect(input.evidence.payload.entries.length).toBeGreaterThan(1);
            }
            return decision;
          },
          requestMasterDecision: async (input, agent, options) => {
            const partial = (input.apiResearch ?? []).find(
              ({ toolName, status }) => toolName === CONSUMER_NAME && status === 'partial',
            );
            if (input.decisionPurpose === 'research_review' && partial) {
              const desiredPlan = desiredFromCurrent(input);
              const producer = desiredPlan.tools.find(
                ({ candidate }) => candidate.toolName === PRODUCER_NAME,
              );
              if (!producer) throw new Error('fixture plan lost its producer');
              producer.candidate.expectedOutput =
                'Fixture items with identifiers required by the selected consumer.';
              expectedRefreshedProducerHash = apiResearchInputsSha256(producer);
              return MasterDecisionOutputSchema.parse({
                binding: input.current?.run ?? input.discovery.run,
                outcome: 'accepted',
                reason: 'Return the working consumer MVP for one focused chain follow-up.',
                recallToolNames: [],
                researchFollowUps: [
                  {
                    toolName: CONSUMER_NAME,
                    instruction:
                      'Use the producer handoff and request 1 to prove the identifier flow.',
                    missingProof: partial.missingProof,
                    relevantToolNames: [PRODUCER_NAME],
                    relevantRequestSeqs: [1],
                  },
                ],
                desiredPlan,
              });
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannerCalls += 1;
            expect(sawFollowUp).toBeTrue();
            expect((input.apiResearch ?? []).every(({ status }) => status === 'proven')).toBeTrue();
            return await basePlanner(input);
          },
        },
      );

      expect(returnedPartial).toBeTrue();
      expect(sawFollowUp).toBeTrue();
      expect(requestedNeighborInspection).toBeTrue();
      expect(sawNeighborInspection).toBeTrue();
      expect(sawRefreshedProducer).toBeTrue();
      expect(plannerCalls).toBe(2);
      expect(terminal.status).toBe('failed');
    });
  });

  it('does not refresh producer research when only the consumer input mapping changes', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-side-local-research-obligations',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      if (!baseResearch || !baseMaster) throw new Error('fixture research roles are missing');
      let producerTurns = 0;
      let returnedPartial = false;
      let sawRemappedConsumer = false;
      let initialProducerResearchSha256: string | undefined;

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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (input.tool.candidate.toolName === PRODUCER_NAME) {
              producerTurns += 1;
              initialProducerResearchSha256 ??= decision.binding.compileInputsSha256;
            }
            if (
              input.tool.candidate.toolName === CONSUMER_NAME &&
              decision.action === 'proven' &&
              !input.followUp &&
              !returnedPartial
            ) {
              returnedPartial = true;
              return {
                ...decision,
                action: 'partial' as const,
                missingProof: ['Confirm which public consumer input populates the request.'],
                reason: 'The MVP works while its selected consumer input mapping needs review.',
              };
            }
            if (input.tool.candidate.toolName === CONSUMER_NAME && input.followUp) {
              expect(input.requiredLinks).toContainEqual({
                role: 'consumer',
                toolName: CONSUMER_NAME,
                parameter: 'alternate_item_id',
              });
              expect(input.followUp.siblingResearch[0]?.researchInputsSha256).toBe(
                initialProducerResearchSha256,
              );
              sawRemappedConsumer = true;
            }
            return decision;
          },
          requestMasterDecision: async (input, agent, options) => {
            if (input.phase === 'discovery') {
              const output = await baseMaster(input, agent, options);
              const consumer = output.desiredPlan.tools.find(
                ({ candidate }) => candidate.toolName === CONSUMER_NAME,
              );
              if (!consumer) throw new Error('fixture plan lost its consumer');
              consumer.candidate.likelyParams.push({
                name: 'alternate_item_id',
                type: 'string',
                description: 'Alternate public identifier input.',
              });
              return output;
            }
            const partial = (input.apiResearch ?? []).find(
              ({ toolName, status }) => toolName === CONSUMER_NAME && status === 'partial',
            );
            if (input.decisionPurpose === 'research_review' && partial) {
              const desiredPlan = desiredFromCurrent(input);
              const edge = desiredPlan.chainEdges.find(({ id }) => id === EDGE_ID);
              if (!edge) throw new Error('fixture plan lost its chain edge');
              edge.consumerParameter = 'alternate_item_id';
              return MasterDecisionOutputSchema.parse({
                binding: input.current?.run ?? input.discovery.run,
                outcome: 'accepted',
                reason: 'Revise only the consumer-side public input mapping and verify it.',
                recallToolNames: [],
                researchFollowUps: [
                  {
                    toolName: CONSUMER_NAME,
                    instruction: 'Prove the revised consumer input mapping.',
                    missingProof: partial.missingProof,
                    relevantToolNames: [PRODUCER_NAME],
                    relevantRequestSeqs: [2],
                  },
                ],
                desiredPlan,
              });
            }
            return await baseMaster(input, agent, options);
          },
        },
      );

      expect(returnedPartial).toBeTrue();
      expect(sawRemappedConsumer).toBeTrue();
      expect(producerTurns).toBe(2);
      expect(terminal.status).toBe('failed');
    });
  });

  it('continues mutually directed retained follow-ups without fresh stale passes', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-retained-follow-up-no-refresh',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !basePlanner) {
        throw new Error('fixture research roles are missing');
      }

      const returnedPartial = new Set<string>();
      const initialTurns = new Map<string, number>();
      const retainedFollowUps = new Map<string, number>();
      const plannedNames: string[] = [];
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
          requestApiResearchStep: async (input, agent, retainedTurnDelta) => {
            const toolName = input.tool.candidate.toolName;
            if (retainedTurnDelta?.kind === 'master_follow_up') {
              retainedFollowUps.set(toolName, (retainedFollowUps.get(toolName) ?? 0) + 1);
            }
            if (!input.followUp) initialTurns.set(toolName, (initialTurns.get(toolName) ?? 0) + 1);
            const decision = await baseResearch(input, agent, retainedTurnDelta);
            if (!input.followUp && decision.action === 'proven' && !returnedPartial.has(toolName)) {
              returnedPartial.add(toolName);
              return {
                ...decision,
                action: 'partial' as const,
                missingProof: [`Review the revised core promise for ${toolName}.`],
                reason: 'The recorded call works; the master will refine its core result promise.',
              };
            }
            return decision;
          },
          requestMasterDecision: async (input, agent, options) => {
            if (
              input.decisionPurpose === 'research_review' &&
              (input.apiResearch ?? []).every(({ status }) => status === 'partial')
            ) {
              const desiredPlan = desiredFromCurrent(input);
              for (const tool of desiredPlan.tools) {
                tool.candidate.expectedOutput = `${tool.candidate.expectedOutput} Revised core result.`;
              }
              return MasterDecisionOutputSchema.parse({
                binding: input.current?.run ?? input.discovery.run,
                outcome: 'revised',
                reason: 'Revise both core result promises and continue their retained researchers.',
                recallToolNames: [],
                researchFollowUps: desiredPlan.tools.map((tool) => ({
                  toolName: tool.candidate.toolName,
                  instruction: `Check the revised result promise for ${tool.candidate.toolName}.`,
                  missingProof: [`Review the revised core promise for ${tool.candidate.toolName}.`],
                  relevantToolNames: desiredPlan.tools
                    .filter(({ id }) => id !== tool.id)
                    .map(({ candidate }) => candidate.toolName),
                  relevantRequestSeqs: [...tool.candidate.requestSeqs],
                })),
                desiredPlan,
              });
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannedNames.push(input.tool.candidate.toolName);
            return await basePlanner(input);
          },
        },
      );

      expect(initialTurns).toEqual(
        new Map([
          [PRODUCER_NAME, 2],
          [CONSUMER_NAME, 2],
        ]),
      );
      expect(retainedFollowUps).toEqual(
        new Map([
          [PRODUCER_NAME, 1],
          [CONSUMER_NAME, 1],
        ]),
      );
      expect(plannedNames).toEqual([PRODUCER_NAME, CONSUMER_NAME]);
      expect(terminal.status).toBe('failed');
    });
  });

  it('plans directly after an edge-only research-review revision', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-edge-only-research-review',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !basePlanner) {
        throw new Error('fixture research roles are missing');
      }

      const researchTurns = new Map<string, number>();
      const plannedNames: string[] = [];
      let revisedWiring = false;
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
          requestApiResearchStep: async (input) => {
            const toolName = input.tool.candidate.toolName;
            researchTurns.set(toolName, (researchTurns.get(toolName) ?? 0) + 1);
            return await baseResearch(input);
          },
          requestMasterDecision: async (input, agent, options) => {
            if (input.decisionPurpose === 'research_review' && !revisedWiring) {
              revisedWiring = true;
              const desiredPlan = desiredFromCurrent(input);
              const consumer = desiredPlan.tools.find(({ id }) => id === CONSUMER_ID);
              if (!consumer) throw new Error('fixture plan lost its consumer');
              consumer.candidate.dependsOnTools = [];
              desiredPlan.chainEdges = [];
              desiredPlan.buildWaves = [[PRODUCER_ID, CONSUMER_ID]];
              return MasterDecisionOutputSchema.parse({
                binding: input.current?.run ?? input.discovery.run,
                outcome: 'revised',
                reason: 'The two proven MVP calls are independent.',
                recallToolNames: [],
                researchFollowUps: [],
                desiredPlan,
              });
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannedNames.push(input.tool.candidate.toolName);
            return await basePlanner(input);
          },
        },
      );

      expect(researchTurns).toEqual(
        new Map([
          [PRODUCER_NAME, 2],
          [CONSUMER_NAME, 2],
        ]),
      );
      expect(new Set(plannedNames)).toEqual(new Set([PRODUCER_NAME, CONSUMER_NAME]));
      expect(terminal.status).toBe('failed');
    });
  });

  it('re-researches only the tool whose public parameters changed', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-public-parameter-research-refresh',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !basePlanner) {
        throw new Error('fixture research roles are missing');
      }

      const researchTurns = new Map<string, number>();
      const plannedNames: string[] = [];
      let revisedParameter = false;
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
          requestApiResearchStep: async (input) => {
            const toolName = input.tool.candidate.toolName;
            researchTurns.set(toolName, (researchTurns.get(toolName) ?? 0) + 1);
            return await baseResearch(input);
          },
          requestMasterDecision: async (input, agent, options) => {
            if (input.decisionPurpose === 'research_review' && !revisedParameter) {
              revisedParameter = true;
              const desiredPlan = desiredFromCurrent(input);
              const consumer = desiredPlan.tools.find(({ id }) => id === CONSUMER_ID);
              if (!consumer) throw new Error('fixture plan lost its consumer');
              consumer.candidate.likelyParams.push({
                name: 'include_metadata',
                type: 'boolean',
                description: 'Whether to include optional item metadata.',
              });
              return MasterDecisionOutputSchema.parse({
                binding: input.current?.run ?? input.discovery.run,
                outcome: 'revised',
                reason: 'Expose one additional public input on the consumer.',
                recallToolNames: [],
                researchFollowUps: [],
                desiredPlan,
              });
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannedNames.push(input.tool.candidate.toolName);
            return await basePlanner(input);
          },
        },
      );

      expect(researchTurns.get(PRODUCER_NAME)).toBe(2);
      expect(researchTurns.get(CONSUMER_NAME)).toBe(4);
      expect(plannedNames).toEqual([PRODUCER_NAME, CONSUMER_NAME]);
      expect(terminal.status).toBe('failed');
    });
  });

  it('shows structured failed attempts to the master before a blocked API tool can leave research', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-blocked-research-review',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const baseResearchTool = base.runApiResearchTool;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !baseResearchTool || !basePlanner) {
        throw new Error('fixture research roles are missing');
      }

      let masterSawFailedFacts = false;
      const plannedNames: string[] = [];
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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (input.tool.candidate.toolName === PRODUCER_NAME && input.observations.length > 0) {
              return {
                binding: decision.binding,
                action: 'blocked' as const,
                reason: input.blockReview
                  ? 'Self-review found no distinct evidence-backed request construction.'
                  : 'The recorded producer request was rejected.',
              };
            }
            return decision;
          },
          runApiResearchTool: async (input) =>
            input.workflowPath.includes(`/${PRODUCER_ID}/`)
              ? {
                  result: {
                    ok: false as const,
                    error: 'FORBIDDEN',
                    message: 'HTTP 403 from the recorded producer request',
                  },
                  executionMechanism: 'fixture-fetch',
                }
              : await baseResearchTool(input),
          requestMasterDecision: async (input, agent, options) => {
            if (input.decisionPurpose === 'research_review') {
              const blocked = (input.apiResearch ?? []).find(
                ({ toolName, status }) => toolName === PRODUCER_NAME && status === 'blocked',
              );
              if (blocked) {
                expect(blocked.observations).toHaveLength(1);
                expect(blocked.observations?.[0]?.result.message).toContain('HTTP 403');
                masterSawFailedFacts = true;
                const desiredPlan = desiredFromCurrent(input);
                desiredPlan.tools = desiredPlan.tools.filter(
                  ({ candidate }) => candidate.toolName !== PRODUCER_NAME,
                );
                const consumer = desiredPlan.tools.find(
                  ({ candidate }) => candidate.toolName === CONSUMER_NAME,
                );
                if (!consumer) throw new Error('fixture plan lost the consumer');
                consumer.candidate.dependsOnTools = [];
                consumer.candidate.dependencySeqs = [];
                desiredPlan.chainEdges = [];
                desiredPlan.buildWaves = [[consumer.id]];
                const coverage = desiredPlan.candidateCoverage.find(
                  ({ discoveryCandidateName }) => discoveryCandidateName === PRODUCER_NAME,
                );
                if (!coverage) throw new Error('fixture plan lost producer coverage');
                coverage.plannedToolIds = [];
                coverage.unresolvedReason = null;
                coverage.excludedReason =
                  'Structured request attempts showed no supported producer implementation.';
                const output = MasterDecisionOutputSchema.parse({
                  binding: input.current?.run ?? input.discovery.run,
                  outcome: 'revised',
                  reason: 'Remove only the factually blocked producer and unlink its consumer.',
                  recallToolNames: [],
                  researchFollowUps: [],
                  desiredPlan,
                });
                return await requestValidatedMasterDecision(input, {
                  ...(agent?.provider ? { provider: agent.provider } : {}),
                  analyzer: {
                    async analyze() {
                      return { text: JSON.stringify(output) };
                    },
                  },
                });
              }
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannedNames.push(input.tool.candidate.toolName);
            return await basePlanner(input);
          },
        },
      );

      expect(masterSawFailedFacts).toBeTrue();
      expect(plannedNames).not.toContain(PRODUCER_NAME);
      expect(plannedNames).toContain(CONSUMER_NAME);
      expect(terminal.status).toBe('failed');
    });
  });

  it('returns an exact repeated partial cycle to the master without another researcher call', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-partial-no-progress-review',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      if (!baseResearch || !baseMaster) throw new Error('fixture research roles are missing');

      const missingProof = ['Prove the required consumer identifier is present.'];
      const repeatedInstruction =
        'Inspect the current response again for the required consumer identifier.';
      let followUpResearchTurns = 0;
      let allowProven = false;
      let sawNoProgressReview = false;
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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (input.tool.candidate.toolName !== CONSUMER_NAME) return decision;
            if (input.followUp) followUpResearchTurns += 1;
            if (allowProven) return decision;
            if (decision.action !== 'proven') return decision;
            return {
              ...decision,
              action: 'partial' as const,
              missingProof,
              reason: 'The same core call works, but the selected identifier proof is unchanged.',
            };
          },
          requestMasterDecision: async (input, agent, options) => {
            if (input.decisionPurpose === 'research_review') {
              const partial = (input.apiResearch ?? []).find(
                ({ toolName, status }) => toolName === CONSUMER_NAME && status === 'partial',
              );
              if (partial) {
                const noProgress = input.researchNoProgress?.find(
                  ({ toolName }) => toolName === CONSUMER_NAME,
                );
                if (noProgress) {
                  sawNoProgressReview = true;
                  expect(noProgress.reason).toContain('same partial handoff');
                  allowProven = true;
                }
                const output = MasterDecisionOutputSchema.parse({
                  binding: input.current?.run ?? input.discovery.run,
                  outcome: 'accepted',
                  reason: noProgress
                    ? 'Use one materially different request construction after the exact no-op.'
                    : 'Return the partial consumer to its retained researcher.',
                  recallToolNames: [],
                  researchFollowUps: [
                    {
                      toolName: CONSUMER_NAME,
                      instruction: noProgress
                        ? 'Test the minimal consumer request without the optional wrapper.'
                        : repeatedInstruction,
                      missingProof: partial.missingProof ?? missingProof,
                      relevantToolNames: [],
                      relevantRequestSeqs: [2],
                    },
                  ],
                  desiredPlan: desiredFromCurrent(input),
                });
                return await requestValidatedMasterDecision(input, {
                  ...(agent?.provider ? { provider: agent.provider } : {}),
                  analyzer: {
                    async analyze() {
                      return { text: JSON.stringify(output) };
                    },
                  },
                });
              }
            }
            return await baseMaster(input, agent, options);
          },
        },
      );

      expect(sawNoProgressReview).toBeTrue();
      expect(followUpResearchTurns).toBe(2);
      expect(terminal.status).toBe('failed');
    });
  });

  it('runs a fresh first research pass after the master renames a tool before planning', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-research-review-rename',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      const baseMaster = base.requestMasterDecision;
      const basePlanner = base.requestFocusedPlan;
      if (!baseResearch || !baseMaster || !basePlanner)
        throw new Error('fixture research roles are missing');

      const renamed = 'find_items';
      let researchReviews = 0;
      let renamedResearchTurns = 0;
      let renamedWasProven = false;
      let plannerCalls = 0;
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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            if (input.tool.candidate.toolName === renamed) {
              renamedResearchTurns += 1;
              if (decision.action === 'proven') renamedWasProven = true;
            }
            return decision;
          },
          requestMasterDecision: async (input, agent, options) => {
            if (input.decisionPurpose === 'research_review') {
              researchReviews += 1;
              if (researchReviews === 1) {
                const desiredPlan = desiredFromCurrent(input);
                const producer = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
                const consumer = desiredPlan.tools.find(({ id }) => id === CONSUMER_ID);
                if (!producer || !consumer) throw new Error('fixture plan lost a tool');
                producer.id = renamed;
                producer.candidate.toolName = renamed;
                consumer.candidate.dependsOnTools = [renamed];
                desiredPlan.buildWaves = desiredPlan.buildWaves.map((wave) =>
                  wave.map((toolId) => (toolId === PRODUCER_ID ? renamed : toolId)),
                );
                desiredPlan.chainEdges = desiredPlan.chainEdges.map((edge) => ({
                  ...edge,
                  producerToolId:
                    edge.producerToolId === PRODUCER_ID ? renamed : edge.producerToolId,
                }));
                desiredPlan.candidateCoverage = desiredPlan.candidateCoverage.map((coverage) => ({
                  ...coverage,
                  plannedToolIds: coverage.plannedToolIds.map((toolId) =>
                    toolId === PRODUCER_ID ? renamed : toolId,
                  ),
                }));
                return MasterDecisionOutputSchema.parse({
                  binding: input.current?.run ?? input.discovery.run,
                  outcome: 'revised',
                  reason: 'Use one clearer public name before planning.',
                  recallToolNames: [],
                  researchFollowUps: [],
                  desiredPlan,
                });
              }
            }
            return await baseMaster(input, agent, options);
          },
          requestFocusedPlan: async (input) => {
            plannerCalls += 1;
            expect(researchReviews).toBeGreaterThanOrEqual(2);
            expect(renamedWasProven).toBeTrue();
            return await basePlanner(input);
          },
        },
      );

      expect(researchReviews).toBeGreaterThanOrEqual(2);
      expect(renamedResearchTurns).toBe(2);
      expect(renamedWasProven).toBeTrue();
      expect(plannerCalls).toBe(2);
      expect(terminal.status).toBe('provider_unavailable');
    });
  });

  it('passes explicit human guidance to the master before and after research', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-user-guidance',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseMaster = base.requestMasterDecision;
      if (!baseMaster) throw new Error('fixture master is missing');
      const guidance = 'Keep location lookup, search, calendar grid, and booking only.';
      const seen: Array<string | undefined> = [];

      await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          userGuidance: guidance,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...base,
          requestMasterDecision: async (input, agent, options) => {
            seen.push(input.userGuidance);
            return await baseMaster(input, agent, options);
          },
        },
      );

      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(new Set(seen)).toEqual(new Set([guidance]));
    });
  });

  it('verifies the researcher-proven API case before synthetic parameter breadth', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-proven-api-baseline',
        events: [],
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const basePlanner = base.requestFocusedPlan;
      if (!basePlanner) throw new Error('fixture planner is missing');
      const calls: Array<{
        toolId: string;
        parameters: Record<string, string | number | boolean>;
        backend?: string;
      }> = [];
      let reviewedConsumerCase: string | undefined;

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
          requestFocusedPlan: async (input) => {
            const output = await basePlanner(input);
            if (input.tool.id !== CONSUMER_ID) return output;
            const implementation = structuredClone(output.implementationPlan);
            for (const verification of implementation.verificationCases) {
              const parameter = verification.parameterValues.find(
                ({ parameterName }) => parameterName === 'item_id',
              );
              if (parameter)
                parameter.value =
                  verification.check === 'replay' ? 'recorded-item' : 'synthetic-item';
            }
            return FocusedPlannerOutputSchema.parse({
              ...output,
              implementationPlan: implementation,
            });
          },
          requestApiResearchStep: async (input) => {
            const decision = await fixtureApiResearchStep(input);
            if (input.tool.id !== CONSUMER_ID || !decision.candidate) return decision;
            return {
              ...decision,
              candidate: {
                ...decision.candidate,
                parameterValues: { item_id: 'recorded-item' },
                testBackend: 'cdp-replay' as const,
              },
            };
          },
          runApiResearchTool: async ({ parameters, backend }) => ({
            result: { ok: true as const, data: { id: parameters.item_id ?? 'item-1' } },
            executionMechanism: backend ?? 'fetch',
          }),
          runApiTool: async ({ workflowPath, parameters, backend }) => {
            const toolId = workflowPath.includes(`/${PRODUCER_ID}/`) ? PRODUCER_ID : CONSUMER_ID;
            calls.push({ toolId, parameters, ...(backend ? { backend } : {}) });
            return {
              result:
                toolId === PRODUCER_ID
                  ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
                  : {
                      ok: true as const,
                      data: { id: parameters.item_id, name: 'Fixture item' },
                    },
              executionMechanism: backend ?? 'fetch',
            };
          },
          requestBaselineMvpReview: async (input) => {
            if (input.toolId === CONSUMER_ID && !input.resultEvidence.payload.chainEdgeId) {
              reviewedConsumerCase = input.resultEvidence.payload.verificationCaseId;
            }
            return credibleBaselineMvpReview(input);
          },
        },
      );

      expect(terminal.status).toBe('failed');
      expect(
        calls
          .filter(({ toolId }) => toolId === CONSUMER_ID)
          .map(({ parameters, backend }) => ({
            parameters,
            backend,
          })),
      ).toEqual([
        { parameters: { item_id: 'recorded-item' }, backend: 'cdp-replay' },
        { parameters: { item_id: 'item-1' }, backend: 'cdp-replay' },
      ]);
      expect(reviewedConsumerCase).toBe(`replay_${CONSUMER_ID}`);
      expect(calls.some(({ parameters }) => parameters.item_id === 'synthetic-item')).toBe(false);
    });
  });

  it('reuses only candidate selection while planning and compilation start fresh', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const sourceRunId = 'run-e2e-candidate-source';
      const source = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        lifecycleFailureFixture({
          runId: sourceRunId,
          events: [],
          promotionBatches: [],
          requestBaselineMvpReview: credibleBaselineMvpReview,
        }),
      );
      expect(existsSync(join(source.runRoot, 'candidate-selection.json'))).toBeTrue();

      const targetEvents: string[] = [];
      const targetBase = lifecycleFailureFixture({
        runId: 'run-e2e-candidate-target',
        events: targetEvents,
        promotionBatches: [],
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const targetMaster = targetBase.requestMasterDecision;
      const targetPlanner = targetBase.requestFocusedPlan;
      const targetCompiler = targetBase.compileFocusedTool;
      if (!targetMaster || !targetPlanner || !targetCompiler) {
        throw new Error('candidate fixture is incomplete');
      }
      const forbiddenCalls: string[] = [];
      let revisionDecisions = 0;
      let firstRevisionWasSelfContained: boolean | undefined;
      const plannerCalls: Array<{ toolId: string; runId: string }> = [];
      const compilerCalls: Array<{
        toolId: string;
        stagingDir: string;
        priorToolDir?: string;
        resumeSessionId?: string;
      }> = [];
      const target = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          fromCandidates: sourceRunId,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 5_000,
        },
        {
          ...targetBase,
          prepareSession: async () => {
            forbiddenCalls.push('triage');
            throw new Error('candidate reuse must skip triage');
          },
          detectToolCandidates: async () => {
            forbiddenCalls.push('detection');
            throw new Error('candidate reuse must skip detection');
          },
          requestToolSelectionAdvice: async () => {
            forbiddenCalls.push('tool-selection-advice');
            throw new Error('candidate reuse must skip tool-selection advice');
          },
          requestMasterDecision: async (input, _agent, options) => {
            if (input.phase === 'discovery') {
              forbiddenCalls.push('discovery-master');
              throw new Error('candidate reuse must skip the discovery master decision');
            }
            revisionDecisions += 1;
            firstRevisionWasSelfContained ??= options?.selfContained;
            return await targetMaster(input);
          },
          requestFocusedPlan: async (input) => {
            plannerCalls.push({ toolId: input.tool.id, runId: input.run.runId });
            return await targetPlanner(input);
          },
          compileFocusedTool: async (input) => {
            compilerCalls.push({
              toolId: input.tool.id,
              stagingDir: input.stagingDir,
              ...(input.priorToolDir ? { priorToolDir: input.priorToolDir } : {}),
              ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
            });
            return await targetCompiler(input);
          },
        },
      );

      expect(forbiddenCalls).toEqual([]);
      expect(target.runRoot).not.toBe(source.runRoot);
      expect(revisionDecisions).toBeGreaterThan(0);
      expect(firstRevisionWasSelfContained).toBeTrue();
      expect(plannerCalls).toEqual([
        { toolId: PRODUCER_ID, runId: 'run-e2e-candidate-target' },
        { toolId: CONSUMER_ID, runId: 'run-e2e-candidate-target' },
      ]);
      expect(compilerCalls.map(({ toolId }) => toolId)).toEqual([PRODUCER_ID, CONSUMER_ID]);
      for (const call of compilerCalls) {
        expect(call.stagingDir.startsWith(`${target.runRoot}/staging/`)).toBeTrue();
        expect(call.priorToolDir).toBeUndefined();
        expect(call.resumeSessionId).toBeUndefined();
      }
      expect(existsSync(join(target.runRoot, 'candidate-selection.json'))).toBeTrue();
    });
  });

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
      let independentExecutionCalled = false;
      let compilerRequestSeqs: number[] = [];
      let compilerScopeSeqs: number[] = [];
      let consumerFocusedEvidenceWasComplete = false;
      let consumerSawProducerTransportEvidence = false;
      let detectorEventCitationsWereGrounded = false;
      let groundedCandidateRemainedAdvisory = false;
      let narrationRemainedInEvidence = false;
      const parameterAdvisorCalls: string[] = [];
      const parameterAdvisorChecks = new Map<string, string[]>();
      const pendingParameterAdvice: Array<() => void> = [];
      let parameterAdviceHadToBeReleased = false;
      let parameterAdviceGuard: ReturnType<typeof setTimeout> | undefined;
      const plannerGuidance: string[] = [];
      let focusedProposalDecisions = 0;
      let revisedProducerWasReplanned = false;
      let producerBuildVisibleWhenConsumerCompileStarted = false;
      let consumerMvpPreview = '';
      let consumerMvpCount: number | null | undefined;
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
          requestApiResearchStep: fixtureApiResearchStep,
          runApiResearchTool: fixtureApiResearchTool,
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
          observeIndependentExecution: async () => {
            independentExecutionCalled = true;
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
              recallToolNames: revisesWithStalePlan ? [PRODUCER_NAME] : [],
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
              const sibling = input.siblingToolEvidence.find(
                ({ toolId }) => toolId === PRODUCER_ID,
              );
              consumerSawProducerTransportEvidence =
                sibling?.toolName === PRODUCER_NAME &&
                sibling.compileContext.sharedHelperNotes === sharedContext.sharedHelperNotes;
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
          compileFocusedTool: async (compileInput) => {
            const { tool, triage, sessionPath, stagingDir } = compileInput;
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
              consumerMvpCount = input.resultEvidence.payload.actualResult.count;
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
      expect(terminal.nonReadyTools).toBe(0);
      expect(terminal.message).toContain('usable MVP');
      expect(terminal.message).toContain('did not change or delay this MVP');
      expect(terminal.message).toContain('unfinished advice is recorded there as deferred');
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
      expect(consumerMvpCount).toBeNull();
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
      expect(independentExecutionCalled).toBe(false);
      expect(compilerRequestSeqs).toEqual([1, 2, 4]);
      expect(compilerScopeSeqs).toEqual([1, 2, 4]);
      expect(consumerFocusedEvidenceWasComplete).toBe(true);
      expect(consumerSawProducerTransportEvidence).toBe(true);
      expect(detectorEventCitationsWereGrounded).toBe(true);
      expect(groundedCandidateRemainedAdvisory).toBe(true);
      expect(narrationRemainedInEvidence).toBe(true);
      expect(parameterAdviceHadToBeReleased).toBe(false);
      // Optional provider work is bounded independently from the core path,
      // while both tools can still begin their post-publication review.
      expect(parameterAdvisorCalls).toEqual([PRODUCER_ID, CONSUMER_ID]);
      expect(events.indexOf(`finesse:${PRODUCER_ID}`)).toBeLessThan(
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
        const executionBindingSha256 = (finesseRecord as { executionBindingSha256: string })
          .executionBindingSha256;
        expect(finesseFile).toBe(
          `${buildRef.sha256.slice('sha256:'.length)}-${executionBindingSha256.slice('sha256:'.length)}.json`,
        );
        expect(finesseRecord).toEqual(
          expect.objectContaining({
            toolId,
            buildRef,
            status: 'deferred',
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

  it('binds correlated sibling values in one chain invocation and retains every edge receipt', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const consumerInvocations: Array<Record<string, string | number | boolean>> = [];
      const reviewedChainEdgeIds: Array<string | undefined> = [];
      const groupedIdEdge = { ...chainEdge };
      const kindEdge = {
        id: 'search-item-kind',
        producerToolId: PRODUCER_ID,
        producerResultPath: 'items[0].kind',
        consumerToolId: CONSUMER_ID,
        consumerParameter: 'item_kind',
      };
      const siblingEdges = [groupedIdEdge, kindEdge];
      const pairConsumerCandidate = {
        ...consumerCandidate,
        likelyParams: [
          ...consumerCandidate.likelyParams,
          {
            name: 'item_kind',
            type: 'string' as const,
            description: 'Correlated item kind returned with the search identifier.',
          },
        ],
      };
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-correlated-sibling-chain',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });

      const terminal = await runFreshMasterTeach(
        {
          site: SITE,
          fromSession: recordingPath,
          noInteractive: true,
          provider: 'codex-cli',
          maxDurationMs: 30_000,
        },
        {
          ...base,
          detectToolCandidates: async () => ({
            ...validateToolCandidateDetection({
              sharedContext,
              candidates: [producerCandidate, pairConsumerCandidate],
            }),
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          }),
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(decisionInput);
              desiredPlan.chainEdges = siblingEdges;
            } else if (decisionInput.plannerProposals.length > 0) {
              desiredPlan = proposalDesiredPlan(decisionInput);
            } else {
              desiredPlan = desiredFromCurrent(decisionInput);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: 'accepted',
              reason: 'Both correlated producer fields belong to one consumer invocation.',
              recallToolNames: [],
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
                result: {
                  ok: true as const,
                  data: { items: [{ id: 'producer-id', kind: 'producer-kind' }] },
                },
                executionMechanism: 'fixture-api',
              };
            }
            consumerInvocations.push({ ...parameters });
            const standalone = parameters.item_id === 'item-1' && parameters.item_kind === 'item-1';
            const correlated =
              parameters.item_id === 'producer-id' && parameters.item_kind === 'producer-kind';
            return {
              result:
                standalone || correlated
                  ? {
                      ok: true as const,
                      data: { id: parameters.item_id, kind: parameters.item_kind },
                    }
                  : {
                      ok: false as const,
                      error: 'BAD_RESPONSE',
                      message: 'fixture rejected a mixed default/producer parameter pair',
                    },
              executionMechanism: 'fixture-api',
            };
          },
          requestBaselineMvpReview: async (reviewInput) => {
            if (
              reviewInput.toolId === CONSUMER_ID &&
              reviewInput.resultEvidence.payload.chainEdgeId
            ) {
              reviewedChainEdgeIds.push(reviewInput.resultEvidence.payload.chainEdgeId);
            }
            return credibleBaselineMvpReview(reviewInput);
          },
          requestCompletionReview: async (input) =>
            CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'Both fixture tools and the shared sibling chain are current.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The current fixture result demonstrates the declared operation.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The fixture supplies the required proof.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
        },
      );

      expect(terminal.status).toBe('completed');
      expect(consumerInvocations).toEqual([
        { item_id: 'item-1', item_kind: 'item-1' },
        { item_id: 'producer-id', item_kind: 'producer-kind' },
      ]);
      expect(reviewedChainEdgeIds).toEqual([EDGE_ID]);
      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      expect(
        state.tools
          .find(({ toolId }) => toolId === CONSUMER_ID)
          ?.currentReceiptRefs.filter(({ key }) => key.startsWith('chain:'))
          .map(({ key }) => key),
      ).toEqual([`chain:${EDGE_ID}`, `chain:${kindEdge.id}`]);
    });
  });

  it('runs only the one producer route selected by the master', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root);
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const consumerInvocations: Array<Record<string, string | number | boolean>> = [];
      const reviewedChainEdgeIds: Array<string | undefined> = [];
      const routeAIdEdge = {
        ...chainEdge,
      };
      const kindProducerName = 'lookup_item_kind';
      const kindProducerId = kindProducerName;
      const kindProducerCandidate = {
        ...producerCandidate,
        toolName: kindProducerName,
        description: 'Look up the correlated fixture item kind.',
        rationale: 'Request 1 also supplies the kind consumed by item detail.',
        expectedOutput: 'The correlated item kind.',
      };
      const kindEdgeA = {
        id: 'search-route-a-kind',
        producerToolId: kindProducerId,
        producerResultPath: 'items[0].kind',
        consumerToolId: CONSUMER_ID,
        consumerParameter: 'item_kind',
      };
      const selectedEdges = [routeAIdEdge, kindEdgeA];
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-alternative-chain-paths',
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
          maxDurationMs: 30_000,
        },
        {
          ...base,
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(decisionInput);
              const consumer = desiredPlan.tools.find(({ id }) => id === CONSUMER_ID);
              const producerCoverage = desiredPlan.candidateCoverage.find(
                ({ discoveryCandidateName }) => discoveryCandidateName === PRODUCER_NAME,
              );
              if (!consumer || !producerCoverage)
                throw new Error('fixture discovery plan is incomplete');
              consumer.candidate = {
                ...consumer.candidate,
                likelyParams: [
                  ...consumer.candidate.likelyParams,
                  {
                    name: 'item_kind',
                    type: 'string',
                    description: 'Correlated kind returned by the kind producer.',
                  },
                ],
                dependencySeqs: [1],
                dependsOnTools: [PRODUCER_NAME, kindProducerName],
              };
              desiredPlan.tools.splice(1, 0, {
                id: kindProducerId,
                candidate: kindProducerCandidate,
                compileContext: decisionInput.discovery.detectorSharedContext,
                evidenceRefs: [decisionInput.discovery.evidence.ref],
                strategy: {
                  kind: 'api',
                  reason: 'The recording contains one replayable request.',
                },
              });
              producerCoverage.plannedToolIds.push(kindProducerId);
              desiredPlan.buildWaves = [[PRODUCER_ID, kindProducerId], [CONSUMER_ID]];
              desiredPlan.chainEdges = selectedEdges;
            } else if (decisionInput.plannerProposals.length > 0) {
              desiredPlan = proposalDesiredPlan(decisionInput);
            } else {
              desiredPlan = desiredFromCurrent(decisionInput);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: 'accepted',
              reason: 'This is the one best-supported producer route for the consumer.',
              recallToolNames: [],
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
          compileFocusedTool: async (compileInput) => {
            if (compileInput.tool.id !== kindProducerId) {
              return await baseCompileFocusedTool(compileInput);
            }
            events.push(`compile:${kindProducerId}`);
            mkdirSync(compileInput.stagingDir, { recursive: true });
            const workflow = WorkflowSchema.parse({
              toolName: kindProducerName,
              intent: { description: compileInput.tool.candidate.description },
              parameters: [],
              requests: [
                {
                  recordingRequestSeq: 1,
                  method: 'GET',
                  url: 'https://fixture.invalid/api/item-kinds',
                  headers: { accept: 'application/json' },
                },
              ],
              site: SITE,
            });
            const workflowPath = join(compileInput.stagingDir, 'workflow.json');
            writeFileSync(workflowPath, `${JSON.stringify(workflow)}\n`);
            return { workflow, workflowPath, toolDir: compileInput.stagingDir };
          },
          runApiTool: async ({ workflowPath, parameters }) => {
            if (workflowPath.includes(`/${PRODUCER_ID}/`)) {
              return {
                result: {
                  ok: true as const,
                  data: {
                    items: [{ id: 'producer-id', alternative_id: 'producer-alternative-id' }],
                  },
                },
                executionMechanism: 'fixture-api',
              };
            }
            if (workflowPath.includes(`/${kindProducerId}/`)) {
              return {
                result: {
                  ok: true as const,
                  data: { items: [{ kind: 'producer-kind' }] },
                },
                executionMechanism: 'fixture-api',
              };
            }
            consumerInvocations.push({ ...parameters });
            const standalone = parameters.item_id === 'item-1' && parameters.item_kind === 'item-1';
            const correlated =
              parameters.item_kind === 'producer-kind' &&
              ['producer-id', 'producer-alternative-id'].includes(String(parameters.item_id));
            return {
              result:
                standalone || correlated
                  ? {
                      ok: true as const,
                      data: { id: parameters.item_id, kind: parameters.item_kind },
                    }
                  : {
                      ok: false as const,
                      error: 'BAD_RESPONSE',
                      message: 'fixture rejected a mixed default/producer parameter pair',
                    },
              executionMechanism: 'fixture-api',
            };
          },
          requestBaselineMvpReview: async (reviewInput) => {
            if (
              reviewInput.toolId === CONSUMER_ID &&
              reviewInput.resultEvidence.payload.chainEdgeId
            ) {
              reviewedChainEdgeIds.push(reviewInput.resultEvidence.payload.chainEdgeId);
            }
            return credibleBaselineMvpReview(reviewInput);
          },
          requestCompletionReview: async (input) =>
            CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'The selected path retains the correlated producer-backed kind.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The current fixture result demonstrates the declared operation.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The fixture supplies the required proof.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
        },
      );

      expect(terminal.status).toBe('completed');
      expect(consumerInvocations).toEqual([
        { item_id: 'item-1', item_kind: 'item-1' },
        { item_id: 'producer-id', item_kind: 'producer-kind' },
      ]);
      expect(reviewedChainEdgeIds).toEqual([EDGE_ID]);
      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      expect(
        state.tools
          .find(({ toolId }) => toolId === CONSUMER_ID)
          ?.currentReceiptRefs.filter(({ key }) => key.startsWith('chain:'))
          .map(({ key }) => key),
      ).toEqual([`chain:${EDGE_ID}`, `chain:${kindEdgeA.id}`]);
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
          compileFocusedTool: async (compileInput) => ({
            ...(await baseCompileFocusedTool(compileInput)),
            compilerSummary:
              'compare_rendered_requests: method equal; body bytes recorded=148 rendered=146; first mismatch byte=72',
          }),
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
            responseObservations: [
              {
                backend: 'fetch' as const,
                requestIndex: 0,
                status: 400,
                bodyByteLength: 41,
                contentType: 'application/json',
                valueType: 'object' as const,
                topLevelKeys: ['error', 'reason'],
              },
            ],
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
      expect(repairFailureQuote).toContain('compare_rendered_requests');
      expect(repairFailureQuote).toContain('recorded=148 rendered=146');
      expect(repairFailureQuote).toContain('liveResponseObservations');
      expect(repairFailureQuote).toContain('"status":400');
      expect(repairFailureQuote).toContain('"topLevelKeys":["error","reason"]');
      expect(repairFailureQuote).not.toContain('invalid request shape');
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(0);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('gives the master every backend failure instead of only the last one', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let repairQuote = '';
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-backend-attempt-facts',
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
            repairQuote = decisionInput.verificationFindings.payload.entries
              .filter((entry) => entry.kind === 'untrusted_redacted_quote')
              .map(({ quote }) => quote)
              .join('\n');
            throw new ProviderUnavailableError(
              new Error('fixture stops after backend facts reach the master'),
            );
          },
          runApiTool: async () => ({
            result: {
              ok: false as const,
              error: 'BAD_RESPONSE' as const,
              message: 'The last backend refused top-level navigation.',
            },
            executionMechanism: 'stealth-fetch',
            backendAttempts: [
              {
                backend: 'fetch' as const,
                outcome: 'escalate' as const,
                detail: `NETWORK: ${'slow bootstrap '.repeat(60)}`,
                durationMs: 1_000,
              },
              {
                backend: 'cdp-replay' as const,
                outcome: 'escalate' as const,
                detail: 'BAD_RESPONSE: request 1 reached the server and returned HTTP 400',
                durationMs: 2_000,
              },
              {
                backend: 'stealth-fetch' as const,
                outcome: 'failed' as const,
                detail: 'BAD_RESPONSE: request 0 refused top-level navigation',
                durationMs: 3_000,
              },
            ],
          }),
        },
      );

      expect(terminal.status).toBe('provider_unavailable');
      expect(repairQuote).toContain('Backend attempts:');
      expect(repairQuote).toContain('cdp-replay: escalate');
      expect(repairQuote).toContain('request 1 reached the server and returned HTTP 400');
      expect(repairQuote).toContain('stealth-fetch: failed');
      expect(repairQuote).toContain('request 0 refused top-level navigation');
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
              recallToolNames: [],
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

  it('keeps a final chain-result repair independent of saved parameter advice', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let baselineChainEvidenceRef = '';
      let completionChainEvidenceRef = '';
      let repairFacts: Array<Record<string, unknown>> = [];
      let repairExcludedParameterAdvice = false;
      let completionReviewCalls = 0;
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
            repairExcludedParameterAdvice = !('parameterAdvice' in decisionInput);
            repairFacts = decisionInput.verificationFindings.payload.entries.flatMap((entry) =>
              entry.kind === 'untrusted_redacted_quote'
                ? [JSON.parse(entry.quote) as Record<string, unknown>]
                : [],
            );
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run,
              outcome: 'accepted',
              reason: 'The core rejection does not justify changing this working build.',
              recallToolNames: [],
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
          requestParameterSelectionAdvice: async (advisorInput) => {
            const tool = advisorInput.currentPlan.payload.tools.find(
              ({ id }) => id === advisorInput.toolId,
            );
            const proof = advisorInput.snapshot.payload.tools.find(
              ({ toolId }) => toolId === advisorInput.toolId,
            );
            const evidenceRef = advisorInput.evidence.payload.entries[0]?.ref;
            if (!tool || !proof || !evidenceRef) {
              throw new Error('fixture expected current tool proof and focused evidence');
            }
            return ParameterSelectionAdvisorOutputSchema.parse({
              binding: {
                runId: advisorInput.run.runId,
                recordingSha256: advisorInput.run.recordingSha256,
                toolId: advisorInput.toolId,
                compileInputsSha256: proof.executionBinding.compileInputsSha256,
              },
              likelyParams: tool.candidate.likelyParams,
              evidenceRefs: [evidenceRef],
              concerns: [],
              reason: 'The verified MVP public parameters remain supported.',
            });
          },
          requestCompletionReview: async (reviewInput) => {
            completionReviewCalls += 1;
            if (completionReviewCalls > 1) {
              throw new ProviderUnavailableError(
                new Error('fixture stops after the independent core repair decision'),
              );
            }
            // Let the best-effort advisor save its suggestion before the core
            // review fails. That suggestion must not enter the repair input.
            await new Promise((resolve) => setTimeout(resolve, 0));
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
      expect(repairExcludedParameterAdvice).toBe(true);
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [CONSUMER_NAME]]);
      expect(terminal.readyTools).toBe(2);
      expect(events.filter((event) => event.startsWith('compile:'))).toEqual([
        `compile:${PRODUCER_ID}`,
        `compile:${CONSUMER_ID}`,
      ]);
      const consumerFinesseDir = join(terminal.runRoot, 'finesse', CONSUMER_ID);
      const consumerFinesseFile = readdirSync(consumerFinesseDir).find((name) =>
        name.endsWith('.json'),
      );
      if (!consumerFinesseFile) throw new Error('missing consumer finesse record');
      expect(readJson(join(consumerFinesseDir, consumerFinesseFile))).toEqual(
        expect.objectContaining({ status: 'suggested' }),
      );
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

  it('expires a saved finesse suggestion when a required revision replaces its exact MVP build', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      let parameterAdvisorCalls = 0;
      let completionReviewCalls = 0;
      let resolveInitialAdvice: (() => void) | undefined;
      let markInitialAdviceReturned: (() => void) | undefined;
      const initialAdviceReturned = new Promise<void>((resolve) => {
        markInitialAdviceReturned = resolve;
      });
      const revisedDescription = 'Search the revised fixture item catalog.';
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-stale-finesse-at-stop',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
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
            if (!decisionInput.verificationFindings) {
              const desiredPlan =
                decisionInput.phase === 'discovery'
                  ? initialSingleToolDesiredPlan(decisionInput)
                  : decisionInput.plannerProposals.length > 0
                    ? proposalDesiredPlan(decisionInput)
                    : desiredFromCurrent(decisionInput);
              const output = MasterDecisionOutputSchema.parse({
                binding: decisionInput.current?.run ?? decisionInput.discovery.run,
                outcome: 'accepted',
                reason: 'The single fixture operation remains supported.',
                recallToolNames: [],
                desiredPlan,
              });
              return requestValidatedMasterDecision(decisionInput, {
                analyzer: {
                  async analyze() {
                    return { text: JSON.stringify(output) };
                  },
                },
              });
            }
            // Let optional advice for Build A finish while an independent core
            // revision is in flight. The journal still points at Build A until
            // this decision returns, but the advice never enters the decision.
            if (!resolveInitialAdvice) await new Promise((resolve) => setTimeout(resolve, 0));
            if (!resolveInitialAdvice) throw new Error('fixture expected the initial advisor');
            resolveInitialAdvice();
            await initialAdviceReturned;
            await new Promise((resolve) => setTimeout(resolve, 0));

            const desiredPlan = desiredFromCurrent(decisionInput);
            const tool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
            if (!tool) throw new Error('fixture expected the producer plan');
            tool.candidate.description = revisedDescription;
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run,
              outcome: 'revised',
              reason: 'The core result review requires a revised producer build.',
              recallToolNames: [PRODUCER_NAME],
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
          requestParameterSelectionAdvice: async (advisorInput) => {
            parameterAdvisorCalls += 1;
            if (parameterAdvisorCalls > 1) {
              throw new Error('Optional breadth for Build B remains best-effort.');
            }
            const tool = advisorInput.currentPlan.payload.tools.find(
              ({ id }) => id === advisorInput.toolId,
            );
            const proof = advisorInput.snapshot.payload.tools.find(
              ({ toolId }) => toolId === advisorInput.toolId,
            );
            const evidenceRef = advisorInput.evidence.payload.entries[0]?.ref;
            if (!tool || !proof || !evidenceRef) {
              throw new Error('fixture expected current tool proof and focused evidence');
            }
            const advice = ParameterSelectionAdvisorOutputSchema.parse({
              binding: {
                runId: advisorInput.run.runId,
                recordingSha256: advisorInput.run.recordingSha256,
                toolId: advisorInput.toolId,
                compileInputsSha256: proof.executionBinding.compileInputsSha256,
              },
              likelyParams: tool.candidate.likelyParams,
              evidenceRefs: [evidenceRef],
              concerns: [],
              reason: 'Build A has optional parameter breadth available for later finesse.',
            });
            return await new Promise<typeof advice>((resolve) => {
              resolveInitialAdvice = () => {
                resolve(advice);
                markInitialAdviceReturned?.();
              };
            });
          },
          requestCompletionReview: async (reviewInput) => {
            completionReviewCalls += 1;
            const results = reviewInput.toolResultEvidence ?? [];
            const result = results.find(({ payload }) => payload.toolId === PRODUCER_ID);
            if (!result) throw new Error('fixture expected the producer result evidence');
            const revisionRequired = completionReviewCalls === 1;
            return CompletionReviewOutputSchema.parse({
              binding: reviewInput.run,
              verdict: revisionRequired ? 'failed' : 'passed',
              summary: revisionRequired
                ? 'The producer needs a required core revision.'
                : 'The revised producer result is credible.',
              findings: revisionRequired
                ? [
                    {
                      severity: 'blocking',
                      toolId: PRODUCER_ID,
                      message: 'Revise the producer core contract.',
                      evidenceRefs: [result.ref],
                    },
                  ]
                : [],
              toolResultReviews: results.map((candidate) => ({
                toolId: candidate.payload.toolId,
                ...(candidate.payload.chainEdgeId
                  ? { chainEdgeId: candidate.payload.chainEdgeId }
                  : {}),
                status: revisionRequired ? 'revision_required' : 'credible',
                reason: revisionRequired
                  ? 'The current producer result requires a core revision.'
                  : 'The revised producer result has the expected fixture shape.',
                evidenceRefs: [candidate.ref],
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

      expect(terminal.status).toBe('completed');
      expect(terminal.readyTools).toBe(1);
      expect(terminal.message).toContain('0 optional parameter suggestion(s)');
      expect(parameterAdvisorCalls).toBe(2);
      expect(completionReviewCalls).toBe(2);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(2);
      expect(promotionBatches).toEqual([[PRODUCER_NAME], [PRODUCER_NAME]]);
      const finesseDir = join(terminal.runRoot, 'finesse', PRODUCER_ID);
      const statuses = readdirSync(finesseDir)
        .filter((name) => name.endsWith('.json'))
        .map(
          (name) =>
            (readJson(join(finesseDir, name)) as { status: string; toolName: string }).status,
        )
        .sort();
      expect(statuses).toEqual(['failed', 'stale']);
    });
  });

  it('continues the retained compiler directly when the master recalls a rejected artifact', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      let repairAttempts = 0;
      let completionReviewCalls = 0;
      let baselineReviews = 0;
      let repairPlannerCalls = 0;
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-retained-leaf-rejected',
        events,
        promotionBatches,
        requestBaselineMvpReview: (reviewInput) => {
          baselineReviews += 1;
          return baselineMvpReview(
            reviewInput,
            baselineReviews === 1 ? 'revision_required' : 'credible',
          );
        },
      });
      const baseRequestFocusedPlan = base.requestFocusedPlan;
      if (!baseRequestFocusedPlan) throw new Error('fixture focused planner is missing');

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
          requestFocusedPlan: async (plannerInput) => {
            if (plannerInput.revisionContext) repairPlannerCalls += 1;
            return await baseRequestFocusedPlan(plannerInput);
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
          requestMasterDecision: async (decisionInput) => {
            const desiredPlan =
              decisionInput.phase === 'discovery'
                ? initialSingleToolDesiredPlan(decisionInput)
                : decisionInput.plannerProposals.length > 0
                  ? proposalDesiredPlan(decisionInput)
                  : desiredFromCurrent(decisionInput);
            if (decisionInput.verificationFindings) {
              repairAttempts += 1;
              const rejectedTool = desiredPlan.tools.find(({ id }) => id === PRODUCER_ID);
              if (!rejectedTool) throw new Error('fixture expected the rejected tool');
              rejectedTool.implementationPlan = undefined;
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: 'accepted',
              reason:
                'Keep the accepted tool contract and explicitly recall its rejected implementation.',
              recallToolNames: decisionInput.verificationFindings ? [PRODUCER_NAME] : [],
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

      expect(terminal.status).toBe('completed');
      expect(terminal.readyTools).toBe(1);
      expect(terminal.nonReadyTools).toBe(0);
      expect(repairAttempts).toBe(1);
      expect(events.filter((event) => event === `review:${PRODUCER_ID}`)).toHaveLength(2);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(2);
      expect(repairPlannerCalls).toBe(0);
      expect(completionReviewCalls).toBe(1);
      expect(promotionBatches).toEqual([[PRODUCER_NAME]]);
    });
  });

  it('sends prior build findings straight to the retained compiler for artifact repair', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const repairReason =
        'Build A returned the wrong core result; compile and verify a fresh Build B plan.';
      const reviewStatuses: Array<'credible' | 'revision_required'> = [];
      const compilerRevisionGuidance: Array<string | undefined> = [];
      const compilerRevisionContexts: Array<FocusedPlannerInput['revisionContext']> = [];
      let sawBuildAFinding = false;
      let repairPlannerCalls = 0;
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
            compilerRevisionContexts.push(compileInput.revisionContext);
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
              repairPlannerCalls += 1;
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
              outcome = 'revised';
              reason = repairReason;
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
              recallToolNames: decisionInput.verificationFindings ? [PRODUCER_NAME] : [],
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
      expect(terminal.nonReadyTools).toBe(0);
      expect(sawBuildAFinding).toBe(true);
      expect(repairPlannerCalls).toBe(0);
      expect(reviewStatuses).toEqual(['revision_required', 'credible']);
      expect(compilerRevisionGuidance[1]).toBe(repairReason);
      expect(compilerRevisionContexts[1]?.sourcePlanRevision).toBeGreaterThan(0);
      expect(compilerRevisionContexts[1]?.sourceBuildRef).toBeDefined();
      expect(compilerRevisionContexts[1]?.previousImplementationPlan?.payload.toolId).toBe(
        PRODUCER_ID,
      );
      expect(
        compilerRevisionContexts[1]?.latestFailureFacts.payload.entries.some(
          (entry) => entry.kind === 'mechanical_fact' && entry.toolId === PRODUCER_ID,
        ),
      ).toBe(true);
      expect(JSON.stringify(compilerRevisionContexts[1]?.latestFailureFacts)).toContain(
        'Factual result from the source build being reviewed',
      );
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
        revisionContext?: FocusedPlannerInput['revisionContext'];
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
              revisionContext: compileInput.revisionContext,
            });
            if (compileAttempts.length === 3)
              throw new ProviderUnavailableError(
                new Error('fixture stops after checking the retained seed'),
              );
            const focused = await baseCompileFocusedTool(compileInput);
            if (compileAttempts.length !== 2) return focused;
            return {
              ...focused,
              compilerSummary:
                'The compiler wrote request sequence 999 while the accepted evidence requires sequence 1.',
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
              recallToolNames: decisionInput.verificationFindings ? [PRODUCER_NAME] : [],
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
      expect(JSON.stringify(compileAttempts[2]?.revisionContext?.latestFailureFacts)).toContain(
        'workflow request provenance does not match the accepted plan',
      );
      expect(JSON.stringify(compileAttempts[2]?.revisionContext?.latestFailureFacts)).toContain(
        'The compiler wrote request sequence 999',
      );
      expect(JSON.stringify(compileAttempts[2]?.revisionContext?.latestFailureFacts)).not.toContain(
        'does not demonstrate the fixture operation',
      );
      expect(compileAttempts[2]?.revisionContext?.sourcePlanRevision).toBeGreaterThan(
        compileAttempts[1]?.revisionContext?.sourcePlanRevision ?? 0,
      );
    });
  });

  it('gives the rejected artifact and retained session to the same-strategy repair', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const compileAttempts: Array<{
        stagingDir: string;
        priorToolDir?: string;
        resumeSessionId?: string;
      }> = [];
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
              resumeSessionId: compileInput.resumeSessionId,
            });
            if (compileAttempts.length === 1) compileInput.onSessionId?.('compiler-session-1');
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
              recallToolNames: decisionInput.verificationFindings ? [PRODUCER_NAME] : [],
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
      expect(compileAttempts[0]?.resumeSessionId).toBeUndefined();
      expect(compileAttempts[1]?.resumeSessionId).toBe('compiler-session-1');
      expect(events).not.toContain(`review:${PRODUCER_ID}`);
      expect(promotionBatches).toEqual([]);
    });
  });

  it('retains the compiler conversation but not incompatible draft files across strategy changes', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const compileAttempts: Array<{
        stagingDir: string;
        priorToolDir?: string;
        resumeSessionId?: string;
        strategyKind?: string;
      }> = [];
      let repairDecisions = 0;
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-session-survives-strategy-change',
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
          requestFocusedPlan: async (plannerInput) => {
            const browser = plannerInput.tool.strategy?.kind === 'playbook_fallback';
            return FocusedPlannerOutputSchema.parse({
              binding: {
                runId: plannerInput.run.runId,
                site: plannerInput.run.site,
                recordingSha256: plannerInput.run.recordingSha256,
                toolId: plannerInput.tool.id,
              },
              tool: plannerInput.tool,
              chainEdges: plannerInput.incomingChainEdges,
              implementationPlan: browser
                ? browserFocusedImplementation(plannerInput)
                : focusedImplementation(plannerInput),
              reason: 'The fixture implementation follows the currently accepted strategy.',
            });
          },
          compileFocusedTool: async (compileInput) => {
            compileAttempts.push({
              stagingDir: compileInput.stagingDir,
              priorToolDir: compileInput.priorToolDir,
              resumeSessionId: compileInput.resumeSessionId,
              strategyKind: compileInput.tool.strategy?.kind,
            });
            if (compileAttempts.length === 1) compileInput.onSessionId?.('compiler-session-1');
            if (compileAttempts.length === 2) {
              throw new ProviderUnavailableError(
                new Error('fixture stops after observing the strategy-change context'),
              );
            }
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
              tool.strategy = {
                kind: 'playbook_fallback',
                reason: 'The fixture explicitly exercises an accepted strategy change.',
              };
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: decisionInput.verificationFindings ? 'revised' : 'accepted',
              reason: decisionInput.verificationFindings
                ? 'Change the fixture strategy while preserving the compiler discussion.'
                : 'Keep the focused producer plan.',
              recallToolNames: [],
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
      expect(compileAttempts[0]?.strategyKind).toBe('api');
      expect(compileAttempts[1]?.strategyKind).toBe('playbook_fallback');
      expect(compileAttempts[0]?.priorToolDir).toBeUndefined();
      expect(compileAttempts[1]?.priorToolDir).toBeUndefined();
      expect(compileAttempts[0]?.resumeSessionId).toBeUndefined();
      expect(compileAttempts[1]?.resumeSessionId).toBe('compiler-session-1');
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
              recallToolNames: outcome === 'revised' ? [PRODUCER_NAME] : [],
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
      expect(terminal.nonReadyTools).toBe(1);
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
      expect(terminal.nonReadyTools).toBe(1);
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

  it('finishes once as partial when a reviewed MVP remains beside an unresolved operation', async () => {
    await withTemporaryImprintHome(async (root) => {
      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const recordingPath = syntheticSessionPath(root);
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-partial-mvp',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      let unresolvedRevisionCount = 0;
      let completionReviewCount = 0;
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
          runApiTool: async ({ workflowPath }) => {
            const producer = workflowPath.includes(`/${PRODUCER_ID}/`);
            return {
              result: producer
                ? { ok: true as const, data: { items: [{ id: 'item-1' }] } }
                : {
                    ok: false as const,
                    error: 'BAD_RESPONSE',
                    message: 'The recorded consumer operation is unresolved.',
                  },
              executionMechanism: 'fixture-api',
            };
          },
          requestMasterDecision: async (decisionInput) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'revised' = 'accepted';
            if (decisionInput.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(decisionInput);
            } else if (decisionInput.verificationFindings) {
              unresolvedRevisionCount += 1;
              outcome = 'revised';
              desiredPlan = desiredFromCurrent(decisionInput);
              desiredPlan.tools = desiredPlan.tools.filter(({ id }) => id === PRODUCER_ID);
              desiredPlan.buildWaves = [[PRODUCER_ID]];
              desiredPlan.chainEdges = [];
              const coverage = desiredPlan.candidateCoverage.find(
                ({ discoveryCandidateName }) => discoveryCandidateName === CONSUMER_NAME,
              );
              if (!coverage) throw new Error('fixture expected consumer coverage');
              coverage.plannedToolIds = [];
              coverage.unresolvedReason =
                'The current grounded consumer request returned no usable result.';
              coverage.excludedReason = null;
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
                  ? 'Keep the verified producer and record the exhausted consumer honestly.'
                  : 'The current fixture plan remains supported.',
              recallToolNames: [],
              desiredPlan,
            });
            return requestValidatedMasterDecision(decisionInput, {
              analyzer: { analyze: async () => ({ text: JSON.stringify(output) }) },
            });
          },
          requestCompletionReview: async (input) => {
            completionReviewCount += 1;
            expect(input.terminalIntent).toBe('partial');
            const blocker = input.claims.find(({ kind }) => kind === 'blocker');
            expect(blocker).toBeDefined();
            expect(blocker?.evidenceRefs.length).toBeGreaterThan(1);
            expect(JSON.stringify(input.evidence)).toContain(
              'The recorded consumer operation is unresolved.',
            );
            return CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary:
                'The producer is credible and the remaining operation is explicitly unresolved.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The current producer result has the expected fixture shape.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports this explicit unresolved state.',
                evidenceRefs: claim.evidenceRefs,
              })),
            });
          },
        },
      );

      expect(terminal.status).toBe('partial');
      expect(terminal.readyTools).toBe(1);
      expect(terminal.nonReadyTools).toBe(1);
      expect(terminal.message).toContain('remain explicitly unresolved');
      expect(unresolvedRevisionCount).toBe(1);
      expect(completionReviewCount).toBe(1);
      expect(promotionBatches).toEqual([[PRODUCER_NAME]]);
      const state = FreshTeachJournalStateSchema.parse(
        readJson(join(terminal.runRoot, 'journal', 'current.json')),
      );
      expect(state.status).toBe('partial');
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
        revisionContext?: FocusedPlannerInput['revisionContext'];
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
                revisionContext: compileInput.revisionContext,
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
              for (const tool of desiredPlan.tools) tool.implementationPlan = undefined;
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: decisionInput.current?.run ?? decisionInput.discovery.run,
              outcome: repairingWithoutPlans ? 'revised' : 'accepted',
              reason: repairingWithoutPlans
                ? 'Recompile only the producer and recheck retained downstream tools.'
                : 'The dependency-ordered fixture plan remains supported.',
              recallToolNames: repairingWithoutPlans ? [PRODUCER_NAME] : [],
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
      expect(
        producerCompileRevisions[1]?.revisionContext?.previousImplementationPlan?.payload.toolId,
      ).toBe(PRODUCER_ID);
      expect(
        JSON.stringify(producerCompileRevisions[1]?.revisionContext?.latestFailureFacts),
      ).toContain('Fixture leaf requests a producer revision.');
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
              recallToolNames: [],
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
          requestApiResearchStep: fixtureApiResearchStep,
          runApiResearchTool: fixtureApiResearchTool,
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
              recallToolNames: [],
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
        nonReadyTools: 0,
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

  it('returns changed-boundary partial research to the same researcher before replanning', async () => {
    await withTemporaryImprintHome(async (root) => {
      const recordingPath = syntheticSessionPath(root, true);
      const session = SessionSchema.parse(readJson(recordingPath));
      session.requests = session.requests.map((request) =>
        request.seq === 4
          ? {
              seq: 4,
              timestamp: request.timestamp,
              method: 'GET',
              url: 'https://fixture.invalid/bootstrap',
              headers: { accept: 'text/html' },
              resourceType: 'Document',
              response: {
                status: 200,
                headers: { 'content-type': 'text/html' },
                mimeType: 'text/html',
                body: '<html>fixture bootstrap page</html>',
              },
            }
          : request,
      );
      writeFileSync(recordingPath, `${JSON.stringify(SessionSchema.parse(session))}\n`);

      const plannerCalls: string[] = [];
      const recallCommands: string[][] = [];
      const targetCompilerProvenance: number[][] = [];
      let targetPlannerCalls = 0;
      let firstTargetSawBootstrap = false;
      let secondTargetSawBootstrap = false;
      let secondTargetSawRevisedPlan = false;
      let secondTargetSawSiblingBootstrap = false;
      let revisionResearchPartial = false;
      let revisionResearchFollowedUp = false;
      let revisionResearchProven = false;

      const implementationWithRequests = (input: FocusedPlannerInput, requestSeqs: number[]) => {
        const implementation = focusedImplementation(input);
        const resultIndex = requestSeqs.length - 1;
        return ImplementationPlanPayloadSchema.parse({
          ...implementation,
          requestProvenance: requestSeqs.map((recordingRequestSeq, artifactRequestIndex) => ({
            artifactRequestIndex,
            recordingRequestSeq,
          })),
          parameterMappings: implementation.parameterMappings.map((mapping) => ({
            ...mapping,
            artifactRequestIndices: [resultIndex],
          })),
          resultSources: [
            {
              artifactRequestIndex: resultIndex,
              source: 'Return the JSON body from the final recorded request.',
            },
          ],
          verificationCases: implementation.verificationCases.map((verificationCase) => ({
            ...verificationCase,
            provenance: {
              ...verificationCase.provenance,
              recordingRequestSeqs: requestSeqs,
            },
          })),
        });
      };

      const events: string[] = [];
      const promotionBatches: string[][] = [];
      const base = lifecycleFailureFixture({
        runId: 'run-e2e-sibling-bootstrap-replan',
        events,
        promotionBatches,
        requestBaselineMvpReview: credibleBaselineMvpReview,
      });
      const baseResearch = base.requestApiResearchStep;
      if (!baseResearch) throw new Error('fixture API researcher is missing');
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
          requestApiResearchStep: async (input) => {
            const decision = await baseResearch(input);
            const isRevisedConsumer =
              input.tool.id === CONSUMER_ID && input.tool.candidate.dependencySeqs.includes(4);
            if (
              isRevisedConsumer &&
              !input.followUp &&
              decision.action === 'proven' &&
              !revisionResearchPartial
            ) {
              revisionResearchPartial = true;
              return {
                ...decision,
                action: 'partial' as const,
                missingProof: ['Confirm request 4 supplies the revised bootstrap obligation.'],
                reason: 'The direct consumer call works; revised bootstrap proof is still missing.',
              };
            }
            if (isRevisedConsumer && input.followUp) {
              revisionResearchFollowedUp = true;
              expect(input.previousProgress?.status).toBe('partial');
              expect(input.followUp.relevantRequestSeqs).toEqual([4]);
              expect(JSON.stringify(input.evidence)).toContain('https://fixture.invalid/bootstrap');
              if (decision.action === 'proven') revisionResearchProven = true;
            }
            return decision;
          },
          requestFocusedPlan: async (input) => {
            plannerCalls.push(input.tool.id);
            const tool = structuredClone(input.tool);
            let requestSeqs = [tool.candidate.requestSeqs[0] ?? -1];
            if (tool.id === PRODUCER_ID) {
              tool.candidate.dependencySeqs = [4];
              tool.compileContext = {
                ...tool.compileContext,
                tokenExtractionNotes: 'Bootstrap transport state with recording request 4.',
              };
              requestSeqs = [4, 1];
            } else {
              targetPlannerCalls += 1;
              const evidenceHasBootstrap = JSON.stringify(input.evidence).includes(
                'https://fixture.invalid/bootstrap',
              );
              if (targetPlannerCalls === 1) firstTargetSawBootstrap = evidenceHasBootstrap;
              else {
                secondTargetSawBootstrap = evidenceHasBootstrap;
                secondTargetSawRevisedPlan =
                  tool.candidate.dependencySeqs.includes(4) &&
                  tool.compileContext.tokenExtractionNotes.includes('request 4');
                const producer = input.siblingToolEvidence.find(
                  ({ toolId }) => toolId === PRODUCER_ID,
                );
                secondTargetSawSiblingBootstrap =
                  producer?.supportRequestSeqs.includes(4) === true &&
                  producer.compileContext.tokenExtractionNotes.includes('request 4');
              }
              if (tool.candidate.dependencySeqs.includes(4)) requestSeqs = [4, 2];
            }
            return FocusedPlannerOutputSchema.parse({
              binding: {
                runId: input.run.runId,
                site: input.run.site,
                recordingSha256: input.run.recordingSha256,
                toolId: tool.id,
              },
              tool: {
                ...tool,
                strategy: {
                  kind: 'api',
                  reason: 'The focused fixture has a grounded API request sequence.',
                },
              },
              chainEdges: input.incomingChainEdges,
              implementationPlan: implementationWithRequests(input, requestSeqs),
              reason:
                tool.id === PRODUCER_ID
                  ? 'Recording request 4 supplies the bootstrap used by request 1.'
                  : 'Use the target evidence currently authorized by the master.',
            });
          },
          requestMasterDecision: async (input) => {
            let desiredPlan: DesiredTeachingPlan;
            let outcome: 'accepted' | 'revised' = 'accepted';
            let researchFollowUps: NonNullable<
              ReturnType<typeof MasterDecisionOutputSchema.parse>['researchFollowUps']
            > = [];
            if (input.decisionPurpose === 'research_review') {
              desiredPlan = desiredFromCurrent(input);
              const partial = (input.apiResearch ?? []).find(
                ({ toolName, status }) => toolName === CONSUMER_NAME && status === 'partial',
              );
              if (partial) {
                researchFollowUps = [
                  {
                    toolName: CONSUMER_NAME,
                    instruction:
                      'Inspect request 4 and prove whether it supplies the revised bootstrap obligation.',
                    missingProof: partial.missingProof ?? [
                      'The revised bootstrap obligation remains unproven.',
                    ],
                    relevantToolNames: [],
                    relevantRequestSeqs: [4],
                  },
                ];
              }
            } else if (input.phase === 'discovery') {
              desiredPlan = initialDesiredPlan(input);
            } else if (input.plannerProposals.length === 2) {
              desiredPlan = proposalDesiredPlan(input);
              const target = desiredPlan.tools.find(({ id }) => id === CONSUMER_ID);
              if (!target) throw new Error('fixture expected the target tool');
              target.candidate.dependencySeqs = [4];
              target.compileContext = {
                ...target.compileContext,
                tokenExtractionNotes: 'Bootstrap transport state with recording request 4.',
              };
              target.implementationPlan = undefined;
              outcome = 'revised';
            } else if (input.plannerProposals.length === 1) {
              expect(input.plannerProposals[0]?.payload.tool.id).toBe(CONSUMER_ID);
              desiredPlan = proposalDesiredPlan(input);
            } else {
              desiredPlan = desiredFromCurrent(input);
            }
            const output = MasterDecisionOutputSchema.parse({
              binding: input.current?.run ?? input.discovery.run,
              outcome,
              reason:
                outcome === 'revised'
                  ? 'Carry the sibling bootstrap into the target and replan only that tool.'
                  : 'The focused fixture plan is current.',
              recallToolNames: [],
              ...(input.decisionPurpose === 'research_review' ? { researchFollowUps } : {}),
              desiredPlan,
            });
            recallCommands.push(output.recallToolNames);
            return requestValidatedMasterDecision(input, {
              analyzer: { analyze: async () => ({ text: JSON.stringify(output) }) },
            });
          },
          compileFocusedTool: async ({ tool, implementationPlan, stagingDir }) => {
            events.push(`compile:${tool.id}`);
            const provenance = implementationPlan.requestProvenance.map(
              ({ recordingRequestSeq }) => recordingRequestSeq,
            );
            if (tool.id === CONSUMER_ID) targetCompilerProvenance.push(provenance);
            mkdirSync(stagingDir, { recursive: true });
            const workflow = WorkflowSchema.parse({
              toolName: tool.candidate.toolName,
              intent: { description: tool.candidate.description },
              parameters: tool.candidate.likelyParams.map(({ name, type, description }) => ({
                name,
                type,
                description,
              })),
              requests: provenance.map((recordingRequestSeq) => ({
                recordingRequestSeq,
                method: 'GET',
                url:
                  recordingRequestSeq === 4
                    ? 'https://fixture.invalid/bootstrap'
                    : recordingRequestSeq === 1
                      ? 'https://fixture.invalid/api/items'
                      : 'https://fixture.invalid/api/items/${param.item_id}',
                headers: { accept: recordingRequestSeq === 4 ? 'text/html' : 'application/json' },
              })),
              site: SITE,
            });
            const workflowPath = join(stagingDir, 'workflow.json');
            writeFileSync(workflowPath, `${JSON.stringify(workflow)}\n`);
            return { workflow, workflowPath, toolDir: stagingDir };
          },
          requestCompletionReview: async (input) =>
            CompletionReviewOutputSchema.parse({
              binding: input.run,
              verdict: 'passed',
              summary: 'Both focused fixture tools have current factual evidence.',
              findings: [],
              toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
                toolId: result.payload.toolId,
                ...(result.payload.chainEdgeId ? { chainEdgeId: result.payload.chainEdgeId } : {}),
                status: 'credible',
                reason: 'The current fixture result has the expected shape.',
                evidenceRefs: [result.ref],
              })),
              claimDispositions: input.claims.map((claim) => ({
                claimId: claim.id,
                status: 'supported',
                reason: 'The supplied evidence supports this terminal claim.',
                evidenceRefs: claim.evidenceRefs,
              })),
            }),
        },
      );

      expect(terminal.status).toBe('completed');
      expect(plannerCalls).toEqual([
        PRODUCER_ID,
        CONSUMER_ID,
        PRODUCER_ID,
        CONSUMER_ID,
        CONSUMER_ID,
      ]);
      expect(firstTargetSawBootstrap).toBe(false);
      expect(secondTargetSawBootstrap).toBe(true);
      expect(secondTargetSawRevisedPlan).toBe(true);
      expect(secondTargetSawSiblingBootstrap).toBe(true);
      expect(revisionResearchPartial).toBe(true);
      expect(revisionResearchFollowedUp).toBe(true);
      expect(revisionResearchProven).toBe(true);
      expect(recallCommands.every((names) => names.length === 0)).toBe(true);
      expect(targetCompilerProvenance).toEqual([[4, 2]]);
      expect(events.filter((event) => event === `compile:${PRODUCER_ID}`)).toHaveLength(1);
      expect(events.filter((event) => event === `compile:${CONSUMER_ID}`)).toHaveLength(1);
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
