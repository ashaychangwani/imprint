import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  buildCompileTools,
  externalVerification,
  isBotDefenseFailure,
} from '../src/imprint/compile-tools.ts';
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

  it('flags declared params that integration.test.ts does not exercise with a distinct value', async () => {
    // Per-parameter coverage check: a parameter declared on the tool surface
    // must appear with at least two distinct values in integration.test.ts
    // (baseline + override) or carry a `// exposed-but-not-verified`
    // annotation. This is the structural enforcement that catches "broken
    // filter ships untested" — e.g., google-flights' max_duration_minutes
    // bug, where the param was declared and templated but no test ever set
    // it to a discriminating value.
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
        f.includes('have no discriminating integration test'),
      );
      expect(coverageFailure).toBeDefined();
      // query has two distinct values → covered, not flagged
      expect(coverageFailure ?? '').not.toContain('query');
      // sort appears only as 'price' in both tests → 1 distinct value → uncovered
      expect(coverageFailure ?? '').toContain('sort');
      // max_price not mentioned at all → uncovered
      expect(coverageFailure ?? '').toContain('max_price');
      // discount_code annotated → allowed, not flagged
      expect(coverageFailure ?? '').not.toContain('discount_code');
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
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
  ] as const;
  for (const [name, text] of notBlocked) {
    it(`does NOT treat "${name}" as bot defense`, () => {
      expect(isBotDefenseFailure(text)).toBe(false);
    });
  }
});
