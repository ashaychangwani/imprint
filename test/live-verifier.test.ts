import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import { __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import { registerCompilerProcessCleanup } from '../src/imprint/compiler-process.ts';
import { type CredentialBackend, setBackendOverride } from '../src/imprint/credential-store.ts';
import {
  LIVE_VERIFICATION_EVIDENCE_FILE,
  LiveVerificationAuthSession,
  LiveVerificationReportSchema,
  appendBackendProbeRawStderrTail,
  appendLiveVerifierLog,
  assertReportCoversWorkflowParameters,
  authRefreshAwaitingContinuation,
  backendPreparationFailureObservation,
  buildVerifierArtifactContext,
  compactVerifierEvidenceContext,
  credentialsForAuthRefresh,
  hasSuiteReceiptForSession,
  mergeSemanticParamVerification,
  namespaceLiveIntegrationEvidence,
  persistLiveVerificationEvidence,
  prepareLiveVerificationBackend,
  readPersistedLiveVerificationEvidence,
  runLiveIntegrationSuite,
  runLiveSemanticVerification,
  semanticVerificationFailures,
  waitForOwnedProcessTree,
  waitForVerifierChild,
} from '../src/imprint/live-verifier.ts';
import { parseBackendRequestStageFacts } from '../src/imprint/probe-backends.ts';
import { ProviderDeadlineError, ProviderReportedError } from '../src/imprint/provider-retry.ts';
import type { BackendsCache } from '../src/imprint/types.ts';

const dirs: string[] = [];
afterEach(() => {
  __setAuthVerifierLadderForTest(null);
  setBackendOverride(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('live verifier auth refresh', () => {
  it('supports first-time authentication without a pre-existing credential store', () => {
    expect(credentialsForAuthRefresh('fixture-site', null, ['session_token'], true)).toEqual({
      site: 'fixture-site',
      cookies: [],
      values: {},
      storage: [],
    });
  });

  it('loads the planned auth workflow and withholds only stale auth-produced state', async () => {
    const secrets = new Map([
      ['username', 'fixture-user'],
      ['password', 'fixture-password'],
      ['session_token', 'expired-session'],
    ]);
    const backend: CredentialBackend = {
      id: 'keyring',
      getSecret: async (_site, name) => secrets.get(name) ?? null,
      setSecret: async (_site, name, value) => {
        secrets.set(name, value);
      },
      deleteSecret: async (_site, name) => {
        secrets.delete(name);
      },
      listSecrets: async () => [...secrets.keys()],
      getCookies: async () => [
        { name: 'session', value: 'expired-cookie', domain: 'fixture.test', path: '/' },
      ],
      setCookies: async () => {},
      getStorage: async () => [
        {
          origin: 'https://fixture.test',
          kind: 'localStorage',
          key: 'session',
          value: 'expired-storage',
        },
      ],
      setStorage: async () => {},
      listSites: async () => ['fixture-site'],
    };
    setBackendOverride(backend);

    const siteDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-refresh-'));
    dirs.push(siteDir);
    const dataDir = pathJoin(siteDir, 'read_fixture');
    const authDir = pathJoin(siteDir, 'authenticate_fixture');
    mkdirSync(dataDir);
    mkdirSync(authDir);
    const dataWorkflowPath = pathJoin(dataDir, 'workflow.json');
    writeFileSync(
      dataWorkflowPath,
      JSON.stringify({
        toolName: 'read_fixture',
        toolKind: 'data',
        intent: { description: 'Read fixture data.' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://fixture.test/data', headers: {} }],
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(authDir, 'workflow.json'),
      JSON.stringify({
        toolName: 'authenticate_fixture',
        toolKind: 'authenticate',
        intent: { description: 'Authenticate to the fixture.' },
        parameters: [
          { name: 'action', type: 'string', description: 'Auth action.', default: 'begin' },
          { name: 'otp', type: 'string', description: 'Second-factor code.', required: false },
        ],
        requests: [
          {
            method: 'POST',
            url: 'https://fixture.test/login',
            headers: {},
            recordingRequestSeq: 1,
            captures: [{ source: 'json', name: 'session_token', path: '$.token' }],
          },
        ],
        authConfig: {
          entry: 'begin',
          actions: {
            begin: {
              parameters: [],
              steps: [{ request: 0, onError: 'fail' }],
              outcome: {
                type: 'pause',
                next: 'finish',
                evidence: ['challenge'],
                carry: ['challenge'],
                message: 'Supply the current one-time code.',
              },
            },
            finish: {
              parameters: ['otp'],
              steps: [{ request: 0, onError: 'fail' }],
              outcome: { type: 'success', evidence: ['session_token'] },
            },
          },
          persist: ['session_token'],
        },
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(siteDir, '.build-plan.json'),
      JSON.stringify({
        perTool: [{ toolName: 'read_fixture' }],
        authTool: { toolName: 'authenticate_fixture' },
      }),
    );

    let receivedCredentials: Parameters<
      NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>
    >[0]['credentials'];
    const calls: Array<Record<string, unknown>> = [];
    __setAuthVerifierLadderForTest((async (args) => {
      calls.push({ params: args.params, initialState: args.initialState });
      receivedCredentials = args.credentials;
      if (args.params.action === 'begin') {
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Supply the current one-time code.',
            nextAction: 'finish',
            continuation: { challenge: 'must-not-leak' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      return {
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>);

    const session = new LiveVerificationAuthSession({
      workflowPath: dataWorkflowPath,
      reason: 'fixture session was rejected',
      cleanSession: true,
      sessionLabel: 'verifier-session-1',
    });
    const first = await session.run();
    expect(first).toMatchObject({
      authToolName: 'authenticate_fixture',
      action: 'begin',
      ok: false,
      error: 'ACTION_REQUIRED',
      nextAction: 'finish',
      requiredParameters: ['otp'],
    });
    expect(JSON.stringify(first)).not.toContain('must-not-leak');
    const second = await session.run({ action: 'finish', parameters: { otp: '123456' } });
    expect(second).toMatchObject({
      authToolName: 'authenticate_fixture',
      action: 'finish',
      ok: true,
    });
    expect(receivedCredentials).toEqual({
      site: 'fixture-site',
      cookies: [],
      values: { username: 'fixture-user', password: 'fixture-password' },
      storage: [],
    });
    expect(calls).toEqual([
      { params: { action: 'begin' }, initialState: undefined },
      {
        params: { otp: '123456', action: 'finish' },
        initialState: { challenge: 'must-not-leak' },
      },
    ]);
    expect(existsSync(pathJoin(siteDir, '.imprint-live-verification.lock'))).toBe(false);

    __setAuthVerifierLadderForTest((async (args) => {
      return await new Promise((resolve) => {
        const finish = () =>
          resolve({
            result: { ok: false, error: 'NETWORK', message: 'cancelled by deadline' },
            usedBackend: 'cdp-replay',
            attempts: [],
          });
        if (args.signal?.aborted) finish();
        else args.signal?.addEventListener('abort', finish, { once: true });
      });
    }) as NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>);
    const deadlineSession = new LiveVerificationAuthSession({
      workflowPath: dataWorkflowPath,
      reason: 'fixture action stalled',
      sessionLabel: 'verifier-session-2',
      deadlineMs: Date.now() + 20,
    });
    await expect(deadlineSession.run()).rejects.toBeInstanceOf(ProviderDeadlineError);
    expect(existsSync(pathJoin(siteDir, '.imprint-live-verification.lock'))).toBe(false);
  });

  it('tracks whether a verifier session still owns an auth continuation', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-refresh-log-'));
    dirs.push(dir);
    const logPath = pathJoin(dir, 'events.jsonl');
    appendLiveVerifierLog(logPath, {
      type: 'auth.refresh.action-required',
      session: 'verifier-session-1',
    });
    expect(authRefreshAwaitingContinuation(logPath, 'verifier-session-1')).toBe(true);
    appendLiveVerifierLog(logPath, {
      type: 'auth.refresh.completed',
      session: 'verifier-session-1',
    });
    expect(authRefreshAwaitingContinuation(logPath, 'verifier-session-1')).toBe(false);
  });

  it('rejects an invented action or missing action parameters without closing the session', async () => {
    const siteDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-refresh-'));
    dirs.push(siteDir);
    const dataDir = pathJoin(siteDir, 'read_fixture');
    const authDir = pathJoin(siteDir, 'authenticate_fixture');
    mkdirSync(dataDir);
    mkdirSync(authDir);
    const dataWorkflowPath = pathJoin(dataDir, 'workflow.json');
    writeFileSync(
      dataWorkflowPath,
      JSON.stringify({
        toolName: 'read_fixture',
        toolKind: 'data',
        intent: { description: 'Read fixture data.' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://fixture.test/data', headers: {} }],
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(authDir, 'workflow.json'),
      JSON.stringify({
        toolName: 'authenticate_fixture',
        toolKind: 'authenticate',
        intent: { description: 'Authenticate to the fixture.' },
        parameters: [],
        requests: [{ method: 'POST', url: 'https://fixture.test/login', headers: {} }],
        authConfig: {
          entry: 'finish',
          actions: {
            finish: {
              parameters: ['otp'],
              steps: [{ request: 0 }],
              outcome: { type: 'success' },
            },
          },
        },
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(siteDir, '.build-plan.json'),
      JSON.stringify({
        perTool: [{ toolName: 'read_fixture' }],
        authTool: { toolName: 'authenticate_fixture' },
      }),
    );
    const session = new LiveVerificationAuthSession({
      workflowPath: dataWorkflowPath,
      reason: 'fixture session expired',
      sessionLabel: 'verifier-session-1',
    });
    try {
      await expect(session.run({ action: 'invented' })).rejects.toThrow('expects action "finish"');
      await expect(session.run()).rejects.toThrow('missing otp');
    } finally {
      await session.close();
    }
    expect(existsSync(pathJoin(siteDir, '.imprint-live-verification.lock'))).toBe(false);
  });
});

describe('verifier artifact context', () => {
  it('supplies workflow, request, parser, integration, playbook, and plan context', () => {
    const siteDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-context-'));
    dirs.push(siteDir);
    const toolDir = pathJoin(siteDir, 'search_things');
    mkdirSync(toolDir);
    writeFileSync(
      pathJoin(toolDir, 'workflow.json'),
      JSON.stringify({ toolName: 'search_things', requests: [] }),
    );
    writeFileSync(
      pathJoin(toolDir, 'request-transform.ts'),
      'export const transform = () => ({ body: "encoded" });',
    );
    writeFileSync(pathJoin(toolDir, 'request.test.ts'), 'test("encoded request", () => {});');
    writeFileSync(pathJoin(toolDir, 'parser.ts'), 'export const parse = () => [];');
    writeFileSync(pathJoin(toolDir, 'parser.test.ts'), 'test("recorded", () => {});');
    writeFileSync(pathJoin(toolDir, 'integration.test.ts'), 'test("live", async () => {});');
    writeFileSync(pathJoin(toolDir, 'playbook.yaml'), 'steps: []\n');
    writeFileSync(
      pathJoin(siteDir, '.build-plan.json'),
      JSON.stringify({
        perTool: [
          {
            toolName: 'search_things',
            requiredInputs: [{ source: 'browser_state' }],
          },
        ],
        dynamicValueFindings: [{ name: 'csrf' }],
      }),
    );

    const context = buildVerifierArtifactContext(toolDir, 'search_things') as Record<
      string,
      unknown
    >;
    expect(context.workflow).toEqual({
      toolName: 'search_things',
      requests: [],
    });
    expect(context.requestTransform).toContain('transform');
    expect(context.requestTests).toContain('encoded request');
    expect(context.parser).toContain('parse');
    expect(context.integrationTests).toContain('live');
    expect(context.playbook).toContain('steps');
    expect(context.buildPlan).toEqual({
      tool: {
        toolName: 'search_things',
        requiredInputs: [{ source: 'browser_state' }],
      },
      dynamicValueFindings: [{ name: 'csrf' }],
    });
  });

  it('tells the verifier that transformed workflow bodies are templates', () => {
    const prompt = readFileSync(
      pathJoin(import.meta.dir, '..', 'prompts/live-verifier-agent.md'),
      'utf8',
    );
    expect(prompt).toContain('Workflow request bodies are templates');
    expect(prompt).toContain('requestStageFacts');
    expect(prompt).toContain('Never infer the');
    expect(prompt).toContain('workflow template alone');
  });

  it('bounds large retained live outputs while preserving durable navigation metadata', () => {
    const evidence = Array.from({ length: 60 }, (_, index) => ({
      schemaVersion: 1,
      kind: 'call',
      label: `targeted-call-${index + 1}`,
      caseName: `case-${index + 1}`,
      toolName: 'search_things',
      requestedParams: { query: `query-${index + 1}` },
      effectiveParams: { query: `query-${index + 1}` },
      result: {
        ok: true,
        data: {
          items: Array.from({ length: 100 }, (_, itemIndex) => ({
            id: `${index}-${itemIndex}`,
            description: 'representative live output '.repeat(100),
          })),
        },
      },
      usedBackend: 'fetch',
      attempts: [{ backend: 'fetch', outcome: 'ok' }],
      durationMs: 10,
    }));

    const context = compactVerifierEvidenceContext(evidence) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(context);
    expect(serialized.length).toBeLessThan(500_000);
    expect(context[0]).toMatchObject({ kind: 'prompt-compaction', omittedRecords: 12 });
    expect(context.at(-1)).toMatchObject({
      label: 'targeted-call-60',
      requestedParams: { query: 'query-60' },
    });
    expect(serialized).toContain(LIVE_VERIFICATION_EVIDENCE_FILE);
  });
});

describe('live semantic verification report', () => {
  it('checks an expired absolute deadline before reading artifacts or spawning a provider', async () => {
    await expect(
      runLiveSemanticVerification({
        provider: 'codex-cli',
        toolDir: '/definitely/missing/provider-deadline-fixture',
        evidence: [],
        deadlineMs: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(ProviderDeadlineError);
  });
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
    appendLiveVerifierLog(path, {
      type: 'attempt.failed',
      attempt: 1,
      password: 'secret',
      stderr: 'request for bob@example.com used Authorization: Bearer secret-token-value',
    });
    appendLiveVerifierLog(path, { type: 'attempt.started', attempt: 2 });
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
    expect(events[0]?.password).toBe('[REDACTED]');
    expect(events[0]?.stderr).not.toContain('bob@example.com');
    expect(events[0]?.stderr).not.toContain('secret-token-value');
  });

  it('redacts shaped auth tokens in persisted verifier strings without hiding benign IDs', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-shaped-token-log-'));
    dirs.push(dir);
    const path = pathJoin(dir, '.live-verifier-log.jsonl');
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const hex = '0123456789abcdef0123456789abcdef01234567';

    appendLiveVerifierLog(path, {
      type: 'tool.output',
      stdout: `request_id=${uuid} Authorization: Bearer ${uuid}`,
      stderr: `content_hash=${hex} access_token=${hex}`,
    });

    const persisted = readFileSync(path, 'utf8');
    expect(persisted).toContain(`request_id=${uuid}`);
    expect(persisted).toContain(`content_hash=${hex}`);
    expect(persisted).not.toContain(`Bearer ${uuid}`);
    expect(persisted).not.toContain(`access_token=${hex}`);
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.startsWith('evidence.json.tmp-'))).toEqual([]);
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
        finishedAt: new Date().toISOString(),
      },
    ]);
    expect(hasSuiteReceiptForSession(path, 'verifier-session-1')).toBe(true);
    expect(hasSuiteReceiptForSession(path, 'verifier-session-2')).toBe(false);
  });

  it('does not treat an interrupted running suite as completed evidence', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-running-suite-'));
    dirs.push(dir);
    const path = pathJoin(dir, 'evidence.json');
    persistLiveVerificationEvidence(path, [
      {
        label: 'suite-running',
        kind: 'suite',
        status: 'running',
        verifierSession: 'verifier-session-1',
      },
    ]);
    expect(hasSuiteReceiptForSession(path, 'verifier-session-1')).toBe(false);
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
      requests: [
        {
          method: 'GET',
          url: 'https://example.com?q=${param.query}',
          headers: {},
        },
      ],
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
  it('surfaces a deterministic provider envelope without retrying or creating artifact feedback', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-provider-error-'));
    dirs.push(dir);
    const event = JSON.stringify({
      type: 'turn.failed',
      status: 422,
      error_code: 'invalid_request',
    });
    const child = spawn(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(event)})`],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForVerifierChild(
        child,
        Date.now() + 60_000,
        pathJoin(dir, 'verifier.log'),
        1,
        Date.now(),
        undefined,
        20,
        'codex-cli',
      );
      throw new Error('expected deterministic provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderReportedError);
      expect((error as ProviderReportedError).statuses).toEqual([422]);
      expect((error as ProviderReportedError).codes).toEqual(['invalid_request']);
    }
  });

  it('aborts the semantic-verifier process tree and keeps bounded KILL escalation alive', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-verifier-abort-'));
    dirs.push(dir);
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
    const controller = new AbortController();
    const waiting = waitForVerifierChild(
      child,
      Date.now() + 60_000,
      pathJoin(dir, 'verifier.log'),
      1,
      Date.now(),
      controller.signal,
      20,
    );
    controller.abort(new Error('semantic verifier cancelled'));
    await expect(waiting).rejects.toThrow('semantic verifier cancelled');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (child.pid === undefined) throw new Error('semantic verifier test child has no pid');
    expect(() => process.kill(child.pid as number, 0)).toThrow();
  });

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

  it('escalates parent-signal cleanup when a detached child ignores SIGTERM', async () => {
    const modulePath = pathJoin(process.cwd(), 'src', 'imprint', 'compiler-process.ts');
    const childProgram =
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000)';
    const helperProgram = `
      import { spawn } from 'node:child_process';
      import { registerCompilerProcessCleanup } from ${JSON.stringify(modulePath)};
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
        detached: true,
        stdio: 'ignore',
      });
      registerCompilerProcessCleanup(child, 50);
      process.stdout.write(String(child.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const helper = spawn(process.execPath, ['-e', helperProgram], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childPid = await new Promise<number>((resolve, reject) => {
      let stdout = '';
      helper.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        const line = stdout.split('\n')[0];
        if (line && /^\d+$/.test(line)) resolve(Number(line));
      });
      helper.once('error', reject);
      helper.once('close', (code) => reject(new Error(`cleanup helper exited ${code}`)));
    });
    try {
      helper.kill('SIGTERM');
      let childAlive = true;
      for (let attempt = 0; attempt < 20 && childAlive; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          process.kill(childPid, 0);
        } catch {
          childAlive = false;
        }
      }
      expect(childAlive).toBe(false);
    } finally {
      helper.kill('SIGKILL');
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        // The expected path already reaped the process group.
      }
    }
  });

  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`re-raises ${signal} after cleaning an owned child despite an earlier persistent handler`, async () => {
      const modulePath = pathJoin(process.cwd(), 'src', 'imprint', 'compiler-process.ts');
      const childProgram =
        'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)';
      const helperProgram = `
        import { spawn } from 'node:child_process';
        import { registerCompilerProcessCleanup } from ${JSON.stringify(modulePath)};
        process.on(${JSON.stringify(signal)}, () => {});
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
          detached: true,
          stdio: 'ignore',
        });
        registerCompilerProcessCleanup(child, 20);
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const helper = spawn(process.execPath, ['-e', helperProgram], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const childPid = await new Promise<number>((resolve, reject) => {
        let stdout = '';
        helper.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
          const line = stdout.split('\n')[0];
          if (line && /^\d+$/.test(line)) resolve(Number(line));
        });
        helper.once('error', reject);
        helper.once('close', (code, received) =>
          reject(new Error(`signal helper exited early ${code}/${received}`)),
        );
      });
      try {
        helper.kill(signal);
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) =>
            helper.once('close', (code, received) => resolve({ code, signal: received })),
        );
        expect(exit.signal === signal || exit.code === (signal === 'SIGTERM' ? 143 : 129)).toBe(
          true,
        );
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        helper.kill('SIGKILL');
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {}
      }
    });
  }

  it('defers SIGINT once while a production-owned child is reaped beyond its grace', async () => {
    const modulePath = pathJoin(process.cwd(), 'src', 'imprint', 'compiler-process.ts');
    const childProgram =
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000)';
    const helperProgram = `
      import { registerCompilerProcessCleanup, spawnOwnedProcess } from ${JSON.stringify(modulePath)};
      let cancellations = 0;
      process.once('SIGINT', () => process.stdout.write('cancelled:' + String(++cancellations) + '\\n'));
      const child = spawnOwnedProcess(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
        stdio: 'ignore',
      });
      registerCompilerProcessCleanup(child, 100);
      process.stdout.write(String(child.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const helper = spawn(process.execPath, ['-e', helperProgram], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const childPid = await new Promise<number>((resolve, reject) => {
      helper.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        const line = stdout.split('\n')[0];
        if (line && /^\d+$/.test(line)) resolve(Number(line));
      });
      helper.once('error', reject);
      helper.once('close', (code) => reject(new Error(`SIGINT helper exited early ${code}`)));
    });
    try {
      const cancelled = new Promise<void>((resolve) => {
        helper.stdout?.on('data', (chunk) => {
          if (String(chunk).includes('cancelled')) resolve();
        });
      });
      helper.kill('SIGINT');
      await cancelled;
      const reapDeadline = Date.now() + 100 + 500 + 200;
      let childAlive = true;
      while (childAlive && Date.now() < reapDeadline) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(20);
        } catch {
          childAlive = false;
        }
      }
      expect(helper.exitCode).toBeNull();
      expect(stdout.match(/cancelled:/g)).toHaveLength(1);
      expect(childAlive).toBe(false);
    } finally {
      helper.kill('SIGKILL');
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {}
    }
  });

  for (const fatalSignal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`lets ${fatalSignal} supersede in-flight SIGINT cleanup for a spawned owned process`, async () => {
      const modulePath = pathJoin(process.cwd(), 'src', 'imprint', 'compiler-process.ts');
      const childProgram =
        'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)';
      const helperProgram = `
        import { registerCompilerProcessCleanup, spawnOwnedProcess } from ${JSON.stringify(modulePath)};
        process.once('SIGINT', () => process.stdout.write('delegated\\n'));
        const child = spawnOwnedProcess(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
          stdio: 'ignore',
        });
        registerCompilerProcessCleanup(child, 150);
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const helper = spawn(process.execPath, ['-e', helperProgram], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      const childPid = await new Promise<number>((resolve, reject) => {
        helper.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
          const line = stdout.split('\n').find((value) => /^\d+$/.test(value));
          if (line) resolve(Number(line));
        });
        helper.once('error', reject);
        helper.once('close', (code) => reject(new Error(`signal helper exited early ${code}`)));
      });
      try {
        const delegated = new Promise<void>((resolve) => {
          const inspect = (): void => {
            if (stdout.includes('delegated')) resolve();
          };
          helper.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
            inspect();
          });
          inspect();
        });
        helper.kill('SIGINT');
        await delegated;
        await Bun.sleep(20);
        const startedAt = Date.now();
        helper.kill(fatalSignal);
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => helper.once('close', (code, signal) => resolve({ code, signal })),
        );
        expect(
          exit.signal === fatalSignal || exit.code === (fatalSignal === 'SIGTERM' ? 143 : 129),
        ).toBe(true);
        expect(Date.now() - startedAt).toBeGreaterThan(75);
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        helper.kill('SIGKILL');
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {}
      }
    });
  }

  it('removes parent cleanup listeners immediately after normal completion', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const unregister = registerCompilerProcessCleanup(child, 50);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    unregister();

    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    try {
      if (child.pid === undefined) throw new Error('child process did not start');
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  });

  it('still reaps a stubborn grandchild after its direct child exits during shutdown', async () => {
    const modulePath = pathJoin(process.cwd(), 'src', 'imprint', 'compiler-process.ts');
    const grandchildProgram =
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)';
    const childProgram = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      grandchild.stdout.once('data', () => {
        process.stdout.write(String(grandchild.pid) + '\\n');
      });
      setInterval(() => {}, 1000);
    `;
    const helperProgram = `
      import { spawn } from 'node:child_process';
      import { registerCompilerProcessCleanup } from ${JSON.stringify(modulePath)};
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const unregister = registerCompilerProcessCleanup(child, 50);
      child.once('close', unregister);
      child.stdout.once('data', (chunk) => {
        process.stdout.write(String(child.pid) + ':' + String(chunk));
      });
      setInterval(() => {}, 1000);
    `;
    const helper = spawn(process.execPath, ['-e', helperProgram], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids = await new Promise<{ child: number; grandchild: number }>((resolve, reject) => {
      let stdout = '';
      helper.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        const line = stdout.split('\n')[0];
        const match = /^(\d+):(\d+)$/.exec(line ?? '');
        if (match) resolve({ child: Number(match[1]), grandchild: Number(match[2]) });
      });
      helper.once('error', reject);
      helper.once('close', (code) => reject(new Error(`cleanup helper exited ${code}`)));
    });
    try {
      helper.kill('SIGTERM');
      let grandchildAlive = true;
      for (let attempt = 0; attempt < 20 && grandchildAlive; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          process.kill(pids.grandchild, 0);
        } catch {
          grandchildAlive = false;
        }
      }
      expect(grandchildAlive).toBe(false);
    } finally {
      helper.kill('SIGKILL');
      try {
        process.kill(-pids.child, 'SIGKILL');
      } catch {
        // The expected path already reaped the process group.
      }
    }
  });

  it('persists and returns only whitelisted request-stage facts from preparation failures', async () => {
    const { toolDir, workflowPath } = fixtureTool();
    const markerFacts = [
      {
        backend: 'fetch',
        requestIndex: 0,
        stage: 'transform',
        outcome: 'failed',
        bodyPresent: true,
        bodyByteLength: 17,
        body: 'must-not-escape',
        url: 'https://secret.example/private',
      },
    ];
    const markedError = new Error(
      `backend broke\nIMPRINT_REQUEST_STAGE_FACTS=${JSON.stringify(markerFacts)}`,
    );

    expect(backendPreparationFailureObservation(markedError)).toEqual({
      error: 'backend broke',
      requestStageFacts: [
        {
          backend: 'fetch',
          requestIndex: 0,
          stage: 'transform',
          outcome: 'failed',
          bodyPresent: true,
          bodyByteLength: 17,
        },
      ],
    });

    await expect(
      prepareLiveVerificationBackend({
        workflowPath,
        params: { query: 'private-query' },
        reason: 'prepare baseline',
        probe: async () => {
          throw markedError;
        },
      }),
    ).rejects.toThrow('backend broke');

    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    const failure = records.find(
      (record) => record.kind === 'backend-preparation' && record.status === 'failed',
    );
    expect(failure).toMatchObject({
      error: 'backend broke',
      requestStageFacts: [
        {
          backend: 'fetch',
          requestIndex: 0,
          stage: 'transform',
          outcome: 'failed',
          bodyPresent: true,
          bodyByteLength: 17,
        },
      ],
    });
    const serializedFailure = JSON.stringify(failure);
    expect(serializedFailure).not.toContain('must-not-escape');
    expect(serializedFailure).not.toContain('secret.example');
    expect(serializedFailure).not.toContain('private-query');
  });

  it('carries request-stage facts through the real probe subprocess transport', async () => {
    const { toolDir, workflowPath } = fixtureTool();
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
    workflow.requestTransformModule = './missing-transform.ts';
    writeFileSync(workflowPath, JSON.stringify(workflow));

    await expect(
      prepareLiveVerificationBackend({
        workflowPath,
        params: { query: 'private-query' },
        reason: 'exercise real subprocess transport',
      }),
    ).rejects.toThrow('backend probe exited');

    const records = readPersistedLiveVerificationEvidence(
      pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE),
    );
    const failure = records.find(
      (record) => record.kind === 'backend-preparation' && record.status === 'failed',
    );
    expect(failure).toMatchObject({
      requestStageFacts: [
        {
          backend: 'fetch',
          requestIndex: 0,
          stage: 'preparation',
          outcome: 'passed',
        },
        {
          backend: 'fetch',
          requestIndex: 0,
          stage: 'transform',
          outcome: 'unavailable',
        },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain('private-query');
  });

  it('retains a maximum-size request-stage marker delivered in one stderr chunk', () => {
    const markerFacts = Array.from({ length: 32 }, (_, requestIndex) => ({
      backend: 'fetch-bootstrap',
      requestIndex: requestIndex + 1_000_000_000,
      stage: 'preparation',
      outcome: 'unavailable',
      bodyPresent: true,
      bodyByteLength: Number.MAX_SAFE_INTEGER,
      bodyChanged: true,
      httpStatus: 599,
    }));
    const marker = `IMPRINT_REQUEST_STAGE_FACTS=${JSON.stringify(markerFacts)}\n`;
    expect(marker.length).toBeGreaterThan(4_000);

    const retained = appendBackendProbeRawStderrTail('', Buffer.from(marker));
    expect(parseBackendRequestStageFacts(retained)).toHaveLength(32);
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

  it('rebinds a proven preference across capability-preserving compiler revisions', async () => {
    const { toolDir, workflowPath, cache } = fixtureTool();
    const { workflowCapabilityHash } = await import('../src/imprint/probe-backends.ts');
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
    writeFileSync(
      pathJoin(toolDir, 'backends.json'),
      JSON.stringify({
        ...cache,
        schemaVersion: 2,
        workflowHash: 'previous-compiler-revision',
        capabilityHash: workflowCapabilityHash(workflow),
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

  it('probes again when a stale cache was proven for different capabilities', async () => {
    const { toolDir, workflowPath, cache } = fixtureTool();
    writeFileSync(
      pathJoin(toolDir, 'backends.json'),
      JSON.stringify({
        ...cache,
        schemaVersion: 2,
        workflowHash: 'previous-compiler-revision',
        capabilityHash: 'different-capabilities',
      }),
    );
    let probes = 0;
    const result = await prepareLiveVerificationBackend({
      workflowPath,
      params: { query: 'tires' },
      reason: 'workflow capabilities changed',
      probe: async (_opts, _root, _tool, outPath) => {
        probes++;
        if (!outPath) throw new Error('expected explicit cache path');
        const { workflowCapabilityHash } = await import('../src/imprint/probe-backends.ts');
        const current = {
          ...cache,
          schemaVersion: 2 as const,
          workflowHash: 'current',
          capabilityHash: workflowCapabilityHash(JSON.parse(readFileSync(workflowPath, 'utf8'))),
        };
        writeFileSync(outPath, JSON.stringify(current));
        return { cache: current, outPath };
      },
    });
    expect(result.reusedCache).toBe(false);
    expect(probes).toBe(1);
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
    const result = await runLiveIntegrationSuite({
      toolDir,
      logPath,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.evidence).toEqual([]);
    expect(result.receipt.status).toBe('failed');
    expect(existsSync(pathJoin(toolDir, 'second-ran'))).toBe(false);
    expect(readlinkSync(pathJoin(dirname(dirname(toolDir)), 'node_modules', 'imprint'))).toBe(
      pathJoin(import.meta.dir, '..'),
    );
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
      expect.objectContaining({
        kind: 'suite',
        status: 'aborted',
        completedCallLabels: [],
      }),
    );
  });
});
