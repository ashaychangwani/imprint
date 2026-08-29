import { describe, expect, it } from 'bun:test';
import {
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type EditableTeachingPlan,
  type EditableTeachingTool,
  type TeachingPlanDecision,
  canonicalTeachingPlanJson,
  createEditableTeachingPlan,
  reviseEditableTeachingPlan,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
  validateEditableTeachingPlan,
} from '../src/imprint/master-teach-plan.ts';
import type { ToolCandidate } from '../src/imprint/tool-candidates.ts';

const RECORDING = teachingPlanContentSha256('recording');
const validation = {
  site: 'fixture-site',
  recordingSha256: RECORDING,
  recordingSeqs: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
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
    primary?: boolean;
    seq?: number;
    dependencies?: string[];
    params?: ToolCandidate['likelyParams'];
  } = {},
): ToolCandidate {
  const seq = options.seq ?? 1;
  return {
    toolName,
    description: `Perform ${toolName}`,
    rationale: `Request ${seq} supports this tool.`,
    confidence: 0.9,
    primary: options.primary ?? false,
    requestSeqs: [seq],
    representativeSeqs: [seq],
    eventSeqs: [],
    expectedOutput: `Results for ${toolName}`,
    likelyParams: options.params ?? [{ name: 'query', type: 'string' }],
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
        }
      : undefined,
  };
}

function desired(tools: EditableTeachingTool[]): DesiredTeachingPlan {
  const plan: DesiredTeachingPlan = {
    site: 'fixture-site',
    recordingSha256: RECORDING,
    sharedContext: structuredClone(EMPTY_CONTEXT),
    tools,
  };
  for (const plannedTool of plan.tools) {
    if (plannedTool.implementationPlan) {
      plannedTool.implementationPlan.basedOnCompileInputsSha256 =
        teachingToolCompileInputsSha256(plannedTool);
    }
  }
  return plan;
}

