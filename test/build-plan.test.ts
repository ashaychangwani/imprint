import { describe, expect, it } from 'bun:test';
import {
  type BuildPlan,
  buildBuildPlanPayload,
  describeAssignedModules,
  planSliceForTool,
  resolveAssignedModules,
  sharedModuleImportPath,
  topoLevels,
  topoSortSharedModules,
  validateBuildPlan,
} from '../src/imprint/build-plan.ts';
import type { ToolCandidate } from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

function basePlan(): BuildPlan {
  return {
    sharedModules: [
      {
        path: '_shared/sign.ts',
        kind: 'request-transform',
        purpose: 'sign request URLs',
        exportSignatures: ['export function signUrl(url: string): string'],
        spec: 'reproduce the CRC32 sig param',
        sourceSeqs: [10],
        dependsOn: [],
      },
    ],
    perTool: [
      {
        toolName: 'search_flights',
        usesSharedModules: ['_shared/sign.ts'],
        loadBearingSeqs: [10],
        parserGuidance: 'extract flights',
        paramChecklist: ['origin', 'destination'],
        authRecipe: {
          required: false,
          loginRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: '',
        },
      },
      {
        toolName: 'search_hotels',
        usesSharedModules: ['_shared/sign.ts'],
        loadBearingSeqs: [11],
        parserGuidance: 'extract hotels',
        paramChecklist: ['city'],
        authRecipe: {
          required: false,
          loginRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: '',
        },
      },
    ],
  };
}

function mod0(plan: BuildPlan): BuildPlan['sharedModules'][number] {
  const m = plan.sharedModules[0];
  if (!m) throw new Error('basePlan() must define at least one shared module');
  return m;
}
function tool0(plan: BuildPlan): BuildPlan['perTool'][number] {
  const t = plan.perTool[0];
  if (!t) throw new Error('basePlan() must define at least one tool');
  return t;
}

describe('validateBuildPlan', () => {
  it('accepts a well-formed plan', () => {
    const plan = validateBuildPlan(basePlan());
    expect(plan.sharedModules).toHaveLength(1);
    expect(plan.perTool).toHaveLength(2);
  });

  it('fills defaults for omitted optional fields', () => {
    const plan = validateBuildPlan({
      perTool: [{ toolName: 'only_tool' }],
    });
    expect(plan.sharedModules).toEqual([]);
    expect(plan.perTool[0]?.usesSharedModules).toEqual([]);
    expect(plan.perTool[0]?.authRecipe.required).toBe(false);
  });

  it('rejects duplicate shared module paths', () => {
    const plan = basePlan();
    plan.sharedModules.push({ ...plan.sharedModules[0] } as BuildPlan['sharedModules'][number]);
    expect(() => validateBuildPlan(plan)).toThrow(/duplicate shared module path/);
  });

  it('rejects duplicate tool names', () => {
    const plan = basePlan();
    plan.perTool[1] = { ...plan.perTool[0] } as BuildPlan['perTool'][number];
    expect(() => validateBuildPlan(plan)).toThrow(/duplicate toolName/);
  });

  it('rejects usesSharedModules referencing an undeclared module', () => {
    const plan = basePlan();
    tool0(plan).usesSharedModules = ['_shared/missing.ts'];
    expect(() => validateBuildPlan(plan)).toThrow(/unknown shared module/);
  });

  it('rejects a dependsOn cycle', () => {
    const plan = basePlan();
    plan.sharedModules = [
      { ...mod0(plan), path: '_shared/a.ts', dependsOn: ['_shared/b.ts'] },
      { ...mod0(plan), path: '_shared/b.ts', dependsOn: ['_shared/a.ts'] },
    ];
    for (const t of plan.perTool) t.usesSharedModules = [];
    expect(() => validateBuildPlan(plan)).toThrow(/cycle/);
  });

  it('rejects a bad shared module path', () => {
    const plan = basePlan();
    mod0(plan).path = 'sign.ts'; // missing _shared/ prefix
    expect(() => validateBuildPlan(plan)).toThrow();
  });

  it('filters perTool to the selected set and backfills missing tools', () => {
    const plan = validateBuildPlan(basePlan(), ['search_flights', 'search_cars']);
    const names = plan.perTool.map((t) => t.toolName).sort();
    expect(names).toEqual(['search_cars', 'search_flights']);
    // search_hotels was dropped (not selected); search_cars backfilled.
    expect(plan.perTool.find((t) => t.toolName === 'search_cars')?.usesSharedModules).toEqual([]);
  });
});

