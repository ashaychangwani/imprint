import { describe, expect, it } from 'bun:test';
import { resolve as pathResolve } from 'node:path';
import { VERB_HELP } from '../src/cli.ts';
import type { ProviderStatus } from '../src/imprint/llm.ts';
import { localSiteDir } from '../src/imprint/paths.ts';
import {
  buildTeachProviderPickerOptions,
  buildTeachStateFromSession,
  promptForTeachProvider,
  resolveTeachStatePath,
} from '../src/imprint/teach.ts';

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
    expect(flags).toContain('--all-tools');
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

describe('teach session state helpers', () => {
  const originalImprintHome = process.env.IMPRINT_HOME;

  function withImprintHome<T>(path: string, fn: () => T): T {
    process.env.IMPRINT_HOME = path;
    try {
      return fn();
    } finally {
      if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
      else process.env.IMPRINT_HOME = originalImprintHome;
    }
  }

  it('treats blank stored session paths as missing', () => {
    expect(resolveTeachStatePath('google-flights', '')).toBeNull();
    expect(resolveTeachStatePath('google-flights', '   ')).toBeNull();
    expect(resolveTeachStatePath('google-flights', undefined)).toBeNull();
  });

  it('resolves relative state paths under ~/.imprint and preserves absolute paths', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      const relative = resolveTeachStatePath('google-flights', 'sessions/one.json');
      expect(relative).toBe(
        pathResolve('/tmp', 'imprint-home', 'google-flights', 'sessions/one.json'),
      );
    });

    const absolute = pathResolve('/tmp', 'session.json');
    expect(resolveTeachStatePath('google-flights', absolute)).toBe(absolute);
  });

  it('builds --from-session checkpoint state with the real session path', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      const sessionPath = pathResolve(
        localSiteDir('google-flights'),
        'sessions',
        '2026-05-08T09-24-14-916Z.json',
      );
      const redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
      const state = buildTeachStateFromSession('google-flights', sessionPath, redactedPath);

      expect(state.sessionPath).toBe('sessions/2026-05-08T09-24-14-916Z.json');
      expect(state.redactedPath).toBe('sessions/2026-05-08T09-24-14-916Z.redacted.json');
      expect(state.completedSteps).toEqual(['record', 'redact']);
    });
  });

  it('builds --from-session checkpoint state before redaction has run', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      const sessionPath = pathResolve(
        localSiteDir('google-flights'),
        'sessions',
        '2026-05-08T09-24-14-916Z.json',
      );
      const state = buildTeachStateFromSession('google-flights', sessionPath, null);

      expect(state.sessionPath).toBe('sessions/2026-05-08T09-24-14-916Z.json');
      expect(state.redactedPath).toBeUndefined();
      expect(state.completedSteps).toEqual(['record']);
    });
  });
});
