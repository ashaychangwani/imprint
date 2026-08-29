import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  bodyEncodingContractFailures,
  buildCompileTools,
  crossReferenceReferencedStateCaptures,
  externalVerification,
  irreversibleProvenanceFailures,
  parseJUnitResults,
  requestEncodingTestContractFailures,
  requestsNeedingBodyEncodingDecision,
  typecheckArtifacts,
} from '../src/imprint/compile-tools.ts';
import { redactSession } from '../src/imprint/redact.ts';
import { ToolCandidateSchema } from '../src/imprint/tool-candidates.ts';
import { type Session, SessionSchema, WorkflowSchema } from '../src/imprint/types.ts';

describe('body encoding compile contract', () => {
  const workflow = (encoding?: 'raw' | 'json-string' | 'form-urlencoded') =>
    WorkflowSchema.parse({
      toolName: 'encoding_contract',
      intent: { description: 'test encoding contract' },
      site: 'fixture',
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: 'https://fixture.test/login',
          headers: { 'content-type': 'text/plain' },
          body: '{"password":"${credential.password}"}',
          bodyPlaceholderEncoding: encoding,
        },
      ],
    });

  it('requires an agent encoding decision and an agent-authored test', () => {
    expect(requestsNeedingBodyEncodingDecision(workflow())).toEqual([0]);
    expect(bodyEncodingContractFailures(workflow()).join('\n')).toContain(
      'no bodyPlaceholderEncoding',
    );
    expect(requestEncodingTestContractFailures(workflow('json-string'), undefined)).toEqual([
      'request.test.ts is mechanically required for a placeholder-bearing request body; the compile agent and independent artifact reviewer remain responsible for test strength',
    ]);
    expect(bodyEncodingContractFailures(workflow()).join('\n')).toContain(
      'host only checks that this file exists and its tests pass',
    );
  });

  it('mechanically accepts even a vacuous passing authored file and assigns strength to review', () => {
    const source = `test('round trips request values', () => expect(true).toBe(true));`;
    for (const encoding of ['raw', 'json-string', 'form-urlencoded'] as const) {
      expect(bodyEncodingContractFailures(workflow(encoding))).toEqual([]);
      expect(requestEncodingTestContractFailures(workflow(encoding), source)).toEqual([]);
    }
    const prompt = readFileSync(
      pathJoin(import.meta.dir, '..', 'prompts', 'compile-agent.md'),
      'utf8',
    );
    expect(prompt).toContain('A vacuous passing assertion is not evidence that encoding works.');
    expect(prompt).toContain(
      'host mechanically checks only that this file exists and its tests pass',
    );
  });

  it('also requires an encoding decision for supported bracketed state placeholders', () => {
    const bracketed = workflow();
    const request = bracketed.requests[0];
    if (!request) throw new Error('bad fixture');
    request.body = '{"token":"${state["anti.csrf"]}"}';

    expect(requestsNeedingBodyEncodingDecision(bracketed)).toEqual([0]);
    expect(bodyEncodingContractFailures(bracketed)).not.toEqual([]);
  });

  it('requires an encoding decision for indexed response placeholders', () => {
    const responseBound = workflow();
    const request = responseBound.requests[0];
    if (!request) throw new Error('bad fixture');
    request.body = '{"token":"${response[0].token}"}';

    expect(requestsNeedingBodyEncodingDecision(responseBound)).toEqual([0]);
    expect(bodyEncodingContractFailures(responseBound)).not.toEqual([]);
    expect(requestEncodingTestContractFailures(responseBound, undefined)).not.toEqual([]);
  });
});

describe('irreversible provenance', () => {
  it('preserves an irreversible source even when the generated request is outside candidate scope', () => {
    const recorded: Session = {
      site: 'fixture',
      startedAt: '2026-07-23T00:00:00.000Z',
      url: 'https://fixture.test',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 42,
          timestamp: 1,
          method: 'POST',
          url: 'https://fixture.test/order',
          headers: {},
          resourceType: 'Fetch',
          effect: 'irreversible',
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const generated = WorkflowSchema.parse({
      toolName: 'place_fixture_order',
      intent: { description: 'Place fixture order.' },
      site: 'fixture',
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: 'https://fixture.test/order',
          headers: {},
          recordingRequestSeq: 42,
        },
      ],
    });

    expect(
      irreversibleProvenanceFailures(recorded, generated, { candidateRequestSeqs: [7] }),
    ).toContain(
      'workflow request index 0 grounded by recordingRequestSeq 42 must declare effect: "irreversible"',
    );
  });
});

function makeSummaryRequest(seq: number, timestamp: number): Session['requests'][number] {
  return {
    seq,
    timestamp,
    method: 'GET',
    url: 'https://api.example.com/search?q=test',
    headers: {},
    resourceType: 'Fetch',
    response: {
      status: 200,
      headers: {},
      mimeType: 'application/json',
      body: '{"items":[{"name":"Test"}]}',
    },
  };
}

it('keeps ordinary compiler tools available for an irreversible candidate', () => {
  const request = makeSummaryRequest(42, 100);
  const session: Session = {
    site: 'test',
    startedAt: '2026-05-04T00:00:00.000Z',
    url: 'https://example.com/start',
    imprintVersion: '0.1.0',
    requests: [{ ...request, effect: 'irreversible' }],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
    triage: {
      effectSchemaVersion: 2,
      coveredSeqs: [42],
      irreversibleSeqs: [42],
      coveredOutboundEventSeqs: [],
      irreversibleEventSeqs: [],
    },
  };

  const toolNames = buildCompileTools(session, '/tmp/test-tool', '/tmp/session.json', {
    candidate: {
      toolName: 'place_order',
      description: 'Place an order',
      rationale: 'primary intent',
      confidence: 1,
      requestSeqs: [42],
      representativeSeqs: [42],
      dependencySeqs: [],
      dependsOnTools: [],
      eventSeqs: [],
      expectedOutput: 'Order confirmation',
      likelyParams: [],
    },
  }).map((tool) => tool.name);

  expect(toolNames).toContain('run_bash');
  expect(toolNames).toContain('run_tests');
});

