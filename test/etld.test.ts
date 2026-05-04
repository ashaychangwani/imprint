/**
 * `registrableDomain` / `isSameRegistrableDomain` are the eTLD+1
 * helpers used by shrinkSession (compile.ts) and the stealth-fetch
 * cookie filter. The naive `split('.').slice(-2)` they replaced was
 * wrong for multi-part public suffixes (.co.uk, .com.au, .co.jp, etc.),
 * silently over-matching every other site under the same suffix.
 *
 * Tests pin both the common .com case and the multi-part suffixes that
 * caused the original bug.
 */

import { describe, expect, it } from 'bun:test';
import { isSameRegistrableDomain, registrableDomain } from '../src/imprint/etld.ts';

describe('registrableDomain', () => {
  it.each([
    // Standard single-suffix TLDs
    ['example.com', 'example.com'],
    ['www.example.com', 'example.com'],
    ['api.v2.example.com', 'example.com'],
    ['example.org', 'example.org'],
    ['example.io', 'example.io'],
    // 2-letter ccTLDs without multi-part suffix → treated as single
    ['example.de', 'example.de'],
    ['example.fr', 'example.fr'],
    // Multi-part ccTLDs — the bug-fix cases
    ['example.co.uk', 'example.co.uk'],
    ['api.example.co.uk', 'example.co.uk'],
    ['cdn.api.example.co.uk', 'example.co.uk'],
    ['example.com.au', 'example.com.au'],
    ['example.co.jp', 'example.co.jp'],
    ['example.com.br', 'example.com.br'],
    ['example.co.za', 'example.co.za'],
    ['example.co.in', 'example.co.in'],
    ['example.com.cn', 'example.com.cn'],
    ['example.co.nz', 'example.co.nz'],
    // UK government suffixes
    ['service.gov.uk', 'service.gov.uk'],
    ['my.service.gov.uk', 'service.gov.uk'],
    // Bare hosts pass through
    ['localhost', 'localhost'],
    ['intranet', 'intranet'],
    // IPs pass through unchanged
    ['127.0.0.1', '127.0.0.1'],
    ['10.0.0.1', '10.0.0.1'],
    ['192.168.1.100', '192.168.1.100'],
    // Empty string returns empty string
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });
});

describe('isSameRegistrableDomain', () => {
  it('returns true for exact match', () => {
    expect(isSameRegistrableDomain('example.com', 'example.com')).toBe(true);
  });

  it('returns true for subdomain match', () => {
    expect(isSameRegistrableDomain('api.example.com', 'example.com')).toBe(true);
    expect(isSameRegistrableDomain('cdn.api.example.com', 'example.com')).toBe(true);
  });

  it('returns false for unrelated domain', () => {
    expect(isSameRegistrableDomain('other.com', 'example.com')).toBe(false);
  });

  it('returns false for prefix-but-not-subdomain (substring trap)', () => {
    // myexample.com is NOT a subdomain of example.com — the leading dot matters.
    expect(isSameRegistrableDomain('myexample.com', 'example.com')).toBe(false);
    expect(isSameRegistrableDomain('notexample.com', 'example.com')).toBe(false);
  });

  it('discriminates correctly under multi-part suffixes (the bug-fix case)', () => {
    // Pre-fix bug: rootDomain('api.example.co.uk') returned 'co.uk',
    // so endsWith('co.uk') matched both example.co.uk AND
    // unrelated-other.co.uk. With the new helpers:
    expect(isSameRegistrableDomain('api.example.co.uk', 'example.co.uk')).toBe(true);
    expect(isSameRegistrableDomain('api.unrelated.co.uk', 'example.co.uk')).toBe(false);
    expect(isSameRegistrableDomain('co.uk', 'example.co.uk')).toBe(false);
  });
});
