import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { buildCompileTools, externalVerification } from '../src/imprint/compile-tools.ts';
import type { Session } from '../src/imprint/types.ts';

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
          response: { status: 200, headers: {}, mimeType: 'text/html', body: '<html>token=abc</html>' },
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
          response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"data":true}' },
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
});
