import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionReviewInput,
  CompletionToolResultEvidenceSchema,
} from '../src/imprint/master-teach-agent-contracts.ts';
import { acceptedRequestNotCheckedCheck } from '../src/imprint/master-teach-checks.ts';
import {
  type ChainEdge,
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type EditableTeachingPlan,
  type EditableTeachingTool,
  type ImplementationPlanPayload,
  type TeachingPlanDecision,
  createEditableTeachingPlan,
  proposeDependencyBuildWaves,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
} from '../src/imprint/master-teach-plan.ts';
import type { ReceiptFact } from '../src/imprint/master-teach-prompt-projections.ts';
import {
  type FreshTeachBootstrapObject,
  FreshTeachJournal,
} from '../src/imprint/master-teach-store.ts';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RECORDING = teachingPlanContentSha256('recording');
const validation = {
  site: 'fixture-site',
  recordingSha256: RECORDING,
  requestSeqs: new Set([1, 2, 3, 4]),
  eventSeqs: new Set([10]),
};
const run = { runId: 'fresh-run', site: validation.site, recordingSha256: RECORDING };
const now = () => '2026-08-29T12:00:00.000Z';
const bootstrapValues = new Map<string, unknown>();

function ref(label: string, value: unknown = label): ContentAddressedRef {
  const sha256 = teachingPlanContentSha256(value);
  const result = { path: `objects/json/${sha256.slice(7)}.json`, sha256 };
  bootstrapValues.set(`${result.path}\u0000${result.sha256}`, value);
  return result;
}

function decision(outcome: 'initial' | 'revised' = 'revised'): TeachingPlanDecision {
  return {
    timestamp: now(),
    outcome,
    reason: 'The recording supports this complete plan.',
    advisorRefs: [],
    evidenceRefs: [],
  };
}

function tool(
  id: string,
  toolName: string,
  seq: number,
  dependsOnTools: string[] = [],
  strategyKind: 'api' | 'playbook_fallback' = 'api',
): EditableTeachingTool {
  return {
    id,
    candidate: {
      toolName,
      description: `Run ${toolName}.`,
      rationale: `Recording evidence supports ${toolName}.`,
      confidence: 0.95,
      requestSeqs: strategyKind === 'api' ? [seq] : [],
      representativeSeqs: strategyKind === 'api' ? [seq] : [],
      eventSeqs: [],
      expectedOutput: `Results from ${toolName}.`,
      likelyParams: [],
      dependencySeqs: [],
      dependsOnTools,
    },
    compileContext: {
      loginRequestSeqs: [],
      credentialNames: [],
      tokenExtractionNotes: '',
      sharedHelperNotes: '',
      authRequestSeqs: [],
      authNotes: '',
    },
    evidenceRefs: [ref(`evidence/${id}.json`)],
    strategy: {
      kind: strategyKind,
      reason:
        strategyKind === 'api'
          ? 'The recording contains an API request.'
          : 'The master selected the browser fallback.',
    },
  };
}

function initialPlan(tools: EditableTeachingTool[], chainEdges: ChainEdge[] = []) {
  return createEditableTeachingPlan(
    {
      site: validation.site,
      recordingSha256: RECORDING,
      tools,
      candidateCoverage: tools.map((tool) => ({
        discoveryCandidateName: tool.candidate.toolName,
        plannedToolIds: [tool.id],
        unresolvedReason: null,
      })),
      buildWaves: proposeDependencyBuildWaves(tools),
      chainEdges,
    },
    { decision: decision('initial') },
    validation,
  );
}

function bootstrapForPlan(plan: EditableTeachingPlan): FreshTeachBootstrapObject[] {
  const refs = plan.tools.flatMap(({ evidenceRefs }) => evidenceRefs);
  return [
    ...new Map(refs.map((value) => [`${value.path}\u0000${value.sha256}`, value])).values(),
  ].map((value) => ({
    ref: value,
    kind: 'json' as const,
    value: bootstrapValues.get(`${value.path}\u0000${value.sha256}`),
  }));
}