it('keeps ordinary compiler tools available for a safe candidate', () => {
  const safe = makeSummaryRequest(7, 50);
  const irreversible = { ...makeSummaryRequest(42, 100), effect: 'irreversible' as const };
  const session: Session = {
    site: 'test',
    startedAt: '2026-05-04T00:00:00.000Z',
    url: 'https://example.com/start',
    imprintVersion: '0.1.0',
    requests: [safe, irreversible],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
  const candidate = {
    toolName: 'read_menu',
    description: 'Read the menu',
    rationale: 'primary intent',
    confidence: 1,
    requestSeqs: [7],
    representativeSeqs: [7],
    dependencySeqs: [],
    dependsOnTools: [],
    eventSeqs: [],
    expectedOutput: 'Menu',
    likelyParams: [],
  };

  const toolNames = buildCompileTools(session, '/tmp/test-tool', '/tmp/session.json', {
    candidate,
  }).map((tool) => tool.name);
  expect(toolNames).toContain('run_bash');
  expect(toolNames).toContain('run_tests');
});

describe('compile tools bounded context', () => {
  it('surfaces the source of verified shared-module proposals', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-plan-'));
    try {
      const toolDir = pathJoin(root, 'search_items');
      mkdirSync(pathJoin(root, '_shared'), { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      writeFileSync(
        pathJoin(root, '_shared', 'request.ts'),
        'export function transform(params: unknown) { return params; }\n',
      );
      const buildPlanPath = pathJoin(root, '.build-plan.json');
      writeFileSync(
        buildPlanPath,
        JSON.stringify({
          sharedModules: [
            {
              path: '_shared/request.ts',
              kind: 'request-transform',
              purpose: 'Build the shared request shape',
              exportSignatures: ['export function transform(params: unknown): unknown'],
              spec: 'Reuse the recorded request shape.',
            },
          ],
          perTool: [
            {
              toolName: 'search_items',
              usesSharedModules: ['_shared/request.ts'],
            },
          ],
        }),
      );

      const session: Session = {
        site: 'test',
        startedAt: '2026-05-04T00:00:00.000Z',
        url: 'https://example.com/start',
        imprintVersion: '0.1.0',
        requests: [],
        events: [],
        narration: [],
        cookieSnapshots: [],
        storageSnapshots: [],
      };
      const readPlan = buildCompileTools(session, toolDir, '/tmp/session.json', {
        buildPlanPath,
        candidate: {
          toolName: 'search_items',
          description: 'Search items',
          rationale: 'primary intent',
          confidence: 1,
          requestSeqs: [],
          representativeSeqs: [],
          dependencySeqs: [],
          dependsOnTools: [],
          eventSeqs: [],
          expectedOutput: 'Matching items',
          likelyParams: [],
        },
        sharedModules: [{ path: '_shared/request.ts', kind: 'request-transform', verified: true }],
      }).find((tool) => tool.name === 'read_build_plan');
      if (!readPlan) throw new Error('missing read_build_plan');

      const result = JSON.parse((await readPlan.handler({})).result);
      expect(result.sharedModuleProposals[0]).toMatchObject({
        importPath: '../_shared/request.ts',
        source: 'export function transform(params: unknown) { return params; }\n',
      });
      expect(result.evidenceBoundary).toContain('suggestions, not proof');
      expect(result).not.toHaveProperty('contractedInputs');
      expect(result).not.toHaveProperty('opaqueValueDecisionProtocol');
      expect(result).not.toHaveProperty('dynamicValueFindings');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces existing artifacts and durable feedback for a bounded revision', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-revision-'));
    try {
      mkdirSync(pathJoin(root, 'notes'), { recursive: true });
      writeFileSync(pathJoin(root, 'workflow.json'), '{"toolName":"search_items"}');
      writeFileSync(pathJoin(root, '.live-verification.json'), '{"verdict":"changes_required"}');
      writeFileSync(pathJoin(root, 'notes', 'audit-feedback.md'), 'alternate input failed');

      const session: Session = {
        site: 'test',
        startedAt: '2026-05-04T00:00:00.000Z',
        url: 'https://example.com/start',
        imprintVersion: '0.1.0',
        requests: [],
        events: [],
        narration: [],
        cookieSnapshots: [],
        storageSnapshots: [],
      };
      const summaryTool = buildCompileTools(session, root, '/tmp/session.json', {
        revisionMode: true,
      }).find((tool) => tool.name === 'read_session_summary');
      if (!summaryTool) throw new Error('missing read_session_summary');

      const summary = JSON.parse((await summaryTool.handler({})).result);
      expect(summary.revisionContext).toMatchObject({
        mode: 'revise_existing_artifact',
        existingArtifacts: {
          entries: [{ path: 'workflow.json' }],
          omitted: { atLeast: 0, exact: true },
        },
        durableDiagnostics: {
          entries: [{ path: '.live-verification.json' }],
          omitted: { atLeast: 0, exact: true },
        },
        feedbackNotes: {
          state: 'available',
          entries: [{ path: 'notes/audit-feedback.md' }],
          omitted: { atLeast: 0, exact: true },
        },
      });
      expect(summary.revisionContext.instruction).toContain('not a from-scratch compile');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds revision notes and ignores non-files and symlinks', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-revision-hostile-'));
    try {
      mkdirSync(pathJoin(root, 'notes'));
      mkdirSync(pathJoin(root, 'parser.ts'));
      writeFileSync(pathJoin(root, 'outside.md'), 'outside');
      symlinkSync(pathJoin(root, 'outside.md'), pathJoin(root, 'workflow.json'));
      symlinkSync(pathJoin(root, 'outside.md'), pathJoin(root, 'notes', 'linked.md'));
      for (let index = 0; index < 70; index++)
        writeFileSync(pathJoin(root, 'notes', `note-${String(index).padStart(2, '0')}.md`), 'note');

      const session: Session = {
        site: 'test',
        startedAt: '2026-05-04T00:00:00.000Z',
        url: 'https://example.com/start',
        imprintVersion: '0.1.0',
        requests: [],
        events: [],
        narration: [],
        cookieSnapshots: [],
        storageSnapshots: [],
      };
      const summaryTool = buildCompileTools(session, root, '/tmp/session.json', {
        revisionMode: true,
      }).find((tool) => tool.name === 'read_session_summary');
      if (!summaryTool) throw new Error('missing read_session_summary');

      const revision = JSON.parse((await summaryTool.handler({})).result).revisionContext;
      expect(revision.existingArtifacts.entries).toEqual([]);
      expect(revision.feedbackNotes).toMatchObject({
        state: 'available',
        scanned: 64,
        scanCap: 64,
        scanTruncated: true,
        omitted: { exact: false },
      });
      expect(revision.feedbackNotes.entries).toHaveLength(16);
      expect(revision.feedbackNotes.omitted.atLeast).toBeGreaterThanOrEqual(47);
      expect(JSON.stringify(revision)).not.toContain('linked.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an empty or non-directory notes path as unavailable', async () => {
    for (const kind of ['empty', 'file', 'symlink'] as const) {
      const root = mkdtempSync(pathJoin(tmpdir(), `imprint-compile-revision-${kind}-`));
      try {
        if (kind === 'empty') mkdirSync(pathJoin(root, 'notes'));
        else if (kind === 'file') writeFileSync(pathJoin(root, 'notes'), 'not a directory');
        else {
          mkdirSync(pathJoin(root, 'notes-target'));
          symlinkSync(pathJoin(root, 'notes-target'), pathJoin(root, 'notes'));
        }
        const session: Session = {
          site: 'test',
          startedAt: '2026-05-04T00:00:00.000Z',
          url: 'https://example.com/start',
          imprintVersion: '0.1.0',
          requests: [],
          events: [],
          narration: [],
          cookieSnapshots: [],
          storageSnapshots: [],
        };
        const summaryTool = buildCompileTools(session, root, '/tmp/session.json', {
          revisionMode: true,
        }).find((tool) => tool.name === 'read_session_summary');
        if (!summaryTool) throw new Error('missing read_session_summary');
        expect(
          JSON.parse((await summaryTool.handler({})).result).revisionContext.feedbackNotes,
        ).toMatchObject({ state: 'none', entries: [], scanTruncated: false });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('does not turn a redacted scalar echo into an automatic state rule', async () => {
    const session: Session = {
      site: 'test',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/bootstrap',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'XSRF-TOKEN=[REDACTED:v3:id=7:len=24]; Path=/',
            },
            mimeType: 'application/json',
            body: '{}',
          },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://example.com/api/search',
          headers: { 'x-csrf-token': '[REDACTED:v3:id=7:len=24]' },
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: '{}',
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const summaryTool = buildCompileTools(session, '/tmp/example', '/tmp/session.json').find(
      (tool) => tool.name === 'read_session_summary',
    );
    if (!summaryTool) throw new Error('missing read_session_summary');

    const result = await summaryTool.handler({});
    const summary = JSON.parse(result.result);
    expect(summary.recordingInventory).toEqual({
      cookieSnapshotCount: 0,
      storageSnapshotCount: 0,
    });
    expect(summary).not.toHaveProperty('stateFacts');
    expect(summary).not.toHaveProperty('captureFacts');
    expect(summary).not.toHaveProperty('stateHints');
    expect(result.result).not.toContain('XSRF-TOKEN');
    expect(result.result).not.toContain('x-csrf-token');
  });
});

describe('compile tools request compaction', () => {
  it('compacts summary requests while preserving selected candidate seqs', async () => {
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-12T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        makeSummaryRequest(1, 100),
        makeSummaryRequest(2, 120),
        makeSummaryRequest(3, 140),
        {
          seq: 4,
          timestamp: 80,
          method: 'POST',
          url: 'https://www.example.com/login',
          headers: {},
          resourceType: 'XHR',
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: '{"ok":true}',
          },
        },
      ],
      events: [],
      narration: [{ seq: 10, timestamp: 90, text: 'searched for test' }],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'search_items',
        description: 'Search items',
        rationale: 'primary intent',
        confidence: 0.9,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'items',
        likelyParams: [],
        dependencySeqs: [],
        dependsOnTools: [],
      },
      sharedContext: {
        loginRequestSeqs: [4],
        credentialNames: [],
        tokenExtractionNotes: '',
        sharedHelperNotes: '',
        authRequestSeqs: [4],
        authNotes: '',
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((request: { seq: number }) => request.seq)).toEqual([
      2, 4,
    ]);
    expect(summary.loadBearingRequests[0]).toMatchObject({
      seq: 2,
      selectedForCandidate: true,
    });
    expect(summary.loadBearingRequests[1]).toMatchObject({
      seq: 4,
      sharedDependency: true,
    });
  });

  it('omits automatic event grounding and enforces the 30 KiB summary budget', async () => {
    const eventSeqs = Array.from({ length: 32 }, (_, index) => index + 1);
    const hostileEventText = `SITE-INSTRUCTION-${'x'.repeat(50_000)}`;
    const narrationText = `USER-INTENT-${'y'.repeat(50_000)}`;
    const scalarSecret = 'scalar-secret-must-not-appear';
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-12T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          ...makeSummaryRequest(1, 100),
          url: `https://api.example.com/bootstrap?secret=${scalarSecret}`,
          body: JSON.stringify({ secret: scalarSecret }),
        },
        {
          ...makeSummaryRequest(2, 200),
          method: 'POST',
          url: `https://api.example.com/search?secret=${scalarSecret}`,
          body: JSON.stringify({ secret: scalarSecret }),
        },
      ],
      events: eventSeqs.map((seq) => ({
        seq,
        timestamp: seq,
        type: 'click',
        detail: hostileEventText,
      })),
      narration: [{ seq: 100, timestamp: 100, text: narrationText }],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'search_items',
        description: 'Search items',
        rationale: 'primary intent',
        confidence: 0.9,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs,
        expectedOutput: 'items',
        likelyParams: [{ name: 'query', type: 'string', description: 'Search query' }],
        dependencySeqs: [1],
        dependsOnTools: [],
      },
      sharedContext: {
        loginRequestSeqs: [1],
        authRequestSeqs: [1],
        credentialNames: ['account'],
        tokenExtractionNotes: 'Capture the redacted bootstrap state.',
        sharedHelperNotes: 'Reuse the shared authenticated session.',
        authNotes: 'Authenticate before search.',
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = (await readSummary.handler({})).result;
    const summary = JSON.parse(result);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(30_000);
    expect(summary).toMatchObject({
      summaryBounded: true,
      site: { name: 'demo', startHost: 'www.example.com', startPath: '/start' },
      selectedCandidate: {
        toolName: 'search_items',
        intent: { description: 'Search items', rationale: 'primary intent' },
        likelyParams: [{ name: 'query', type: 'string' }],
        eventSeqs,
        requestSeqs: [2],
        dependencySeqs: [1],
      },
      sharedCompileContext: {
        loginRequestSeqs: [1],
        credentialNames: ['account'],
      },
      recordingInventory: { cookieSnapshotCount: 0, storageSnapshotCount: 0 },
      loadBearingRequests: [
        { seq: 1, method: 'GET', host: 'api.example.com', path: '/bootstrap' },
        { seq: 2, method: 'POST', host: 'api.example.com', path: '/search' },
      ],
    });
    expect(summary.narration[0].text).toStartWith('USER-INTENT-');
    expect([...summary.narration[0].text]).toHaveLength(256);
    expect(summary.omissions.narration).toMatchObject({
      entries: { atLeast: 0, exact: true },
      characters: { atLeast: 1, exact: false },
      utf8Bytes: { atLeast: 1, exact: false },
      truncatedTextFields: 1,
    });
    expect(summary.omissions.loadBearingRequests.characters).toMatchObject({
      exact: false,
    });
    expect(summary.omissions.loadBearingRequests.characters.atLeast).toBeGreaterThanOrEqual(1);
    expect(summary).not.toHaveProperty('paramGroundingHints');
    expect(summary).not.toHaveProperty('paramGroundingWork');
    expect(summary).not.toHaveProperty('stateFacts');
    expect(summary).not.toHaveProperty('captureFacts');
    expect(result).not.toContain('SITE-INSTRUCTION-');
    expect(result).not.toContain(scalarSecret);
  });

  it('includes preserved candidate dependencies even when they are outside load-bearing filters', async () => {
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-12T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://auth.example-idp.com/login',
          headers: {},
          resourceType: 'Document',
          response: { status: 302, headers: {}, mimeType: 'text/html', body: '' },
        },
        makeSummaryRequest(2, 200),
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'search_items',
        description: 'Search items',
        rationale: 'primary intent',
        confidence: 0.9,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'items',
        likelyParams: [],
        dependencySeqs: [1],
        dependsOnTools: [],
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((request: { seq: number }) => request.seq)).toEqual([
      1, 2,
    ]);
    expect(summary.loadBearingRequests[0]).toMatchObject({
      seq: 1,
      sharedDependency: true,
    });
  });

  it('distinguishes wanted sequences outside the scan from proven absence', async () => {
    const candidateFor = (seq: number) => ({
      toolName: 'search_items',
      description: 'Search items',
      rationale: 'primary intent',
      confidence: 0.9,
      requestSeqs: [seq],
      representativeSeqs: [seq],
      eventSeqs: [],
      expectedOutput: 'items',
      likelyParams: [],
      dependencySeqs: [],
      dependsOnTools: [],
    });
    const base: Omit<Session, 'requests'> = {
      site: 'demo',
      startedAt: '2026-05-12T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const cappedSession: Session = {
      ...base,
      requests: Array.from({ length: 10_001 }, (_, index) => makeSummaryRequest(index + 1, index)),
    };
    const earlyTool = buildCompileTools(cappedSession, '/tmp/tool', '/tmp/session.json', {
      candidate: candidateFor(1),
    }).find((tool) => tool.name === 'read_session_summary');
    if (!earlyTool) throw new Error('read_session_summary tool missing');
    expect(JSON.parse((await earlyTool.handler({})).result).requestIndex).toMatchObject({
      state: 'not_checked',
      foundWithinScan: 1,
      notCheckedTotal: 0,
      requestTail: { state: 'not_checked', count: 1 },
    });

    const cappedTool = buildCompileTools(cappedSession, '/tmp/tool', '/tmp/session.json', {
      candidate: candidateFor(10_001),
    }).find((tool) => tool.name === 'read_session_summary');
    if (!cappedTool) throw new Error('read_session_summary tool missing');
    expect(JSON.parse((await cappedTool.handler({})).result).requestIndex).toMatchObject({
      state: 'not_checked',
      notFoundWithinScannedSeqs: [10_001],
      notCheckedSeqs: [10_001],
      notCheckedTotal: 1,
      notCheckedSeqsOmitted: 0,
      requestTail: { state: 'not_checked', count: 1 },
    });

    const absentButUnprovableTool = buildCompileTools(
      cappedSession,
      '/tmp/tool',
      '/tmp/session.json',
      { candidate: candidateFor(99_999) },
    ).find((tool) => tool.name === 'read_session_summary');
    if (!absentButUnprovableTool) throw new Error('read_session_summary tool missing');
    expect(
      JSON.parse((await absentButUnprovableTool.handler({})).result).requestIndex,
    ).toMatchObject({
      state: 'not_checked',
      notFoundWithinScannedSeqs: [99_999],
      notCheckedSeqs: [99_999],
      notCheckedTotal: 1,
      requestTail: { state: 'not_checked', count: 1 },
    });

    const completeTool = buildCompileTools(
      { ...base, requests: cappedSession.requests.slice(0, 3) },
      '/tmp/tool',
      '/tmp/session.json',
      { candidate: candidateFor(999) },
    ).find((tool) => tool.name === 'read_session_summary');
    if (!completeTool) throw new Error('read_session_summary tool missing');
    expect(JSON.parse((await completeTool.handler({})).result).requestIndex).toMatchObject({
      state: 'checked',
      absentSeqs: [999],
      absentTotal: 1,
      absentSeqsOmitted: 0,
      requestTail: { state: 'checked', count: 0 },
    });
  });
});

