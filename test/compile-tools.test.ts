import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type { RequiredInput } from '../src/imprint/build-plan.ts';
import {
  assertNoRawSecrets,
  buildCompileTools,
  classifyIntegrationOutcome,
  classifyParamCoverage,
  contractedInputGate,
  crossReferenceReferencedStateCaptures,
  detectTokenSources,
  externalVerification,
  extractTestBlocks,
  injectContractedInputs,
  isBotDefenseFailure,
  parseJUnitResults,
  typecheckArtifacts,
} from '../src/imprint/compile-tools.ts';
import { type Session, WorkflowSchema } from '../src/imprint/types.ts';

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

describe('compile tools state hints', () => {
  it('surfaces redacted equality between an earlier Set-Cookie and a later request header', async () => {
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
    const summary = JSON.parse(result.result) as { stateHints: Array<Record<string, unknown>> };

    expect(summary.stateHints).toContainEqual({
      type: 'request_field_equals_earlier_set_cookie',
      producerSeq: 1,
      consumerSeq: 2,
      cookie: 'XSRF-TOKEN',
      requestField: 'header:x-csrf-token',
    });
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
        primary: true,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'items',
        likelyParams: [],
        dependencySeqs: [],
      },
      sharedContext: {
        loginRequestSeqs: [4],
        credentialNames: [],
        tokenExtractionNotes: '',
        sharedHelperNotes: '',
        twoFactorDetected: false,
        twoFactorType: 'none' as const,
        twoFactorRequestSeqs: [],
        authCompletionSeqs: [],
        twoFactorContext: [],
        twoFactorNotes: '',
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
        primary: true,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'items',
        likelyParams: [],
        dependencySeqs: [1],
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
});

describe('compile tools representativeSeqs', () => {
  it('uses representativeSeqs for inline data when provided', async () => {
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
        primary: true,
        requestSeqs: [10, 11, 12, 13, 14],
        representativeSeqs: [10],
        eventSeqs: [],
        expectedOutput: 'suggestions',
        likelyParams: [],
        dependencySeqs: [1],
      },
    }).find((tool) => tool.name === 'read_session_summary');
    if (!readSummary) throw new Error('read_session_summary tool missing');

    const result = await readSummary.handler({});
    const summary = JSON.parse(result.result);

    expect(summary.loadBearingRequests.map((r: { seq: number }) => r.seq)).toEqual([1, 10]);
    expect(summary.loadBearingRequests[0]).toMatchObject({ seq: 1, sharedDependency: true });
    expect(summary.loadBearingRequests[1]).toMatchObject({ seq: 10, selectedForCandidate: true });
    expect(summary.loadBearingRequests[1].inlineData).toBeDefined();
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
        primary: true,
        requestSeqs: [1, 2, 3],
        representativeSeqs: [],
        eventSeqs: [],
        expectedOutput: 'confirmation',
        likelyParams: [],
        dependencySeqs: [],
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
        primary: true,
        requestSeqs: [2],
        representativeSeqs: [2],
        eventSeqs: [],
        expectedOutput: 'data',
        likelyParams: [],
        dependencySeqs: [],
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
  it('typechecks generated artifacts from os tmpdir paths', async () => {
    const exampleDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-typecheck-tmp-'));

    try {
      symlinkSync(
        pathJoin(import.meta.dir, '..', 'node_modules'),
        pathJoin(exampleDir, 'node_modules'),
      );
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

  it('fails when likelyParams are not templated in any request', async () => {
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

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        likelyParams: [
          { name: 'query', type: 'string', description: 'Search query' },
          { name: 'max_price', type: 'number', description: 'Maximum price filter' },
          { name: 'sort_order', type: 'string', description: 'Sort order' },
        ],
      });

      expect(failures.some((f) => f.includes('not templated'))).toBe(true);
      expect(failures.some((f) => f.includes('max_price'))).toBe(true);
      expect(failures.some((f) => f.includes('sort_order'))).toBe(true);
      expect(failures.some((f) => f.includes('query'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('fails a producer whose parser does not emit a declared emitsTokens field', async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-emits-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');
    const session: Session = {
      site: 'emits-fixture',
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
          { toolName: 'search_hotels', intent: { description: 'x' }, requests: [], site: 'x' },
          null,
          2,
        ),
        'utf8',
      );
      // Parser emits `propertyToken`, but the contract requires `hotel_id`.
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        'export function extract(b: { items: string[] }) {\n  return { propertyToken: b.items[0] };\n}\n',
        'utf8',
      );

      const misses = await externalVerification(exampleDir, session, sessionPath, {
        emittedTokens: [{ field: 'hotel_id', shape: 'composite' }],
      });
      expect(misses.failures.some((f) => f.includes('hotel_id') && f.includes('emit'))).toBe(true);

      // When the parser DOES emit the field, the producer gate passes.
      writeFileSync(
        pathJoin(exampleDir, 'parser.ts'),
        'export function extract(b: { items: string[] }) {\n  return { hotel_id: b.items[0] };\n}\n',
        'utf8',
      );
      const hits = await externalVerification(exampleDir, session, sessionPath, {
        emittedTokens: [{ field: 'hotel_id', shape: 'composite' }],
      });
      expect(hits.failures.some((f) => f.includes('parser.ts does not emit'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('fails when likelyParams are in parameters but not referenced in requests', async () => {
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

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        likelyParams: [
          { name: 'query', type: 'string', description: 'Search query' },
          { name: 'max_price', type: 'number', description: 'Max price' },
        ],
      });

      expect(failures.some((f) => f.includes('max_price'))).toBe(true);
      expect(failures.some((f) => f.includes('query'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('passes when all likelyParams are templated in requests', async () => {
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

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        likelyParams: [
          { name: 'query', type: 'string', description: 'Search query' },
          { name: 'max_price', type: 'number', description: 'Max price' },
        ],
      });

      expect(failures.some((f) => f.includes('likelyParams'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('warns when likelyParams only appear in invented URL query params', async () => {
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
        likelyParams: [
          { name: 'origin', type: 'string', description: 'Origin' },
          { name: 'airlines', type: 'string', description: 'Airline filter' },
        ],
        candidateRequestSeqs: [1],
      });

      expect(failures.some((f) => f.includes('origin'))).toBe(false);
      expect(warnings.some((w) => w.includes('airlines'))).toBe(true);
      expect(warnings.some((w) => w.includes('invented'))).toBe(true);
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
        likelyParams: [
          { name: 'query', type: 'string', description: 'Search query' },
          { name: 'sort', type: 'string', description: 'Sort order' },
        ],
        candidateRequestSeqs: [1],
      });

      expect(failures.some((f) => f.includes('query'))).toBe(false);
      expect(failures.some((f) => f.includes('sort'))).toBe(false);
      expect(warnings.some((w) => w.includes('invented'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('flags declared params with no passing param:<name> test (suite ran, none annotated)', async () => {
    // Per-parameter coverage check (Fix C/D): a parameter is covered only by a
    // `param:<name>` integration test that ACTUALLY RAN GREEN. The fixture's
    // integration suite passes offline but has no `param:` tests, so every
    // non-annotated param is uncovered (blocking); the annotated one is allowed.
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
          },
          null,
          2,
        ),
        'utf8',
      );

      // Integration test that exercises `query` (two distinct values: 'baseline' and 'apple'),
      // mentions `sort` only once at its baseline default (uncovered),
      // never mentions `max_price` (uncovered),
      // and explicitly annotates `discount_code` as not verified (allowed).
      writeFileSync(
        pathJoin(exampleDir, 'integration.test.ts'),
        `import { expect, test } from 'bun:test';

test('baseline', async () => {
  const params = { query: 'baseline', sort: 'price' };
  // exposed-but-not-verified: discount_code is templated but the recording
  // had no variation and no discriminating value is derivable from baseline.
  expect(params).toBeDefined();
});

test('override query', async () => {
  const params = { query: 'apple', sort: 'price' };
  expect(params).toBeDefined();
});
`,
        'utf8',
      );

      const parserCode = 'export function extract(raw) { return { items: [] }; }';
      writeFileSync(pathJoin(exampleDir, 'parser.ts'), parserCode, 'utf8');

      const { failures } = await externalVerification(exampleDir, session, sessionPath, {
        likelyParams: [
          { name: 'query', type: 'string', description: 'Query' },
          { name: 'sort', type: 'string', description: 'Sort key' },
          { name: 'max_price', type: 'number', description: 'Max price' },
          { name: 'discount_code', type: 'string', description: 'Discount' },
        ],
      });

      const coverageFailure = failures.find((f) =>
        f.includes('no passing `param:<name>` integration test'),
      );
      expect(coverageFailure).toBeDefined();
      // No param:<name> tests exist → every non-annotated param is uncovered.
      expect(coverageFailure ?? '').toContain('query');
      expect(coverageFailure ?? '').toContain('sort');
      expect(coverageFailure ?? '').toContain('max_price');
      // discount_code annotated → allowed, not flagged
      expect(coverageFailure ?? '').not.toContain('discount_code');
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

  it("Fix B: rejects a workflow body that freezes one recorded user's session into a varying field", async () => {
    const repoRoot = pathJoin(import.meta.dir, '..');
    const scratchRoot = pathJoin(repoRoot, '.context');
    mkdirSync(scratchRoot, { recursive: true });
    const exampleDir = mkdtempSync(pathJoin(scratchRoot, 'compile-fixB-'));
    const sessionPath = pathJoin(exampleDir, 'session.json');

    // Two recorded POSTs to the same endpoint differ in pickupDate. The
    // recording therefore proves pickupDate is user input; freezing it as
    // a literal in workflow.json must be rejected.
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
      });
      const frozenFailure = frozen.failures.find((f) => f.includes('frozen to one recorded'));
      expect(frozenFailure).toBeDefined();
      // Should name BOTH varying fields, not the constant ones
      expect(frozenFailure ?? '').toContain('pickupDate');
      expect(frozenFailure ?? '').toContain('pickupCity');
      expect(frozenFailure ?? '').not.toContain('country');
      expect(frozenFailure ?? '').not.toContain('fromHomePage');

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
      });
      expect(templated.failures.some((f) => f.includes('frozen to one recorded'))).toBe(false);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });
});

describe('classifyParamCoverage', () => {
  const integrationSrc = `import { expect, test } from 'bun:test';
import { runWorkflowWithLadder } from 'imprint/backend-ladder';

test('baseline', async () => {
  const { result } = await runWorkflowWithLadder({ workflowPath: WP, params: {} });
  expect(result.ok).toBe(true);
});

test('param:query=apple constrains results', async () => {
  const { result } = await runWorkflowWithLadder({ workflowPath: WP, params: { query: 'apple' } });
  expect(result.ok).toBe(true);
});

test('param:fake passes without calling the workflow', async () => {
  expect(1).toBe(1);
});

// exposed-but-not-verified: discount_code has no discriminating value.
test('param:discount_code is annotated', async () => {
  expect(1).toBe(1);
});
`;

  it('marks a param covered when its param:<name> test ran green and calls the workflow', () => {
    const { paramVerification, uncovered, tautological } = classifyParamCoverage({
      likelyParams: [{ name: 'query' }],
      integrationSrc,
      passedTests: new Set(['param:query=apple constrains results']),
      integrationOutcome: 'passed',
    });
    expect(paramVerification).toEqual([{ name: 'query', verified: true }]);
    expect(uncovered).toEqual([]);
    expect(tautological).toEqual([]);
  });

  it('flags a passing param test that never calls runWorkflowWithLadder as tautological', () => {
    const { tautological, paramVerification } = classifyParamCoverage({
      likelyParams: [{ name: 'fake' }],
      integrationSrc,
      passedTests: new Set(['param:fake passes without calling the workflow']),
      integrationOutcome: 'passed',
    });
    expect(tautological).toEqual(['fake']);
    expect(paramVerification).toEqual([]);
  });

  it('marks params unverified (not blocking) when the suite was waived by anti-bot', () => {
    const { paramVerification, uncovered } = classifyParamCoverage({
      likelyParams: [{ name: 'query' }, { name: 'sort' }],
      integrationSrc,
      passedTests: new Set(),
      integrationOutcome: 'waived-bot',
    });
    expect(uncovered).toEqual([]);
    expect(paramVerification).toEqual([
      { name: 'query', verified: false, reason: 'waived-bot' },
      { name: 'sort', verified: false, reason: 'waived-bot' },
    ]);
  });

  it('marks an annotated param unverified (not blocking) when the suite ran green', () => {
    const { paramVerification, uncovered } = classifyParamCoverage({
      likelyParams: [{ name: 'discount_code' }],
      integrationSrc,
      passedTests: new Set(),
      integrationOutcome: 'passed',
    });
    expect(uncovered).toEqual([]);
    expect(paramVerification).toEqual([
      { name: 'discount_code', verified: false, reason: 'annotated' },
    ]);
  });

  it('blocks an uncovered, unannotated param when the suite ran green', () => {
    const { uncovered, paramVerification } = classifyParamCoverage({
      likelyParams: [{ name: 'sort' }],
      integrationSrc,
      passedTests: new Set(['baseline']),
      integrationOutcome: 'passed',
    });
    expect(uncovered).toEqual(['sort']);
    expect(paramVerification).toEqual([]);
  });

  it('leaves unchained empty for non-token params', () => {
    const { unchained } = classifyParamCoverage({
      likelyParams: [{ name: 'query' }],
      integrationSrc,
      passedTests: new Set(['param:query=apple constrains results']),
      integrationOutcome: 'passed',
    });
    expect(unchained).toEqual([]);
  });

  // ── Producer-sourced token params (chained verification) ──
  const chainedSrc = `import { runWorkflowWithLadder } from 'imprint/backend-ladder';

test('param:hotel_id uses a fresh token minted by search_hotels', async () => {
  const producer = await runWorkflowWithLadder({ workflowPath: new URL('../search_hotels/workflow.json', import.meta.url).pathname, params: {} });
  const fresh = (producer.result.data as any).hotel_id;
  const { result } = await runWorkflowWithLadder({ workflowPath: WP, params: { hotel_id: fresh } });
  expect(result.ok).toBe(true);
});
`;
  // Same title, but the test only calls this tool's own workflow (the tautology).
  const tautologicalChainSrc = `import { runWorkflowWithLadder } from 'imprint/backend-ladder';

test('param:hotel_id selects the hotel', async () => {
  const { result } = await runWorkflowWithLadder({ workflowPath: WP, params: { hotel_id: 'RECORDED_COMPOSITE' } });
  expect(result.ok).toBe(true);
});
`;
  const tokenSources = [
    { param: 'hotel_id', sourceTool: 'search_hotels', sourceField: 'hotel_id' },
  ];

  it('verifies a token param via a chained test that mints from the producer sibling', () => {
    const { paramVerification, unchained } = classifyParamCoverage({
      likelyParams: [{ name: 'hotel_id' }],
      integrationSrc: chainedSrc,
      passedTests: new Set(['param:hotel_id uses a fresh token minted by search_hotels']),
      integrationOutcome: 'passed',
      tokenSources,
    });
    expect(unchained).toEqual([]);
    expect(paramVerification).toEqual([
      {
        name: 'hotel_id',
        verified: true,
        sourcedFrom: { tool: 'search_hotels', field: 'hotel_id' },
      },
    ]);
  });

  it('flags a token param as unchained when its passing test reuses the recorded constant', () => {
    const { unchained, paramVerification } = classifyParamCoverage({
      likelyParams: [{ name: 'hotel_id' }],
      integrationSrc: tautologicalChainSrc,
      passedTests: new Set(['param:hotel_id selects the hotel']),
      integrationOutcome: 'passed',
      tokenSources,
    });
    expect(unchained).toEqual(['hotel_id']);
    expect(paramVerification).toEqual([]);
  });

  it('waives a token param (non-blocking) when the producer suite was anti-bot blocked', () => {
    const { unchained, paramVerification } = classifyParamCoverage({
      likelyParams: [{ name: 'hotel_id' }],
      integrationSrc: chainedSrc,
      passedTests: new Set(),
      integrationOutcome: 'waived-bot',
      tokenSources,
    });
    expect(unchained).toEqual([]);
    expect(paramVerification).toEqual([
      {
        name: 'hotel_id',
        verified: false,
        reason: 'waived-chain',
        sourcedFrom: { tool: 'search_hotels', field: 'hotel_id' },
      },
    ]);
  });

  it('blocks a token param with no chained test on a green suite', () => {
    const { unchained, paramVerification } = classifyParamCoverage({
      likelyParams: [{ name: 'hotel_id' }],
      integrationSrc: chainedSrc,
      passedTests: new Set(['some other test']),
      integrationOutcome: 'passed',
      tokenSources,
    });
    expect(unchained).toEqual(['hotel_id']);
    expect(paramVerification).toEqual([]);
  });
});

describe('detectTokenSources', () => {
  it('flags a param whose recorded value appears in a sibling response', () => {
    const out = detectTokenSources({
      likelyParams: [{ name: 'offer_token' }],
      recordedParamValues: new Map([['offer_token', 'fixture-token-0001']]),
      siblingResponses: [{ toolName: 'search_x', body: '{"items":[{"t":"fixture-token-0001"}]}' }],
    });
    expect(out).toEqual([{ param: 'offer_token', sourceTool: 'search_x' }]);
  });

  it('matches a composite segment when the producer emits only a fragment', () => {
    const out = detectTokenSources({
      likelyParams: [{ name: 'hotel_id' }],
      recordedParamValues: new Map([
        ['hotel_id', '0x880e2cbb24a58c1f:0x469c0c8118eb74b2|/m/0gz469'],
      ]),
      siblingResponses: [{ body: '{"ftid":"0x880e2cbb24a58c1f:0x469c0c8118eb74b2"}' }],
    });
    expect(out.map((t) => t.param)).toEqual(['hotel_id']);
  });

  it('ignores low-entropy / free-text values and non-matches', () => {
    expect(
      detectTokenSources({
        likelyParams: [{ name: 'sort' }, { name: 'city' }, { name: 'tok' }],
        recordedParamValues: new Map([
          ['sort', 'price'],
          ['city', 'Chicago Loop'],
          ['tok', 'ABCDEF0123456789'],
        ]),
        siblingResponses: [{ body: '{"results":["price","Chicago Loop"]}' }],
      }),
    ).toEqual([]);
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

describe('extractTestBlocks', () => {
  it('captures each test title and its body up to the next test', () => {
    const src = `test('param:a does x', async () => {
  await runWorkflowWithLadder({ params: { a: 1 } });
});
test('param:b does y', () => {
  expect(1).toBe(1);
});`;
    const blocks = extractTestBlocks(src);
    expect(blocks.map((b) => b.title)).toEqual(['param:a does x', 'param:b does y']);
    expect(blocks[0]?.body.includes('runWorkflowWithLadder')).toBe(true);
    expect(blocks[1]?.body.includes('runWorkflowWithLadder')).toBe(false);
  });
});

describe('buildInlineData form-encoded decoding', () => {
  it('decodes form-encoded request body with JSON field values', async () => {
    const session: Session = {
      site: 'form-decode-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/api',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/data',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          resourceType: 'Fetch',
          body: 'f.req=%5Bnull%2C%22inner%22%5D&other=plain',
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

    const tools = buildCompileTools(session, '/tmp/test-form-decode', '/tmp/session.json', {
      candidate: {
        toolName: 'test_tool',
        description: 'test',
        rationale: 'test',
        confidence: 0.9,
        primary: true,
        requestSeqs: [1],
        representativeSeqs: [1],
        eventSeqs: [],
        expectedOutput: 'test',
        likelyParams: [],
        dependencySeqs: [],
      },
    });

    const summaryTool = tools.find((t) => t.name === 'read_session_summary');
    expect(summaryTool).toBeDefined();
    if (!summaryTool) return;

    const result = await summaryTool.handler({});
    const summary = JSON.parse(result.result);

    const lbr = summary.loadBearingRequests.find((r: Record<string, unknown>) => r.seq === 1);
    expect(lbr).toBeDefined();
    expect(lbr.inlineData.requestBodyDecoded).toBeDefined();
    expect(lbr.inlineData.requestBodyDecoded['f.req']).toEqual([null, 'inner']);
    expect(lbr.inlineData.requestBodyDecoded.other).toBe('plain');
  });

  it('does not add requestBodyDecoded for non-form-encoded bodies', async () => {
    const session: Session = {
      site: 'json-body-fixture',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/api',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/data',
          headers: { 'content-type': 'application/json' },
          resourceType: 'Fetch',
          body: '{"key": "value"}',
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

    const tools = buildCompileTools(session, '/tmp/test-json-body', '/tmp/session.json', {
      candidate: {
        toolName: 'test_tool',
        description: 'test',
        rationale: 'test',
        confidence: 0.9,
        primary: true,
        requestSeqs: [1],
        representativeSeqs: [1],
        eventSeqs: [],
        expectedOutput: 'test',
        likelyParams: [],
        dependencySeqs: [],
      },
    });

    const summaryTool = tools.find((t) => t.name === 'read_session_summary');
    expect(summaryTool).toBeDefined();
    if (!summaryTool) return;

    const result = await summaryTool.handler({});
    const summary = JSON.parse(result.result);

    const lbr = summary.loadBearingRequests.find((r: Record<string, unknown>) => r.seq === 1);
    expect(lbr).toBeDefined();
    expect(lbr.inlineData.requestBodyDecoded).toBeUndefined();
  });
});

describe('externalVerification — shared-module import assertion', () => {
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

  const signModule = {
    path: '_shared/sign.ts',
    kind: 'request-transform' as const,
    verified: true,
    importPath: '../_shared/sign.ts',
    exportSignatures: ['export function transform(method: string, url: string): string'],
    purpose: 'sign URLs',
  };

  // Match the import-assertion message specifically — not unrelated failures
  // (e.g. "parser.ts import failed") that also mention the module path.
  function hasImportAssertion(failures: string[], modulePath: string): boolean {
    return failures.some(
      (f) => f.includes('build plan assigns shared module') && f.includes(modulePath),
    );
  }

  it('fails when an assigned request-transform module is not wired into the workflow', async () => {
    const { dir, sessionPath, session } = setupDir('share-rt-missing-', 'rt-missing', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'rt-missing',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath, {
        assignedSharedModules: [signModule],
      });
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the import assertion when requestTransformModule points at the shared module', async () => {
    const { dir, sessionPath, session } = setupDir('share-rt-ok-', 'rt-ok', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'rt-ok',
      requestTransformModule: '../_shared/sign.ts',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath, {
        assignedSharedModules: [signModule],
      });
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the import assertion when parser.ts imports an assigned parser-helper', async () => {
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
      const { failures } = await externalVerification(dir, session, sessionPath, {
        assignedSharedModules: [
          {
            path: '_shared/decode.ts',
            kind: 'parser-helper',
            verified: true,
            importPath: '../_shared/decode.ts',
            exportSignatures: ['export function decode(d: unknown): unknown'],
            purpose: 'decode',
          },
        ],
      });
      expect(hasImportAssertion(failures, '_shared/decode.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not assert imports for unverified shared modules', async () => {
    const { dir, sessionPath, session } = setupDir('share-unverified-', 'unverified', {
      toolName: 'search_items',
      intent: { description: 'Search' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api/search?q=alpha', headers: {} }],
      site: 'unverified',
    });
    try {
      const { failures } = await externalVerification(dir, session, sessionPath, {
        assignedSharedModules: [{ ...signModule, verified: false }],
      });
      expect(hasImportAssertion(failures, '_shared/sign.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isBotDefenseFailure', () => {
  // Generalized across bot-defense vendors — NOT specialized to any one site.
  const blocked = [
    [
      '302 redirect to a challenge/verify page',
      '302 Found\nlocation: https://example.com/challenge?reason=verify',
    ],
    [
      '"unusual traffic" interstitial',
      'Our systems have detected unusual traffic from your computer network.',
    ],
    ['Cloudflare "Just a moment"', '503 Service Unavailable\nJust a moment...\ncf-chl-bypass'],
    ['Cloudflare Attention Required', 'Attention Required! | Cloudflare (Ray ID: 8ab...)'],
    ['reCAPTCHA', 'Error: please complete the reCAPTCHA challenge to continue'],
    ['hCaptcha', 'hcaptcha verification required'],
    ['DataDome', '403 Forbidden\nx-datadome: protected'],
    ['PerimeterX', '403 Forbidden — perimeterx px-captcha shown'],
    ['Akamai 403 challenge', '403 Forbidden: bot challenge from Akamai'],
    [
      'Akamai _abck unvalidated after interaction (200 soft-block)',
      '[imprint cdp-browser] _abck status after interaction: ~-1~\n[imprint backend] fetch: OK in 1201ms\nworkflow returned no hotels',
    ],
    ['429 rate limit', '429 Too Many Requests — rate limit exceeded'],
    ['generic access denied 403', '403 Forbidden: Access Denied'],
  ] as const;
  for (const [name, text] of blocked) {
    it(`treats "${name}" as bot defense`, () => {
      expect(isBotDefenseFailure(text)).toBe(true);
    });
  }

  const notBlocked = [
    [
      'assertion failure',
      'expect(result.flights.length).toBeGreaterThan(0)\n  Expected: > 0\n  Received: 0',
    ],
    ['400 bad params', '400 Bad Request: missing required parameter "origin"'],
    ['plain empty result', 'workflow returned { flights: [] } — no data for these inputs'],
    ['generic 500', '500 Internal Server Error'],
    ['ordinary redirect, no challenge', '302 Found\nlocation: https://example.com/results?page=2'],
    // The bare re-mint log precedes a retry that often succeeds — it must NOT, on
    // its own, be read as a block (only the post-interaction confirmation does).
    [
      'Akamai cached-jar re-mint log (precedes retry)',
      '[imprint cdp-jar] cached jar not validated (_abck~-1~, no bm_sv) — re-mint',
    ],
  ] as const;
  for (const [name, text] of notBlocked) {
    it(`does NOT treat "${name}" as bot defense`, () => {
      expect(isBotDefenseFailure(text)).toBe(false);
    });
  }
});

describe('classifyIntegrationOutcome (Fix A — liveVerified decoupled from the param suite)', () => {
  // Faithful reproduction of the southwest search_flights verifier run that shipped
  // liveVerified:false: fetch 403, but stealth-fetch AND cdp-replay BOTH returned
  // real data and the probe picked a winner — then the paced param suite overran
  // the verifier timeout and was SIGKILLed (timedOut), leaving a partial log whose
  // lone fetch-403 used to be misread as a total bot block ⇒ waived-bot ⇒ false.
  const WINNER_BUT_TIMED_OUT = [
    '[imprint backend] trying fetch…',
    '[imprint backend] trying cdp-replay…',
    '[imprint backend] trying stealth-fetch…',
    '[imprint backend] fetch: FORBIDDEN in 201ms — escalating',
    '[imprint backend] stealth-fetch: OK in 16679ms',
    '[imprint backend] cdp-replay: OK in 35137ms',
    '[imprint backend] parallel probe: winner=stealth-fetch (16679ms)',
    '  fetch: FORBIDDEN — Request 0 returned 403: { "code": 403050700 } (202ms)',
    '  cdp-replay: OK in 35137ms',
    '  stealth-fetch: OK in 16679ms',
  ].join('\n');

  it('keeps the baseline live-verified when a probe winner returned real data, despite a timeout', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: true,
      combined: WINNER_BUT_TIMED_OUT,
      passedTests: new Set(['baseline returns flights', 'param:origination_airport_code=OAK']),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    // The bug was: waived-bot ⇒ liveVerified:false. Now a backend demonstrably
    // returned real data, so the baseline IS verified…
    expect(v.baselineLiveVerified).toBe(true);
    // …and a TIMEOUT is infra, never a bot block (the lone fetch-403 must not win).
    expect(v.outcome).toBe('waived-infra');
    // exhaustedBackends lists ONLY the rung that failed (fetch) — not cdp-replay /
    // stealth-fetch, which succeeded.
    expect(v.exhaustedBackends).toEqual(['fetch']);
  });

  it('detects the baseline via the probe-winner log even when JUnit is empty (timeout SIGKILL)', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: true,
      combined: WINNER_BUT_TIMED_OUT,
      passedTests: new Set(), // JUnit truncated/absent on a kill
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.baselineLiveVerified).toBe(true);
  });

  it('detects the baseline via a passing non-param JUnit test even without a winner line', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      combined: '[imprint backend] fetch: NETWORK in 30000ms — escalating',
      passedTests: new Set(['baseline returns real data']),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.baselineLiveVerified).toBe(true);
  });

  it('still waives liveVerified:false on a GENUINE total block — no winner, no baseline pass', () => {
    const combined = [
      '[imprint backend] trying fetch…',
      '[imprint backend] fetch: FORBIDDEN in 180ms — escalating',
      '[imprint backend] parallel probe: all backends failed',
      '  fetch: FORBIDDEN — 403 Access Denied (180ms)',
      '  stealth-fetch: FORBIDDEN — 403 (220ms)',
    ].join('\n');
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      combined,
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.baselineLiveVerified).toBe(false);
    expect(v.outcome).toBe('waived-bot'); // 403 + access denied ⇒ bot defense
  });

  it('a timeout is infra even if the partial output has a fetch 403 (never a bot block)', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: true,
      combined:
        '[imprint backend] fetch: FORBIDDEN in 200ms — escalating\n  fetch: FORBIDDEN — 403 (200ms)',
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.outcome).toBe('waived-infra');
  });

  it('classifies a clean exit as passed + baseline verified', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 0,
      timedOut: false,
      combined: '[imprint backend] fetch: OK in 300ms',
      passedTests: new Set(['baseline', 'param:max_price=50']),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.outcome).toBe('passed');
    expect(v.baselineLiveVerified).toBe(true);
  });

  it('classifies a declared-capture STATE_MISSING as failed (workflow bug, not waived)', () => {
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      // The EXACT runtime message (em-dash separator + "(source) did not produce a value").
      combined: 'STATE_MISSING — Required capture "csrf_token" (json) did not produce a value.',
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(['csrf_token']),
    });
    expect(v.outcome).toBe('failed');
    expect(v.captureFailName).toBe('csrf_token');
    expect(v.captureFailFromKnown).toBe(true);
  });

  it('a capture-fail is failed (not waived-bot) even when an _abck line is in the log', () => {
    // Regression for marriott search_hotels: req1 placeId capture returned empty
    // (a broken self-derived chain), all backends STATE_MISSING, but `_abck~-1~`
    // was in the log. Must be `failed` (fix the workflow), NOT shipped waived-bot.
    const combined = [
      '[imprint backend] trying fetch…',
      '[imprint cdp-browser] _abck status after interaction: ~-1~',
      '[imprint backend] fetch: STATE_MISSING in 494ms — non-escalatable, returning',
      'STATE_MISSING — Required capture "placeId" (json) did not produce a value.',
      '[imprint backend] parallel probe: all backends failed',
    ].join('\n');
    const v = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      combined,
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
    });
    expect(v.captureFailName).toBe('placeId');
    expect(v.outcome).toBe('failed');
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

// ─── Emit-time secret guard + contracted-input injection/gate (Threads B/C) ───

function secretSession(): Session {
  return {
    site: 'test',
    startedAt: '2026-06-26T00:00:00.000Z',
    url: 'https://www.example.com/',
    imprintVersion: '0.1.0',
    requests: [
      {
        // Pre-interaction request: X-App-Key is a page-minted app constant.
        seq: 5,
        timestamp: 10,
        method: 'GET',
        url: 'https://api.example.com/bootstrap',
        headers: { 'X-App-Key': 'synthetic-appkey-001' },
        resourceType: 'Fetch',
        response: { status: 200, headers: {}, mimeType: 'application/json', body: '{}' },
      },
      {
        // Post-interaction request: Authorization + Cookie are per-user secrets.
        seq: 10,
        timestamp: 100,
        method: 'GET',
        url: 'https://api.example.com/data',
        headers: {
          Authorization: 'Bearer secrettoken1234567890abcdef',
          'X-App-Key': 'synthetic-appkey-001',
          Cookie: 'session=cookievalue1234567890',
        },
        resourceType: 'Fetch',
        response: { status: 200, headers: {}, mimeType: 'application/json', body: '{}' },
      },
    ],
    events: [{ seq: 0, timestamp: 50, type: 'click', detail: '{"selector":"#go"}' }],
    narration: [],
    // Clean-start recording (no cookies/storage before login) — page-minted
    // detection is sound here, so X-App-Key is exempt as an app constant.
    cookieSnapshots: [
      { takenAt: '2026-06-26T00:00:00.000Z', timestamp: 0, label: 'start', cookies: [] },
    ],
    storageSnapshots: [],
  };
}

/** An ALREADY-AUTHENTICATED (`--persist-profile`) recording: a per-user bearer the
 *  SPA persisted in localStorage is sent as `Authorization: Bearer <token>` before
 *  the first interaction. The page-minted heuristic must NOT exempt it — the
 *  scheme-stripped storage check recognizes the stored token. */
function authedStartSession(): Session {
  return {
    site: 'test',
    startedAt: '2026-06-26T00:00:00.000Z',
    url: 'https://www.example.com/',
    imprintVersion: '0.1.0',
    requests: [
      {
        seq: 1,
        timestamp: 10,
        method: 'GET',
        url: 'https://api.example.com/data',
        headers: { Authorization: 'Bearer realuserjwt1234567890abcdef' },
        resourceType: 'Fetch',
        response: { status: 200, headers: {}, mimeType: 'application/json', body: '{}' },
      },
    ],
    events: [{ seq: 0, timestamp: 5000, type: 'click', detail: '{"selector":"#go"}' }],
    narration: [],
    cookieSnapshots: [
      { takenAt: '2026-06-26T00:00:00.000Z', timestamp: 0, label: 'start', cookies: [] },
    ],
    storageSnapshots: [
      {
        takenAt: '2026-06-26T00:00:00.000Z',
        timestamp: 0,
        label: 'start',
        origin: 'https://www.example.com',
        localStorage: { access_token: 'realuserjwt1234567890abcdef' },
        sessionStorage: {},
      },
    ],
  };
}

describe('assertNoRawSecrets', () => {
  it('blocks a persisted per-user bearer in an ALREADY-AUTHED recording (scheme-stripped, not exempt)', () => {
    // Regression for the critical under-block: the bearer is sent pre-interaction as
    // "Bearer <token>", but its bare token is in start localStorage, so
    // detectPageMintedHeaders does NOT mark it page-minted and the raw token is caught.
    const session = authedStartSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { Authorization: 'Bearer realuserjwt1234567890abcdef' } }],
    });
    const r = assertNoRawSecrets({ workflowJson, session });
    expect(r.failures.length).toBe(1);
  });

  it('blocks a pre-interaction Authorization token even with NO captured storage (always-secret header)', () => {
    // Hardening: a bearer minted from uncaptured storage (IndexedDB) in an
    // already-authed recording is still caught — Authorization is inherently
    // per-session auth and is never treated as a page-minted constant.
    const session = authedStartSession();
    session.storageSnapshots = []; // simulate the token living in uncaptured storage
    const workflowJson = JSON.stringify({
      requests: [{ headers: { Authorization: 'Bearer realuserjwt1234567890abcdef' } }],
    });
    const r = assertNoRawSecrets({ workflowJson, session });
    expect(r.failures.length).toBe(1);
  });

  it('blocks a raw sensitive-header value that leaked into workflow.json', () => {
    const session = secretSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { Authorization: 'Bearer secrettoken1234567890abcdef' } }],
    });
    const r = assertNoRawSecrets({ workflowJson, session });
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/raw secret/i);
  });

  it('auto-rewrites a known value to its contracted placeholder', () => {
    const session = secretSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { Authorization: 'Bearer secrettoken1234567890abcdef' } }],
    });
    const r = assertNoRawSecrets({
      workflowJson,
      session,
      placeholderByValue: new Map([
        ['Bearer secrettoken1234567890abcdef', '${credential.access_token}'],
      ]),
    });
    expect(r.rewrites).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.workflowJson).toContain('${credential.access_token}');
    expect(r.workflowJson).not.toContain('secrettoken1234567890abcdef');
  });

  it('allows a static literal (page-minted app constant), not a leak', () => {
    const session = secretSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { 'X-App-Key': 'synthetic-appkey-001' } }],
    });
    const r = assertNoRawSecrets({
      workflowJson,
      session,
      allowedLiterals: new Set(['synthetic-appkey-001']),
    });
    expect(r.failures).toEqual([]);
  });

  it('does NOT block a hardcoded page-minted app key even without a contract (no regression)', () => {
    // The compile-agent prompt tells the agent to hardcode page-minted keys like
    // x-api-key verbatim. The single-tool generate path has no requiredInputs, so
    // the guard must rely on the page-minted detector to avoid blocking them.
    const session = secretSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { 'X-App-Key': 'synthetic-appkey-001' } }],
    });
    const r = assertNoRawSecrets({ workflowJson, session });
    expect(r.failures).toEqual([]);
  });

  it('still blocks a hardcoded session cookie (cookies are never page-minted)', () => {
    const session = secretSession();
    const workflowJson = JSON.stringify({
      requests: [{ headers: { Cookie: 'session=cookievalue1234567890' } }],
    });
    const r = assertNoRawSecrets({ workflowJson, session });
    expect(r.failures.length).toBe(1);
  });

  it('blocks a raw secret in parser.ts (never rewritten)', () => {
    const session = secretSession();
    const r = assertNoRawSecrets({
      workflowJson: '{}',
      parserSrc: 'const t = "Bearer secrettoken1234567890abcdef";',
      session,
    });
    expect(r.failures.some((f) => f.includes('parser.ts'))).toBe(true);
  });
});

