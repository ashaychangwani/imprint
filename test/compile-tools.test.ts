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
      1, 2, 4,
    ]);
    expect(summary.loadBearingRequests[0]).toMatchObject({
      seq: 1,
      repeatCount: 2,
      repeatedSeqs: [1, 3],
      lastTimestamp: 140,
    });
    expect(summary.loadBearingRequests[1]).toMatchObject({
      seq: 2,
      selectedForCandidate: true,
    });
    expect(summary.loadBearingRequests[2]).toMatchObject({
      seq: 4,
      sharedDependency: true,
    });
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

      const failures = await externalVerification(exampleDir, session, sessionPath);
      expect(failures.some((failure) => failure.includes('failed typecheck'))).toBe(true);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });
});