describe('compile tools representativeSeqs', () => {
  it('uses representativeSeqs for bounded request facts when provided', async () => {
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-24T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 50,
          method: 'GET',
          url: 'https://www.example.com/bootstrap',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            mimeType: 'text/html',
            body: '<html>token=abc</html>',
          },
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          seq: 10 + i,
          timestamp: 100 + i * 10,
          method: 'POST' as const,
          url: 'https://www.example.com/api/autocomplete',
          headers: { 'content-type': 'application/json' },
          resourceType: 'Fetch' as const,
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: JSON.stringify({ results: [`result-${i}`] }),
          },
        })),
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'autocomplete',
        description: 'Autocomplete search',
        rationale: 'autocomplete intent',
        confidence: 0.9,
        requestSeqs: [10, 11, 12, 13, 14],
        representativeSeqs: [10],
        eventSeqs: [],
        expectedOutput: 'suggestions',
        likelyParams: [],
        dependencySeqs: [1],
        dependsOnTools: [],
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((r: { seq: number }) => r.seq)).toEqual([1, 10]);
    expect(summary.loadBearingRequests[0]).toMatchObject({ seq: 1, sharedDependency: true });
    expect(summary.loadBearingRequests[1]).toMatchObject({ seq: 10, selectedForCandidate: true });
    expect(summary.loadBearingRequests[1].inlineData).toBeUndefined();
    expect(summary.loadBearingRequests[1]).toHaveProperty('responseBodyCharacters');
  });

  it('falls back to requestSeqs when representativeSeqs is empty', async () => {
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-24T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://www.example.com/api/search',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"a":1}' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://www.example.com/api/book',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"b":2}' },
        },
        {
          seq: 3,
          timestamp: 300,
          method: 'GET',
          url: 'https://www.example.com/api/confirm',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"c":3}' },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'book_item',
        description: 'Book an item',
        rationale: 'booking flow',
        confidence: 0.9,
        requestSeqs: [1, 2, 3],
        representativeSeqs: [],
        eventSeqs: [],
        expectedOutput: 'confirmation',
        likelyParams: [],
        dependencySeqs: [],
        dependsOnTools: [],
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3]);
    for (const r of summary.loadBearingRequests) {
      expect(r.selectedForCandidate).toBe(true);
    }
  });

  it('excludes non-candidate load-bearing requests from summary', async () => {
    const session: Session = {
      site: 'demo',
      startedAt: '2026-05-24T00:00:00.000Z',
      url: 'https://www.example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        makeSummaryRequest(1, 100),
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://www.example.com/api/target',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: '{"data":true}',
          },
        },
        makeSummaryRequest(3, 300),
        makeSummaryRequest(4, 400),
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    const readSummary = buildCompileTools(session, '/tmp/tool', '/tmp/session.json', {
      candidate: {
        toolName: 'target_action',
        description: 'Target action',
        rationale: 'primary intent',
        confidence: 0.9,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'data',
        likelyParams: [],
        dependencySeqs: [],
        dependsOnTools: [],
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((r: { seq: number }) => r.seq)).toEqual([2]);
    expect(summary.loadBearingRequests[0]).toMatchObject({ seq: 2, selectedForCandidate: true });
  });
});

