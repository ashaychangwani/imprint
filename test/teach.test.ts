import { describe, expect, it } from 'bun:test';
import { VERB_HELP } from '../src/cli.ts';
import type { ProviderStatus } from '../src/imprint/llm.ts';
import { buildTeachProviderPickerOptions, promptForTeachProvider } from '../src/imprint/teach.ts';

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

describe('teach provider picker', () => {
  const statuses: ProviderStatus[] = [
    {
      name: 'claude-cli',
      detected: true,
      availableForTeach: true,
      reason: 'claude found',
      setupHint: 'install claude',
    },
    {
      name: 'codex-cli',
      detected: false,
      availableForTeach: false,
      reason: 'codex missing',
      setupHint: 'run codex login',
    },
    {
      name: 'cursor-cli',
      detected: true,
      availableForTeach: false,
      reason: 'cursor detected but unsupported',
      setupHint: 'enable cursor',
    },
  ];

  it('shows detected providers plus setup/help entries for unavailable providers', () => {
    const options = buildTeachProviderPickerOptions(statuses);
    expect(options.map((o) => o.value)).toEqual([
      'use:claude-cli',
      'setup:codex-cli',
      'setup:cursor-cli',
    ]);
    expect(options[1]?.label).toContain('not detected');
    expect(options[2]?.label).toContain('not available for teach');
  });

  it('loops back after an unavailable provider is selected for setup help', async () => {
    const notes: string[] = [];
    const choices = ['setup:codex-cli', 'use:claude-cli'];
    const provider = await promptForTeachProvider(statuses, {
      select: async () => choices.shift() ?? 'use:claude-cli',
      note: (message) => notes.push(message),
      isCancel: () => false,
    });

    expect(provider).toBe('claude-cli');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('run codex login');
  });
});