function fixture(tools = [tool('search-id', 'search', 1)], chainEdges: ChainEdge[] = []) {
  const parent = mkdtempSync(join(tmpdir(), 'imprint-journal-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'run');
  const plan = initialPlan(tools, chainEdges);
  const journal = FreshTeachJournal.create({
    root,
    run,
    plan,
    validation,
    sharedManifest: { files: [] },
    bootstrap: bootstrapForPlan(plan),
    now,
  });
  return { journal, root, plan };
}

function desiredFrom(plan: EditableTeachingPlan): DesiredTeachingPlan {
  const { version: _version, revision: _revision, decision: _decision, ...desired } = plan;
  return structuredClone(desired);
}

function implementation(toolValue: EditableTeachingTool): ImplementationPlanPayload {
  const api = toolValue.strategy?.kind === 'api';
  const requestSeqs = api ? toolValue.candidate.requestSeqs : [];
  return {
    version: 1,
    toolId: toolValue.id,
    strategyKind: api ? 'api' : 'playbook_fallback',
    requestProvenance: requestSeqs.map((recordingRequestSeq, artifactRequestIndex) => ({
      artifactRequestIndex,
      recordingRequestSeq,
    })),
    parameterMappings: [],
    responseDependencies: [],
    resultSources: [
      {
        artifactRequestIndex: requestSeqs.length ? 0 : null,
        source: 'Return the execution result.',
      },
    ],
    outputGuidance: 'Return a stable result.',
    verificationCases: [
      ...(api
        ? [
            {
              id: 'recorded_replay',
              check: 'replay' as const,
              parameterValues: [],
              expectedResult: 'Return the recorded result shape.',
              provenance: {
                recordingRequestSeqs: requestSeqs,
                recordingEventSeqs: [],
                evidenceRefs: toolValue.evidenceRefs,
              },
            },
          ]
        : []),
      {
        id: 'current_live',
        check: 'live',
        parameterValues: [],
        expectedResult: 'Return a current result shape.',
        provenance: {
          recordingRequestSeqs: requestSeqs,
          recordingEventSeqs: [],
          evidenceRefs: toolValue.evidenceRefs,
        },
      },
    ],
  };
}

function acceptImplementations(journal: FreshTeachJournal): EditableTeachingPlan {
  const current = journal.currentPlan();
  const desired = desiredFrom(current);
  for (const plannedTool of desired.tools) {
    plannedTool.implementationPlan = journal.storeImplementationPlan(
      implementation(plannedTool),
      teachingToolCompileInputsSha256(plannedTool, desired.chainEdges),
    );
  }
  journal.revisePlan(desired, {
    expectedRevision: current.revision,
    decision: decision(),
  });
  return journal.currentPlan();
}

function workflow(
  toolName: string,
  requestSeqs: number[],
  parameters: Array<{ name: string; type: 'string' | 'number' | 'boolean' }> = [],
) {
  return {
    toolName,
    intent: { description: `Run ${toolName}.` },
    parameters: parameters.map((parameter) => ({
      ...parameter,
      description: `Public ${parameter.name} parameter.`,
    })),
    requests: requestSeqs.map((recordingRequestSeq, index) => ({
      method: 'GET',
      url: `https://fixture.test/request-${index}`,
      headers: {},
      recordingRequestSeq,
    })),
    site: validation.site,
  };
}

function issueBuild(journal: FreshTeachJournal, id: string) {
  const plannedTool = journal.currentPlan().tools.find((candidate) => candidate.id === id);
  if (!plannedTool) throw new Error(`missing fixture tool ${id}`);
  const parameters = plannedTool.candidate.likelyParams.flatMap(({ name, type }) =>
    type ? [{ name, type }] : [],
  );
  return journal.issueBuild({
    toolId: id,
    workflow: workflow(
      plannedTool.candidate.toolName,
      plannedTool.strategy?.kind === 'api' ? plannedTool.candidate.requestSeqs : [],
      parameters,
    ),
  });
}

function passedInvocation(subject: string): ReceiptFact {
  return { kind: 'invocation', subject, status: 'passed', invocationIndex: 0 };
}

function replayFacts(seqs: number[]): ReceiptFact[] {
  return seqs.map((recordingSeq, artifactRequestIndex) => ({
    kind: 'request_comparison',
    subject: `request.${artifactRequestIndex}`,
    status: 'passed',
    artifactRequestIndex,
    recordingSeq,
    expectedBytes: 10,
    actualBytes: 10,
    remainingComparisons: seqs.length - artifactRequestIndex - 1,
  }));
}

function passRequiredChecks(journal: FreshTeachJournal, id: string, seqs: number[]) {
  journal.issueReceipt({ toolId: id, check: 'contract', facts: [passedInvocation('contract')] });
  journal.issueReceipt({ toolId: id, check: 'replay', facts: replayFacts(seqs) });
  journal.issueReceipt({ toolId: id, check: 'live', facts: [passedInvocation('live')] });
}

function completionInput(journal: FreshTeachJournal): CompletionReviewInput {
  const state = journal.readState();
  const plan = journal.currentPlan();
  const snapshot = journal.currentExecutionSnapshot();
  const evidencePayload = { entries: [] };
  const toolResultEvidence = plan.tools.map((plannedTool) => {
    if (!plannedTool.implementationPlan)
      throw new Error(`missing implementation plan for ${plannedTool.id}`);
    const proof = snapshot.payload.tools.find(({ toolId }) => toolId === plannedTool.id);
    const liveReceipt = proof?.receipts.find(({ check }) => check === 'live');
    if (!liveReceipt) throw new Error(`missing live receipt for ${plannedTool.id}`);
    const liveCase = implementation(plannedTool).verificationCases.find(
      ({ check }) => check === 'live',
    );
    if (!liveCase) throw new Error(`missing live case for ${plannedTool.id}`);
    const payload = {
      toolId: plannedTool.id,
      toolName: plannedTool.candidate.toolName,
      implementationPlanRef: plannedTool.implementationPlan,
      verificationCaseId: liveCase.id,
      expectedResult: liveCase.expectedResult,
      liveReceiptRef: liveReceipt.ref,
      actualResult: {
        observed: true,
        preview: '[{"ok":true}]',
        shape: 'array<object{ok}>',
        count: 1,
        truncated: false,
      },
    };
    return CompletionToolResultEvidenceSchema.parse({ ref: journal.storeJson(payload), payload });
  });
  return {
    terminalIntent: 'completed',
    run: {
      ...state.run,
      planRevision: plan.revision,
      planSha256: state.currentPlanRef.sha256,
    },
    recordingIndex: {
      recordingSha256: RECORDING,
      requestSeqs: [...validation.requestSeqs],
      eventSeqs: [...validation.eventSeqs],
    },
    currentPlan: { ref: state.currentPlanRef, payload: plan },
    snapshot,
    history: journal.receiptHistoryProjection(),
    evidence: { ref: journal.storeJson(evidencePayload), payload: evidencePayload },
    toolResultEvidence,
    claims: [],
  };
}

function passedCompletionOutput(input: CompletionReviewInput) {
  return {
    binding: input.run,
    verdict: 'passed' as const,
    summary: 'Every planned tool has current factual proof.',
    findings: [],
    toolResultReviews: (input.toolResultEvidence ?? []).map((result) => ({
      toolId: result.payload.toolId,
      status: 'credible' as const,
      reason: 'The current live result supports the implementation plan promise.',
      evidenceRefs: [result.ref],
    })),
    claimDispositions: [],
  };
}

describe('small fresh teach journal', () => {
  it('keeps every master-planned tool and its waves, including more than 32 tools', () => {
    const tools = Array.from({ length: 40 }, (_, index) =>
      tool(`tool-${index}`, `operation_${index}`, (index % 4) + 1),
    );
    const { journal } = fixture(tools);
    expect(journal.currentPlan().tools).toHaveLength(40);
    expect(journal.currentPlan().buildWaves.flat()).toEqual(tools.map(({ id }) => id));
    expect(journal.readState().tools).toHaveLength(40);
  });

  it('starts only a fresh run and stores plain atomic state plus content-addressed objects', () => {
    const { journal, root, plan } = fixture();
    const jsonRef = journal.storeJson({ factual: true });
    const bytesRef = journal.storeBytes('artifact bytes');
    expect(journal.readJson(jsonRef)).toEqual({ factual: true });
    expect(Buffer.from(journal.readBytes(bytesRef)).toString('utf8')).toBe('artifact bytes');
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).version).toBe(1);
    expect(() =>
      FreshTeachJournal.create({
        root,
        run,
        plan,
        validation,
        sharedManifest: { files: [] },
      }),
    ).toThrow('already exists');
    expect((FreshTeachJournal as unknown as { open?: unknown }).open).toBeUndefined();
  });

  it('rejects a build whose recorded request provenance is wrong', () => {
    const { journal } = fixture();
    acceptImplementations(journal);
    expect(() =>
      journal.issueBuild({ toolId: 'search-id', workflow: workflow('search', [2]) }),
    ).toThrow('provenance');
    expect(issueBuild(journal, 'search-id').record.toolId).toBe('search-id');
  });

  it('records factual receipts, browser replay N/A, and replacement history', () => {
    const { journal } = fixture([
      tool('api-id', 'api_search', 1),
      tool('browser-id', 'browser_search', 2, [], 'playbook_fallback'),
    ]);
    acceptImplementations(journal);
    issueBuild(journal, 'api-id');
    issueBuild(journal, 'browser-id');
    passRequiredChecks(journal, 'api-id', [1]);
    const browserReplay = journal.issueReceipt({ toolId: 'browser-id', check: 'replay' });
    expect(browserReplay.status).toBe('not_applicable');
    journal.issueReceipt({
      toolId: 'browser-id',
      check: 'contract',
      facts: [passedInvocation('contract')],
    });
    journal.issueReceipt({
      toolId: 'browser-id',
      check: 'live',
      facts: [passedInvocation('live')],
    });
    journal.issueReceipt({
      toolId: 'api-id',
      check: 'contract',
      facts: [passedInvocation('contract_replacement')],
    });
    expect(journal.receiptHistoryProjection().payload.totalCount).toBe(1);
    expect(journal.currentExecutionSnapshot().payload.tools).toHaveLength(2);
  });

  it('includes every superseded receipt in completion history', () => {
    const { journal } = fixture([tool('api-id', 'api_search', 1)]);
    acceptImplementations(journal);
    issueBuild(journal, 'api-id');
    for (let index = 0; index < 520; index += 1) {
      journal.issueReceipt({
        toolId: 'api-id',
        check: 'contract',
        facts: [passedInvocation(`contract_${index}`)],
      });
    }

    const history = journal.receiptHistoryProjection().payload;
    expect(history.totalCount).toBe(519);
    expect(history.includedCount).toBe(519);
    expect(history.entries).toHaveLength(519);
    expect(history.truncated).toBe(false);
    expect(history.entries[0]?.ordinal).toBe(518);
    expect(history.entries.at(-1)?.ordinal).toBe(0);
  });

  it('invalidates only a revised tool and its consumers while keeping unrelated builds', () => {
    const { journal } = fixture([
      tool('producer-id', 'producer', 1),
      tool('consumer-id', 'consumer', 2, ['producer']),
      tool('other-id', 'other', 3),
    ]);
    acceptImplementations(journal);
    issueBuild(journal, 'producer-id');
    issueBuild(journal, 'other-id');
    issueBuild(journal, 'consumer-id');
    const otherBuild = journal
      .readState()
      .tools.find(({ toolId }) => toolId === 'other-id')?.buildRef;
    const consumerBuild = journal
      .readState()
      .tools.find(({ toolId }) => toolId === 'consumer-id')?.buildRef;
    const current = journal.currentPlan();
    const desired = desiredFrom(current);
    const producer = desired.tools.find(({ id }) => id === 'producer-id');
    if (!producer) throw new Error('missing producer fixture');
    producer.compileContext.sharedHelperNotes = 'The master revised this tool.';
    producer.implementationPlan = undefined;
    journal.revisePlan(desired, {
      expectedRevision: current.revision,
      decision: decision(),
    });
    const after = journal.readState();
    expect(after.tools.find(({ toolId }) => toolId === 'producer-id')?.buildRef).toBeUndefined();
    expect(after.tools.find(({ toolId }) => toolId === 'consumer-id')?.buildRef).toEqual(
      consumerBuild,
    );
    expect(after.tools.find(({ toolId }) => toolId === 'consumer-id')?.currentReceiptRefs).toEqual(
      [],
    );
    expect(after.tools.find(({ toolId }) => toolId === 'other-id')?.buildRef).toEqual(otherBuild);
  });

  it('binds a chain receipt to the current producer build', () => {
    const edge: ChainEdge = {
      id: 'producer-to-consumer',
      producerToolId: 'producer-id',
      producerResultPath: '[0].id',
      consumerToolId: 'consumer-id',
      consumerParameter: 'item_id',
    };
    const producer = tool('producer-id', 'producer', 1);
    const consumer = tool('consumer-id', 'consumer', 2, ['producer']);
    consumer.candidate.likelyParams = [
      { name: 'item_id', type: 'string', description: 'Identifier from producer output.' },
    ];
    const { journal } = fixture([producer, consumer], [edge]);
    const current = journal.currentPlan();
    const desired = desiredFrom(current);
    for (const plannedTool of desired.tools) {
      const payload = implementation(plannedTool);
      payload.parameterMappings = plannedTool.candidate.likelyParams.map(({ name }) => ({
        parameterName: name,
        artifactRequestIndices: [0],
        guidance: 'Apply the producer value.',
      }));
      for (const verificationCase of payload.verificationCases)
        verificationCase.parameterValues = plannedTool.candidate.likelyParams.map(
          ({ name: parameterName }) => ({ parameterName, value: 'fixture-id' }),
        );
      plannedTool.implementationPlan = journal.storeImplementationPlan(
        payload,
        teachingToolCompileInputsSha256(plannedTool, desired.chainEdges),
      );
    }
    journal.revisePlan(desired, {
      expectedRevision: current.revision,
      decision: decision(),
    });
    issueBuild(journal, 'producer-id');
    issueBuild(journal, 'consumer-id');
    const receipt = journal.issueReceipt({
      toolId: 'consumer-id',
      check: 'chain',
      chainEdgeId: edge.id,
      facts: [passedInvocation('chain')],
    });
    expect(receipt.dependencyBuilds).toHaveLength(1);
    expect(receipt.dependencyBuilds[0]?.toolId).toBe('producer-id');
  });

  it('finishes only after every tool has factual proof and the independent review passes', () => {
    const { journal } = fixture();
    acceptImplementations(journal);
    issueBuild(journal, 'search-id');
    passRequiredChecks(journal, 'search-id', [1]);
    expect(() => journal.finish('completed')).toThrow('completion review');
    const input = completionInput(journal);
    expect(journal.finishWithReview('completed', input, passedCompletionOutput(input)).status).toBe(
      'completed',
    );
    expect(() => journal.storeJson({ tooLate: true })).toThrow('terminal');
  });

  it('finishes when an API replay baseline is explicitly unavailable', () => {
    const { journal } = fixture();
    acceptImplementations(journal);
    issueBuild(journal, 'search-id');
    journal.issueReceipt({
      toolId: 'search-id',
      check: 'contract',
      facts: [passedInvocation('contract')],
    });
    journal.issueReceipt({
      toolId: 'search-id',
      check: 'replay',
      facts: acceptedRequestNotCheckedCheck({
        provenance: [{ artifactRequestIndex: 0, recordingRequestSeq: 1 }],
      }).facts,
    });
    journal.issueReceipt({
      toolId: 'search-id',
      check: 'live',
      facts: [passedInvocation('live')],
    });
    const input = completionInput(journal);

    expect(journal.finishWithReview('completed', input, passedCompletionOutput(input)).status).toBe(
      'completed',
    );
  });
});
