import { describe, expect, it } from 'bun:test';
import { VERB_HELP } from '../src/cli.ts';

describe('teach verb', () => {
  it('has a VERB_HELP entry', () => {
    expect(VERB_HELP.teach).toBeDefined();
    expect(VERB_HELP.teach?.summary.length).toBeGreaterThan(0);
    expect(VERB_HELP.teach?.example.startsWith('imprint teach')).toBe(true);
  });

  it('VERB_HELP lists --url, --persist-profile, --no-interactive flags', () => {
    const flags = VERB_HELP.teach?.flags?.map((f) => f.name) ?? [];
    expect(flags).toContain('--url <url>');
    expect(flags).toContain('--persist-profile');
    expect(flags).toContain('--no-interactive');
  });
});
