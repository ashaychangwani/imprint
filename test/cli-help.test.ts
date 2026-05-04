/**
 * Drift-guard for the CLI verb / per-verb-help registry. The dispatcher
 * `switch (verb) { case '<name>': ... }` and the VERB_HELP map must
 * stay in sync — adding a verb but not its help (or vice versa) leaves
 * a real user staring at "No help for unknown verb" or a broken `--help`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { VERB_HELP } from '../src/cli.ts';

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
  for (const x of ['fetch', 'stealth-fetch', 'playbook', 'auto']) set.delete(x);
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