describe('planSliceForTool', () => {
  it('resolves the tool slice with its shared modules', () => {
    const slice = planSliceForTool(basePlan(), 'search_flights');
    expect(slice?.tool.toolName).toBe('search_flights');
    expect(slice?.sharedModules.map((m) => m.path)).toEqual(['_shared/sign.ts']);
  });

  it('returns undefined for an unknown tool', () => {
    expect(planSliceForTool(basePlan(), 'nope')).toBeUndefined();
  });
});

describe('topoSortSharedModules', () => {
  it('orders modules after their dependencies', () => {
    const plan = basePlan();
    plan.sharedModules = [
      { ...mod0(plan), path: '_shared/b.ts', dependsOn: ['_shared/a.ts'] },
      { ...mod0(plan), path: '_shared/a.ts', dependsOn: [] },
    ];
    const ordered = topoSortSharedModules(plan.sharedModules).map((m) => m.path);
    expect(ordered).toEqual(['_shared/a.ts', '_shared/b.ts']);
  });

  it('throws on a hand-built cycle', () => {
    const plan = basePlan();
    plan.sharedModules = [
      { ...mod0(plan), path: '_shared/a.ts', dependsOn: ['_shared/b.ts'] },
      { ...mod0(plan), path: '_shared/b.ts', dependsOn: ['_shared/a.ts'] },
    ];
    expect(() => topoSortSharedModules(plan.sharedModules)).toThrow(/cycle/);
  });
});

describe('topoLevels', () => {
  function mods(specs: Array<[string, string[]]>): BuildPlan['sharedModules'] {
    const tmpl = mod0(basePlan());
    return specs.map(([path, dependsOn]) => ({ ...tmpl, path, dependsOn }));
  }

  it('puts mutually-independent modules in a single level', () => {
    const levels = topoLevels(
      mods([
        ['_shared/a.ts', []],
        ['_shared/b.ts', []],
      ]),
    );
    expect(levels).toHaveLength(1);
    expect(levels[0]?.map((m) => m.path).sort()).toEqual(['_shared/a.ts', '_shared/b.ts']);
  });

  it('orders a dependency chain into one module per level', () => {
    const levels = topoLevels(
      mods([
        ['_shared/c.ts', ['_shared/b.ts']],
        ['_shared/b.ts', ['_shared/a.ts']],
        ['_shared/a.ts', []],
      ]),
    );
    expect(levels.map((l) => l.map((m) => m.path))).toEqual([
      ['_shared/a.ts'],
      ['_shared/b.ts'],
      ['_shared/c.ts'],
    ]);
  });

  it('groups diamond siblings into the same level', () => {
    const levels = topoLevels(
      mods([
        ['_shared/a.ts', []],
        ['_shared/b.ts', ['_shared/a.ts']],
        ['_shared/c.ts', ['_shared/a.ts']],
        ['_shared/d.ts', ['_shared/b.ts', '_shared/c.ts']],
      ]),
    );
    expect(levels.map((l) => l.map((m) => m.path).sort())).toEqual([
      ['_shared/a.ts'],
      ['_shared/b.ts', '_shared/c.ts'],
      ['_shared/d.ts'],
    ]);
  });

  it('places every module after its dependencies when flattened', () => {
    const order = topoLevels(
      mods([
        ['_shared/b.ts', ['_shared/a.ts']],
        ['_shared/a.ts', []],
        ['_shared/c.ts', ['_shared/a.ts']],
      ]),
    )
      .flat()
      .map((m) => m.path);
    expect(order.indexOf('_shared/a.ts')).toBeLessThan(order.indexOf('_shared/b.ts'));
    expect(order.indexOf('_shared/a.ts')).toBeLessThan(order.indexOf('_shared/c.ts'));
  });
});

