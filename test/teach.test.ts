import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { VERB_HELP } from '../src/cli.ts';
import type {
  CompileAgentProgress,
  CompileAgentResult,
} from '../src/imprint/compile-agent-types.ts';
import type { ProviderStatus } from '../src/imprint/llm.ts';
import { localSessionsDir, localSiteDir } from '../src/imprint/paths.ts';
import {
  type TeachState,
  type WorkflowState,
  discoverOrphanSession,
  loadTeachState,
  pruneStalePendingTeachWorkflows,
  toRelativeTeachStatePath,
} from '../src/imprint/teach-state.ts';
import {
  assertCandidateToolName,
  assertSuccessfulAuthCompile,
  authCompileLlmConfig,
  authCompletionMatches,
  buildTeachCandidatePicker,
  buildTeachProviderPickerOptions,
  buildTeachStateFromSession,
  finalizeTeachCandidateSelection,
  formatAuthProgress,
  formatTeachCandidateAutoAddNotice,
  hasDurableAuthState,
  loadCachedClassificationsForSession,
  mapLimit,
  mergeReplayCandidateDependencies,
  promptForTeachProvider,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
  resolvedArtifactCheckpointPath,
  selectCompileSessionArtifact,
  selectCompleteAuthCredentials,
  selectPrimaryNamedResult,
  selectTeachCandidates,
  updateCandidateStageCheckpoints,
} from '../src/imprint/teach.ts';
import {
  deriveStructuralCandidateDependencies,
  validateToolCandidateDetection,
} from '../src/imprint/tool-candidates.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

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
    expect(flags).toContain('--primary-tool');
    expect(flags).toContain('--tool <toolName>');
  });

  it('documents all-tools as the default and --primary-tool as the narrowing flag', () => {
    const flags = new Map(VERB_HELP.teach?.flags?.map((flag) => [flag.name, flag.description]));
    expect(flags.get('--no-interactive')).toContain('all detected tools');
    expect(flags.get('--all-tools')).toContain('default');
    expect(flags.get('--primary-tool')).toContain('upstream dependencies');
  });
});

describe('teach auth compile boundary', () => {
  const result = (overrides: Partial<CompileAgentResult>): CompileAgentResult => ({
    success: false,
    outcome: 'error',
    message: 'fixture auth failure',
    conversationLogPath: '/tmp/fixture-auth-log.json',
    turns: 1,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  });

  it('rejects failed auth before data tools can compile', () => {
    expect(() => assertSuccessfulAuthCompile(result({}))).toThrow(
      'Auth agent did not complete successfully: fixture auth failure',
    );
  });

  it('rejects an auth success that produced no workflow', () => {
    expect(() =>
      assertSuccessfulAuthCompile(result({ success: true, outcome: 'done', message: 'done' })),
    ).toThrow('Auth agent reported success without producing workflow.json.');
  });

  it('accepts a verified auth workflow', () => {
    expect(() =>
      assertSuccessfulAuthCompile(
        result({
          success: true,
          outcome: 'done',
          message: 'done',
          workflowPath: '/tmp/authenticate_fixture/workflow.json',
        }),
      ),
    ).not.toThrow();
  });

  it('passes the selected provider and model into auth compilation', () => {
    expect(authCompileLlmConfig('codex-cli', 'gpt-5.6-terra')).toEqual({
      provider: 'codex-cli',
      model: 'gpt-5.6-terra',
    });
  });

  it('reuses auth completion only while the plan and workflow hashes match', () => {
    const completion = {
      toolName: 'authenticate_fixture',
      buildPlanHash: 'plan-a',
      workflowHash: 'workflow-a',
      completedAt: '2026-07-11T00:00:00.000Z',
    };
    expect(authCompletionMatches(completion, completion)).toBe(true);
    expect(authCompletionMatches(completion, { ...completion, buildPlanHash: 'plan-b' })).toBe(
      false,
    );
    expect(authCompletionMatches(completion, { ...completion, workflowHash: 'workflow-b' })).toBe(
      false,
    );
  });

  it('requires declared persisted auth state instead of counting input credentials', () => {
    const workflow = WorkflowSchema.parse({
      toolName: 'authenticate_fixture',
      toolKind: 'authenticate',
      site: 'fixture',
      intent: { description: 'fixture auth' },
      parameters: [],
      requests: [],
      authConfig: { entry: 'start', persist: ['authorization'], actions: {} },
    });
    expect(
      hasDurableAuthState(workflow, {
        values: { username: 'user', password: 'pass' },
        cookies: [],
      }),
    ).toBe(false);
    expect(hasDurableAuthState(workflow, { values: { authorization: 'token' }, cookies: [] })).toBe(
      true,
    );
  });
});

