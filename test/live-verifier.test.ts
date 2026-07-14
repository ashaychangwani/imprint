import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  LIVE_VERIFICATION_EVIDENCE_FILE,
  LiveVerificationReportSchema,
  appendLiveVerifierLog,
  assertReportCoversWorkflowParameters,
  buildVerifierArtifactContext,
  hasSuiteReceiptForSession,
  mergeSemanticParamVerification,
  namespaceLiveIntegrationEvidence,
  persistLiveVerificationEvidence,
  prepareLiveVerificationBackend,
  readPersistedLiveVerificationEvidence,
  runLiveIntegrationSuite,
  semanticVerificationFailures,
  waitForOwnedProcessTree,
} from '../src/imprint/live-verifier.ts';
import type { BackendsCache } from '../src/imprint/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('verifier artifact context', () => {
  it('supplies workflow, implementation, integration, playbook, and plan context', () => {
    const siteDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-context-'));
    dirs.push(siteDir);
    const toolDir = pathJoin(siteDir, 'search_things');
    mkdirSync(toolDir);
    writeFileSync(
      pathJoin(toolDir, 'workflow.json'),
      JSON.stringify({ toolName: 'search_things', requests: [] }),
    );
    writeFileSync(pathJoin(toolDir, 'parser.ts'), 'export const parse = () => [];');
    writeFileSync(pathJoin(toolDir, 'parser.test.ts'), 'test("recorded", () => {});');
    writeFileSync(pathJoin(toolDir, 'integration.test.ts'), 'test("live", async () => {});');
    writeFileSync(pathJoin(toolDir, 'playbook.yaml'), 'steps: []\n');
    writeFileSync(
      pathJoin(siteDir, '.build-plan.json'),
      JSON.stringify({
        perTool: [{ toolName: 'search_things', requiredInputs: [{ source: 'browser_state' }] }],
        dynamicValueFindings: [{ name: 'csrf' }],
      }),
    );

    const context = buildVerifierArtifactContext(toolDir, 'search_things') as Record<
      string,
      unknown
    >;
    expect(context.workflow).toEqual({ toolName: 'search_things', requests: [] });
    expect(context.parser).toContain('parse');
    expect(context.integrationTests).toContain('live');
    expect(context.playbook).toContain('steps');
    expect(context.buildPlan).toEqual({
      tool: { toolName: 'search_things', requiredInputs: [{ source: 'browser_state' }] },
      dynamicValueFindings: [{ name: 'csrf' }],
    });
  });
});

