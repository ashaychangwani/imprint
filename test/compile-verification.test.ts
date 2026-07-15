import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  type LiveIntegrationEvidence,
  readLiveIntegrationEvidence,
  runCapturedIntegrationCase,
} from '../src/imprint/compile-verification.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compile live evidence', () => {
  it('reads the actual tool-level input and parsed result from JSONL', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-evidence-'));
    dirs.push(dir);
    const path = pathJoin(dir, 'evidence.jsonl');
    const evidence = {
      schemaVersion: 1,
      kind: 'call',
      label: 'baseline-search',
      caseName: 'baseline search',
      toolName: 'search_products',
      requestedParams: { query: 'tires' },
      effectiveParams: { query: 'tires', limit: 10 },
      result: { ok: true, data: { items: [{ name: 'All-season tire' }] } },
      usedBackend: 'fetch',
      attempts: [{ backend: 'fetch', outcome: 'ok', detail: 'HTTP 200', durationMs: 25 }],
      durationMs: 28,
    } satisfies LiveIntegrationEvidence;
    writeFileSync(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    expect(readLiveIntegrationEvidence(path)).toEqual([evidence]);
  });

  it('rejects malformed evidence instead of silently approving an empty record', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-evidence-'));
    dirs.push(dir);
    const path = pathJoin(dir, 'evidence.jsonl');
    writeFileSync(path, '{"schemaVersion":1}\n', 'utf8');
    expect(() => readLiveIntegrationEvidence(path)).toThrow(
      'invalid live integration evidence record',
    );
  });

  it('pins final verification to the cached preferred backend without ladder exploration', async () => {
    const previousSpacing = process.env.IMPRINT_COMPILE_ACT_SPACING_MS;
    process.env.IMPRINT_COMPILE_ACT_SPACING_MS = '0';
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('blocked', { status: 403 }),
    });
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-preferred-backend-'));
    dirs.push(root);
    const toolDir = pathJoin(root, 'fixture-site', 'search_fixture');
    mkdirSync(toolDir, { recursive: true });
    const workflowPath = pathJoin(toolDir, 'workflow.json');
    writeFileSync(
      workflowPath,
      JSON.stringify({
        toolName: 'search_fixture',
        intent: { description: 'Search a fixture.' },
        parameters: [],
        requests: [{ method: 'GET', url: `http://127.0.0.1:${server.port}/search`, headers: {} }],
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(toolDir, 'backends.json'),
      JSON.stringify({
        probedAt: new Date().toISOString(),
        imprintVersion: '0.1.0',
        preferredOrder: ['fetch'],
        results: { fetch: { outcome: 'ok', durationMs: 10 } },
      }),
    );
    try {
      const run = await runCapturedIntegrationCase({
        caseName: 'preferred-only',
        workflowPath,
        params: {},
        preferredOnlyBackend: true,
      });
      expect(run.result.ok).toBe(false);
      expect(run.usedBackend).toBe('fetch');
      expect(run.attempts.map((attempt) => attempt.backend)).toEqual(['fetch']);
    } finally {
      server.stop(true);
      if (previousSpacing === undefined) process.env.IMPRINT_COMPILE_ACT_SPACING_MS = undefined;
      else process.env.IMPRINT_COMPILE_ACT_SPACING_MS = previousSpacing;
    }
  });

  it('requires backend preparation instead of probing inside a preferred-only case', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-preferred-backend-'));
    dirs.push(root);
    const toolDir = pathJoin(root, 'fixture-site', 'search_fixture');
    mkdirSync(toolDir, { recursive: true });
    const workflowPath = pathJoin(toolDir, 'workflow.json');
    writeFileSync(
      workflowPath,
      JSON.stringify({
        toolName: 'search_fixture',
        intent: { description: 'Search a fixture.' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://example.com/search', headers: {} }],
        site: 'fixture-site',
      }),
    );
    await expect(
      runCapturedIntegrationCase({
        caseName: 'unprepared',
        workflowPath,
        params: {},
        preferredOnlyBackend: true,
      }),
    ).rejects.toThrow('call prepare_live_backend');
  });
});