describe('resolveAssignedModules + sharedModuleImportPath', () => {
  it('annotates verified status from the manifest and computes import paths', () => {
    const assigned = resolveAssignedModules(basePlan(), 'search_flights', [
      { path: '_shared/sign.ts', kind: 'request-transform', verified: true },
    ]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.verified).toBe(true);
    expect(assigned[0]?.importPath).toBe('../_shared/sign.ts');
  });

  it('marks modules unverified when the manifest says so', () => {
    const assigned = resolveAssignedModules(basePlan(), 'search_flights', [
      { path: '_shared/sign.ts', kind: 'request-transform', verified: false },
    ]);
    expect(assigned[0]?.verified).toBe(false);
  });

  it('treats every module as verified when no manifest is supplied', () => {
    const assigned = resolveAssignedModules(basePlan(), 'search_flights');
    expect(assigned[0]?.verified).toBe(true);
  });

  it('builds the relative import path from a module path', () => {
    expect(sharedModuleImportPath('_shared/decode.ts')).toBe('../_shared/decode.ts');
  });
});

describe('describeAssignedModules', () => {
  it('returns empty when nothing is verified', () => {
    expect(
      describeAssignedModules([
        {
          path: '_shared/sign.ts',
          kind: 'request-transform',
          verified: false,
          importPath: '../_shared/sign.ts',
          exportSignatures: [],
          purpose: 'x',
        },
      ]),
    ).toBe('');
  });

  it('lists verified modules with their import path', () => {
    const text = describeAssignedModules([
      {
        path: '_shared/sign.ts',
        kind: 'request-transform',
        verified: true,
        importPath: '../_shared/sign.ts',
        exportSignatures: ['export function signUrl(url: string): string'],
        purpose: 'sign URLs',
      },
    ]);
    expect(text).toContain('../_shared/sign.ts');
    expect(text).toContain('requestTransformModule');
  });
});

describe('buildBuildPlanPayload', () => {
  function session(): Session {
    return {
      site: 'demo',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 10,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/flights?sig=ABCDEF',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"f":[]}' },
        },
        {
          seq: 11,
          timestamp: 200,
          method: 'GET',
          url: 'https://example.com/api/hotels?sig=GHIJK',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"h":[]}' },
        },
        {
          seq: 99,
          timestamp: 300,
          method: 'GET',
          url: 'https://tracker.example.net/pixel',
          headers: {},
          resourceType: 'Image',
          response: { status: 200, headers: {}, mimeType: 'image/gif', body: '' },
        },
      ],
      events: [],
      narration: [{ seq: 1, timestamp: 50, text: 'searching flights and hotels' }],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
  }

  function candidate(toolName: string, seqs: number[]): ToolCandidate {
    return {
      toolName,
      description: toolName,
      rationale: 'x',
      confidence: 0.9,
      primary: toolName === 'search_flights',
      requestSeqs: seqs,
      representativeSeqs: [],
      eventSeqs: [],
      expectedOutput: 'results',
      likelyParams: [],
      dependencySeqs: [],
    };
  }

  it('scopes requests to candidate seqs and drops out-of-scope traffic', () => {
    const payload = buildBuildPlanPayload({
      session: session(),
      candidates: [candidate('search_flights', [10]), candidate('search_hotels', [11])],
    });
    const seqs = payload.requests.flatMap((r) => [r.seq, ...(r.repeatedSeqs ?? [])]);
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).not.toContain(99); // tracker pixel is out of scope
    expect(payload.selectedTools.map((t) => t.toolName).sort()).toEqual([
      'search_flights',
      'search_hotels',
    ]);
  });

  it('includes only non-constant ephemeral classifications', () => {
    const payload = buildBuildPlanPayload({
      session: session(),
      candidates: [candidate('search_flights', [10]), candidate('search_hotels', [11])],
      classifications: [
        {
          originalSeq: 10,
          location: 'url:sig',
          classification: 'browser_minted',
          value1: 'ABCDEF',
          value2: 'ZZZZZZ',
        },
        {
          originalSeq: 11,
          location: 'url:sig',
          classification: 'constant',
          value1: 'GHIJK',
          value2: 'GHIJK',
        },
      ],
    });
    expect(payload.ephemeralValues).toHaveLength(1);
    expect(payload.ephemeralValues[0]?.classification).toBe('browser_minted');
  });
});