describe('live semantic verification report', () => {
  const approved = {
    status: 'approved' as const,
    summary: 'The returned products match the requested search.',
    baseline: {
      verdict: 'semantically_correct' as const,
      reason: 'Names, prices, and requested category are present.',
    },
    parameters: [
      {
        name: 'query',
        verdict: 'works' as const,
        reason: 'Returned items match the query.',
      },
    ],
    issues: [],
    gaps: [],
  };

  it('accepts a consistent approval', () => {
    expect(LiveVerificationReportSchema.parse(approved)).toEqual(approved);
    expect(semanticVerificationFailures(approved)).toEqual([]);
  });

  it('does not accept evidence IDs as part of the semantic report contract', () => {
    expect(() =>
      LiveVerificationReportSchema.parse({
        ...approved,
        baseline: { ...approved.baseline, evidenceIds: ['invented-id'] },
      }),
    ).toThrow('Unrecognized key');
  });

  it('rejects approval when the baseline is not semantically correct', () => {
    expect(() =>
      LiveVerificationReportSchema.parse({
        ...approved,
        baseline: { ...approved.baseline, verdict: 'tool_broken' },
      }),
    ).toThrow('approval requires a semantically_correct baseline');
  });

  it('appends sanitized verifier events without overwriting an earlier attempt', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-log-'));
    dirs.push(dir);
    const path = pathJoin(dir, '.live-verifier-log.jsonl');
    appendLiveVerifierLog(path, { type: 'attempt.failed', attempt: 1, password: 'secret' });
    appendLiveVerifierLog(path, { type: 'attempt.started', attempt: 2 });
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
    expect(events[0]?.password).toBe('[REDACTED]');
  });

  it('rejects a clean approval that quietly contains a non-working parameter', () => {
    expect(() =>
      LiveVerificationReportSchema.parse({
        ...approved,
        parameters: [
          {
            ...approved.parameters[0],
            verdict: 'no_op',
            reason: 'The output did not change.',
          },
        ],
      }),
    ).toThrow('approved requires every reported parameter to work');
  });

  it('requires exactly one verdict for every declared workflow parameter', () => {
    expect(() =>
      assertReportCoversWorkflowParameters(
        LiveVerificationReportSchema.parse({ ...approved, parameters: [] }),
        [{ name: 'query' }],
      ),
    ).toThrow('missing: query');
    expect(() =>
      assertReportCoversWorkflowParameters(
        LiveVerificationReportSchema.parse({
          ...approved,
          parameters: [approved.parameters[0], approved.parameters[0]],
        }),
        [{ name: 'query' }],
      ),
    ).toThrow('duplicates: query');
  });

  it('does not let approved_with_gaps hide a no-op parameter', () => {
    expect(() =>
      LiveVerificationReportSchema.parse({
        ...approved,
        status: 'approved_with_gaps',
        parameters: [{ ...approved.parameters[0], verdict: 'no_op' }],
        gaps: ['query remains unresolved'],
      }),
    ).toThrow('permits only works or untestable');
  });

  it('persists a sanitized evidence sidecar with readable labels', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-evidence-'));
    dirs.push(dir);
    const path = pathJoin(dir, 'evidence.json');
    persistLiveVerificationEvidence(path, [
      {
        schemaVersion: 1,
        kind: 'call',
        label: 'baseline-search',
        caseName: 'baseline',
        toolName: 'search_fixture',
        requestedParams: { query: 'tires', password: 'do-not-persist' },
        effectiveParams: { query: 'tires' },
        result: { ok: true, data: { items: [{ name: 'Touring tire' }] } },
        usedBackend: 'fetch',
        attempts: [],
        durationMs: 1,
      },
    ]);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    expect(persisted[0]?.label).toBe('baseline-search');
    expect((persisted[0]?.requestedParams as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('namespaces repeated call labels so compiler revisions retain both outputs', () => {
    const evidence = {
      schemaVersion: 1 as const,
      kind: 'call' as const,
      label: 'baseline',
      caseName: 'baseline',
      toolName: 'search_fixture',
      requestedParams: { query: 'tires' },
      effectiveParams: { query: 'tires' },
      result: { ok: true as const, data: [] },
      usedBackend: 'fetch' as const,
      attempts: [],
      durationMs: 1,
    };
    expect(namespaceLiveIntegrationEvidence([evidence], 'suite-2')[0]?.label).toBe(
      'suite-2/baseline',
    );
  });

  it('requires a suite receipt from the current verifier session', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-session-suite-'));
    dirs.push(dir);
    const path = pathJoin(dir, 'evidence.json');
    persistLiveVerificationEvidence(path, [
      {
        label: 'suite-1',
        kind: 'suite',
        status: 'passed',
        verifierSession: 'verifier-session-1',
      },
    ]);
    expect(hasSuiteReceiptForSession(path, 'verifier-session-1')).toBe(true);
    expect(hasSuiteReceiptForSession(path, 'verifier-session-2')).toBe(false);
  });

  it('turns expected-versus-observed review issues into compiler feedback', () => {
    const report = LiveVerificationReportSchema.parse({
      ...approved,
      status: 'changes_required',
      summary: 'The endpoint returned a generic landing-page payload.',
      baseline: { ...approved.baseline, verdict: 'tool_broken' },
      issues: [
        {
          summary: 'Wrong response entity',
          expected: 'Costco product records',
          observed: 'Navigation suggestions without products',
          suggestedFix: 'Use the product-search request and parser branch.',
        },
      ],
    });
    expect(semanticVerificationFailures(report)[0]).toContain('Wrong response entity');
    expect(semanticVerificationFailures(report)[0]).toContain('Costco product records');
    expect(semanticVerificationFailures(report)[0]).toContain('product-search request');
  });

  it('lets semantic parameter evidence downgrade a mechanically green parameter', () => {
    const report = LiveVerificationReportSchema.parse({
      ...approved,
      status: 'approved_with_gaps',
      parameters: [
        {
          name: 'query',
          verdict: 'works',
          reason: 'Query changed the returned products.',
        },
        {
          name: 'warehouse',
          verdict: 'untestable',
          reason: 'Only one warehouse was available in the recording.',
        },
      ],
      gaps: ['warehouse behavior remains unverified'],
    });
    expect(
      mergeSemanticParamVerification(
        [
          { name: 'query', verified: true },
          { name: 'warehouse', verified: true },
        ],
        report,
      ),
    ).toEqual([
      { name: 'query', verified: true, reason: undefined },
      { name: 'warehouse', verified: false, reason: 'semantic-gap' },
    ]);
  });
});

function fixtureTool(): {
  root: string;
  toolDir: string;
  workflowPath: string;
  cache: BackendsCache;
} {
  const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-verifier-tool-'));
  dirs.push(root);
  const toolDir = pathJoin(root, 'fixture-site', 'search_fixture');
  mkdirSync(toolDir, { recursive: true });
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  writeFileSync(
    workflowPath,
    JSON.stringify({
      toolName: 'search_fixture',
      intent: { description: 'Search a fixture.' },
      parameters: [{ name: 'query', type: 'string', description: 'Search text.' }],
      requests: [{ method: 'GET', url: 'https://example.com?q=${param.query}', headers: {} }],
      site: 'fixture-site',
    }),
  );
  const cache: BackendsCache = {
    probedAt: '2026-07-14T00:00:00.000Z',
    imprintVersion: '0.1.0',
    preferredOrder: ['fetch'],
    results: { fetch: { outcome: 'ok', durationMs: 10 } },
  };
  return { root, toolDir, workflowPath, cache };
}

describe('live verifier backend preparation and suite receipts', () => {
  it('terminates an owned probe process tree when its separate budget expires', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const startedAt = Date.now();
    const result = await waitForOwnedProcessTree(child, 50, 100);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('reuses a valid backend cache without invoking the probe', async () => {
    const { toolDir, workflowPath, cache } = fixtureTool();
    writeFileSync(pathJoin(toolDir, 'backends.json'), JSON.stringify(cache));
    let probes = 0;
    const result = await prepareLiveVerificationBackend({
      workflowPath,
      params: { query: 'tires' },
      reason: 'prepare baseline',
      probe: async () => {
        probes++;
        throw new Error('probe should not run');
      },
    });
    expect(result.reusedCache).toBe(true);
    expect(result.preferredBackend).toBe('fetch');
    expect(probes).toBe(0);
  });

  it('rebinds a proven preference across compiler revisions without probing', async () => {
    const { toolDir, workflowPath, cache } = fixtureTool();
    writeFileSync(
      pathJoin(toolDir, 'backends.json'),
      JSON.stringify({
        ...cache,
        schemaVersion: 2,
        workflowHash: 'previous-compiler-revision',
        capabilityHash: 'previous-capabilities',
      }),
    );
    let probes = 0;
    const result = await prepareLiveVerificationBackend({
      workflowPath,
      params: { query: 'tires' },
      reason: 'verify revised parser and tests',
      probe: async () => {
        probes++;
        throw new Error('compiler revision should not reprobe');
      },
    });
    const rebound = JSON.parse(readFileSync(pathJoin(toolDir, 'backends.json'), 'utf8')) as {
      workflowHash?: string;
      preferredOrder: string[];
    };
    expect(result.reusedCache).toBe(true);
    expect(result.preferredBackend).toBe('fetch');
    expect(rebound.workflowHash).not.toBe('previous-compiler-revision');
    expect(rebound.preferredOrder).toEqual(['fetch']);
    expect(probes).toBe(0);
  });

  it('uses the existing resolved-tool probe for a missing cache and for forced reprobe', async () => {
    const { toolDir, workflowPath, cache } = fixtureTool();
    let probes = 0;
    const fakeProbe = async () => {
      probes++;
      const outPath = pathJoin(toolDir, 'backends.json');
      writeFileSync(outPath, JSON.stringify(cache));
      return { cache, outPath };
    };
    const first = await prepareLiveVerificationBackend({
      workflowPath,
      params: { query: 'tires' },
      reason: 'cache is missing',
      probe: fakeProbe,
    });
    const second = await prepareLiveVerificationBackend({
      workflowPath,
      params: { query: 'tires' },
      reason: 'preferred backend failed',
      forceReprobe: true,
      probe: fakeProbe,
    });
    expect(first.reusedCache).toBe(false);
    expect(second.reusedCache).toBe(false);
    expect(probes).toBe(2);
  });

  it('fails fast and persists a suite receipt even when no call evidence completes', async () => {
    const { toolDir, cache } = fixtureTool();
    writeFileSync(pathJoin(toolDir, 'backends.json'), JSON.stringify(cache));
    writeFileSync(
      pathJoin(toolDir, 'integration.test.ts'),
      `import { expect, test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\ntest('first fails', () => expect(1).toBe(2));\ntest('second must not run', () => writeFileSync('second-ran', 'yes'));\n`,
    );
    const logPath = pathJoin(toolDir, '.live-verifier-log.jsonl');
    const result = await runLiveIntegrationSuite({ toolDir, logPath, timeoutMs: 5_000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.evidence).toEqual([]);
    expect(result.receipt.status).toBe('failed');
    expect(existsSync(pathJoin(toolDir, 'second-ran'))).toBe(false);
    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    expect(records.some((record) => record.kind === 'suite' && record.status === 'failed')).toBe(
      true,
    );
    expect(readFileSync(logPath, 'utf8')).toContain('suite.completed');
  });

  it('persists a timed-out suite receipt with zero completed calls', async () => {
    const { toolDir, cache } = fixtureTool();
    writeFileSync(pathJoin(toolDir, 'backends.json'), JSON.stringify(cache));
    writeFileSync(
      pathJoin(toolDir, 'integration.test.ts'),
      `import { test } from 'bun:test';\ntest('hangs', async () => await new Promise(() => undefined), 10_000);\n`,
    );
    const result = await runLiveIntegrationSuite({ toolDir, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.receipt.status).toBe('timed_out');
    expect(result.receipt.completedCallLabels).toEqual([]);
    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    expect(records.some((record) => record.kind === 'suite' && record.status === 'timed_out')).toBe(
      true,
    );
  });

  it('retains stable call evidence from repeated suite runs under distinct suite labels', async () => {
    const { toolDir, cache } = fixtureTool();
    writeFileSync(pathJoin(toolDir, 'backends.json'), JSON.stringify(cache));
    writeFileSync(
      pathJoin(toolDir, 'integration.test.ts'),
      `import { test } from 'bun:test';\nimport { appendFileSync } from 'node:fs';\ntest('baseline', () => {\n  appendFileSync(process.env.IMPRINT_LIVE_EVIDENCE_PATH!, JSON.stringify({ schemaVersion: 1, kind: 'call', label: 'baseline', caseName: 'baseline', toolName: 'search_fixture', requestedParams: { query: 'tires' }, effectiveParams: { query: 'tires' }, result: { ok: true, data: [] }, usedBackend: 'fetch', attempts: [], durationMs: 1 }) + '\\n');\n});\n`,
    );
    await runLiveIntegrationSuite({ toolDir, timeoutMs: 5_000 });
    await runLiveIntegrationSuite({ toolDir, timeoutMs: 5_000 });
    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    expect(records.map((record) => record.label)).toEqual(
      expect.arrayContaining(['suite-1/baseline', 'suite-1', 'suite-2/baseline', 'suite-2']),
    );
  });

  it('persists an aborted suite receipt when backend preparation has not succeeded', async () => {
    const { toolDir } = fixtureTool();
    writeFileSync(
      pathJoin(toolDir, 'integration.test.ts'),
      `import { test } from 'bun:test';\ntest('must not launch', () => undefined);\n`,
    );
    await expect(runLiveIntegrationSuite({ toolDir })).rejects.toThrow(
      'call prepare_live_backend before running the suite',
    );
    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'suite', status: 'aborted', completedCallLabels: [] }),
    );
  });
});