describe('injectContractedInputs', () => {
  it('injects a dropped credential header into the matching request', () => {
    const session = secretSession();
    const workflow = {
      requests: [{ method: 'GET', url: 'https://api.example.com/data', headers: {} }],
    };
    const ri: RequiredInput[] = [
      {
        location: 'header:Authorization',
        source: 'auth',
        wiring: 'credential',
        credentialName: 'access_token',
        recordedSeq: 10,
        note: '',
      },
    ];
    const res = injectContractedInputs(workflow, ri, session);
    expect(res.injected).toBe(1);
    expect(workflow.requests[0]?.headers).toEqual({
      Authorization: '${credential.access_token}',
    });
  });

  it('sets workflow.bootstrap.url from a referer input', () => {
    const session = secretSession();
    const workflow: {
      requests: Array<{ method?: string; url?: string; headers?: Record<string, string> }>;
      bootstrap?: { url?: string };
    } = { requests: [] };
    const res = injectContractedInputs(
      workflow,
      [
        {
          location: 'referer',
          source: 'browser_state',
          wiring: 'state',
          bootstrapUrl: 'https://www.example.com/checkout',
          note: '',
        },
      ],
      session,
    );
    expect(res.bootstrapSet).toBe(true);
    expect(workflow.bootstrap?.url).toBe('https://www.example.com/checkout');
  });

  it('does not overwrite a header the agent already wired', () => {
    const session = secretSession();
    const workflow = {
      requests: [
        { method: 'GET', url: 'https://api.example.com/data', headers: { Authorization: 'keep' } },
      ],
    };
    const res = injectContractedInputs(
      workflow,
      [
        {
          location: 'header:Authorization',
          source: 'auth',
          wiring: 'credential',
          credentialName: 'access_token',
          recordedSeq: 10,
          note: '',
        },
      ],
      session,
    );
    expect(res.injected).toBe(0);
    expect(workflow.requests[0]?.headers.Authorization).toBe('keep');
  });

  it('does not inject a browser_state header when no capture produces it', () => {
    const session = secretSession();
    const workflow = {
      requests: [{ method: 'GET', url: 'https://api.example.com/data', headers: {} }],
    };
    const res = injectContractedInputs(
      workflow,
      [
        {
          location: 'header:X-State',
          source: 'browser_state',
          wiring: 'state',
          stateName: 'x_state',
          recordedSeq: 10,
          note: '',
        },
      ],
      session,
    );
    expect(res.injected).toBe(0);
  });
});