describe('teach auth credential precedence', () => {
  it('selects a complete stored set and ignores unrelated credentials', () => {
    expect(
      selectCompleteAuthCredentials(
        { username: 'fixture-user', password: 'fixture-password', unused: 'extra' },
        ['username', 'password'],
      ),
    ).toEqual({ username: 'fixture-user', password: 'fixture-password' });
  });

  it('rejects a partial or blank stored set so another source can be used', () => {
    expect(
      selectCompleteAuthCredentials({ username: 'fixture-user' }, ['username', 'password']),
    ).toBeNull();
    expect(
      selectCompleteAuthCredentials({ username: 'fixture-user', password: '' }, [
        'username',
        'password',
      ]),
    ).toBeNull();
  });

  it('accepts an empty requirement for credential-free auth', () => {
    expect(selectCompleteAuthCredentials({ unused: 'extra' }, [])).toEqual({});
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

  it('normalizes shared context saved before neutral auth fields existed', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const siteDir = localSiteDir('legacy-auth');
      mkdirSync(siteDir, { recursive: true });
      writeFileSync(
        pathResolve(siteDir, '.teach-state.json'),
        JSON.stringify({
          workflows: {
            search: workflowState({
              sharedContext: {
                loginRequestSeqs: [5],
                credentialNames: ['username'],
                twoFactorType: 'push',
              } as unknown as WorkflowState['sharedContext'],
            }),
          },
        }),
      );

      const context = loadTeachState('legacy-auth').workflows.search?.sharedContext;
      expect(context?.authRequestSeqs).toEqual([]);
      expect(context?.authNotes).toBe('');
      expect(context).not.toHaveProperty('twoFactorType');
    });
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

  it('recovers the original artifact from a repeated triaged path', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    withImprintHome(home, () => {
      const sessionsDir = localSessionsDir('remitly');
      mkdirSync(sessionsDir, { recursive: true });
      const original = pathResolve(sessionsDir, 'capture.triaged.json');
      writeFileSync(original, '{}\n');

      const state = workflowState({
        completedSteps: ['record', 'redact', 'replay-and-diff', 'triage'],
        triagedPath: 'sessions/capture.triaged.triaged.json',
      });

      expect(resolveWorkflowTriagedPath('remitly', state)).toBe(original);
    });
  });

  it('uses the persisted triaged artifact for bounded compile resumes', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    const persisted = pathResolve(home, 'capture.filtered.json');
    const redacted = pathResolve(home, 'capture.redacted.json');
    writeFileSync(persisted, '{}\n');
    writeFileSync(redacted, '{}\n');
    writeFileSync(pathResolve(home, 'capture.triaged.json'), '{}\n');

    expect(selectCompileSessionArtifact(persisted, redacted)).toEqual({
      path: persisted,
      triaged: true,
    });
  });

  it('falls back when a persisted triaged artifact is stale', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-teach-'));
    const stale = pathResolve(home, 'missing.filtered.json');
    const redacted = pathResolve(home, 'capture.redacted.json');
    const derived = pathResolve(home, 'capture.triaged.json');
    writeFileSync(redacted, '{}\n');
    writeFileSync(derived, '{}\n');

    expect(selectCompileSessionArtifact(stale, redacted)).toEqual({
      path: derived,
      triaged: true,
    });
  });

  it('preserves external absolute paths when healing checkpoint state', () => {
    const external = pathResolve(tmpdir(), 'capture.triaged.json');
    expect(resolvedArtifactCheckpointPath('remitly', external, external)).toBe(external);
  });

  it('persists genuine external artifacts as resolvable absolute paths', () => {
    const home = mkdtempSync(pathResolve(tmpdir(), 'imprint-home-'));
    const external = pathResolve(tmpdir(), 'external-recordings', 'capture.triaged.json');
    withImprintHome(home, () => {
      expect(toRelativeTeachStatePath('remitly', external)).toBe(external);
      expect(resolvedArtifactCheckpointPath('remitly', undefined, external)).toBe(external);
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

describe('teach candidate selection defaults', () => {
  const detection = (() => {
    const validated = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName: 'search_items',
          description: 'Search items',
          rationale: 'primary intent',
          confidence: 0.9,
          primary: true,
          requestSeqs: [2],
          dependencySeqs: [1],
        },
        {
          toolName: 'lookup_items',
          description: 'Look up items',
          rationale: 'search prerequisite',
          confidence: 0.8,
          primary: false,
          requestSeqs: [1],
        },
        {
          toolName: 'get_details',
          description: 'Get details',
          rationale: 'downstream consumer',
          confidence: 0.8,
          primary: false,
          requestSeqs: [3],
          dependencySeqs: [2],
        },
      ],
    });
    return {
      ...validated,
      candidates: deriveStructuralCandidateDependencies(validated.candidates),
      inputTokens: null,
      outputTokens: null,
      durationMs: 1,
    };
  })();

  it('selects every detected tool in non-interactive mode by default', async () => {
    const selected = await selectTeachCandidates(detection, { noInteractive: true });
    expect(selected.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'lookup_items',
      'get_details',
    ]);
  });

  it('initially checks every interactive option and labels direct prerequisites', () => {
    const picker = buildTeachCandidatePicker(detection.candidates);
    expect(picker.initialValues).toEqual(['search_items', 'lookup_items', 'get_details']);
    expect(picker.options.find((option) => option.value === 'search_items')?.hint).toContain(
      'requires lookup_items',
    );
    expect(picker.options.find((option) => option.value === 'lookup_items')?.hint).not.toContain(
      'requires',
    );
  });

  it('keeps --all-tools equivalent to the non-interactive default', async () => {
    const selected = await selectTeachCandidates(detection, {
      noInteractive: true,
      allTools: true,
    });
    expect(selected.map((candidate) => candidate.toolName)).toEqual(
      detection.candidates.map((candidate) => candidate.toolName),
    );
  });

  it('selects only the primary tool and its transitive prerequisites with --primary-tool', async () => {
    const selected = await selectTeachCandidates(detection, {
      noInteractive: true,
      primaryTool: true,
    });
    expect(selected.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'lookup_items',
    ]);
  });

  it('closes a submitted downstream-only choice without adding independent tools', () => {
    const downstream = finalizeTeachCandidateSelection(detection.candidates, ['get_details']);
    expect(downstream.selected.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'lookup_items',
      'get_details',
    ]);
    expect(downstream.autoAdded.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'lookup_items',
    ]);

    const independent = finalizeTeachCandidateSelection(detection.candidates, ['lookup_items']);
    expect(independent.selected.map((candidate) => candidate.toolName)).toEqual(['lookup_items']);
  });

  it('formats structural and replay auto-add notices distinctly', () => {
    const autoAdded = finalizeTeachCandidateSelection(detection.candidates, [
      'get_details',
    ]).autoAdded;
    expect(formatTeachCandidateAutoAddNotice(autoAdded, 'structural')).toEqual({
      body: '  + search_items\n  + lookup_items',
      title: 'Added required upstream tools',
    });
    expect(formatTeachCandidateAutoAddNotice(autoAdded, 'replay')?.title).toBe(
      'Added recorded prerequisites',
    );
    expect(formatTeachCandidateAutoAddNotice([], 'structural')).toBeUndefined();
  });

  it('adapts persisted value1 classifications before merging replay token edges', () => {
    const merged = mergeReplayCandidateDependencies(detection.candidates, [
      {
        classification: 'server_derived',
        originalSeq: 3,
        location: 'url_param:item_token',
        producerSeq: 1,
        producerPath: '$.results[0].itemToken',
        value1: 'ChcI78-luoXdhoaIARoKL20vMDJ2cGdnMRAB',
        value2: 'ChcI78-luoXdhoaIARoKL20vMDJ2cGdnMRAC',
      },
    ]);

    expect(
      merged.find((candidate) => candidate.toolName === 'get_details')?.dependsOnTools,
    ).toEqual(['search_items', 'lookup_items']);
  });

  it('hands the dependency-closed detected set to build planning after replay edges', () => {
    const replayOnlyCandidates = detection.candidates.map((candidate) =>
      candidate.toolName === 'get_details'
        ? { ...candidate, dependencySeqs: [], dependsOnTools: [] }
        : candidate,
    );
    const finalized = finalizeTeachCandidateSelection(
      replayOnlyCandidates,
      ['get_details'],
      [
        {
          classification: 'server_derived',
          originalSeq: 3,
          location: 'url_param:item_token',
          producerSeq: 2,
          producerPath: '$.results[0].itemToken',
          value1: 'ChcI78-luoXdhoaIARoKL20vMDJ2cGdnMRAB',
          value2: 'ChcI78-luoXdhoaIARoKL20vMDJ2cGdnMRAC',
        },
      ],
    );

    expect(
      finalized.candidates.find((candidate) => candidate.toolName === 'get_details')
        ?.dependsOnTools,
    ).toEqual(['search_items']);
    expect(finalized.selected.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'lookup_items',
      'get_details',
    ]);
  });

  it('selects the primary compiled result even when an upstream dependency was detected first', () => {
    const lookup = { workflow: { toolName: 'lookup_items' } };
    const search = { workflow: { toolName: 'search_items' } };
    expect(
      selectPrimaryNamedResult(
        [lookup, search],
        [
          { candidate: { toolName: 'lookup_items', primary: false } },
          { candidate: { toolName: 'search_items', primary: true } },
        ],
      ),
    ).toBe(search);
  });
});

