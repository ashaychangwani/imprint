import { describe, expect, it } from 'bun:test';
import {
  type ChainEdge,
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  DesiredTeachingPlanSchema,
  type EditableTeachingPlan,
  type EditableTeachingTool,
  ImplementationPlanPayloadSchema,
  type TeachingPlanDecision,
  type TeachingToolCandidate,
  canonicalTeachingPlanJson,
  createEditableTeachingPlan,
  groundDetectorCandidateForMaster,
  implementationPlanRequestProvenanceSha256,
  normalizeDetectorCandidateForMaster,
  proposeDependencyBuildWaves,
  reviseEditableTeachingPlan,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
  unresolvedCandidateCoverage,
  validateBuildWorkflowProvenance,
  validateEditableTeachingPlan,
  validateImplementationPlanForTool,
} from '../src/imprint/master-teach-plan.ts';

const RECORDING = teachingPlanContentSha256('recording');
const validation = {
  site: 'fixture-site',
  recordingSha256: RECORDING,
  requestSeqs: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
  eventSeqs: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
};

const EMPTY_CONTEXT = {
  loginRequestSeqs: [],
  credentialNames: [],
  tokenExtractionNotes: '',
  sharedHelperNotes: '',
  authRequestSeqs: [],
  authNotes: '',
};

function ref(name: string, contents = name): ContentAddressedRef {
  return { path: `evidence/${name}.json`, sha256: teachingPlanContentSha256(contents) };
}

function candidate(
  toolName: string,
  options: {
    seq?: number;
    dependencies?: string[];
    params?: TeachingToolCandidate['likelyParams'];
  } = {},
): TeachingToolCandidate {
  const seq = options.seq ?? 1;
  return {
    toolName,
    description: `Perform ${toolName}`,
    rationale: `Request ${seq} supports this tool.`,
    confidence: 0.9,
    requestSeqs: [seq],
    representativeSeqs: [seq],
    eventSeqs: [],
    expectedOutput: `Results for ${toolName}`,
    likelyParams: options.params ?? [
      { name: 'query', type: 'string', description: 'Public query text.' },
    ],
    dependencySeqs: [],
    dependsOnTools: options.dependencies ?? [],
  };
}

function tool(
  id: string,
  name: string,
  options: Parameters<typeof candidate>[1] & { plan?: string } = {},
): EditableTeachingTool {
  return {
    id,
    candidate: candidate(name, options),
    compileContext: structuredClone(EMPTY_CONTEXT),
    evidenceRefs: [ref(`${id}-request`)],
    strategy: { kind: 'api', reason: 'The recording contains a replayable request.' },
    implementationPlan: options.plan
      ? {
          ...ref(`${id}-plan`, options.plan),
          basedOnCompileInputsSha256: teachingPlanContentSha256('pending'),
          requestProvenanceSha256: implementationPlanRequestProvenanceSha256([
            { artifactRequestIndex: 0, recordingRequestSeq: options.seq ?? 1 },
          ]),
        }
      : undefined,
  };
}

function desired(tools: EditableTeachingTool[], chainEdges: ChainEdge[] = []): DesiredTeachingPlan {
  const plan: DesiredTeachingPlan = {
    site: 'fixture-site',
    recordingSha256: RECORDING,
    tools,
    candidateCoverage: tools.map((tool) => ({
      discoveryCandidateName: tool.candidate.toolName,
      plannedToolIds: [tool.id],
      unresolvedReason: null,
    })),
    buildWaves: proposeDependencyBuildWaves(tools),
    chainEdges,
  };
  for (const plannedTool of plan.tools) {
    if (plannedTool.implementationPlan) {
      plannedTool.implementationPlan.basedOnCompileInputsSha256 = teachingToolCompileInputsSha256(
        plannedTool,
        chainEdges,
      );
    }
  }
  return plan;
}

function firstTool(plan: DesiredTeachingPlan): EditableTeachingTool {
  const value = plan.tools[0];
  if (!value) throw new Error('test plan has no tools');
  return value;
}

function firstEdge(plan: DesiredTeachingPlan): ChainEdge {
  const value = plan.chainEdges[0];
  if (!value) throw new Error('test plan has no chain edge');
  return value;
}

function firstEvidence(toolValue: EditableTeachingTool): ContentAddressedRef {
  const value = toolValue.evidenceRefs[0];
  if (!value) throw new Error('test tool has no evidence');
  return value;
}

function decision(
  outcome: 'initial' | 'accepted' | 'rejected' | 'revised',
  reason = 'The evidence supports this complete plan.',
): TeachingPlanDecision {
  return {
    timestamp: '2026-08-29T10:00:00.000Z',
    outcome,
    reason,
    advisorRefs: [ref('advisor')],
    evidenceRefs: [ref('decision-evidence')],
  };
}

function create(plan: DesiredTeachingPlan): EditableTeachingPlan {
  return createEditableTeachingPlan(plan, { decision: decision('initial') }, validation);
}

