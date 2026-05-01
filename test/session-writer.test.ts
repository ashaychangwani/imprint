/**
 * Pure I/O tests for the session writer + assembler.
 * No CDP, no Chromium, no network — just JSONL round-trip + body merge logic.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { assembleFromJsonl, createSessionWriter } from '../src/imprint/session-writer.ts';
import type { CapturedEvent, CapturedRequest, Narration } from '../src/imprint/types.ts';

const META = {
  site: 'unit',
  url: 'https://example.com/',
  imprintVersion: '0.1.0',
  startedAt: '2026-04-30T00:00:00.000Z',
};

const sampleRequest = (seq: number): CapturedRequest => ({
  seq,
  timestamp: seq * 100,
  method: 'GET',
  url: `https://example.com/r${seq}`,
  headers: { 'user-agent': 'imprint-test' },
  resourceType: 'XHR',
  response: { status: 200, headers: { 'content-type': 'text/html' }, mimeType: 'text/html' },
});

const sampleEvent = (seq: number): CapturedEvent => ({
  seq,
  timestamp: seq * 100,
  type: 'navigation',
  detail: 'https://example.com/page',
});

const sampleNarration = (seq: number, text: string): Narration => ({
  seq,
  timestamp: seq * 100,
  text,
});

describe('session writer', () => {
  it('round-trips meta + requests + events + narration through JSONL', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-sw-'));
    const jsonlPath = pathJoin(tmp, 'session.jsonl');

    const w = createSessionWriter(jsonlPath, META);
    w.request(sampleRequest(0));
    w.event(sampleEvent(1));
    w.narration(sampleNarration(2, 'i clicked the search button'));
    w.request(sampleRequest(3));
    const { sessionPath } = await w.close();

    expect(existsSync(jsonlPath)).toBe(true);
    expect(existsSync(sessionPath)).toBe(true);

    const session = assembleFromJsonl(jsonlPath);
    expect(session.site).toBe('unit');
    expect(session.requests.length).toBe(2);
    expect(session.events.length).toBe(1);
    expect(session.narration.length).toBe(1);
    expect(session.narration[0]?.text).toBe('i clicked the search button');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('merges late-arriving request-body records into the matching request by seq', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-sw-'));
    const jsonlPath = pathJoin(tmp, 'session.jsonl');

    const w = createSessionWriter(jsonlPath, META);
    w.request(sampleRequest(0));
    w.request(sampleRequest(1));
    // Body for the first request arrives later (after the second was already written).
    w.requestBody(0, '<html>hello</html>');
    w.requestBody(1, '<html>two</html>');
    await w.close();

    const session = assembleFromJsonl(jsonlPath);
    expect(session.requests.length).toBe(2);
    expect(session.requests[0]?.response?.body).toBe('<html>hello</html>');
    expect(session.requests[1]?.response?.body).toBe('<html>two</html>');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('drops a request-body record whose seq has no matching request', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-sw-'));
    const jsonlPath = pathJoin(tmp, 'session.jsonl');

    const w = createSessionWriter(jsonlPath, META);
    w.request(sampleRequest(0));
    w.requestBody(99, '<html>orphan</html>'); // no request with seq=99
    await w.close();

    const session = assembleFromJsonl(jsonlPath);
    expect(session.requests.length).toBe(1);
    expect(session.requests[0]?.response?.body).toBeUndefined();

    rmSync(tmp, { recursive: true, force: true });
  });

  it('produces a parseable JSONL even mid-stream (simulated crash)', async () => {
    // We don't actually crash bun — we just write a partial JSONL by writing the
    // meta header + a few records and reading without calling close().
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-sw-'));
    const jsonlPath = pathJoin(tmp, 'session.jsonl');

    const w = createSessionWriter(jsonlPath, META);
    w.request(sampleRequest(0));
    w.event(sampleEvent(1));
    // Wait for the writes to flush, then read directly without closing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const partial = readFileSync(jsonlPath, 'utf8');
    const lines = partial.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      // Each line must be valid JSON on its own.
      expect(() => JSON.parse(line)).not.toThrow();
    }

    await w.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws clearly when the JSONL has no meta header', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-sw-'));
    const jsonlPath = pathJoin(tmp, 'session.jsonl');
    require('node:fs').writeFileSync(
      jsonlPath,
      `${JSON.stringify({ kind: 'request', data: sampleRequest(0) })}\n`,
    );
    expect(() => assembleFromJsonl(jsonlPath)).toThrow(/no meta header/);
    rmSync(tmp, { recursive: true, force: true });
  });
});
