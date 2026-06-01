import { describe, expect, it } from 'bun:test';
import {
  type BuildPlan,
  type TokenContractHint,
  buildBuildPlanPayload,
  deriveTokenContractHints,
  describeAssignedModules,
  planSliceForTool,
  reconcileTokenContracts,
  resolveAssignedModules,
  resolveTokenParams,
  sharedModuleImportPath,
  topoLevels,
  topoLevelsForTools,
  topoSortSharedModules,
  validateBuildPlan,
} from '../src/imprint/build-plan.ts';
import type { ToolCandidate } from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

function basePlan(): BuildPlan {
  // Route through validateBuildPlan so schema defaults (e.g. emitsTokens/
  // tokenParams) are applied and the fixture stays robust to new optional fields.
  return validateBuildPlan({
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
  });
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

describe('opaque-token contract (emitsTokens / tokenParams)', () => {
  function plan(perTool: unknown[]): unknown {
    return { sharedModules: [], perTool };
  }
  const producer = {
    toolName: 'search_hotels',
    emitsTokens: [{ field: 'hotel_id', shape: 'composite ftid|area' }],
  };

  it('accepts a valid producer→consumer token contract', () => {
    const built = validateBuildPlan(
      plan([
        producer,
        {
          toolName: 'get_hotel_offers',
          tokenParams: [
            { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
          ],
        },
      ]),
    );
    expect(resolveTokenParams(built, 'get_hotel_offers')).toEqual([
      { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
    ]);
    expect(resolveTokenParams(built, 'search_hotels')).toEqual([]);
  });

  it('rejects a tokenParam pointing at an unknown producer tool', () => {
    expect(() =>
      validateBuildPlan(
        plan([
          {
            toolName: 'get_hotel_offers',
            tokenParams: [{ param: 'hotel_id', sourceTool: 'nope', sourceField: 'hotel_id' }],
          },
        ]),
      ),
    ).toThrow(/unknown producer tool/);
  });

  it('rejects a tokenParam that sources from its own tool', () => {
    expect(() =>
      validateBuildPlan(
        plan([
          {
            toolName: 'get_hotel_offers',
            emitsTokens: [{ field: 'hotel_id', shape: '' }],
            tokenParams: [
              { param: 'hotel_id', sourceTool: 'get_hotel_offers', sourceField: 'hotel_id' },
            ],
          },
        ]),
      ),
    ).toThrow(/cannot source from its own tool/);
  });

  it('rejects a consumed field the producer does not declare in emitsTokens', () => {
    expect(() =>
      validateBuildPlan(
        plan([
          { toolName: 'search_hotels' }, // declares no emitsTokens
          {
            toolName: 'get_hotel_offers',
            tokenParams: [
              { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
            ],
          },
        ]),
      ),
    ).toThrow(/does not declare emitted field/);
  });
});

describe('topoLevelsForTools', () => {
  function chainedPlan(): BuildPlan {
    return validateBuildPlan({
      sharedModules: [],
      perTool: [
        { toolName: 'search_hotels', emitsTokens: [{ field: 'hotel_id', shape: 'c' }] },
        {
          toolName: 'get_hotel_offers',
          tokenParams: [
            { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
          ],
        },
      ],
    });
  }

  it('orders the producer in an earlier level than its consumer', () => {
    const tools = [{ toolName: 'get_hotel_offers' }, { toolName: 'search_hotels' }];
    const levels = topoLevelsForTools(tools, chainedPlan());
    expect(levels.map((l) => l.map((t) => t.toolName))).toEqual([
      ['search_hotels'],
      ['get_hotel_offers'],
    ]);
  });

  it('keeps independent tools in a single level (no token contracts)', () => {
    const tools = [{ toolName: 'a' }, { toolName: 'b' }, { toolName: 'c' }];
    const levels = topoLevelsForTools(tools, null);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.map((t) => t.toolName)).toEqual(['a', 'b', 'c']);
  });

  it('appends a residual token-param cycle as a final level without dropping tools', () => {
    const cyclic = validateBuildPlan({
      sharedModules: [],
      perTool: [
        {
          toolName: 'a',
          emitsTokens: [{ field: 'fa', shape: '' }],
          tokenParams: [{ param: 'pa', sourceTool: 'b', sourceField: 'fb' }],
        },
        {
          toolName: 'b',
          emitsTokens: [{ field: 'fb', shape: '' }],
          tokenParams: [{ param: 'pb', sourceTool: 'a', sourceField: 'fa' }],
        },
        { toolName: 'c' }, // independent
      ],
    });
    const tools = [{ toolName: 'a' }, { toolName: 'b' }, { toolName: 'c' }];
    const levels = topoLevelsForTools(tools, cyclic);
    // The independent tool resolves first; the a↔b cycle is appended last.
    expect(levels.map((l) => l.map((t) => t.toolName))).toEqual([['c'], ['a', 'b']]);
    // Every tool is placed exactly once — none dropped, no infinite loop.
    expect(
      levels
        .flat()
        .map((t) => t.toolName)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('deriveTokenContractHints', () => {
  const tools = [
    { toolName: 'search_hotels', requestSeqs: [10, 11], likelyParams: [] },
    { toolName: 'get_hotel_offers', requestSeqs: [20], likelyParams: [{ name: 'hotel_id' }] },
  ];
  const edge = {
    classification: 'server_derived',
    originalSeq: 20,
    location: 'url_param:hotel_id',
    producerSeq: 11,
    producerPath: '$.results[0].detailToken',
    value: 'ChcI78-luoXdhoaIARoKL20vMDJ2cGdnMRAB', // opaque token
  };

  it('detects a grounded cross-tool edge (server_derived, different owner tools)', () => {
    const hints = deriveTokenContractHints({ selectedTools: tools, ephemeralValues: [edge] });
    expect(hints).toEqual([
      {
        consumerTool: 'get_hotel_offers',
        consumerParam: 'hotel_id',
        consumerLocation: 'url_param:hotel_id',
        producerTool: 'search_hotels',
        producerField: 'detailToken',
        producerPath: '$.results[0].detailToken',
        nameable: true,
      },
    ]);
  });

  it('skips human-typed text mistaken as server_derived (echoed search query)', () => {
    // The autocomplete reflects the typed query back, so the diff flags `q` as
    // server_derived — but "Chicago Loop" is not a token and must not become a
    // cross-tool contract.
    const hints = deriveTokenContractHints({
      selectedTools: [
        { toolName: 'suggest_places', requestSeqs: [11], likelyParams: [] },
        { toolName: 'search_hotels', requestSeqs: [20], likelyParams: [{ name: 'q' }] },
      ],
      ephemeralValues: [{ ...edge, location: 'url_param:q', value: 'Chicago Loop' }],
    });
    expect(hints).toEqual([]);
  });

  it('flags an opaque JSPB body path as not nameable', () => {
    const hints = deriveTokenContractHints({
      selectedTools: tools,
      ephemeralValues: [{ ...edge, location: 'body[0][10][8][0][0][0]' }],
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.nameable).toBe(false);
  });

  it('reconciles the derived param name to a matching likelyParam (case-insensitive)', () => {
    const t = [
      { toolName: 'search_hotels', requestSeqs: [11], likelyParams: [] },
      { toolName: 'get_hotel_offers', requestSeqs: [20], likelyParams: [{ name: 'hotelId' }] },
    ];
    const hints = deriveTokenContractHints({
      selectedTools: t,
      ephemeralValues: [{ ...edge, location: 'url_param:hotelid' }],
    });
    expect(hints[0]?.consumerParam).toBe('hotelId');
  });

  it('skips header locations (session/anti-bot tokens, out of scope)', () => {
    const hints = deriveTokenContractHints({
      selectedTools: tools,
      ephemeralValues: [{ ...edge, location: 'header:x-csrf-token' }],
    });
    expect(hints).toEqual([]);
  });

  it('skips intra-tool values (producer and consumer are the same tool)', () => {
    const hints = deriveTokenContractHints({
      selectedTools: tools,
      ephemeralValues: [{ ...edge, originalSeq: 11 }], // both seqs owned by search_hotels
    });
    expect(hints).toEqual([]);
  });

  it('skips ambiguous seqs owned by more than one tool', () => {
    const shared = [
      { toolName: 'search_hotels', requestSeqs: [11], likelyParams: [] },
      { toolName: 'get_hotel_offers', requestSeqs: [11, 20], likelyParams: [] }, // 11 shared
    ];
    const hints = deriveTokenContractHints({ selectedTools: shared, ephemeralValues: [edge] });
    expect(hints).toEqual([]);
  });

  it('ignores non-server_derived classifications and missing producers', () => {
    expect(
      deriveTokenContractHints({
        selectedTools: tools,
        ephemeralValues: [{ ...edge, classification: 'browser_minted' }],
      }),
    ).toEqual([]);
    expect(
      deriveTokenContractHints({
        selectedTools: tools,
        ephemeralValues: [{ ...edge, producerSeq: undefined, producerPath: undefined }],
      }),
    ).toEqual([]);
  });
});

describe('reconcileTokenContracts', () => {
  const hint: TokenContractHint = {
    consumerTool: 'get_hotel_offers',
    consumerParam: 'hotel_id',
    consumerLocation: 'url_param:hotel_id',
    producerTool: 'search_hotels',
    producerField: 'detailToken',
    producerPath: '$.results[0].detailToken',
    nameable: true,
  };
  const selected = new Set(['search_hotels', 'get_hotel_offers']);

  it('injects a missing contract that then passes validation', () => {
    const parsed = {
      sharedModules: [],
      perTool: [
        { toolName: 'search_hotels', authRecipe: {} },
        { toolName: 'get_hotel_offers', authRecipe: {} },
      ],
    };
    const res = reconcileTokenContracts(parsed, [hint], selected);
    expect(res.injected).toBe(1);
    expect(res.repaired).toBe(0);
    const built = validateBuildPlan(parsed, ['search_hotels', 'get_hotel_offers']);
    // Injection names the producer field after the clean consumer param.
    expect(resolveTokenParams(built, 'get_hotel_offers')).toEqual([
      { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
    ]);
    expect(
      built.perTool.find((t) => t.toolName === 'search_hotels')?.emitsTokens.map((e) => e.field),
    ).toContain('hotel_id');
  });

  it('does NOT duplicate a contract the planner already declared under another param name', () => {
    // Real-data regression: the planner correctly declared `property_token` ←
    // search_hotels, but the diff also surfaces the same edge at an opaque JSPB
    // slot (param "0"). The edge is already covered, so nothing is injected.
    const parsed = {
      sharedModules: [],
      perTool: [
        {
          toolName: 'search_hotels',
          authRecipe: {},
          emitsTokens: [{ field: 'property_token', shape: 'composite' }],
        },
        {
          toolName: 'get_hotel_offers',
          authRecipe: {},
          tokenParams: [
            { param: 'property_token', sourceTool: 'search_hotels', sourceField: 'property_token' },
          ],
        },
      ],
    };
    const jspbHint: TokenContractHint = {
      ...hint,
      consumerParam: '0',
      consumerLocation: 'body[0][10][8][0][0][0]',
      producerField: 'body_substring',
      nameable: false,
    };
    const res = reconcileTokenContracts(parsed, [jspbHint], selected);
    expect(res).toEqual({ injected: 0, repaired: 0, warnings: [] });
    expect(
      resolveTokenParams(validateBuildPlan(parsed, [...selected]), 'get_hotel_offers'),
    ).toEqual([
      { param: 'property_token', sourceTool: 'search_hotels', sourceField: 'property_token' },
    ]);
  });

  it('warns but does not inject an unnameable (opaque-path) missed edge', () => {
    const parsed = {
      sharedModules: [],
      perTool: [
        { toolName: 'search_hotels', authRecipe: {} },
        { toolName: 'get_hotel_offers', authRecipe: {} },
      ],
    };
    const jspbHint: TokenContractHint = {
      ...hint,
      consumerParam: '0',
      consumerLocation: 'body[0][10][8][0][0][0]',
      nameable: false,
    };
    const res = reconcileTokenContracts(parsed, [jspbHint], selected);
    expect(res.injected).toBe(0);
    expect(res.repaired).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(
      resolveTokenParams(validateBuildPlan(parsed, [...selected]), 'get_hotel_offers'),
    ).toEqual([]);
  });

  it('repairs a half-declared contract (consumer tokenParam, no producer emitsTokens)', () => {
    const parsed = {
      sharedModules: [],
      perTool: [
        { toolName: 'search_hotels', authRecipe: {} }, // forgot emitsTokens — would fail superRefine
        {
          toolName: 'get_hotel_offers',
          authRecipe: {},
          tokenParams: [
            { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'detailToken' },
          ],
        },
      ],
    };
    const res = reconcileTokenContracts(parsed, [hint], selected);
    expect(res.repaired).toBe(1);
    expect(res.injected).toBe(0);
    // Validation would have thrown before the repair; now it succeeds.
    const built = validateBuildPlan(parsed, ['search_hotels', 'get_hotel_offers']);
    expect(
      built.perTool.find((t) => t.toolName === 'search_hotels')?.emitsTokens.map((e) => e.field),
    ).toContain('detailToken');
  });

  it('is a no-op when the contract is already fully declared', () => {
    const parsed = {
      sharedModules: [],
      perTool: [
        {
          toolName: 'search_hotels',
          authRecipe: {},
          emitsTokens: [{ field: 'detailToken', shape: 'composite' }],
        },
        {
          toolName: 'get_hotel_offers',
          authRecipe: {},
          tokenParams: [
            { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'detailToken' },
          ],
        },
      ],
    };
    expect(reconcileTokenContracts(parsed, [hint], selected)).toEqual({
      injected: 0,
      repaired: 0,
      warnings: [],
    });
  });

  it('does nothing when there are no detected edges (single-tool / non-chained sites)', () => {
    const parsed = { sharedModules: [], perTool: [{ toolName: 'x', authRecipe: {} }] };
    const before = JSON.stringify(parsed);
    expect(reconcileTokenContracts(parsed, [], new Set(['x']))).toEqual({
      injected: 0,
      repaired: 0,
      warnings: [],
    });
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it('skips an edge whose endpoint is not a selected tool', () => {
    const parsed = {
      sharedModules: [],
      perTool: [{ toolName: 'get_hotel_offers', authRecipe: {} }],
    };
    const res = reconcileTokenContracts(parsed, [hint], new Set(['get_hotel_offers']));
    expect(res).toEqual({ injected: 0, repaired: 0, warnings: [] });
  });
});
