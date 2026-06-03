/**
 * Tests for the cdp-browser jar cache + recorded-session seeding. No real
 * Chromium/network — synthetic jars and session JSON in a tmp site dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MintedJar } from '../src/imprint/cdp-browser-fetch.ts';
import {
  JAR_MAX_AGE_SECONDS,
  clearJar,
  loadJar,
  saveJar,
  seedJarFromRecording,
} from '../src/imprint/cdp-jar-cache.ts';

let siteDir: string;
beforeEach(() => {
  siteDir = mkdtempSync(join(tmpdir(), 'imprint-jar-'));
});
afterEach(() => {
  rmSync(siteDir, { recursive: true, force: true });
});

function validJar(): MintedJar {
  return {
    cookies: [{ name: '_abck', value: 'X~0~Y', domain: '.example.com', path: '/' }],
    ua: 'UA/148',
    html: '',
    bootstrapEpoch: Date.now(),
    abckFlag: '0',
  };
}

describe('cdp-jar-cache loadJar/saveJar/clearJar', () => {
  it('round-trips a fresh validated jar', () => {
    saveJar(siteDir, validJar());
    const j = loadJar(siteDir);
    expect(j?.abckFlag).toBe('0');
    expect(j?.cookies).toHaveLength(1);
  });

  it('rejects an aged-out jar', () => {
    const j = validJar();
    j.bootstrapEpoch = Date.now() - (JAR_MAX_AGE_SECONDS + 10) * 1000;
    saveJar(siteDir, j);
    expect(loadJar(siteDir)).toBeNull();
  });

  it('rejects a non-validated (_abck != 0) jar', () => {
    const j = validJar();
    j.abckFlag = '-1';
    saveJar(siteDir, j);
    expect(loadJar(siteDir)).toBeNull();
  });

  it('clearJar removes the cached jar', () => {
    saveJar(siteDir, validJar());
    clearJar(siteDir);
    expect(loadJar(siteDir)).toBeNull();
  });
});

describe('seedJarFromRecording', () => {
  function writeSession(name: string, body: unknown): void {
    const sessions = join(siteDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, name), JSON.stringify(body));
  }

  it('seeds from a fresh recording with a validated _abck', () => {
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [
            { name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' },
            { name: 'sess', value: 's', domain: '.example.com', path: '/' },
          ],
        },
      ],
      requests: [{ requestHeaders: { 'User-Agent': 'RealChrome/148' } }],
    });
    expect(seedJarFromRecording(siteDir)).toBe(true);
    const j = loadJar(siteDir);
    expect(j?.cookies).toHaveLength(2);
    expect(j?.ua).toBe('RealChrome/148');
    expect(j?.abckFlag).toBe('0');
  });

  it('does NOT seed from a recording with neither _abck~0~ nor bm_sv', () => {
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~-1~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [],
    });
    expect(seedJarFromRecording(siteDir)).toBe(false);
    expect(loadJar(siteDir)).toBeNull();
  });

  it('SEEDS a recording whose _abck rotated to ~-1~ but carries bm_sv (validated session)', () => {
    // Real recordings often end with _abck~-1~ (it rotates after clearing the
    // .act) yet still carry bm_sv — the validated-session marker. That jar
    // replays fine live, so it must seed (regression guard for the over-strict
    // _abck==='0' gate that wrongly rejected a valid recording).
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [
            { name: '_abck', value: 'T~-1~Z', domain: '.example.com', path: '/' },
            { name: 'bm_sv', value: 'V', domain: '.example.com', path: '/' },
            { name: 'ak_bmsc', value: 'A', domain: '.example.com', path: '/' },
          ],
        },
      ],
      requests: [{ requestHeaders: { 'User-Agent': 'RealChrome/148' } }],
    });
    expect(seedJarFromRecording(siteDir)).toBe(true);
    const j = loadJar(siteDir);
    expect(j).not.toBeNull();
    expect(j?.validated).toBe(true);
    expect(j?.cookies.some((c) => c.name === 'bm_sv')).toBe(true);
  });

  it('ignores .redacted/.triaged sessions and returns false when none usable', () => {
    writeSession('2026-06-02T00-00-00-000Z.redacted.json', { cookieSnapshots: [], requests: [] });
    writeSession('2026-06-02T00-00-00-000Z.triaged.json', { cookieSnapshots: [], requests: [] });
    expect(seedJarFromRecording(siteDir)).toBe(false);
  });

  it("seeded jar's bootstrapEpoch is the recording's file mtime (not Date.now)", () => {
    // Load-bearing: the cached jar ages out against the RECORDING's mtime, not
    // when it was seeded — a regression to Date.now() would mask jar staleness.
    const name = '2026-06-02T00-00-00-000Z.json';
    writeSession(name, {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [{ requestHeaders: { 'User-Agent': 'RealChrome/148' } }],
    });
    const mtimeMs = statSync(join(siteDir, 'sessions', name)).mtimeMs;
    expect(seedJarFromRecording(siteDir)).toBe(true);
    const j = loadJar(siteDir);
    expect(j).not.toBeNull();
    expect(Math.abs((j?.bootstrapEpoch ?? 0) - mtimeMs)).toBeLessThan(1000);
  });

  it('does NOT seed from a recording older than JAR_MAX_AGE_SECONDS', () => {
    const name = '2026-06-02T00-00-00-000Z.json';
    writeSession(name, {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [{ requestHeaders: { 'User-Agent': 'RealChrome/148' } }],
    });
    const old = new Date(Date.now() - (JAR_MAX_AGE_SECONDS + 60) * 1000);
    utimesSync(join(siteDir, 'sessions', name), old, old);
    expect(seedJarFromRecording(siteDir)).toBe(false);
    expect(loadJar(siteDir)).toBeNull();
  });

  it('seeds an empty UA (no recorded User-Agent) without throwing', () => {
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [{ requestHeaders: { Accept: '*/*' } }],
    });
    expect(seedJarFromRecording(siteDir)).toBe(true);
    expect(loadJar(siteDir)?.ua).toBe('');
  });

  it('seeds jar.html from the recorded Document body (Fix 1: html_regex captures can resolve)', () => {
    // Regression for the html:'' bug: a workflow whose .act references
    // ${state.csrf_token}/${state.csp_nonce} from html_regex bootstrap captures
    // STATE_MISSINGs on the recording-seed path unless jar.html carries the page.
    const pageHtml =
      '<html><head><script nonce="aabbccddeeff00112233445566778899">x</script>' +
      'mUtil.createSecureCookie("Csrf-token", "0123456789abcdef0123456789abcdef");</head></html>';
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [
            { name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' },
            { name: 'bm_sv', value: 'V', domain: '.example.com', path: '/' },
          ],
        },
      ],
      requests: [
        { requestHeaders: { 'User-Agent': 'RealChrome/148' } },
        {
          url: 'https://www.example.com/',
          resourceType: 'Document',
          response: { status: 200, mimeType: 'text/html;charset=UTF-8', body: pageHtml },
        },
      ],
    });
    expect(seedJarFromRecording(siteDir)).toBe(true);
    const j = loadJar(siteDir);
    expect(j?.html).toBe(pageHtml);
    expect(j?.source).toBe('recording');
    // the same primitive jarBootstrapCaptureState uses must now resolve:
    expect(/nonce="([0-9a-f]{32})"/.exec(j?.html ?? '')?.[1]).toBe(
      'aabbccddeeff00112233445566778899',
    );
  });

  it('prefers the recorded response for the exact bootstrapUrl over the largest body', () => {
    const bootstrapBody = '<html>bootstrap nonce="11111111111111111111111111111111"</html>';
    const biggerOtherBody = `<html>${'x'.repeat(5000)} other</html>`;
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [
        { requestHeaders: { 'User-Agent': 'RealChrome/148' } },
        {
          url: 'https://www.example.com/other',
          resourceType: 'Document',
          response: { mimeType: 'text/html', body: biggerOtherBody },
        },
        {
          url: 'https://www.example.com/bootstrap',
          resourceType: 'Document',
          response: { mimeType: 'text/html', body: bootstrapBody },
        },
      ],
    });
    expect(seedJarFromRecording(siteDir, null, 'https://www.example.com/bootstrap')).toBe(true);
    expect(loadJar(siteDir)?.html).toBe(bootstrapBody);
  });

  it('falls back to the largest text/html Document body when bootstrapUrl is absent from the recording', () => {
    const small = '<html>small</html>';
    const large = `<html>${'y'.repeat(8000)}</html>`;
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [
        { requestHeaders: { 'User-Agent': 'RealChrome/148' } },
        {
          url: 'https://www.example.com/',
          resourceType: 'Document',
          response: { mimeType: 'text/html', body: small },
        },
        {
          url: 'https://www.example.com/h=3002',
          resourceType: 'Document',
          response: { mimeType: 'text/html', body: large },
        },
        // XHR with a body must be ignored (not a bootstrap Document page)
        {
          url: 'https://www.example.com/x.act',
          resourceType: 'XHR',
          response: { mimeType: 'text/html', body: `<html>${'z'.repeat(9000)}</html>` },
        },
      ],
    });
    // bootstrapUrl points at a page NOT in the recording → largest Document wins
    expect(seedJarFromRecording(siteDir, null, 'https://www.example.com/Rental-Cars')).toBe(true);
    expect(loadJar(siteDir)?.html).toBe(large);
  });

  it('seeds empty html without throwing when the recording has no Document body', () => {
    writeSession('2026-06-02T00-00-00-000Z.json', {
      cookieSnapshots: [
        {
          label: 'end',
          cookies: [{ name: '_abck', value: 'T~0~Z', domain: '.example.com', path: '/' }],
        },
      ],
      requests: [{ requestHeaders: { 'User-Agent': 'RealChrome/148' } }],
    });
    expect(seedJarFromRecording(siteDir)).toBe(true);
    expect(loadJar(siteDir)?.html).toBe('');
  });
});