describe('contractedInputGate', () => {
  it('blocks when a non-producer contracted input is unwired', () => {
    const gate = contractedInputGate('{"requests":[{"headers":{}}]}', [
      {
        location: 'header:Authorization',
        source: 'auth',
        wiring: 'credential',
        credentialName: 'access_token',
        note: '',
      },
    ]);
    expect(gate.unresolved).toBe(1);
    expect(gate.failures.length).toBe(1);
  });

  it('passes when the wiring is present', () => {
    const gate = contractedInputGate(
      JSON.stringify({ requests: [{ headers: { Authorization: '${credential.access_token}' } }] }),
      [
        {
          location: 'header:Authorization',
          source: 'auth',
          wiring: 'credential',
          credentialName: 'access_token',
          note: '',
        },
      ],
    );
    expect(gate.unresolved).toBe(0);
    expect(gate.failures).toEqual([]);
  });

  it('treats a missing referer bootstrap as a non-blocking warning', () => {
    const gate = contractedInputGate('{"requests":[]}', [
      {
        location: 'referer',
        source: 'browser_state',
        wiring: 'state',
        bootstrapUrl: 'https://www.example.com/checkout',
        note: '',
      },
    ]);
    expect(gate.failures).toEqual([]);
    expect(gate.warnings.length).toBe(1);
    expect(gate.unresolved).toBe(0);
  });

  it('does not gate producer_tool params (handled by the param machinery)', () => {
    const gate = contractedInputGate('{"requests":[{"headers":{}}]}', [
      {
        location: 'url_param:hotel_id',
        source: 'producer_tool',
        wiring: 'param',
        param: 'hotel_id',
        producerTool: 'search',
        producerField: 'hotelToken',
        note: '',
      },
    ]);
    expect(gate.failures).toEqual([]);
  });
});

