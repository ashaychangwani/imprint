import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { VERB_HELP } from '../src/cli.ts';
import type { CompileAgentProgress } from '../src/imprint/compile-agent-types.ts';
import type { ProviderStatus } from '../src/imprint/llm.ts';
import { localSessionsDir, localSiteDir } from '../src/imprint/paths.ts';
import {
  type TeachState,
  type WorkflowState,
  discoverOrphanSession,
  pruneStalePendingTeachWorkflows,
} from '../src/imprint/teach-state.ts';
import {
  assertCandidateToolName,
  buildTeachProviderPickerOptions,
  buildTeachStateFromSession,
  formatAuthProgress,
  mapLimit,
  promptForTeachProvider,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
  updateCandidateStageCheckpoints,
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

  function workflowState(overrides: Partial<WorkflowState>): WorkflowState {
    return {
      sessionPath: 'sessions/2026-06-08T07-22-19-383Z.json',
      completedSteps: [],
      startedAt: '2026-06-08T07:52:26.823Z',
      updatedAt: '2026-06-08T07:52:26.823Z',
      ...overrides,
    };
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

  it('resolves explicit relative triaged paths under IMPRINT_HOME', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const state = workflowState({
        completedSteps: ['record', 'redact', 'triage'],
        triagedPath: 'sessions/2026-06-08T07-22-19-383Z.triaged.json',
      });

      expect(resolveWorkflowTriagedPath('yelp', state)).toBe(
        pathResolve(home, 'yelp', 'sessions', '2026-06-08T07-22-19-383Z.triaged.json'),
      );
    });
  });

  it('recovers legacy triaged paths from a redacted sibling file', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('yelp');
      mkdirSync(sessionsDir, { recursive: true });
      const triagedPath = pathResolve(sessionsDir, '2026-06-08T07-22-19-383Z.triaged.json');
      writeFileSync(triagedPath, '{}\n');

      const state = workflowState({
        completedSteps: ['record', 'redact', 'replay-and-diff', 'triage', 'detect-candidates'],
        redactedPath: 'sessions/2026-06-08T07-22-19-383Z.redacted.json',
      });

      expect(resolveWorkflowTriagedPath('yelp', state)).toBe(triagedPath);
    });
  });

  it('does not derive triaged paths when the sibling artifact is absent', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('yelp');
      mkdirSync(sessionsDir, { recursive: true });
      const state = workflowState({
        completedSteps: ['record', 'redact', 'replay-and-diff', 'triage', 'detect-candidates'],
        redactedPath: 'sessions/2026-06-08T07-22-19-383Z.redacted.json',
      });

      expect(resolveWorkflowTriagedPath('yelp', state)).toBeNull();
    });
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

  it('does not treat checked-in example sessions as resumable local teach state', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      expect(discoverOrphanSession('google-flights', { workflows: {} })).toBeNull();
    });
  });

  it('discovers orphan sessions from the active IMPRINT_HOME', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('google-flights');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(pathResolve(sessionsDir, '2026-05-08T09-24-14-916Z.json'), '{}\n');

      const state = discoverOrphanSession('google-flights', { workflows: {} });

      expect(state?.sessionPath).toBe('sessions/2026-05-08T09-24-14-916Z.json');
      expect(state?.completedSteps).toEqual(['record']);
    });
  });

  it('prunes stale pending workflows with no recoverable session when a completed workflow owns the same recording', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('yelp');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(pathResolve(sessionsDir, '2026-06-08T07-22-19-383Z.json'), '{}\n');
      writeFileSync(pathResolve(sessionsDir, '2026-06-08T07-22-19-383Z.redacted.json'), '{}\n');

      const state: TeachState = {
        workflows: {
          search_restaurants: {
            sessionPath: 'sessions/2026-06-08T07-22-19-383Z.json',
            redactedPath: 'sessions/2026-06-08T07-22-19-383Z.redacted.json',
            completedSteps: [
              'record',
              'redact',
              'replay-and-diff',
              'triage',
              'detect-candidates',
              'generate',
              'compile-playbook',
              'emit',
              'register',
            ],
            startedAt: '2026-06-08T07:52:26.823Z',
            updatedAt: '2026-06-08T08:05:19.644Z',
          },
          _pending_stale: {
            sessionPath: '',
            completedSteps: ['replay-and-diff', 'triage'],
            startedAt: '2026-06-08T07:52:26.835Z',
            updatedAt: '2026-06-08T07:52:26.836Z',
            classificationsPath: '.classifications.json',
            triagedPath: 'sessions/2026-06-08T07-22-19-383Z.triaged.json',
          },
        },
      };

      expect(pruneStalePendingTeachWorkflows('yelp', state)).toBe(true);
      expect(state.workflows._pending_stale).toBeUndefined();
      expect(state.workflows.search_restaurants).toBeDefined();
    });
  });

  it('preserves pending workflows that still have recoverable session files', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('yelp');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(pathResolve(sessionsDir, 'pending.json'), '{}\n');
      writeFileSync(pathResolve(sessionsDir, 'pending.redacted.json'), '{}\n');

      const state: TeachState = {
        workflows: {
          search_restaurants: {
            sessionPath: 'sessions/completed.json',
            redactedPath: 'sessions/completed.redacted.json',
            completedSteps: ['record', 'redact', 'generate', 'compile-playbook', 'emit'],
            startedAt: '2026-06-08T07:52:26.823Z',
            updatedAt: '2026-06-08T08:05:19.644Z',
          },
          _pending_valid: {
            sessionPath: 'sessions/pending.json',
            redactedPath: 'sessions/pending.redacted.json',
            completedSteps: ['record', 'redact'],
            startedAt: '2026-06-08T07:52:26.835Z',
            updatedAt: '2026-06-08T07:52:26.836Z',
          },
        },
      };

      expect(pruneStalePendingTeachWorkflows('yelp', state)).toBe(false);
      expect(state.workflows._pending_valid).toBeDefined();
    });
  });

  it('writes candidate-stage checkpoints to selected tool keys without recreating the pending key', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const state: TeachState = {
        workflows: {
          search_restaurants: {
            sessionPath: 'sessions/2026-06-08T07-22-19-383Z.json',
            redactedPath: 'sessions/2026-06-08T07-22-19-383Z.redacted.json',
            completedSteps: ['record', 'redact', 'detect-candidates'],
            startedAt: '2026-06-08T07:52:26.823Z',
            updatedAt: '2026-06-08T08:05:19.644Z',
          },
        },
      };

      updateCandidateStageCheckpoints({
        site: 'yelp',
        state,
        plans: [{ workflowKey: 'search_restaurants', startFrom: 'generate' }],
        fallbackWorkflowKey: '_pending_stale',
        replay: { classificationsPath: '.classifications.json' },
        triage: { triagedPath: 'sessions/2026-06-08T07-22-19-383Z.triaged.json' },
      });

      const ws = state.workflows.search_restaurants;
      expect(ws?.completedSteps).toContain('replay-and-diff');
      expect(ws?.completedSteps).toContain('triage');
      expect(ws?.classificationsPath).toBe('.classifications.json');
      expect(ws?.triagedPath).toBe('sessions/2026-06-08T07-22-19-383Z.triaged.json');
      expect(state.workflows._pending_stale).toBeUndefined();

      const persisted = readFileSync(
        pathResolve(localSiteDir('yelp'), '.teach-state.json'),
        'utf8',
      );
      expect(persisted).toContain('search_restaurants');
      expect(persisted).not.toContain('_pending_stale');
    });
  });
});

