/**
 * Tests for the IMPRINT_PROXY helpers (no real Chromium / network) — proxyUrl()
 * env handling and chromeProxyArg() credential stripping for --proxy-server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chromeProxyArg, proxyUrl } from '../src/imprint/chromium.ts';

describe('proxyUrl (IMPRINT_PROXY env)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.IMPRINT_PROXY;
  });
  afterEach(() => {
    // env vars are strings; restore to the prior value or blank (proxyUrl treats
    // blank as "no proxy", so '' is equivalent to unset for its contract).
    process.env.IMPRINT_PROXY = saved ?? '';
  });

  it('treats blank/whitespace as no proxy', () => {
    process.env.IMPRINT_PROXY = '';
    expect(proxyUrl()).toBeUndefined();
    process.env.IMPRINT_PROXY = '   ';
    expect(proxyUrl()).toBeUndefined();
  });

  it('returns the trimmed proxy URL when set', () => {
    process.env.IMPRINT_PROXY = '  http://resi.example.com:8000  ';
    expect(proxyUrl()).toBe('http://resi.example.com:8000');
  });
});

describe('chromeProxyArg (strip creds for --proxy-server)', () => {
  it('keeps scheme://host:port and drops inline credentials', () => {
    expect(chromeProxyArg('http://user:pass@resi.example.com:8000')).toBe(
      'http://resi.example.com:8000',
    );
  });

  it('passes through a plain host:port', () => {
    expect(chromeProxyArg('resi.example.com:8000')).toBe('resi.example.com:8000');
  });

  it('supports socks5 scheme', () => {
    expect(chromeProxyArg('socks5://10.0.0.1:1080')).toBe('socks5://10.0.0.1:1080');
  });

  it('returns null for an unparseable value', () => {
    expect(chromeProxyArg('not a proxy')).toBeNull();
  });
});
