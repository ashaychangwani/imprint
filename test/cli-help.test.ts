/**
 * Drift-guard for the CLI verb / per-verb-help registry. The dispatcher
 * `switch (verb) { case '<name>': ... }` and the VERB_HELP map must
 * stay in sync — adding a verb but not its help (or vice versa) leaves
 * a real user staring at "No help for unknown verb" or a broken `--help`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  VERB_HELP,
  closestVerb,
  inferPlaybookSiteForSmokeCommand,
  tryParseParamKV,
} from '../src/cli.ts';

const CLI_SOURCE = readFileSync(pathResolve(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8');

const dispatcherVerbs = (() => {
  const set = new Set<string>();
  // Scrape `case '<verb>':` from the dispatcher switch.
  const re = /^\s+case '([a-z][a-z-]*)':/gm;
  let match: RegExpExecArray | null = re.exec(CLI_SOURCE);
  while (match !== null) {
    if (match[1]) set.add(match[1]);
    match = re.exec(CLI_SOURCE);
  }
  // Filter out the backend-ladder cases (they live in a different switch).
  for (const x of ['fetch', 'fetch-bootstrap', 'stealth-fetch', 'playbook', 'auto']) set.delete(x);
  // 'playbook' IS a real CLI verb too — re-add it (the filter was over-broad).
  set.add('playbook');
  return set;
})();

describe('CLI verb / VERB_HELP drift', () => {
  it('every dispatcher verb has a VERB_HELP entry', () => {
    const missing = [...dispatcherVerbs].filter((v) => !(v in VERB_HELP));
    expect(missing).toEqual([]);
  });

  it('every VERB_HELP entry corresponds to a real dispatcher verb', () => {
    const orphan = Object.keys(VERB_HELP).filter((v) => !dispatcherVerbs.has(v));
    expect(orphan).toEqual([]);
  });

  it.each(Object.keys(VERB_HELP))('%s help has a non-empty summary + example', (verb) => {
    const h = VERB_HELP[verb];
    expect(h?.summary.length).toBeGreaterThan(0);
    expect(h?.usage.length).toBeGreaterThan(0);
    expect(h?.example.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(VERB_HELP))('%s example starts with `imprint %s`', (verb) => {
    expect(VERB_HELP[verb]?.example.startsWith(`imprint ${verb}`)).toBe(true);
  });
});

describe('closestVerb (typo suggestions)', () => {
  it.each([
    ['recrod', 'record'],
    ['recor', 'record'],
    ['crn', 'cron'],
    ['mcpserver', 'mcp-server'],
    ['emt', 'emit'],
    ['doctr', 'doctor'],
  ])('%s → %s', (typo, expected) => {
    expect(closestVerb(typo)).toBe(expected);
  });

  it.each(['xyzzy', 'foobar', 'gen', 'aaaaaaaa'])('%s → null (too far from any verb)', (input) => {
    expect(closestVerb(input)).toBeNull();
  });

  it('returns the exact verb when input matches one', () => {
    expect(closestVerb('record')).toBe('record');
  });
});

describe('tryParseParamKV', () => {
  it('parses simple k=v pairs as strings', () => {
    expect(tryParseParamKV(['origin=SJC', 'dest=SAN'])).toEqual({
      origin: 'SJC',
      dest: 'SAN',
    });
  });

  it('coerces well-formed booleans', () => {
    expect(tryParseParamKV(['x=true', 'y=false'])).toEqual({ x: true, y: false });
  });

  it.each([
    ['count=5', { count: 5 }],
    ['price=10.5', { price: 10.5 }],
    ['neg=-7', { neg: -7 }],
    ['zero=0', { zero: 0 }],
    ['exp=1e3', { exp: 1000 }],
    ['negDecimal=-0.5', { negDecimal: -0.5 }],
  ])('coerces well-formed numbers: %s', (input, expected) => {
    expect(tryParseParamKV([input])).toEqual(expected);
  });

  it.each([
    // Leading-zero codes (airport, library card, ZIP) must stay strings.
    ['code=0123', { code: '0123' }],
    ['zip=00501', { zip: '00501' }],
    // Number(v) accepts these but they're almost certainly intended as strings.
    ['x=Infinity', { x: 'Infinity' }],
    ['x=-Infinity', { x: '-Infinity' }],
    ['x=NaN', { x: 'NaN' }],
    // Hex / binary / octal literals stay strings (Number() would parse hex).
    ['hex=0x1F', { hex: '0x1F' }],
    ['bin=0b10', { bin: '0b10' }],
    // Whitespace-only or whitespace-padded — Number(' 1 ') is 1; we don't want that.
    ['ws= 1 ', { ws: ' 1 ' }],
    // Empty value stays an empty string (allowed; matches old behavior).
    ['empty=', { empty: '' }],
    // Trailing-dot decimal (incomplete) stays string.
    ['weird=1.', { weird: '1.' }],
  ])('does NOT coerce ambiguous values: %s', (input, expected) => {
    expect(tryParseParamKV([input])).toEqual(expected);
  });

  it('returns null and prints to stderr on malformed entries (no =)', () => {
    expect(tryParseParamKV(['no_equals_sign'])).toBeNull();
  });

  it('handles undefined input as empty result', () => {
    expect(tryParseParamKV(undefined)).toEqual({});
  });

  it('keeps the first = as the separator (so values can contain =)', () => {
    expect(tryParseParamKV(['url=https://x.com?a=b'])).toEqual({
      url: 'https://x.com?a=b',
    });
  });
});

describe('inferPlaybookSiteForSmokeCommand', () => {
  it('infers the site from nested generated tool playbook paths', () => {
    expect(
      inferPlaybookSiteForSmokeCommand(
        '/Users/me/.imprint/webwidget-domains/search_domain_extensions/playbook.yaml',
        'search_domain_extensions',
      ),
    ).toBe('webwidget-domains');
  });

  it('keeps supporting old site-level playbook paths', () => {
    expect(
      inferPlaybookSiteForSmokeCommand(
        '/Users/me/.imprint/webwidget-domains/playbook.yaml',
        'search_domain_extensions',
      ),
    ).toBe('webwidget-domains');
  });
});