function implementationPayload(
  strategyKind: 'api' | 'playbook_fallback',
  recordingRequestSeqs: number[],
) {
  return ImplementationPlanPayloadSchema.parse({
    version: 1,
    toolId: 'search-id',
    strategyKind,
    requestProvenance: recordingRequestSeqs.map((recordingRequestSeq, artifactRequestIndex) => ({
      artifactRequestIndex,
      recordingRequestSeq,
    })),
    parameterMappings: [],
    responseDependencies: [],
    resultSources: [
      {
        artifactRequestIndex: recordingRequestSeqs.length ? 0 : null,
        source: 'Return the actual execution result.',
      },
    ],
    outputGuidance: 'Return a stable public result.',
    verificationCases: [
      ...(strategyKind === 'api'
        ? [
            {
              id: 'recorded_replay',
              check: 'replay' as const,
              parameterValues: [],
              expectedResult: 'Return the recorded public result shape.',
              provenance: {
                recordingRequestSeqs,
                recordingEventSeqs: [],
                evidenceRefs: [ref('search-id-request')],
              },
            },
          ]
        : []),
      {
        id: 'recorded_live',
        check: 'live',
        parameterValues: [],
        expectedResult: 'Return the recorded public result shape.',
        provenance: {
          recordingRequestSeqs,
          recordingEventSeqs: [],
          evidenceRefs: [ref('search-id-request')],
        },
      },
    ],
  });
}

function workflowRequestProvenance(recordingRequestSeqs: Array<number | undefined>) {
  return {
    toolName: 'search',
    intent: { description: 'Search a fixture.' },
    parameters: [],
    requests: recordingRequestSeqs.map((recordingRequestSeq, index) => ({
      method: 'GET',
      url: `https://fixture.test/request-${index}`,
      headers: {},
      ...(recordingRequestSeq === undefined ? {} : { recordingRequestSeq }),
    })),
    site: 'fixture-site',
  };
}

function chain(): DesiredTeachingPlan {
  return desired(
    [
      tool('producer-id', 'produce_token', { seq: 1 }),
      tool('consumer-id', 'consume_token', {
        seq: 2,
        dependencies: ['produce_token'],
      }),
      tool('leaf-id', 'show_details', { seq: 3, dependencies: ['consume_token'] }),
      tool('other-id', 'unrelated_search', { seq: 4 }),
    ],
    [
      {
        id: 'producer-consumer',
        producerToolId: 'producer-id',
        producerResultPath: 'results[0].token',
        consumerToolId: 'consumer-id',
        consumerParameter: 'query',
      },
      {
        id: 'consumer-leaf',
        producerToolId: 'consumer-id',
        producerResultPath: 'results[0].token',
        consumerToolId: 'leaf-id',
        consumerParameter: 'query',
      },
    ],
  );
}

