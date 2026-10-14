import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  retainResponseEvidence,
  retainedResponseEvidencePath,
} from '../src/imprint/research-response-evidence.ts';
import { type ResponseEvidence, executeWorkflow } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const workflow: Workflow = {
  site: 'fixture.invalid',
  toolName: 'fixture_chain',
  intent: { description: 'Fixture chain' },
  parameters: [],
  requests: [
    { method: 'GET', url: 'https://fixture.invalid/first', headers: {}, recordingRequestSeq: 12 },
    { method: 'GET', url: 'https://fixture.invalid/second', headers: {}, recordingRequestSeq: 13 },
  ],
};
const credentials = {
  site: 'fixture.invalid',
  values: { password: 'fixture-password' },
  cookies: [],
};

describe('immediate response evidence', () => {
  it('preserves both responses before downstream HTTP failure and distinguishes retries', async () => {
    const evidence: ResponseEvidence[] = [];
    let completedChains = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let requests = 0;
      const result = await executeWorkflow({
        workflow,
        credentials,
        params: {},
        fetchImpl: (async () =>
          ++requests === 1
            ? new Response('first fixture-password')
            : new Response('second failed', { status: 400 })) as unknown as typeof fetch,
        onResponseEvidence: (response) => evidence.push(response),
        onRawResponses: () => completedChains++,
      });
      expect(result.ok).toBeFalse();
    }
    expect(completedChains).toBe(0);
    expect(evidence.map(({ bodyText }) => bodyText)).toEqual([
      'first ${credential.password}',
      'second failed',
      'first ${credential.password}',
      'second failed',
    ]);
    expect(evidence.map(({ recordingRequestSeq }) => recordingRequestSeq)).toEqual([
      12, 13, 12, 13,
    ]);
    expect(evidence[0]?.attemptId).toBe(evidence[1]?.attemptId);
    expect(evidence[0]?.attemptId).not.toBe(evidence[2]?.attemptId);
  });

  it('retains the first body when a required capture prevents the second request', async () => {
    const [first, second] = workflow.requests;
    if (!first || !second) throw new Error('Missing fixture requests');
    const evidence: ResponseEvidence[] = [];
    let requests = 0;
    const result = await executeWorkflow({
      workflow: {
        ...workflow,
        requests: [
          {
            ...first,
            captures: [
              {
                name: 'required',
                source: 'cookie',
                cookie: 'missing',
                required: true,
                capability: 'ordinary_http',
                allowHttpOnlyProjection: false,
              },
            ],
          },
          second,
        ],
      },
      credentials,
      params: {},
      fetchImpl: (async () => {
        requests++;
        return new Response('first complete');
      }) as unknown as typeof fetch,
      onResponseEvidence: (response) => evidence.push(response),
    });
    expect(result.ok).toBeFalse();
    expect(requests).toBe(1);
    expect(evidence[0]?.bodyText).toBe('first complete');
  });

  it('retains a just-read body even when cancellation happens during the read', async () => {
    const controller = new AbortController();
    const evidence: ResponseEvidence[] = [];
    const response = new Response('unused');
    Object.defineProperty(response, 'text', {
      value: async () => {
        controller.abort();
        return 'read before cancellation';
      },
    });
    const result = await executeWorkflow({
      workflow,
      credentials,
      params: {},
      signal: controller.signal,
      fetchImpl: (async () => response) as unknown as typeof fetch,
      onResponseEvidence: (entry) => evidence.push(entry),
    });
    expect(result.ok).toBeFalse();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.bodyText).toBe('read before cancellation');
  });

  it('records unavailable body metadata without inventing empty response evidence', async () => {
    const response = new Response('unused');
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw new Error('fixture read failed');
      },
    });
    const evidence: ResponseEvidence[] = [];
    const result = await executeWorkflow({
      workflow,
      credentials,
      params: {},
      fetchImpl: (async () => response) as unknown as typeof fetch,
      onResponseEvidence: (entry) => evidence.push(entry),
    });
    expect(result.ok).toBeFalse();
    expect(evidence[0]?.readError).toBe('fixture read failed');
    expect(evidence[0]?.bodyText).toBeUndefined();
  });

  it('retains bodies before parser failure and ignores observer exceptions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imprint-response-parser-'));
    try {
      writeFileSync(
        join(dir, 'parser.ts'),
        'export function extract() { throw new Error("fixture parser failure"); }',
      );
      const evidence: ResponseEvidence[] = [];
      const result = await executeWorkflow({
        workflow: { ...workflow, parserModule: './parser.ts' },
        workflowPath: join(dir, 'workflow.json'),
        credentials,
        params: {},
        fetchImpl: (async () => new Response('retained')) as unknown as typeof fetch,
        onResponseEvidence: (entry) => {
          evidence.push(entry);
          throw new Error('observer failed');
        },
      });
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.message).toContain('fixture parser failure');
      expect(evidence).toHaveLength(2);
      const success = await executeWorkflow({
        workflow,
        credentials,
        params: {},
        fetchImpl: (async () => new Response('successful')) as unknown as typeof fetch,
        onResponseEvidence: () => {
          throw new Error('observer failed');
        },
      });
      expect(success.ok).toBeTrue();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists isolated attempt/backend/request files before the invocation finishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imprint-response-journal-'));
    try {
      const retained = ['fetch', 'cdp-replay'].flatMap((backend) =>
        [0, 1].map((requestIndex) =>
          retainResponseEvidence(dir, 'observation', 'candidate', {
            attemptId: `${backend}-attempt`,
            backend: backend as 'fetch' | 'cdp-replay',
            requestIndex,
            receivedAt: new Date().toISOString(),
            status: 200,
            bodyText: `${backend}-${requestIndex}`,
          }),
        ),
      );
      expect(new Set(retained.map(({ evidenceRef }) => evidenceRef)).size).toBe(4);
      expect(
        retained.map(({ evidenceRef }) =>
          readFileSync(retainedResponseEvidencePath(dir, 'observation', evidenceRef), 'utf8'),
        ),
      ).toEqual(['fetch-0', 'fetch-1', 'cdp-replay-0', 'cdp-replay-1']);
      const journal = readFileSync(join(dir, 'live-results/responses.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(journal).toHaveLength(4);
      expect(journal[0]).toMatchObject({
        observationId: 'observation',
        candidateSha256: 'candidate',
        backend: 'fetch',
        requestIndex: 0,
      });
      expect(journal[0].bodyText).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