describe('externalVerification', () => {
  it('mechanically validates the real parser export for irreversible workflows', async () => {
    const exampleDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-irreversible-parser-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');
    const session: Session = {
      site: 'irreversible-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/order',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/order',
          headers: {},
          body: '{}',
          resourceType: 'Fetch',
          effect: 'irreversible',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: '{"orderId":"1"}',
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify({
          toolName: 'place_order',
          intent: { description: 'Place an order' },
          site: session.site,
          parameters: [],
          requests: [
            {
              method: 'POST',
              url: 'https://example.com/api/order',
              headers: {},
              body: '{}',
              effect: 'irreversible',
              recordingRequestSeq: 1,
            },
          ],
          parserModule: './parser.ts',
        }),
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        'export const extract = (input: unknown) => input;\n',
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.test.ts'),
        `import { expect, test } from 'bun:test';
import { extract } from './parser.ts';
test('recorded response', () => expect(extract({ orderId: '1' })).toEqual({ orderId: '1' }));
`,
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [1],
      });

      expect(failures.some((failure) => failure.includes('parser.ts runtime export check'))).toBe(
        false,
      );

      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        'export const parse = () => null;\n',
        'utf8',
      );
      const second = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [1],
      });
      expect(
        second.failures.some((failure) => failure.includes('parser.ts runtime export check')),
      ).toBe(true);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('typechecks generated artifacts from os tmpdir paths', async () => {
    const exampleDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-typecheck-tmp-'));

    try {
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        `export function extract(input: { ok: boolean }) {
  return { ok: input.ok };
}
`,
        'utf8',
      );

      const result = await typecheckArtifacts(exampleDir, ['parser.ts']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('/private/Users');
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('rejects generated artifacts that pass bun tests but fail strict typecheck', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-typecheck-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'typecheck-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=alpha',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ items: ['alpha'] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_typecheck_fixture',
            intent: { description: 'Search typecheck fixture' },
            parameters: [],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=alpha',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'typecheck-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        `type Payload = { items?: string[] };

export function extract(data: Payload) {
  const first = data.items[0];
  return { first };
}
`,
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.test.ts'),
        `import { describe, expect, it } from 'bun:test';
import { extract } from './parser.ts';

describe('extract', () => {
  it('extracts the first item', () => {
    const result = extract({ items: ['alpha'] });
    expect(result.first).toBe('alpha');
    expect(Object.keys(result)).toContain('first');
    expect(result).toEqual({ first: 'alpha' });
  });
});
`,
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);
      expect(failures.some((failure) => failure.includes('failed typecheck'))).toBe(true);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not enforce detector-suggested parameters in the runtime verifier', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-likelyparams-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'likelyparams-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [{ name: 'query', type: 'string', description: 'Search query' }],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'likelyparams-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);

      expect(failures.some((f) => f.includes('valid disposition'))).toBe(false);
      expect(failures.some((f) => f.includes('max_price'))).toBe(false);
      expect(failures.some((f) => f.includes('sort_order'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not require a runtime-authored parameter limitation', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-omitted-likelyparam-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'omitted-likelyparam-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [{ name: 'query', type: 'string', description: 'Search query' }],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}',
                headers: { Accept: 'application/json' },
              },
            ],
            limitations: [
              {
                feature: 'Maximum-price filter',
                reason: 'No request field or live behavior in the recording grounds this filter.',
                omittedParameters: ['max_price'],
              },
            ],
            site: 'omitted-likelyparam-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures, warnings } = await externalVerification(exampleDir, session, sessionPath);

      expect(failures.some((failure) => failure.includes('max_price'))).toBe(false);
      expect(warnings.some((warning) => warning.includes('max_price'))).toBe(false);
      expect(warnings.some((warning) => warning.includes('intentionally omitted'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('leaves public parameter usefulness to the agents', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-public-omitted-param-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'public-omitted-param-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'max_price', type: 'number', description: 'Maximum price filter' },
            ],
            requests: [{ method: 'GET', url: 'https://example.com/api/search', headers: {} }],
            limitations: [
              {
                feature: 'Maximum-price filter',
                reason: 'No grounded request field.',
                omittedParameters: ['max_price'],
              },
            ],
            site: 'public-omitted-param-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);

      expect(failures.some((failure) => failure.includes('max_price'))).toBe(false);
      expect(failures.some((failure) => failure.includes('valid disposition'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not infer meaning from an opaque-looking parameter default', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-opaque-param-default-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'opaque-param-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/reservations',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/reservation?search_token=recorded-token',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ reservation: { id: 'res-1' } }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'get_reservation',
            intent: { description: 'Get reservation details' },
            parameters: [
              {
                name: 'search_token',
                type: 'string',
                description: 'Opaque reservation selector',
                default:
                  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/reservation?search_token=${param.search_token}',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'opaque-param-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);
      expect(failures.some((f) => f.includes('long opaque recorded default'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not infer meaning from an opaque-looking query literal', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-opaque-url-token-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'opaque-url-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/details',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/details',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ ok: true }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'get_details',
            intent: { description: 'Get details' },
            parameters: [],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/details?search_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.cccccccccccccccccccccccccccccccc.dddddddddddddddddddddddddddddddd',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'opaque-url-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);
      expect(failures.some((f) => f.includes('long opaque literal query value'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('fails credential placeholders that are not in the credential contract', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-uncontracted-credential-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'credential-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search',
          headers: { 'x-api-key': 'public-app-key' },
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ items: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search',
                headers: { 'X-API-Key': '${credential.api_key}' },
              },
            ],
            site: 'credential-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        credentialNames: ['username', 'password'],
      });
      expect(failures.some((f) => f.includes('uncontracted credential'))).toBe(true);
      expect(failures.some((f) => f.includes('${credential.api_key}'))).toBe(true);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('allows credential placeholders named by the credential contract', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-contracted-credential-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'credential-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/login',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'content-type': 'application/json' },
          body: '{"username":"user"}',
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ ok: true }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'login',
            intent: { description: 'Log in' },
            parameters: [],
            requests: [
              {
                method: 'POST',
                url: 'https://example.com/api/login',
                headers: { 'Content-Type': 'application/json' },
                body: '{"username":"${credential.username}","password":"${credential.password}"}',
              },
            ],
            site: 'credential-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        credentialNames: ['username', 'password'],
      });
      expect(failures.some((f) => f.includes('uncontracted credential'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('leaves header parameter meaning to the agents', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-app-metadata-param-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'metadata-param-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=alpha',
          headers: { 'x-api-key': 'public-app-key' },
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ items: ['alpha'] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'query', type: 'string', description: 'Search query' },
              { name: 'x_api_key', type: 'string', description: 'Public app key' },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}',
                headers: { 'X-API-Key': '${param.x_api_key}' },
              },
            ],
            site: 'metadata-param-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);
      expect(failures.some((f) => f.includes('x_api_key'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not inspect parser assertions or deferred integration source shape', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-baseline-tautology-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');
    const session: Session = {
      site: 'baseline-tautology-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/trips',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/trips',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ items: [{ id: 'trip-1' }] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'list_trips',
            intent: { description: 'List trips' },
            parameters: [],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/trips',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'baseline-tautology-fixture',
            parserModule: './parser.ts',
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        `export function extract(data: { items?: Array<{ id: string }> }) {
  return { items: data.items ?? [] };
}
`,
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.test.ts'),
        `import { expect, test } from 'bun:test';

test('authored parser check', () => expect(true).toBe(true));
`,
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'integration.test.ts'),
        `import { expect, test } from 'bun:test';
import workflowJson from './workflow.json' with { type: 'json' };

test('live API call returns trips', () => {
  expect(workflowJson.toolName).toBe('list_trips');
  expect(workflowJson.site).toBe('baseline-tautology-fixture');
});
`,
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        deferLiveIntegrationToSemanticAgent: true,
      });
      expect(failures).toEqual([]);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('reports an executed integration failure without reclassifying it', async () => {
    const exampleDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-factual-live-failure-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');
    const session = SessionSchema.parse({
      site: 'factual-live-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/items',
      imprintVersion: '0.1.0',
      requests: [],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    });
    try {
      writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify({
          toolName: 'list_items',
          intent: { description: 'List items' },
          site: session.site,
          parameters: [],
          requests: [{ method: 'GET', url: 'https://example.com/api/items', headers: {} }],
          parserModule: './parser.ts',
        }),
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        'export function extract(raw: unknown) { return raw; }\n',
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'parser.test.ts'),
        "import { expect, test } from 'bun:test'; test('runs', () => expect(true).toBe(true));\n",
        'utf8',
      );
      writeFileSync(
        pathJoin(exampleDir, 'integration.test.ts'),
        "import { expect, test } from 'bun:test'; test('authored case', () => expect('actual').toBe('expected'));\n",
        'utf8',
      );

      const { failures, warnings } = await externalVerification(exampleDir, session, sessionPath);
      const liveFailure = failures.find((failure) =>
        failure.includes('bun test integration.test.ts exited'),
      );
      expect(liveFailure).toContain('actual');
      expect(warnings.some((warning) => /bot|infra|waiv/i.test(warning))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not let stale plan-shaped fields mutate or block an artifact', async () => {
    const exampleDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-plan-advisory-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');
    const session: Session = {
      site: 'plan-advisory-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const workflow = JSON.stringify(
      {
        toolName: 'search_items',
        intent: { description: 'Search items' },
        site: session.site,
        parameters: [],
        requests: [{ method: 'GET', url: 'https://example.com/search', headers: {} }],
      },
      null,
      2,
    );
    try {
      writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
      writeFileSync(pathJoin(exampleDir, 'workflow.json'), workflow, 'utf8');
      const stalePlanFields = {
        requiredInputs: [
          {
            location: 'header:X-Plan-Only',
            source: 'static',
            wiring: 'literal',
            literal: 'must-not-be-injected',
          },
        ],
        emittedTokens: [{ field: 'plan_only_output', shape: 'string' }],
        tokenParams: [
          { param: 'plan_only_input', sourceTool: 'producer', sourceField: 'plan_only_output' },
        ],
      } as unknown as NonNullable<Parameters<typeof externalVerification>[3]>;

      const result = await externalVerification(exampleDir, session, sessionPath, stalePlanFields);
      expect(readFileSync(pathJoin(exampleDir, 'workflow.json'), 'utf8')).toBe(workflow);
      expect(result.failures.join('\n')).not.toContain('plan_only_output');
      expect(result.failures.join('\n')).not.toContain('plan_only_input');
      expect(result.failures.join('\n')).not.toContain('X-Plan-Only');
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not classify public parameters by placeholder use', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-likelyparams-phantom-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'likelyparams-phantom-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'query', type: 'string', description: 'Search query' },
              { name: 'max_price', type: 'number', description: 'Max price' },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'likelyparams-phantom-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);

      expect(failures.some((f) => f.includes('max_price'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not emit detector-parameter diagnostics for a valid workflow', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-likelyparams-pass-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'likelyparams-pass-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'query', type: 'string', description: 'Search query' },
              { name: 'max_price', type: 'number', description: 'Max price' },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}&max=${param.max_price}',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'likelyparams-pass-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const { failures } = await externalVerification(exampleDir, session, sessionPath);

      expect(failures.some((f) => f.includes('detector parameter'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not classify query-parameter intent from recording shape', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-invented-qp-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'invented-qp-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/flights',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/search?f.sid=123&bl=build1',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          resourceType: 'Fetch',
          body: 'f.req=%5B1%2C2%2C3%5D',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ flights: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_flights',
            intent: { description: 'Search flights' },
            parameters: [
              { name: 'origin', type: 'string', description: 'Origin' },
              { name: 'airlines', type: 'string', description: 'Airline filter' },
            ],
            requests: [
              {
                method: 'POST',
                url: 'https://example.com/api/search?f.sid=123&bl=build1&_imp_airlines=${param.airlines}',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'f.req=%5B${param.origin}%2C2%2C3%5D',
              },
            ],
            site: 'invented-qp-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const parserCode = 'export function extract(raw) { return { flights: [] }; }';
      writeFileSync(pathJoin(exampleDir, 'parser.ts'), parserCode, 'utf8');

      const { failures, warnings } = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [1],
      });

      expect(failures.some((f) => f.includes('origin'))).toBe(false);
      expect(warnings.some((w) => w.includes('airlines'))).toBe(false);
      expect(warnings.some((w) => w.includes('invented'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not warn when params are in body or original query params', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-legit-qp-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'legit-qp-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test&sort=price',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'query', type: 'string', description: 'Search query' },
              { name: 'sort', type: 'string', description: 'Sort order' },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}&sort=${param.sort}',
                headers: { Accept: 'application/json' },
              },
            ],
            site: 'legit-qp-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );

      const parserCode = 'export function extract(raw) { return { results: [] }; }';
      writeFileSync(pathJoin(exampleDir, 'parser.ts'), parserCode, 'utf8');

      const { failures, warnings } = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [1],
      });

      expect(failures.some((f) => f.includes('query'))).toBe(false);
      expect(failures.some((f) => f.includes('sort'))).toBe(false);
      expect(warnings.some((w) => w.includes('invented'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not classify parameter coverage from test names or comments', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-coverage-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    const session: Session = {
      site: 'coverage-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=test&sort=price',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ results: [] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'search_items',
            intent: { description: 'Search items' },
            parameters: [
              { name: 'query', type: 'string', description: 'Query' },
              { name: 'sort', type: 'string', description: 'Sort key' },
              { name: 'max_price', type: 'number', description: 'Max price' },
              { name: 'discount_code', type: 'string', description: 'Discount' },
            ],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/api/search?q=${param.query}&sort=${param.sort}&max=${param.max_price}&disc=${param.discount_code}',
                headers: {},
              },
            ],
            site: 'coverage-fixture',
            parserModule: './parser.ts',
          },
          null,
          2,
        ),
        'utf8',
      );

      // The semantic reviewer, not a runtime source scan, decides whether these
      // cases prove the parameters work.
      writeFileSync(
        pathJoin(exampleDir, 'integration.test.ts'),
        `import { expect, test } from 'bun:test';

test('baseline', async () => {
  const params = { query: 'baseline', sort: 'price' };
  // This authored case intentionally says nothing about the other parameters.
  expect(params).toBeDefined();
});

test('override query', async () => {
  const params = { query: 'apple', sort: 'price' };
  expect(params).toBeDefined();
});
`,
        'utf8',
      );

      const parserCode =
        'export function extract(_raw: unknown) { return { items: [] as unknown[] }; }';
      writeFileSync(pathJoin(exampleDir, 'parser.ts'), parserCode, 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'parser.test.ts'),
        `import { expect, test } from 'bun:test';
import { extract } from './parser.ts';

test('authored parser check', () => expect(extract({}).items).toEqual([]));
`,
        'utf8',
      );

      const { failures, paramVerification } = await externalVerification(
        exampleDir,
        session,
        sessionPath,
        {
          deferLiveIntegrationToSemanticAgent: true,
        },
      );

      expect(failures).toEqual([]);
      expect(paramVerification).toEqual([]);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('Fix A: rejects a response_header capture when the recorded response has no such header', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-fixA-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    // The recording's /bootstrap response embeds the token in HTML body but
    // does NOT return it as a response header. A workflow that declares
    // response_header: 'X-Csrf-Token' will fail at runtime; the verifier
    // must reject done() at compile.
    const session: Session = {
      site: 'fixA-fixture',
      startedAt: '2026-06-01T00:00:00.000Z',
      url: 'https://example.com/bootstrap',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 10,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/bootstrap',
          headers: {},
          resourceType: 'Document',
          response: {
            status: 200,
            headers: { 'content-type': 'text/html' },
            mimeType: 'text/html',
            body: '<html><script>var token="abc123";</script></html>',
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'fix_a_tool',
            intent: { description: 'fixture' },
            parameters: [],
            requests: [
              {
                method: 'GET',
                url: 'https://example.com/bootstrap',
                headers: {},
                captures: [
                  {
                    source: 'response_header',
                    name: 'csrf_token',
                    header: 'X-Csrf-Token',
                    required: true,
                  },
                ],
              },
            ],
            site: 'fixA-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );
      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [10],
      });
      const captureFailure = failures.find(
        (f) => f.includes('csrf_token') && f.includes('response_header'),
      );
      expect(captureFailure).toBeDefined();
      expect(captureFailure ?? '').toContain('no "X-Csrf-Token" header');
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('does not classify varying body fields as user parameters', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-fixB-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    // Variation is factual evidence for an agent to inspect; it is not enough
    // for the host to decide that either field must be a public parameter.
    const session: Session = {
      site: 'fixB-fixture',
      startedAt: '2026-06-01T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 100,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/search.act',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'pickupDate=06/01/2026&pickupCity=Santa Clara-CA&country=US&fromHomePage=true',
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: 'ok' },
        },
        {
          seq: 200,
          timestamp: 200,
          method: 'POST',
          url: 'https://example.com/search.act',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'pickupDate=07/15/2026&pickupCity=Reno-NV&country=US&fromHomePage=true',
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: 'ok' },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };

    try {
      writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
      // Frozen-body case
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'fix_b_tool',
            intent: { description: 'fixture' },
            parameters: [{ name: 'car_token', type: 'string', description: 'unused' }],
            requests: [
              {
                method: 'POST',
                url: 'https://example.com/search.act',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'pickupDate=06/01/2026&pickupCity=Santa Clara-CA&country=US&fromHomePage=true',
              },
            ],
            site: 'fixB-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );
      const frozen = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [100, 200],
        deferLiveIntegrationToSemanticAgent: true,
      });
      const frozenFailure = frozen.failures.find((f) => f.includes('frozen to one recorded'));
      expect(frozenFailure).toBeUndefined();

      // Inverse: templated body → no Fix B failure
      writeFileSync(
        pathJoin(exampleDir, 'workflow.json'),
        JSON.stringify(
          {
            toolName: 'fix_b_tool',
            intent: { description: 'fixture' },
            parameters: [
              { name: 'pickup_date', type: 'string', description: '' },
              { name: 'pickup_city', type: 'string', description: '' },
            ],
            requests: [
              {
                method: 'POST',
                url: 'https://example.com/search.act',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'pickupDate=${param.pickup_date}&pickupCity=${param.pickup_city}&country=US&fromHomePage=true',
              },
            ],
            site: 'fixB-fixture',
          },
          null,
          2,
        ),
        'utf8',
      );
      const templated = await externalVerification(exampleDir, session, sessionPath, {
        candidateRequestSeqs: [100, 200],
        deferLiveIntegrationToSemanticAgent: true,
      });
      expect(templated.failures.some((f) => f.includes('frozen to one recorded'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });
});

describe('parseJUnitResults', () => {
  it('separates passed (self-closed) from failed (with <failure>) testcases', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="s">
    <testcase name="param:query=apple constrains results" classname="s" />
    <testcase name="baseline &gt; ok" classname="s"></testcase>
    <testcase name="param:sort fails" classname="s">
      <failure message="expected true">at line 5</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const { passed, failed } = parseJUnitResults(xml);
    expect(passed.has('param:query=apple constrains results')).toBe(true);
    expect(passed.has('baseline > ok')).toBe(true); // XML entity unescaped
    expect(failed.has('param:sort fails')).toBe(true);
    expect(passed.has('param:sort fails')).toBe(false);
  });

  it('returns empty sets for empty/missing input', () => {
    const { passed, failed } = parseJUnitResults('');
    expect(passed.size).toBe(0);
    expect(failed.size).toBe(0);
  });
});

describe('bounded read_session_summary', () => {
  it('does not decode or serialize a 240k deeply nested form body', async () => {
    const nested = `${'['.repeat(120_000)}${']'.repeat(120_000)}`;
    const narrationText = `intent-${'🧪'.repeat(50_000)}`;
    const session = SessionSchema.parse({
      site: `fixture-${'s'.repeat(50_000)}`,
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/api?private=omitted',
      imprintVersion: '0.1.0',
      requests: Array.from({ length: 10_001 }, (_, index) => ({
        seq: index + 1,
        timestamp: index,
        method: 'CUSTOMMETHOD',
        url: `https://${'a'.repeat(63)}.${'b'.repeat(25)}.com/${'p'.repeat(160)}-${index + 1}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        resourceType: 'Fetch',
        ...(index === 0 ? { body: `payload=${nested}` } : {}),
        response: { status: 200, headers: {}, mimeType: 'm'.repeat(64), body: '{}' },
      })),
      events: Array.from({ length: 20_000 }, (_, index) => ({
        seq: index + 1,
        timestamp: index,
        type: 'click' as const,
        detail: 'SITE-DIRECTIVE-MUST-NOT-APPEAR',
      })),
      narration: Array.from({ length: 1_000 }, (_, index) => ({
        seq: index + 1,
        timestamp: index,
        text: narrationText,
      })),
      cookieSnapshots: [],
      storageSnapshots: [],
    });
    const manySeqs = Array.from({ length: 50_000 }, (_, index) => index + 1);
    const paramDescription = `description-${'🔎'.repeat(10_000)}`;
    const candidate = ToolCandidateSchema.parse({
      toolName: `test_${'t'.repeat(59)}`,
      description: `test-${'💡'.repeat(50_000)}`,
      rationale: `reason-${'🧠'.repeat(50_000)}`,
      confidence: 0.9,
      requestSeqs: manySeqs,
      representativeSeqs: [1],
      eventSeqs: manySeqs,
      expectedOutput: `output-${'📦'.repeat(50_000)}`,
      likelyParams: Array.from({ length: 1_000 }, (_, index) => ({
        name: `param_${index}_${'k'.repeat(48)}`,
        type: 'string' as const,
        description: paramDescription,
      })),
      dependencySeqs: manySeqs,
      dependsOnTools: [],
    });
    const revisionRoot = mkdtempSync(pathJoin(tmpdir(), 'imprint-summary-fallback-'));
    mkdirSync(pathJoin(revisionRoot, 'notes'));
    writeFileSync(pathJoin(revisionRoot, 'workflow.json'), '{}');
    for (let index = 0; index < 16; index++)
      writeFileSync(
        pathJoin(revisionRoot, 'notes', `note-${index}-${'q'.repeat(220)}.md`),
        'revision note',
      );
    const summaryTool = buildCompileTools(session, revisionRoot, '/tmp/session.json', {
      candidate,
      revisionMode: true,
      sharedContext: {
        loginRequestSeqs: manySeqs,
        authRequestSeqs: manySeqs,
        credentialNames: Array.from(
          { length: 1_000 },
          (_, index) => `credential_${index}_${'c'.repeat(48)}`,
        ),
        tokenExtractionNotes: `token-${'🔐'.repeat(50_000)}`,
        sharedHelperNotes: `helper-${'🧩'.repeat(50_000)}`,
        authNotes: `auth-${'💭'.repeat(50_000)}`,
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!summaryTool) throw new Error('read_session_summary tool missing');

    const result = (await summaryTool.handler({})).result;
    const summary = JSON.parse(result);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(30_000);
    expect(summary.summaryEmergencyFallback || summary.summaryHardFallback).toBe(true);
    expect(summary).toMatchObject({
      summaryBounded: true,
      requestIndex: { scanned: 10_000, cap: 10_000, truncated: true },
      selectedCandidate: {
        toolName: `test_${'t'.repeat(59)}`,
        representativeSeqs: [1],
      },
      revisionContext: {
        mode: 'revise_existing_artifact',
        existingArtifacts: { entries: [{ path: 'workflow.json' }] },
        feedbackNotes: { entries: expect.any(Array) },
      },
    });
    expect(
      summary.loadBearingRequests.find((request: { seq: number }) => request.seq === 1),
    ).toMatchObject({ seq: 1, requestBodyCharacters: 240_008 });
    expect(summary.omissions.candidate.entries).toMatchObject({ exact: true });
    expect(summary.omissions.narration.entries).toMatchObject({
      atLeast: 994,
      exact: true,
    });
    expect(summary.omissions.loadBearingRequests.characters).toMatchObject({
      exact: false,
    });
    expect(summary.omissions.loadBearingRequests.characters.atLeast).toBeGreaterThanOrEqual(1);
    expect(result).not.toContain(nested.slice(0, 100));
    expect(result).not.toContain('SITE-DIRECTIVE-MUST-NOT-APPEAR');
    expect(result).not.toContain('requestBodyDecoded');
    rmSync(revisionRoot, { recursive: true, force: true });
  });
});

describe('inspect_body_structure compile tool', () => {
  it('uses only the redacted in-memory session and preserves encoding facts', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-body-structure-'));
    const sessionPath = pathJoin(dir, 'raw-session.json');
    const redactedValue = '[REDACTED]';
    const framedGapSecret = 'framed-host-secret-redaction-missed';
    const nestedGapSecret = 'nested-form-secret-redaction-missed';
    const outsideOne = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `outside-${index}`,
        JSON.stringify({ value: `one-${index}` }),
      ]),
    );
    const outsideTwo = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `outside-${index}`,
        JSON.stringify({ value: `two-${index}` }),
      ]),
    );
    const framedRedactedPayload = JSON.stringify({
      payload: JSON.stringify({ secret: framedGapSecret }),
    });
    const framedRedactedResponse = JSON.stringify({ issued: framedGapSecret });
    const requestOne = {
      seq: 1,
      timestamp: 1,
      method: 'POST',
      url: 'https://example.test/api',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      resourceType: 'Fetch' as const,
      body: `payload=${encodeURIComponent(JSON.stringify({ secret: redactedValue }))}`,
      response: {
        status: 200,
        headers: {},
        mimeType: 'application/json',
        body: JSON.stringify({ echoed: redactedValue }),
      },
    };
    const redactedSession: Session = {
      site: 'fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.test/',
      imprintVersion: '0.1.0',
      requests: [
        {
          ...requestOne,
          seq: 0,
          response: {
            ...requestOne.response,
            body: `${new TextEncoder().encode(framedRedactedResponse).length}\n${framedRedactedResponse}`,
          },
        },
        requestOne,
        {
          ...requestOne,
          seq: 2,
          body: JSON.stringify({ payload: { secret: redactedValue } }),
        },
        {
          ...requestOne,
          seq: 3,
          body: JSON.stringify({
            target: JSON.stringify({ same: redactedValue }),
            ...outsideOne,
          }),
        },
        {
          ...requestOne,
          seq: 4,
          body: JSON.stringify({
            target: JSON.stringify({ same: redactedValue }),
            ...outsideTwo,
          }),
        },
        {
          ...requestOne,
          seq: 5,
          body: `${new TextEncoder().encode(framedRedactedPayload).length}\n${framedRedactedPayload}`,
        },
        {
          ...requestOne,
          seq: 6,
          body: `payload=${encodeURIComponent(
            JSON.stringify({ inner: JSON.stringify({ secret: nestedGapSecret }) }),
          )}`,
        },
      ],
      events: [
        {
          seq: 2,
          type: 'click',
          timestamp: 2,
          detail: JSON.stringify({ text: 'recorded selection' }),
        },
      ],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const hostRedactedSession = redactSession(redactedSession).session;
    expect(hostRedactedSession.requests.find((request) => request.seq === 5)?.body).toContain(
      framedGapSecret,
    );
    expect(hostRedactedSession.requests.find((request) => request.seq === 6)?.body).toContain(
      nestedGapSecret,
    );
    const rawSecret = 'raw-secret-must-not-appear';
    const framedRawPayload = JSON.stringify({ payload: JSON.stringify({ secret: rawSecret }) });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        ...redactedSession,
        requests: [
          {
            ...requestOne,
            body: `payload=${encodeURIComponent(JSON.stringify({ secret: rawSecret }))}`,
          },
          {
            ...requestOne,
            seq: 5,
            body: `${new TextEncoder().encode(framedRawPayload).length}\n${framedRawPayload}`,
          },
        ],
      }),
    );

    try {
      const inspect = buildCompileTools(hostRedactedSession, dir, sessionPath).find(
        (tool) => tool.name === 'inspect_body_structure',
      );
      expect(inspect?.description).toContain('redacted request or response body');
      expect(inspect?.input_schema.properties).not.toHaveProperty('pathRefs');
      expect(inspect?.input_schema.properties).not.toHaveProperty('matchPathRef');

      const opaque = await inspect?.handler({ seq: 3, side: 'request' });
      expect(opaque?.result).not.toContain('outside-0');
      expect(opaque?.result).not.toContain('/target');
      expect(JSON.parse(opaque?.result ?? '{}').jsonStringBoundaries[0]).toEqual({
        depth: 1,
      });

      const hidden = await inspect?.handler({
        seq: 1,
        side: 'request',
        pointer: '/payload/secret',
      });
      expect(hidden?.result).not.toContain(rawSecret);
      expect(hidden?.result).not.toContain(redactedValue);
      expect(JSON.parse(hidden?.result ?? '{}').pointer).toMatchObject({
        path: '/payload/secret',
        type: 'string',
      });
      const objectValue = await inspect?.handler({
        seq: 2,
        side: 'request',
        pointer: '/payload',
      });
      const objectFact = JSON.parse(objectValue?.result ?? '{}').pointer;
      expect(objectFact).toMatchObject({ type: 'object' });
      expect(objectFact).not.toHaveProperty('value');
      expect(objectValue?.result).not.toContain(redactedValue);
      const hostilePointer = `/${'hostile-key'.repeat(100)}`;
      const rejectedPointer = await inspect?.handler({
        seq: 1,
        side: 'request',
        pointer: hostilePointer,
      });
      expect(rejectedPointer?.result).not.toContain('hostile-key');

      const shown = await inspect?.handler({
        seq: 1,
        side: 'request',
        format: 'form-urlencoded',
        pointer: '/payload/secret',
        compareToSeq: 2,
        compareFormat: 'json',
      });
      const shownResult = JSON.parse(shown?.result ?? '{}');
      expect(shownResult.format).toBe('form-urlencoded');
      expect(shownResult.compareToFormat).toBe('json');
      expect(shownResult.pointer.value).toBeUndefined();
      expect(shownResult.comparison.differences).toContainEqual(
        expect.objectContaining({
          kind: 'encoding',
          leftEncoding: 'json-string',
          rightEncoding: 'native',
        }),
      );
      expect(shown?.result).not.toContain(rawSecret);

      const framed = await inspect?.handler({
        seq: 5,
        side: 'request',
        format: 'decimal-framed-json',
        pointer: '/0/payload/secret',
      });
      const framedText = framed?.result ?? '';
      expect(framedText).not.toContain(rawSecret);
      expect(framedText).not.toContain(framedGapSecret);
      expect(framedText).not.toContain(redactedValue);
      expect(framedText.toLowerCase()).not.toContain('byte');
      const nestedGap = await inspect?.handler({
        seq: 6,
        side: 'request',
        pointer: '/payload/inner/secret',
      });
      expect(nestedGap?.result).not.toContain(nestedGapSecret);
      expect((nestedGap?.result ?? '').toLowerCase()).not.toContain('byte');
      expect(JSON.parse(nestedGap?.result ?? '{}').pointer).not.toHaveProperty('value');

      const framedMatches = await inspect?.handler({
        seq: 5,
        side: 'request',
        format: 'decimal-framed-json',
        pointer: '/0/payload/secret',
        findEarlierMatches: true,
        earlierResponseFormat: 'decimal-framed-json',
      });
      const framedEquality = JSON.parse(framedMatches?.result ?? '{}').earlierResponseEqualities;
      expect(framedEquality).toMatchObject({
        responseFormat: 'decimal-framed-json',
        reasonCode: 'matches_found',
        work: { responsesDecoded: 1, responsesSkipped: 4 },
        facts: [{ responseSeq: 0 }],
      });
      expect(framedMatches?.result).not.toContain(framedGapSecret);

      const fullComparison = await inspect?.handler({
        seq: 1,
        side: 'request',
        compareToSeq: 2,
      });
      const fullResult = JSON.parse(fullComparison?.result ?? '{}');
      expect(fullResult.wireByteLength).toBeUndefined();
      expect(fullResult.comparison.wireEvidence).toBe('unavailable_from_redacted_evidence');
      const encoding = fullResult.comparison.differences.find(
        (difference: { kind: string }) => difference.kind === 'encoding',
      );
      expect(encoding.path).toBeUndefined();
      const resolvedComparison = await inspect?.handler({
        seq: 1,
        side: 'request',
        compareToSeq: 2,
        includePaths: true,
      });
      expect(
        JSON.parse(resolvedComparison?.result ?? '{}').comparison.differences.find(
          (difference: { kind: string }) => difference.kind === 'encoding',
        ).path,
      ).toBe('/payload');

      const narrow = await inspect?.handler({
        seq: 3,
        side: 'request',
        pointer: '/target',
        compareToSeq: 4,
      });
      const narrowResult = JSON.parse(narrow?.result ?? '{}');
      expect(narrow?.isError).not.toBe(true);
      expect(narrowResult.jsonStringBoundaries).toEqual([{ depth: 0 }]);
      expect(narrowResult.jsonStringBoundariesTruncated).toBeUndefined();
      expect(narrowResult.comparisonPathBase).toBe('/target');
      expect(narrowResult.comparison).toMatchObject({ differences: [] });
      expect(narrowResult.comparison.wireEvidence).toBe('unavailable_from_redacted_evidence');
      expect(narrowResult.comparison.truncated).toBeUndefined();
      expect((narrow?.result ?? '').length).toBeLessThan(16 * 1024);

      const global = await inspect?.handler({ seq: 3, side: 'request' });
      const globalResult = JSON.parse(global?.result ?? '{}');
      expect(globalResult.jsonStringBoundaries).toHaveLength(8);
      expect(globalResult.jsonStringBoundariesTruncated).toBe(true);

      const exactMatches = await inspect?.handler({
        seq: 2,
        side: 'request',
        pointer: '/payload/secret',
        findEarlierMatches: true,
      });
      const exactResult = JSON.parse(exactMatches?.result ?? '{}').earlierResponseEqualities;
      expect(exactResult.facts[0]).toMatchObject({
        responseSeq: 1,
      });
      expect(exactResult.facts[0].responsePath).toBeUndefined();
      expect(exactResult.equalityScope).toBe('supplied_host_redaction_representation_only');
      expect(JSON.stringify(exactResult.facts[0]).toLowerCase()).not.toContain('byte');
      expect(exactMatches?.result).not.toContain(rawSecret);
      const exactPaths = await inspect?.handler({
        seq: 2,
        side: 'request',
        pointer: '/payload/secret',
        findEarlierMatches: true,
        includePaths: true,
      });
      expect(
        JSON.parse(exactPaths?.result ?? '{}').earlierResponseEqualities.facts[0],
      ).toMatchObject({ responsePath: '/echoed', responseSeq: 1 });

      const diffEvent = buildCompileTools(hostRedactedSession, dir, sessionPath).find(
        (tool) => tool.name === 'diff_request_for_event',
      );
      const unselected = JSON.parse((await diffEvent?.handler({ eventSeq: 2 }))?.result ?? '{}');
      expect(unselected).toMatchObject({
        state: 'not_checked',
        reasonCode: 'agent_pair_required',
        association: { mode: 'unselected' },
        limits: { alternativesPerSide: 4 },
      });
      expect(unselected.alternatives.before.length).toBeGreaterThan(0);
      expect(unselected.alternatives.after.length).toBeGreaterThan(0);
      expect(unselected).not.toHaveProperty('triggeredSeq');
      expect(unselected).not.toHaveProperty('priorSeq');
      const compared = JSON.parse(
        (
          await diffEvent?.handler({
            eventSeq: 2,
            beforeSeq: 1,
            afterSeq: 3,
            beforeFormat: 'form-urlencoded',
            afterFormat: 'json',
          })
        )?.result ?? '{}',
      );
      expect(compared).toMatchObject({
        state: 'compared',
        selectedPair: { beforeSeq: 1, afterSeq: 3 },
      });
      const incomplete = await diffEvent?.handler({ eventSeq: 2, beforeSeq: 1 });
      expect(incomplete?.isError).toBe(true);
      expect(JSON.parse(incomplete?.result ?? '{}')).toMatchObject({
        state: 'invalid',
        reasonCode: 'request_pair_incomplete',
      });
      for (const eventSeq of [999, 1.5]) {
        const rejected = await diffEvent?.handler({ eventSeq });
        expect(rejected?.isError).toBe(true);
        expect(JSON.parse(rejected?.result ?? '{}').reasonCode).toBe(
          eventSeq === 999 ? 'event_not_found' : 'invalid_event_seq',
        );
      }

      const summaryTool = buildCompileTools(hostRedactedSession, dir, sessionPath, {
        candidate: {
          toolName: 'inspect_fixture',
          description: 'Inspect fixture',
          rationale: 'test',
          confidence: 1,
          requestSeqs: [2],
          representativeSeqs: [2],
          eventSeqs: [2],
          expectedOutput: 'fixture',
          likelyParams: [],
          dependencySeqs: [],
          dependsOnTools: [],
        },
      }).find((tool) => tool.name === 'read_session_summary');
      const summary = JSON.parse((await summaryTool?.handler({}))?.result ?? '{}');
      expect(summary.exactMatchHints).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('/payload/secret');
      expect(summary.selectedCandidate.eventSeqs).toEqual([2]);
      expect(summary.paramGroundingHints).toBeUndefined();
      expect(summary.paramGroundingWork).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('recorded selection');

      const response = await inspect?.handler({
        seq: 1,
        side: 'response',
        pointer: '/echoed',
      });
      expect(JSON.parse(response?.result ?? '{}').pointer.type).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses pointer-local nested decoding and rejects every unknown format field', async () => {
    const hostile = JSON.stringify(Array.from({ length: 1_100 }, (_, index) => index));
    const body = JSON.stringify({
      a: hostile,
      b: hostile,
      c: hostile,
      d: hostile,
      target: '{"value":1}',
    });
    const request = {
      seq: 1,
      timestamp: 1,
      method: 'POST',
      url: 'https://example.test/api',
      headers: {},
      resourceType: 'Fetch' as const,
      body,
      response: { status: 200, headers: {}, mimeType: 'application/json', body: '{}' },
    };
    const session: Session = {
      site: 'fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.test/',
      imprintVersion: '0.1.0',
      requests: [request, { ...request, seq: 2 }],
      events: [{ seq: 5, timestamp: 5, type: 'click', detail: 'host-controlled label' }],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const tools = buildCompileTools(session, '/tmp/body-format-test', '/tmp/session.json');
    const inspect = tools.find((tool) => tool.name === 'inspect_body_structure');
    const exact = await inspect?.handler({
      seq: 1,
      side: 'request',
      pointer: '/target/value',
    });
    expect(JSON.parse(exact?.result ?? '{}')).toMatchObject({
      nestedJsonExpansion: {
        totalLimitReached: true,
        candidateNotChecked: 1,
        candidateNotCheckedState: 'candidate_not_checked',
      },
      pointer: { type: 'number', encoding: 'json-string' },
    });

    for (const [field, expected] of [
      ['format', 'unsupported body format'],
      ['compareFormat', 'unsupported comparison body format'],
      ['earlierResponseFormat', 'unsupported earlier response body format'],
    ] as const) {
      const result = await inspect?.handler({ seq: 1, side: 'request', [field]: 'unknown' });
      expect(result).toMatchObject({ isError: true, result: expected });
    }

    const diff = tools.find((tool) => tool.name === 'diff_request_for_event');
    for (const [field, reasonCode] of [
      ['beforeFormat', 'invalid_before_format'],
      ['afterFormat', 'invalid_after_format'],
    ] as const) {
      const result = await diff?.handler({ eventSeq: 5, [field]: 'unknown' });
      expect(result?.isError).toBe(true);
      expect(JSON.parse(result?.result ?? '{}')).toMatchObject({ state: 'invalid', reasonCode });
    }
  });
});

describe('externalVerification — advisory shared-module proposals', () => {
  function fixtureSession(site: string): Session {
    return {
      site,
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/search',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/search?q=alpha',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            mimeType: 'application/json',
            body: JSON.stringify({ items: ['alpha'] }),
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
  }

  function setupDir(
    prefix: string,
    site: string,
    workflow: Record<string, unknown>,
  ): {
    dir: string;
    sessionPath: string;
    session: Session;
  } {
    const scratchRoot = pathJoin(import.meta.dir, '..', '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const dir = mkdtempSync(pathJoin(scratchRoot, prefix));
    const session = fixtureSession(site);
    const sessionPath = pathJoin(dir, 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
    writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8');
    return { dir, sessionPath, session };
  }

  // Guard against reintroducing a host import policy while allowing unrelated
  // mechanical failures to mention a module path.
  function hasImportAssertion(failures: string[], modulePath: string): boolean {
    return failures.some(
      (f) => f.includes('requires shared module import') && f.includes(modulePath),
    );
  }

  it('does not enforce an unaccepted request-transform proposal', async () => {
    const { dir, sessionPath, session } = setupDir('share-rt-missing-', 'rt-missing', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'rt-missing',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath);
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not impose a policy when a workflow chooses a shared transform', async () => {
    const { dir, sessionPath, session } = setupDir('share-rt-ok-', 'rt-ok', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'rt-ok',
      requestTransformModule: '../_shared/sign.ts',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath);
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not impose a policy when a parser chooses a shared helper', async () => {
    const { dir, sessionPath, session } = setupDir('share-ph-ok-', 'ph-ok', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'ph-ok',
      parserModule: './parser.ts',
    });
    try {
      writeFileSync(
        pathJoin(dir, 'parser.ts'),
        `import { decode } from '../_shared/decode.ts';\nexport function extract(d: unknown) { return decode(d); }\n`,
        'utf8',
      );
      const { failures } = await externalVerification(dir, session, sessionPath);
      expect(hasImportAssertion(failures, '_shared/decode.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not impose an import policy for an unavailable proposal', async () => {
    const { dir, sessionPath, session } = setupDir('share-unverified-', 'unverified', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'unverified',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath);
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('crossReferenceReferencedStateCaptures (Fix 2)', () => {
  // The recorded landing page embeds csrf the way costco actually does, plus a
  // csp-nonce. The bootstrap page (/Rental-Cars) is intentionally ABSENT from
  // the recording — only "/" carries the tokens — to mirror the real case.
  const PAGE_HTML =
    '<html><head><script nonce="aabbccddeeff00112233445566778899"></script>' +
    'mUtil.createSecureCookie("Csrf-token", "ef8ae77dfa9d8ae29c20673743826a43ef8ae77dfa9d8ae29c20673743826a43ef8ae77dfa9d8ae29c20673743826a43ef8ae77d");' +
    '</head><body>ok</body></html>';

  function sessionWithLandingPage(): Session {
    return {
      site: 'costco-car-rental',
      startedAt: '2026-06-02T00:00:00.000Z',
      url: 'https://www.costcotravel.com/',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 0,
          timestamp: 10,
          method: 'GET',
          url: 'https://www.costcotravel.com/',
          headers: {},
          resourceType: 'Document',
          response: {
            status: 200,
            headers: { 'content-type': 'text/html;charset=UTF-8' },
            mimeType: 'text/html;charset=UTF-8',
            body: PAGE_HTML,
          },
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
  }

  function workflowWithCsrf(csrfPattern: string) {
    return WorkflowSchema.parse({
      toolName: 'search_rental_cars',
      intent: { description: 'search rental cars' },
      parameters: [],
      site: 'costco-car-rental',
      bootstrap: {
        url: 'https://www.costcotravel.com/Rental-Cars',
        captures: [
          {
            source: 'html_regex',
            name: 'csp_nonce',
            pattern: 'nonce="([0-9a-f]{32})"',
            required: false,
          },
          { source: 'html_regex', name: 'csrf_token', pattern: csrfPattern, required: false },
        ],
      },
      requests: [
        {
          method: 'POST',
          url: 'https://www.costcotravel.com/rentalCarSearch.act',
          headers: {
            'X-Csrf-Token': '${state.csrf_token}',
            'X-Csp-Nonce': '${state.csp_nonce}',
          },
          body: 'pickupCity=SJC',
        },
      ],
    });
  }

  it('REJECTS a csrf html_regex that does not match the recorded page (the actual costco bug)', () => {
    // The agent's shipped pattern: the ", " separator after "Csrf-token" defeats it.
    const badPattern = '[Cc]srf[^"\']{0,24}[\'"]([0-9a-f]{48,})[\'"]';
    const { failures, failedCaptureNames } = crossReferenceReferencedStateCaptures(
      workflowWithCsrf(badPattern),
      sessionWithLandingPage(),
    );
    expect(failedCaptureNames.has('csrf_token')).toBe(true);
    expect(failures.join('\n')).toContain('csrf_token');
    expect(failures.join('\n')).toContain('STATE_MISSING');
    // csp_nonce DOES match → must NOT be flagged.
    expect(failedCaptureNames.has('csp_nonce')).toBe(false);
  });

  it('PASSES when the csrf pattern matches the recorded createSecureCookie form', () => {
    const goodPattern = 'createSecureCookie\\("Csrf-token",\\s*"([0-9a-f]{48,})"';
    const { failures, failedCaptureNames } = crossReferenceReferencedStateCaptures(
      workflowWithCsrf(goodPattern),
      sessionWithLandingPage(),
    );
    expect(failures).toHaveLength(0);
    expect(failedCaptureNames.size).toBe(0);
  });

  it('rejection holds even though required:false (a request hard-references the value)', () => {
    // Guard: the capture is required:false; Fix A would skip it. Fix 2 must not.
    const badPattern = 'NOPE_NO_MATCH_([0-9a-f]{99})';
    const { failedCaptureNames } = crossReferenceReferencedStateCaptures(
      workflowWithCsrf(badPattern),
      sessionWithLandingPage(),
    );
    expect(failedCaptureNames.has('csrf_token')).toBe(true);
  });

  it('flags an invalid regex pattern referenced by a request', () => {
    const { failures } = crossReferenceReferencedStateCaptures(
      workflowWithCsrf('([unclosed'),
      sessionWithLandingPage(),
    );
    expect(failures.join('\n')).toContain('invalid regex');
  });

  it('rejects a referenced state placeholder with no declared capture', () => {
    const wf = WorkflowSchema.parse({
      toolName: 't',
      intent: { description: 'd' },
      parameters: [],
      site: 'costco-car-rental',
      requests: [
        {
          method: 'GET',
          url: 'https://www.costcotravel.com/api',
          headers: { 'X-Api-Key': '${state.api_key}' },
        },
      ],
    });
    const { failures, failedCaptureNames } = crossReferenceReferencedStateCaptures(
      wf,
      sessionWithLandingPage(),
    );
    expect(failedCaptureNames.has('api_key')).toBe(true);
    expect(failures.join('\n')).toContain('declares no capture named "api_key"');
    expect(failures.join('\n')).toContain('STATE_MISSING');
  });

  it('does not flag when no request references the capture (${state.X} unused)', () => {
    const wf = WorkflowSchema.parse({
      toolName: 't',
      intent: { description: 'd' },
      parameters: [],
      site: 'costco-car-rental',
      bootstrap: {
        url: 'https://www.costcotravel.com/Rental-Cars',
        captures: [
          { source: 'html_regex', name: 'csrf_token', pattern: 'NOPE([0-9]+)', required: false },
        ],
      },
      requests: [
        { method: 'GET', url: 'https://www.costcotravel.com/x', headers: {} }, // no ${state.csrf_token}
      ],
    });
    const { failures } = crossReferenceReferencedStateCaptures(wf, sessionWithLandingPage());
    expect(failures).toHaveLength(0);
  });
});

// ─── Emit-time secret guard ─────────────────────────────────────────────────
// ─── Emit-time secret guard + contracted-input injection/gate (Threads B/C) ───