describe('teach candidate artifact validation', () => {
  const candidate = {
    toolName: 'search_domain_extensions',
    description: 'Search domain extensions',
    rationale: 'primary intent',
    confidence: 0.9,
    primary: true,
    requestSeqs: [133],
    representativeSeqs: [133],
    eventSeqs: [151],
    expectedOutput: 'domain results',
    likelyParams: [],
    dependencySeqs: [],
  };

  it('accepts matching artifact tool names', () => {
    expect(() =>
      assertCandidateToolName('Compiled playbook', 'search_domain_extensions', candidate),
    ).not.toThrow();
  });

  it('rejects playbook drift to another candidate before checkpointing', () => {
    expect(() =>
      assertCandidateToolName('Compiled playbook', 'add_domain_to_cart', candidate),
    ).toThrow(/does not match selected candidate/);
  });
});

describe('mapLimit', () => {
  it('waits for active work to settle before surfacing the first failure', async () => {
    const completed: number[] = [];
    const started: number[] = [];

    await expect(
      mapLimit([1, 2, 3], 2, async (item) => {
        started.push(item);
        if (item === 1) {
          await Bun.sleep(5);
          throw new Error('boom');
        }
        await Bun.sleep(20);
        completed.push(item);
        return item;
      }),
    ).rejects.toThrow('boom');

    expect(started).toEqual([1, 2]);
    expect(completed).toEqual([2]);
  });
});

describe('formatAuthProgress', () => {
  const base = (over: Partial<CompileAgentProgress> = {}): CompileAgentProgress => ({
    turn: 1,
    phase: 'tool',
    elapsedMs: 0,
    budgetMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    verificationCycle: 1,
    maxVerificationCycles: 1,
    ...over,
  });

  it('plain progress shows just the cumulative turn', () => {
    expect(formatAuthProgress(base({ turn: 29 }))).toBe('Auth compile: turn 29');
  });

  it('a failed verification surfaces phase, error, status, and attempt', () => {
    const s = formatAuthProgress(
      base({
        turn: 30,
        attempt: 2,
        maxAttempts: 5,
        lastVerification: {
          phase: 'initiate',
          ok: false,
          error: 'FORBIDDEN',
          status: 403,
          checkpoint: 'run_verification',
        },
      }),
    );
    expect(s).toContain('turn 30');
    expect(s).toContain('initiate FAILED');
    expect(s).toContain('FORBIDDEN');
    expect(s).toContain('HTTP 403');
    expect(s).toContain('attempt 2/5');
    expect(s).toContain('retrying');
  });

  it('a successful verification falls back to the plain turn line', () => {
    const s = formatAuthProgress(
      base({ turn: 31, lastVerification: { phase: 'complete', ok: true } }),
    );
    expect(s).toBe('Auth compile: turn 31');
  });

  it('omits the attempt suffix when attempt counts are absent', () => {
    const s = formatAuthProgress(
      base({ turn: 5, lastVerification: { phase: 'initiate', ok: false, error: 'NETWORK' } }),
    );
    expect(s).toContain('initiate FAILED');
    expect(s).toContain('NETWORK');
    expect(s).not.toContain('attempt');
  });

  it('the per-segment offset makes the turn monotonic (no reset across segments)', () => {
    // Mirrors runAuthSegmentLoop's wrap: turn = offset + perSegmentTurn.
    const wrap = (offset: number, perSegmentTurn: number): string =>
      formatAuthProgress(base({ turn: offset + perSegmentTurn }));
    // segment 1 ran 28 turns; segment 2 emits raw 1,2,3 → displayed 29,30,31.
    expect(wrap(28, 1)).toBe('Auth compile: turn 29');
    expect(wrap(28, 2)).toBe('Auth compile: turn 30');
    expect(wrap(28, 3)).toBe('Auth compile: turn 31');
  });
});