describe('cached replay classification identity', () => {
  it('loads only a sidecar produced from the exact current recording', () => {
    const dir = mkdtempSync(pathResolve(tmpdir(), 'imprint-classifications-'));
    const sessionPath = pathResolve(dir, 'recording.redacted.json');
    const classPath = pathResolve(dir, '.classifications.json');
    const sessionContents = '{"site":"fixture"}\n';
    writeFileSync(sessionPath, sessionContents);
    const classification = {
      classification: 'server_derived' as const,
      originalSeq: 2,
      location: 'url_param:item_token',
      value1: 'opaque-token-0001',
      value2: 'opaque-token-0002',
    };
    writeFileSync(
      classPath,
      JSON.stringify({
        sourceSessionHash: createHash('sha256').update(sessionContents).digest('hex'),
        classifications: [classification],
      }),
    );

    expect(loadCachedClassificationsForSession(classPath, sessionPath)).toEqual([classification]);

    writeFileSync(sessionPath, '{"site":"different-recording"}\n');
    expect(loadCachedClassificationsForSession(classPath, sessionPath)).toBeUndefined();

    writeFileSync(classPath, JSON.stringify({ classifications: [classification] }));
    expect(loadCachedClassificationsForSession(classPath, sessionPath)).toBeUndefined();
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

  it('a failed verification surfaces action, error, and status', () => {
    const s = formatAuthProgress(
      base({
        turn: 30,
        lastVerification: {
          action: 'begin',
          ok: false,
          error: 'FORBIDDEN',
          status: 403,
          checkpoint: 'run_verification',
        },
      }),
    );
    expect(s).toContain('turn 30');
    expect(s).toContain('begin FAILED');
    expect(s).toContain('FORBIDDEN');
    expect(s).toContain('HTTP 403');
    expect(s).toContain('revising');
  });

  it('a successful verification falls back to the plain turn line', () => {
    const s = formatAuthProgress(
      base({ turn: 31, lastVerification: { action: 'finish', ok: true } }),
    );
    expect(s).toBe('Auth compile: turn 31');
  });

  it('shows a generic action failure', () => {
    const s = formatAuthProgress(
      base({ turn: 5, lastVerification: { action: 'begin', ok: false, error: 'NETWORK' } }),
    );
    expect(s).toContain('begin FAILED');
    expect(s).toContain('NETWORK');
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