describe('editable master teaching plan', () => {
  it('creates and validates a strict initial snapshot', () => {
    const plan = create(desired([tool('search-id', 'search')]));
    expect(plan.revision).toBe(1);
    expect(plan.decision.outcome).toBe('initial');
    expect(validateEditableTeachingPlan(plan, validation)).toEqual(plan);
    expect(() =>
      createEditableTeachingPlan(
        desired([tool('search-id', 'search')]),
        { decision: decision('accepted') },
        validation,
      ),
    ).toThrow('first plan decision');
  });

  it('distinguishes an evidence-backed detector exclusion from unfinished work', () => {
    const plan = desired([tool('search-id', 'search')]);
    plan.candidateCoverage.push({
      discoveryCandidateName: 'telemetry_false_positive',
      plannedToolIds: [],
      unresolvedReason: null,
      excludedReason: 'The recording shows this is telemetry, not a user-facing operation.',
    });
    const created = createEditableTeachingPlan(
      plan,
      { decision: decision('initial') },
      {
        ...validation,
        discoveryCandidateNames: ['search', 'telemetry_false_positive'],
      },
    );
    expect(unresolvedCandidateCoverage(created)).toEqual([]);

    const invalid = structuredClone(plan);
    const invalidCoverage = invalid.candidateCoverage[1];
    if (!invalidCoverage) throw new Error('missing exclusion fixture');
    invalidCoverage.unresolvedReason = 'The operation is also unfinished.';
    expect(DesiredTeachingPlanSchema.safeParse(invalid).success).toBe(false);

    const unresolved = structuredClone(plan);
    const unresolvedCoverage = unresolved.candidateCoverage[1];
    if (!unresolvedCoverage) throw new Error('missing unresolved fixture');
    unresolvedCoverage.excludedReason = null;
    unresolvedCoverage.unresolvedReason = 'The credible operation is not solved yet.';
    expect(unresolvedCandidateCoverage(DesiredTeachingPlanSchema.parse(unresolved))).toHaveLength(
      1,
    );
  });

  it('rejects unknown fields in plan, tool, candidate, refs, and compile context', () => {
    const base = desired([tool('search-id', 'search')]);
    const baseTool = firstTool(base);
    for (const invalid of [
      { ...base, surprise: true },
      { ...base, tools: [{ ...baseTool, surprise: true }] },
      {
        ...base,
        tools: [{ ...baseTool, candidate: { ...baseTool.candidate, surprise: true } }],
      },
      {
        ...base,
        tools: [
          {
            ...baseTool,
            evidenceRefs: [{ ...firstEvidence(baseTool), x: 1 }],
          },
        ],
      },
      {
        ...base,
        tools: [{ ...baseTool, compileContext: { ...baseTool.compileContext, surprise: true } }],
      },
      { ...base, sharedContext: structuredClone(EMPTY_CONTEXT) },
    ]) {
      expect(() => create(invalid as DesiredTeachingPlan)).toThrow();
    }
  });

  it('uses strict required semantic wire fields without coercion or defaults', () => {
    const base = desired([tool('search-id', 'search')]);
    const missingArrays = structuredClone(base) as unknown as Record<string, unknown>;
    const candidateValue = (missingArrays.tools as Array<Record<string, unknown>>)[0]
      ?.candidate as Record<string, unknown>;
    candidateValue.requestSeqs = undefined;
    expect(DesiredTeachingPlanSchema.safeParse(missingArrays).success).toBe(false);

    const missingParamField = structuredClone(base);
    const parameter = firstTool(missingParamField).candidate.likelyParams[0] as unknown as Record<
      string,
      unknown
    >;
    parameter.description = undefined;
    expect(DesiredTeachingPlanSchema.safeParse(missingParamField).success).toBe(false);

    const coerced = structuredClone(base);
    (firstTool(coerced).candidate.likelyParams[0] as unknown as Record<string, unknown>).type =
      'String';
    expect(DesiredTeachingPlanSchema.safeParse(coerced).success).toBe(false);

    const missingContextField = structuredClone(base);
    (
      firstTool(missingContextField).compileContext as unknown as Record<string, unknown>
    ).authNotes = undefined;
    expect(DesiredTeachingPlanSchema.safeParse(missingContextField).success).toBe(false);
  });

  it('maps shipped unknown detector metadata to null and removes only its timestamp', () => {
    const value = candidate('search');
    const detectorValue = structuredClone(value);
    const detectorParameter = detectorValue.likelyParams[0] as unknown as Record<string, unknown>;
    detectorParameter.type = undefined;
    detectorParameter.description = undefined;
    expect(
      normalizeDetectorCandidateForMaster({
        ...detectorValue,
        eventTimeRange: { startTimestamp: 1, endTimestamp: 2 },
      }),
    ).toEqual({
      ...value,
      likelyParams: [{ name: 'query', type: null, description: null }],
    });
    expect(() => normalizeDetectorCandidateForMaster({ ...value, injected: true })).toThrow();
  });

  it('grounds raw detector event citations without changing its semantic proposal', () => {
    const value = candidate('search');
    value.requestSeqs = [1];
    value.representativeSeqs = [1];
    value.eventSeqs = [4, 1, 327, 999];
    value.dependencySeqs = [2];

    expect(
      groundDetectorCandidateForMaster(value, {
        eventSeqs: new Set([4]),
      }),
    ).toEqual({
      ...value,
      requestSeqs: [1],
      representativeSeqs: [1],
      eventSeqs: [4],
      dependencySeqs: [2],
    });

    const invalidEventsOnly = structuredClone(value);
    invalidEventsOnly.requestSeqs = [];
    invalidEventsOnly.representativeSeqs = [];
    invalidEventsOnly.dependencySeqs = [];
    invalidEventsOnly.eventSeqs = [1, 327, 999];
    const grounded = groundDetectorCandidateForMaster(invalidEventsOnly, {
      eventSeqs: new Set([4]),
    });
    expect(grounded.eventSeqs).toEqual([]);
    expect(grounded.toolName).toBe(invalidEventsOnly.toolName);
    expect(grounded.rationale).toBe(invalidEventsOnly.rationale);
  });

  it('preserves explicit unknown metadata and permits an honest empty output description', () => {
    const plan = desired([tool('search-id', 'search')]);
    const candidateValue = firstTool(plan).candidate;
    candidateValue.expectedOutput = '';
    candidateValue.likelyParams = [{ name: 'query', type: null, description: null }];
    expect(create(plan).tools[0]?.candidate).toEqual(candidateValue);
  });

  it('represents an honest empty plan without inventing a tool', () => {
    expect(create(desired([])).tools).toEqual([]);
  });

  it('rejects absolute and escaping content-reference paths', () => {
    for (const path of [
      '/tmp/evidence.json',
      '../evidence.json',
      'evidence/../secret',
      'C:/x',
      ' evidence/request.json',
      'evidence/request.json ',
    ]) {
      const plan = desired([tool('search-id', 'search')]);
      firstEvidence(firstTool(plan)).path = path;
      expect(() => create(plan)).toThrow();
    }
  });

  it('rejects noncanonical whitespace instead of silently trimming semantic fields', () => {
    const plan = desired([tool('search-id', 'search')]);
    firstTool(plan).candidate.description = ' padded description ';
    expect(() => create(plan)).toThrow('whitespace is not canonical');
    const site = desired([]);
    site.site = ' fixture-site';
    expect(() => create(site)).toThrow('whitespace is not canonical');
  });

  it('requires unique stable ids and names without ranking tools', () => {
    expect(() => create(desired([tool('same-id', 'one'), tool('same-id', 'two')]))).toThrow(
      'duplicate tool id',
    );
    expect(() => create(desired([tool('one-id', 'same'), tool('two-id', 'same')]))).toThrow(
      'duplicate tool name',
    );
    expect(create(desired([tool('one-id', 'one'), tool('two-id', 'two')])).tools).toHaveLength(2);
  });

  it('bounds stable ids, tool names, and dependency names to snapshot-safe lengths', () => {
    const longest = 'a'.repeat(128);
    expect(create(desired([tool(longest, longest)])).tools[0]?.id).toBe(longest);

    const tooLong = 'a'.repeat(129);
    expect(() => create(desired([tool(tooLong, 'search')]))).toThrow('invalid stable tool id');
    expect(() => create(desired([tool('search-id', tooLong)]))).toThrow();
    expect(() =>
      create(desired([tool('search-id', 'search', { dependencies: [tooLong] })])),
    ).toThrow();
  });

  it('rejects duplicate sequence numbers in candidates and focused compile context', () => {
    for (const field of [
      'requestSeqs',
      'representativeSeqs',
      'eventSeqs',
      'dependencySeqs',
    ] as const) {
      const plan = desired([tool('search-id', 'search')]);
      firstTool(plan).candidate[field] = [1, 1];
      expect(() => create(plan)).toThrow('sequence list must be unique');
    }
    for (const field of ['loginRequestSeqs', 'authRequestSeqs'] as const) {
      const plan = desired([tool('search-id', 'search')]);
      firstTool(plan).compileContext[field] = [1, 1];
      expect(() => create(plan)).toThrow('sequence list must be unique');
    }
  });

  it('requires every representative sequence to belong to its candidate requests', () => {
    const plan = desired([tool('search-id', 'search')]);
    firstTool(plan).candidate.representativeSeqs = [2];
    expect(() => create(plan)).toThrow(
      "representative seq 2 is absent from this candidate's requestSeqs",
    );
  });

  it('rejects missing recording seqs, missing dependencies, and cycles', () => {
    expect(() => create(desired([tool('bad-id', 'bad', { seq: 99 })]))).toThrow(
      'unknown recording seq 99',
    );
    expect(() =>
      create(
        desired([
          tool('one-id', 'one'),
          tool('two-id', 'two', { seq: 2, dependencies: ['missing'] }),
        ]),
      ),
    ).toThrow('depends on missing tool');
    expect(() =>
      create(
        desired([
          tool('one-id', 'one', { dependencies: ['two'] }),
          tool('two-id', 'two', { seq: 2, dependencies: ['one'] }),
        ]),
      ),
    ).toThrow('dependency cycle');
  });

  it('suggests one parallel wave containing every independent tool exactly once', () => {
    const tools = [
      tool('search-id', 'search'),
      tool('calendar-id', 'calendar', { seq: 2 }),
      tool('status-id', 'status', { seq: 3 }),
    ];
    const waves = proposeDependencyBuildWaves(tools);
    expect(waves).toEqual([['search-id', 'calendar-id', 'status-id']]);
    expect(waves.flat()).toEqual(tools.map(({ id }) => id));
  });

  it('keeps every discovered tool when the plan contains more than 32', () => {
    const tools = Array.from({ length: 40 }, (_, index) =>
      tool(`tool-${index}`, `operation_${index}`, { seq: (index % 8) + 1 }),
    );
    const plan = create(desired(tools));
    expect(plan.tools).toHaveLength(40);
    expect(plan.buildWaves.flat()).toEqual(tools.map(({ id }) => id));
  });

  it('suggests dependency-ordered waves for producers, consumers, and multiple levels', () => {
    const tools = [
      tool('search-id', 'search'),
      tool('reviews-id', 'reviews', { seq: 2, dependencies: ['details'] }),
      tool('details-id', 'details', { seq: 3, dependencies: ['search'] }),
      tool('calendar-id', 'calendar', { seq: 4 }),
      tool('booking-id', 'booking', {
        seq: 5,
        dependencies: ['details', 'calendar'],
      }),
    ];
    expect(proposeDependencyBuildWaves(tools)).toEqual([
      ['search-id', 'calendar-id'],
      ['details-id'],
      ['reviews-id', 'booking-id'],
    ]);
  });

  it('validates the master build hierarchy without replacing it with the default suggestion', () => {
    const plan = desired([
      tool('producer-id', 'producer'),
      tool('consumer-id', 'consumer', { seq: 2, dependencies: ['producer'] }),
      tool('independent-id', 'independent', { seq: 3 }),
    ]);
    plan.buildWaves = [['producer-id'], ['independent-id'], ['consumer-id']];
    expect(create(plan).buildWaves).toEqual([['producer-id'], ['independent-id'], ['consumer-id']]);
  });

  it('rejects incomplete, duplicate, unknown, same-wave, and reversed master build waves', () => {
    const valid = desired([
      tool('producer-id', 'producer'),
      tool('consumer-id', 'consumer', { seq: 2, dependencies: ['producer'] }),
    ]);
    for (const buildWaves of [
      [['producer-id']],
      [['producer-id'], ['consumer-id'], ['consumer-id']],
      [['producer-id'], ['unknown-id'], ['consumer-id']],
      [['producer-id', 'consumer-id']],
      [['consumer-id'], ['producer-id']],
    ]) {
      const plan = structuredClone(valid);
      plan.buildWaves = buildWaves;
      expect(() => create(plan)).toThrow();
    }
  });

  it('rejects missing dependencies and cycles when proposing initial waves', () => {
    expect(() =>
      proposeDependencyBuildWaves([tool('consumer-id', 'consumer', { dependencies: ['missing'] })]),
    ).toThrow('depends on missing tool');
    expect(() =>
      proposeDependencyBuildWaves([
        tool('one-id', 'one', { dependencies: ['two'] }),
        tool('two-id', 'two', { seq: 2, dependencies: ['one'] }),
      ]),
    ).toThrow('dependency cycle');
  });

  it('persists and validates explicit producer-consumer chain edges', () => {
    const plan = chain();
    expect(create(plan).chainEdges).toEqual(plan.chainEdges);
    const badParameter = structuredClone(plan);
    firstEdge(badParameter).consumerParameter = 'missing';
    expect(() => create(badParameter)).toThrow('unknown consumer parameter');
    const badTool = structuredClone(plan);
    firstEdge(badTool).producerToolId = 'missing-id';
    expect(() => create(badTool)).toThrow('references unknown tool');
    const badDependency = structuredClone(plan);
    const consumer = badDependency.tools[1];
    if (!consumer) throw new Error('test plan has no consumer');
    consumer.candidate.dependsOnTools = [];
    expect(() => create(badDependency)).toThrow('absent from the explicit tool dependency');
  });

  it('treats candidate metadata-only changes as no compile work', () => {
    const original = desired([
      tool('search-id', 'search'),
      tool('details-id', 'details', { seq: 2 }),
    ]);
    const current = create(original);
    const changed = structuredClone(original);
    firstTool(changed).candidate.confidence = 0.2;
    firstTool(changed).candidate.rationale = 'An advisor supplied a different rationale.';
    const details = changed.tools.find((value) => value.id === 'details-id');
    if (!details) throw new Error('test plan has no details tool');
    const result = reviseEditableTeachingPlan(
      current,
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.replanToolIds).toEqual([]);
    expect(result.recompileToolIds).toEqual([]);
    expect(result.reverifyToolIds).toEqual([]);
  });

  it('records rejected advice as a new no-op revision', () => {
    const original = desired([tool('search-id', 'search')]);
    const result = reviseEditableTeachingPlan(
      create(original),
      structuredClone(original),
      {
        expectedRevision: 1,
        decision: decision('rejected', 'The suggested split did not match the recorded operation.'),
      },
      validation,
    );
    expect(result.plan.revision).toBe(2);
    expect(result.plan.decision.outcome).toBe('rejected');
    expect(result.recompileToolIds).toEqual([]);
  });

  it('requires a strategy for an accepted implementation plan', () => {
    const plan = desired([tool('search-id', 'search', { plan: 'plan text' })]);
    firstTool(plan).strategy = undefined;
    expect(() => create(plan)).toThrow('needs a strategy');
  });

  it('keeps discovery uncertainty but requires concrete public parameters when a plan is accepted', () => {
    const discovery = desired([
      tool('search-id', 'search', {
        params: [{ name: 'query', type: null, description: null }],
      }),
    ]);
    expect(create(discovery).tools[0]?.candidate.likelyParams).toEqual([
      { name: 'query', type: null, description: null },
    ]);

    const accepted = desired([
      tool('search-id', 'search', {
        plan: 'accepted plan',
        params: [{ name: 'query', type: null, description: 'Search text.' }],
      }),
    ]);
    expect(() => create(accepted)).toThrow('needs a concrete scalar type');

    firstTool(accepted).candidate.likelyParams = [
      { name: 'query', type: 'string', description: null },
    ];
    const implementation = firstTool(accepted).implementationPlan;
    if (!implementation) throw new Error('test tool has no implementation ref');
    implementation.basedOnCompileInputsSha256 = teachingToolCompileInputsSha256(
      firstTool(accepted),
    );
    expect(() => create(accepted)).toThrow('needs a nonempty description');
  });

  it('binds declared verification cases to public parameter types and focused provenance', () => {
    const planned = tool('search-id', 'search');
    const payload = implementationPayload('api', [1]);
    payload.parameterMappings = [
      {
        parameterName: 'query',
        artifactRequestIndices: [0],
        guidance: 'Apply the public query to request zero.',
      },
    ];
    for (const verificationCase of payload.verificationCases)
      verificationCase.parameterValues = [{ parameterName: 'query', value: 'fixture query' }];
    const replayCase = payload.verificationCases.find(({ check }) => check === 'replay');
    const liveCase = payload.verificationCases.find(({ check }) => check === 'live');
    if (!replayCase || !liveCase)
      throw new Error('test implementation needs replay and live cases');
    replayCase.parameterValueOrigin = 'recorded_baseline';
    liveCase.parameterValueOrigin = 'synthetic_live';
    expect(
      validateImplementationPlanForTool(
        payload,
        planned,
        validation.requestSeqs,
        validation.eventSeqs,
      ),
    ).toEqual(payload);

    const unavailableBaseline = structuredClone(payload);
    const unavailableReplay = unavailableBaseline.verificationCases.find(
      ({ check }) => check === 'replay',
    );
    if (!unavailableReplay) throw new Error('test implementation has no replay case');
    unavailableReplay.parameterValueOrigin = 'unavailable';
    unavailableReplay.parameterValues = [];
    expect(
      validateImplementationPlanForTool(
        unavailableBaseline,
        planned,
        validation.requestSeqs,
        validation.eventSeqs,
      ),
    ).toEqual(unavailableBaseline);

    const syntheticReplay = structuredClone(payload);
    const invalidReplay = syntheticReplay.verificationCases.find(({ check }) => check === 'replay');
    if (!invalidReplay) throw new Error('test implementation has no replay case');
    invalidReplay.parameterValueOrigin = 'synthetic_live';
    expect(() => ImplementationPlanPayloadSchema.parse(syntheticReplay)).toThrow(
      'replay parameters cannot be synthetic live values',
    );

    const wrongType = structuredClone(payload);
    const wrongTypeCase = wrongType.verificationCases[0];
    if (!wrongTypeCase) throw new Error('test implementation has no verification case');
    wrongTypeCase.parameterValues = [{ parameterName: 'query', value: 42 }];
    expect(() =>
      validateImplementationPlanForTool(
        wrongType,
        planned,
        validation.requestSeqs,
        validation.eventSeqs,
      ),
    ).toThrow('does not match its public scalar type');

    const foreignEvidence = structuredClone(payload);
    const foreignCase = foreignEvidence.verificationCases[0];
    if (!foreignCase) throw new Error('test implementation has no verification case');
    foreignCase.provenance.evidenceRefs = [ref('foreign')];
    expect(() =>
      validateImplementationPlanForTool(
        foreignEvidence,
        planned,
        validation.requestSeqs,
        validation.eventSeqs,
      ),
    ).toThrow('evidence outside tool.evidenceRefs');

    const unknownEvent = structuredClone(payload);
    const unknownEventCase = unknownEvent.verificationCases[0];
    if (!unknownEventCase) throw new Error('test implementation has no verification case');
    unknownEventCase.provenance.recordingEventSeqs = [999];
    expect(() =>
      validateImplementationPlanForTool(
        unknownEvent,
        planned,
        validation.requestSeqs,
        validation.eventSeqs,
      ),
    ).toThrow('unknown recording event seq 999');
  });

  it('requires the fixed API and playbook verification paths without inventing cases', () => {
    const api = implementationPayload('api', [1]);
    expect(() =>
      ImplementationPlanPayloadSchema.parse({
        ...api,
        verificationCases: api.verificationCases.filter(({ check }) => check === 'replay'),
      }),
    ).toThrow('at least one live verification case');
    expect(() =>
      ImplementationPlanPayloadSchema.parse({
        ...api,
        verificationCases: api.verificationCases.filter(({ check }) => check === 'live'),
      }),
    ).toThrow('exactly one replay verification case');
    const replay = api.verificationCases.find(({ check }) => check === 'replay');
    if (!replay) throw new Error('test API implementation has no replay case');
    expect(() =>
      ImplementationPlanPayloadSchema.parse({
        ...api,
        verificationCases: [...api.verificationCases, { ...replay, id: 'second_replay' }],
      }),
    ).toThrow('exactly one replay verification case');

    const playbook = implementationPayload('playbook_fallback', []);
    expect(() =>
      ImplementationPlanPayloadSchema.parse({
        ...playbook,
        verificationCases: [
          ...playbook.verificationCases,
          {
            ...replay,
            id: 'playbook_replay',
            provenance: { ...replay.provenance, recordingRequestSeqs: [] },
          },
        ],
      }),
    ).toThrow('playbook implementation plans cannot declare replay verification cases');
  });

  it('binds implementation plans to the stable tool id', () => {
    const source = tool('source-id', 'search');
    const target = { ...structuredClone(source), id: 'target-id' };
    const sourceCompileInputs = teachingToolCompileInputsSha256(source);
    const targetCompileInputs = teachingToolCompileInputsSha256(target);
    expect(sourceCompileInputs).not.toBe(targetCompileInputs);
    target.implementationPlan = {
      ...ref('source-plan', 'source implementation plan'),
      basedOnCompileInputsSha256: sourceCompileInputs,
      requestProvenanceSha256: implementationPlanRequestProvenanceSha256([
        { artifactRequestIndex: 0, recordingRequestSeq: 1 },
      ]),
    };
    const crossToolPlan = desired([target]);
    const crossToolImplementation = firstTool(crossToolPlan).implementationPlan;
    if (!crossToolImplementation) throw new Error('missing cross-tool implementation fixture');
    crossToolImplementation.basedOnCompileInputsSha256 = sourceCompileInputs;
    expect(() => create(crossToolPlan)).toThrow(
      'implementation plan is based on stale compile inputs',
    );
  });

  it('issues API builds only when actual workflow request provenance is exact', () => {
    const accepted = implementationPayload('api', [1, 2]);
    expect(
      validateBuildWorkflowProvenance(workflowRequestProvenance([1, 2]), accepted).requests.map(
        ({ recordingRequestSeq }) => recordingRequestSeq,
      ),
    ).toEqual([1, 2]);
    expect(() =>
      validateBuildWorkflowProvenance(workflowRequestProvenance([1, 2]), {
        ...accepted,
        requestProvenance: [{ artifactRequestIndex: 0, recordingRequestSeq: 1 }],
        verificationCases: accepted.verificationCases.map((verificationCase) => ({
          ...verificationCase,
          provenance: {
            ...verificationCase.provenance,
            recordingRequestSeqs: [1],
          },
        })),
      }),
    ).toThrow('2 requests but accepted provenance has 1');
    expect(() =>
      validateBuildWorkflowProvenance(workflowRequestProvenance([2, 1]), accepted),
    ).toThrow('accepted provenance requires 1');
    expect(() =>
      validateBuildWorkflowProvenance(workflowRequestProvenance([undefined, 2]), accepted),
    ).toThrow('request 0 is missing recordingRequestSeq');
  });

  it('issues a playbook shell only with no workflow requests or API request map', () => {
    const accepted = implementationPayload('playbook_fallback', []);
    expect(
      validateBuildWorkflowProvenance(workflowRequestProvenance([]), accepted).requests,
    ).toEqual([]);
    expect(() => validateBuildWorkflowProvenance(workflowRequestProvenance([1]), accepted)).toThrow(
      'playbook_fallback workflow has 1 requests but accepted provenance has 0',
    );
    expect(() =>
      validateBuildWorkflowProvenance(workflowRequestProvenance([]), {
        ...accepted,
        requestProvenance: [{ artifactRequestIndex: 0, recordingRequestSeq: 1 }],
      }),
    ).toThrow('playbook implementation plans cannot declare API request provenance');
  });

  it('ignores strategy explanation edits but replans when the strategy kind changes', () => {
    const original = desired([tool('search-id', 'search')]);
    const explanationOnly = structuredClone(original);
    const explanationTool = firstTool(explanationOnly);
    if (!explanationTool.strategy) throw new Error('test tool has no strategy');
    explanationTool.strategy.reason = 'A clearer evidence-backed explanation.';
    const explanationResult = reviseEditableTeachingPlan(
      create(original),
      explanationOnly,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(explanationResult.replanToolIds).toEqual([]);
    expect(explanationResult.recompileToolIds).toEqual([]);

    const fallback = structuredClone(original);
    const fallbackTool = firstTool(fallback);
    fallbackTool.strategy = {
      kind: 'playbook_fallback',
      reason: 'The accepted evidence shows the API route is incompatible.',
    };
    const fallbackResult = reviseEditableTeachingPlan(
      create(original),
      fallback,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(fallbackResult.replanToolIds).toEqual(['search-id']);
    expect(fallbackResult.recompileToolIds).toEqual(['search-id']);
  });

  it('recompiles for an implementation-plan-only change without replanning', () => {
    const original = desired([tool('search-id', 'search', { plan: 'old plan' })]);
    const changed = structuredClone(original);
    const changedTool = firstTool(changed);
    if (!changedTool.implementationPlan) throw new Error('test tool has no implementation plan');
    changedTool.implementationPlan = {
      ...ref('search-plan', 'new plan'),
      basedOnCompileInputsSha256: teachingToolCompileInputsSha256(changedTool),
      requestProvenanceSha256: implementationPlanRequestProvenanceSha256([
        { artifactRequestIndex: 0, recordingRequestSeq: 1 },
      ]),
    };
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('accepted') },
      validation,
    );
    expect(result.replanToolIds).toEqual([]);
    expect(result.recompileToolIds).toEqual(['search-id']);
  });

  it('compares the complete implementation-plan ref', () => {
    const original = desired([tool('search-id', 'search', { plan: 'same plan' })]);
    const changed = structuredClone(original);
    const implementation = firstTool(changed).implementationPlan;
    if (!implementation) throw new Error('test tool has no implementation plan');
    implementation.path = 'moved/search-plan.json';
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.recompileToolIds).toEqual(['search-id']);
  });

  it('recompiles for parameter, request, evidence, and implementation-plan content changes', () => {
    const cases: Array<{ replan: boolean; mutate: (plan: DesiredTeachingPlan) => void }> = [
      {
        replan: true,
        mutate: (plan) => {
          firstTool(plan).candidate.likelyParams.push({
            name: 'date',
            type: 'string',
            description: 'Requested date.',
          });
        },
      },
      {
        replan: true,
        mutate: (plan) => {
          firstTool(plan).candidate.requestSeqs = [2];
          firstTool(plan).candidate.representativeSeqs = [2];
        },
      },
      {
        replan: true,
        mutate: (plan) => {
          firstTool(plan).evidenceRefs = [ref('new-evidence')];
        },
      },
      {
        replan: false,
        mutate: (plan) => {
          firstTool(plan).implementationPlan = {
            ...ref('search-plan', 'changed plan'),
            basedOnCompileInputsSha256: teachingPlanContentSha256('pending'),
            requestProvenanceSha256: implementationPlanRequestProvenanceSha256([
              { artifactRequestIndex: 0, recordingRequestSeq: 1 },
            ]),
          };
        },
      },
    ];
    for (const { mutate, replan } of cases) {
      const original = desired([tool('search-id', 'search', { plan: 'old plan' })]);
      const changed = structuredClone(original);
      mutate(changed);
      const changedTool = firstTool(changed);
      if (changedTool.implementationPlan) {
        changedTool.implementationPlan.basedOnCompileInputsSha256 =
          teachingToolCompileInputsSha256(changedTool);
      }
      const result = reviseEditableTeachingPlan(
        create(original),
        changed,
        { expectedRevision: 1, decision: decision('revised') },
        validation,
      );
      expect(result.replanToolIds).toEqual(replan ? ['search-id'] : []);
      expect(result.recompileToolIds).toEqual(['search-id']);
      expect(result.reverifyToolIds).toEqual(['search-id']);
    }
  });

  it('rejects an implementation plan after its compile inputs change', () => {
    const original = desired([tool('search-id', 'search', { plan: 'old plan' })]);
    const changed = structuredClone(original);
    firstTool(changed).candidate.likelyParams.push({
      name: 'date',
      type: 'string',
      description: 'Requested date.',
    });
    expect(() =>
      reviseEditableTeachingPlan(
        create(original),
        changed,
        { expectedRevision: 1, decision: decision('revised') },
        validation,
      ),
    ).toThrow('implementation plan is based on stale compile inputs');
  });

  it('uses content hashes, not ref paths or ordering, as compile evidence identity', () => {
    const original = desired([tool('search-id', 'search', { plan: 'same plan' })]);
    firstTool(original).evidenceRefs.push(ref('second'));
    const originalTool = firstTool(original);
    if (!originalTool.implementationPlan) throw new Error('test tool has no implementation plan');
    originalTool.implementationPlan.basedOnCompileInputsSha256 =
      teachingToolCompileInputsSha256(originalTool);
    const changed = structuredClone(original);
    const changedTool = firstTool(changed);
    changedTool.evidenceRefs.reverse();
    firstEvidence(changedTool).path = 'moved/evidence.json';
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.recompileToolIds).toEqual([]);
  });

  it('invalidates only a tool and its consumers when its compile context changes', () => {
    const original = chain();
    const changed = structuredClone(original);
    firstTool(changed).compileContext.sharedHelperNotes = 'A new focused compile instruction.';
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.replanToolIds).toEqual(['producer-id']);
    expect(result.recompileToolIds).toEqual(['producer-id']);
    expect(result.reverifyToolIds).toEqual(['consumer-id', 'leaf-id', 'producer-id']);
  });

  it('recompiles both ends when the producer output obligation changes', () => {
    const original = chain();
    const changed = structuredClone(original);
    firstEdge(changed).producerResultPath = 'results[0].replacement_token';
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.recompileToolIds).toEqual(['consumer-id', 'producer-id']);
    expect(result.reverifyToolIds).toEqual(['consumer-id', 'leaf-id', 'producer-id']);
  });

  it('does not make a producer compile depend on a consumer parameter name', () => {
    const original = chain();
    const changed = structuredClone(original);
    const consumer = changed.tools.find(({ id }) => id === 'consumer-id');
    if (!consumer) throw new Error('missing consumer fixture');
    consumer.candidate.likelyParams = consumer.candidate.likelyParams.map((parameter) =>
      parameter.name === firstEdge(changed).consumerParameter
        ? { ...parameter, name: 'renamed_token' }
        : parameter,
    );
    firstEdge(changed).consumerParameter = 'renamed_token';
    const originalProducer = original.tools.find(({ id }) => id === 'producer-id');
    const changedProducer = changed.tools.find(({ id }) => id === 'producer-id');
    if (!originalProducer || !changedProducer) throw new Error('missing producer fixture');
    expect(teachingToolCompileInputsSha256(originalProducer, original.chainEdges)).toBe(
      teachingToolCompileInputsSha256(changedProducer, changed.chainEdges),
    );
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.recompileToolIds).toEqual(['consumer-id']);
  });

  it('recompiles a changed producer and only reverifies its transitive consumers', () => {
    const original = chain();
    const changed = structuredClone(original);
    firstTool(changed).candidate.requestSeqs = [5];
    firstTool(changed).candidate.representativeSeqs = [5];
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.recompileToolIds).toEqual(['producer-id']);
    expect(result.reverifyToolIds).toEqual(['consumer-id', 'leaf-id', 'producer-id']);
  });

  it('derives add, remove, merge, and split effects from complete desired state', () => {
    const original = chain();
    const current = create(original);
    const merged = desired([
      tool('combined-id', 'produce_and_consume', { seq: 1 }),
      tool('leaf-id', 'show_details', { seq: 3, dependencies: ['produce_and_consume'] }),
      tool('other-id', 'unrelated_search', { seq: 4 }),
    ]);
    const mergeResult = reviseEditableTeachingPlan(
      current,
      merged,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(mergeResult.addedToolIds).toEqual(['combined-id']);
    expect(mergeResult.removedToolIds).toEqual(['consumer-id', 'producer-id']);
    expect(mergeResult.recompileToolIds).toEqual(['combined-id', 'leaf-id']);

    const split = desired([
      tool('producer-a-id', 'produce_a', { seq: 1 }),
      tool('producer-b-id', 'produce_b', { seq: 2 }),
      tool('leaf-id', 'show_details', { seq: 3, dependencies: ['produce_a'] }),
      tool('other-id', 'unrelated_search', { seq: 4 }),
    ]);
    const splitResult = reviseEditableTeachingPlan(
      mergeResult.plan,
      split,
      { expectedRevision: 2, decision: decision('revised') },
      validation,
    );
    expect(splitResult.addedToolIds).toEqual(['producer-a-id', 'producer-b-id']);
    expect(splitResult.removedToolIds).toEqual(['combined-id']);
  });

  it('reverifies remaining consumers when a producer is removed', () => {
    const original = chain();
    const changed = desired([
      tool('consumer-id', 'consume_token', { seq: 2 }),
      tool('leaf-id', 'show_details', { seq: 3, dependencies: ['consume_token'] }),
      tool('other-id', 'unrelated_search', { seq: 4 }),
    ]);
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.removedToolIds).toEqual(['producer-id']);
    expect(result.recompileToolIds).toEqual(['consumer-id', 'leaf-id']);
    expect(result.reverifyToolIds).toEqual(['consumer-id', 'leaf-id']);
  });

  it('rejects revision conflicts and changes to immutable recording identity', () => {
    const original = desired([tool('search-id', 'search')]);
    const current = create(original);
    expect(() =>
      reviseEditableTeachingPlan(
        current,
        original,
        { expectedRevision: 0, decision: decision('accepted') },
        validation,
      ),
    ).toThrow('revision conflict');
    expect(() =>
      reviseEditableTeachingPlan(
        current,
        { ...original, site: 'other-site' },
        { expectedRevision: 1, decision: decision('revised') },
        validation,
      ),
    ).toThrow('does not match run site');
    expect(() =>
      reviseEditableTeachingPlan(
        current,
        { ...original, recordingSha256: teachingPlanContentSha256('other recording') },
        { expectedRevision: 1, decision: decision('revised') },
        validation,
      ),
    ).toThrow('does not match the run recording');
  });

  it('binds initial validation to the controller site and recording hash', () => {
    const plan = desired([tool('search-id', 'search')]);
    expect(() =>
      createEditableTeachingPlan(
        plan,
        { decision: decision('initial') },
        {
          ...validation,
          site: 'other-site',
        },
      ),
    ).toThrow('does not match run site');
    expect(() =>
      createEditableTeachingPlan(
        plan,
        { decision: decision('initial') },
        {
          ...validation,
          recordingSha256: teachingPlanContentSha256('other recording'),
        },
      ),
    ).toThrow('does not match the run recording');
  });

  it('canonicalizes object keys before hashing', () => {
    expect(canonicalTeachingPlanJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(teachingPlanContentSha256({ b: 2, a: 1 })).toBe(
      teachingPlanContentSha256({ a: 1, b: 2 }),
    );
  });
});