function firstTool(plan: DesiredTeachingPlan): EditableTeachingTool {
  const value = plan.tools[0];
  if (!value) throw new Error('test plan has no tools');
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

function chain(): DesiredTeachingPlan {
  return desired([
    tool('producer-id', 'produce_token', { primary: true, seq: 1 }),
    tool('consumer-id', 'consume_token', {
      seq: 2,
      dependencies: ['produce_token'],
    }),
    tool('leaf-id', 'show_details', { seq: 3, dependencies: ['consume_token'] }),
    tool('other-id', 'unrelated_search', { seq: 4 }),
  ]);
}

describe('editable master teaching plan', () => {
  it('creates and validates a strict initial snapshot', () => {
    const plan = create(desired([tool('search-id', 'search', { primary: true })]));
    expect(plan.revision).toBe(1);
    expect(plan.decision.outcome).toBe('initial');
    expect(validateEditableTeachingPlan(plan, validation)).toEqual(plan);
    expect(() =>
      createEditableTeachingPlan(
        desired([tool('search-id', 'search', { primary: true })]),
        { decision: decision('accepted') },
        validation,
      ),
    ).toThrow('first plan decision');
  });

  it('rejects unknown fields in plan, tool, candidate, refs, and shared context', () => {
    const base = desired([tool('search-id', 'search', { primary: true })]);
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
      { ...base, sharedContext: { ...base.sharedContext, surprise: true } },
    ]) {
      expect(() => create(invalid as DesiredTeachingPlan)).toThrow();
    }
  });

  it('rejects absolute and escaping content-reference paths', () => {
    for (const path of ['/tmp/evidence.json', '../evidence.json', 'evidence/../secret', 'C:/x']) {
      const plan = desired([tool('search-id', 'search', { primary: true })]);
      firstEvidence(firstTool(plan)).path = path;
      expect(() => create(plan)).toThrow('workspace-relative path');
    }
  });

  it('requires unique stable ids and names without making primary a runtime decision', () => {
    expect(() =>
      create(desired([tool('same-id', 'one', { primary: true }), tool('same-id', 'two')])),
    ).toThrow('duplicate tool id');
    expect(() =>
      create(desired([tool('one-id', 'same', { primary: true }), tool('two-id', 'same')])),
    ).toThrow('duplicate tool name');
    expect(create(desired([tool('one-id', 'one')])).tools[0]?.candidate.primary).toBe(false);
    expect(
      create(
        desired([
          tool('one-id', 'one', { primary: true }),
          tool('two-id', 'two', { primary: true }),
        ]),
      ).tools.map((value) => value.candidate.primary),
    ).toEqual([true, true]);
  });

  it('rejects missing recording seqs, missing dependencies, and cycles', () => {
    expect(() => create(desired([tool('bad-id', 'bad', { primary: true, seq: 99 })]))).toThrow(
      'unknown recording seq 99',
    );
    expect(() =>
      create(
        desired([
          tool('one-id', 'one', { primary: true }),
          tool('two-id', 'two', { seq: 2, dependencies: ['missing'] }),
        ]),
      ),
    ).toThrow('depends on missing tool');
    expect(() =>
      create(
        desired([
          tool('one-id', 'one', { primary: true, dependencies: ['two'] }),
          tool('two-id', 'two', { seq: 2, dependencies: ['one'] }),
        ]),
      ),
    ).toThrow('dependency cycle');
  });

  it('treats candidate metadata-only changes as no compile work', () => {
    const original = desired([
      tool('search-id', 'search', { primary: true }),
      tool('details-id', 'details', { seq: 2 }),
    ]);
    const current = create(original);
    const changed = structuredClone(original);
    firstTool(changed).candidate.confidence = 0.2;
    firstTool(changed).candidate.rationale = 'An advisor supplied a different rationale.';
    firstTool(changed).candidate.primary = false;
    const details = changed.tools.find((value) => value.id === 'details-id');
    if (!details) throw new Error('test plan has no details tool');
    details.candidate.primary = true;
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
    const original = desired([tool('search-id', 'search', { primary: true })]);
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
    const plan = desired([tool('search-id', 'search', { primary: true, plan: 'plan text' })]);
    firstTool(plan).strategy = undefined;
    expect(() => create(plan)).toThrow('needs a strategy');
  });

  it('ignores strategy explanation edits but replans when the strategy kind changes', () => {
    const original = desired([tool('search-id', 'search', { primary: true })]);
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
    const original = desired([tool('search-id', 'search', { primary: true, plan: 'old plan' })]);
    const changed = structuredClone(original);
    const changedTool = firstTool(changed);
    if (!changedTool.implementationPlan) throw new Error('test tool has no implementation plan');
    changedTool.implementationPlan = {
      ...ref('search-plan', 'new plan'),
      basedOnCompileInputsSha256: teachingToolCompileInputsSha256(changedTool),
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

  it('recompiles for parameter, request, evidence, and implementation-plan content changes', () => {
    const cases: Array<{ replan: boolean; mutate: (plan: DesiredTeachingPlan) => void }> = [
      {
        replan: true,
        mutate: (plan) => {
          firstTool(plan).candidate.likelyParams.push({ name: 'date', type: 'string' });
        },
      },
      {
        replan: true,
        mutate: (plan) => {
          firstTool(plan).candidate.requestSeqs = [2];
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
          };
        },
      },
    ];
    for (const { mutate, replan } of cases) {
      const original = desired([tool('search-id', 'search', { primary: true, plan: 'old plan' })]);
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
    const original = desired([tool('search-id', 'search', { primary: true, plan: 'old plan' })]);
    const changed = structuredClone(original);
    firstTool(changed).candidate.likelyParams.push({ name: 'date', type: 'string' });
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
    const original = desired([tool('search-id', 'search', { primary: true, plan: 'same plan' })]);
    firstTool(original).evidenceRefs.push(ref('second'));
    const originalTool = firstTool(original);
    if (!originalTool.implementationPlan) throw new Error('test tool has no implementation plan');
    originalTool.implementationPlan.basedOnCompileInputsSha256 =
      teachingToolCompileInputsSha256(originalTool);
    const changed = structuredClone(original);
    const changedTool = firstTool(changed);
    changedTool.evidenceRefs.reverse();
    firstEvidence(changedTool).path = 'moved/evidence.json';
    if (changedTool.implementationPlan) {
      changedTool.implementationPlan.path = 'moved/plan.md';
    }
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

  it('does not invalidate tools for global context notes not passed to their compiler', () => {
    const original = chain();
    const changed = structuredClone(original);
    changed.sharedContext.sharedHelperNotes = 'Master-only observation.';
    const result = reviseEditableTeachingPlan(
      create(original),
      changed,
      { expectedRevision: 1, decision: decision('revised') },
      validation,
    );
    expect(result.replanToolIds).toEqual([]);
    expect(result.recompileToolIds).toEqual([]);
  });

  it('recompiles a changed producer and only reverifies its transitive consumers', () => {
    const original = chain();
    const changed = structuredClone(original);
    firstTool(changed).candidate.requestSeqs = [5];
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
      tool('combined-id', 'produce_and_consume', { primary: true, seq: 1 }),
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
      tool('producer-a-id', 'produce_a', { primary: true, seq: 1 }),
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
      tool('consumer-id', 'consume_token', { primary: true, seq: 2 }),
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
    expect(result.recompileToolIds).toEqual(['consumer-id']);
    expect(result.reverifyToolIds).toEqual(['consumer-id', 'leaf-id']);
  });

  it('rejects revision conflicts and changes to immutable recording identity', () => {
    const original = desired([tool('search-id', 'search', { primary: true })]);
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
    const plan = desired([tool('search-id', 'search', { primary: true })]);
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