describe('classifyIntegrationOutcome contract-gap', () => {
  it('classifies a contract gap as failed, NOT waived-bot, even with a bot line', () => {
    const verdict = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      combined: 'Access Denied\n_abck sensor\nFORBIDDEN',
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
      contractGap: true,
    });
    expect(verdict.outcome).toBe('failed');
  });

  it('still waives a genuine bot block when there is no contract gap', () => {
    const verdict = classifyIntegrationOutcome({
      exitCode: 1,
      timedOut: false,
      combined: '_abck status after interaction: ~-1~',
      passedTests: new Set(),
      referencedStateBroken: false,
      failedCaptureNames: new Set(),
      contractGap: false,
    });
    expect(verdict.outcome).toBe('waived-bot');
  });
});

describe('reveal_request tool', () => {
  it('returns the UNREDACTED request + response read from the recording on disk', async () => {
    const session = secretSession();
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-reveal-'));
    const sessionPath = pathJoin(dir, 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
    try {
      const tools = buildCompileTools(session, dir, sessionPath, {});
      const reveal = tools.find((t) => t.name === 'reveal_request');
      expect(reveal).toBeDefined();
      const out = await reveal?.handler({ seqs: [10] });
      const parsed = JSON.parse(out?.result ?? '[]');
      expect(parsed[0].headers.Authorization).toBe('Bearer secrettoken1234567890abcdef');
      expect(parsed[0].headers.Cookie).toBe('session=cookievalue1234567890');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
