/**
 * End-to-end smoke test for the recorder. Launches a real Chromium, navigates
 * to example.com (zero anti-bot, zero auth), records for 2 seconds, then aborts
 * via AbortController and asserts the captured session is well-formed.
 *
 * Skipped when CI=true unless RUN_BROWSER_TESTS=1 is also set, because GitHub
 * Actions Ubuntu runners don't have Chrome at /usr/bin/google-chrome by default.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { record } from '../src/imprint/record.ts';

const SHOULD_RUN = process.env.CI !== 'true' || process.env.RUN_BROWSER_TESTS === '1';

describe('recorder e2e', () => {
  if (!SHOULD_RUN) {
    it.skip('skipped in CI: set RUN_BROWSER_TESTS=1 to enable', () => {});
    return;
  }

  it('captures a navigation to example.com', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();

    // Kick off the recording. It runs until ctrl.abort() fires.
    const recordPromise = record({
      site: 'test',
      url: 'https://example.com/',
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });

    // Give Chromium time to launch + load + finish all network requests.
    // example.com is ~1KB so this is generous.
    await sleep(5000);
    ctrl.abort();

    const result = await recordPromise;

    expect(result.jsonlPath).toBe(outPath);
    expect(existsSync(result.sessionPath)).toBe(true);
    expect(result.count).toBeGreaterThan(0);

    // Validate the assembled session through the same parser downstream tools use.
    const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
    const session = assembleFromJsonl(outPath);
    expect(session.site).toBe('test');
    expect(session.url).toBe('https://example.com/');
    expect(session.requests.length).toBeGreaterThan(0);

    const exampleRequest = session.requests.find((r) => r.url.includes('example.com'));
    expect(exampleRequest).toBeDefined();
    expect(exampleRequest?.method).toBe('GET');
    if (exampleRequest?.response) {
      expect(exampleRequest.response.status).toBeGreaterThanOrEqual(200);
      expect(exampleRequest.response.status).toBeLessThan(400);
    }

    // Hardening assertions added day 2.5 — cookie snapshots fire at start
    // and end so we know the auth state surrounding the captured workflow.
    expect(session.cookieSnapshots.length).toBeGreaterThanOrEqual(2);
    const startSnap = session.cookieSnapshots.find((s) => s.label === 'start');
    const endSnap = session.cookieSnapshots.find((s) => s.label === 'end');
    expect(startSnap).toBeDefined();
    expect(endSnap).toBeDefined();

    rmSync(tmp, { recursive: true, force: true });
  }, 30_000);

  it('check verb reports a session without erroring', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();

    const recordPromise = record({
      site: 'check-test',
      url: 'https://example.com/',
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });

    await sleep(3500);
    ctrl.abort();
    await recordPromise;

    const { checkSession } = await import('../src/imprint/check.ts');
    const result = checkSession(outPath.replace(/\.jsonl$/, '.json'));
    // We expect at least the no-narration warning. Capture is otherwise sound.
    expect(result.summary).toContain('site:        check-test');
    expect(result.summary).toContain('cookies:');
    expect(result.warnings.some((w) => /narration/i.test(w))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  }, 30_000);
});
