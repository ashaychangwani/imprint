/**
 * Tests for the `imprint teach --from-step/--to-step/--only` dependency guard:
 * starting at a phase is only allowed when a prior run reached/crossed every
 * earlier phase, so its outputs can be reused. Pure/synthetic — no network.
 */
import { describe, expect, it } from 'bun:test';
import {
  ANALYSIS_COMPLETED_STEPS,
  TEACH_STEPS,
  type TeachState,
  type WorkflowState,
  analysisBlockRunsForWindow,
  assertResumableAt,
  candidateSelectionChanged,
  detectCandidatesCompletedSteps,
  isCandidateBackedResume,
  isResumableAt,
  mergeAnalysisCompletedSteps,
  pruneUnselectedCandidateWorkflows,
  resolveStepStartTarget,
  resolveTeachPhaseWindow,
  resolvedTeachRunPolicy,
  selectMultiToolResumePlans,
  staleCompletedToolsForRun,
  validateToolScopedResumeStep,
} from '../src/imprint/teach-state.ts';

function ws(
  completedSteps: WorkflowState['completedSteps'],
  updatedAt = '2026-01-01T00:00:00Z',
): WorkflowState {
  return {
    sessionPath: 'sessions/rec.json',
    completedSteps,
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt,
  };
}

describe('assertResumableAt (phase dependency guard)', () => {
  it('orders triage before replay and candidate detection', () => {
    expect(TEACH_STEPS.slice(0, 5)).toEqual([
      'record',
      'redact',
      'triage',
      'replay-and-diff',
      'detect-candidates',
    ]);
    expect(() => assertResumableAt('s', 'k', ws(['record', 'redact']), 'replay-and-diff')).toThrow(
      /missing required earlier step\(s\) \[triage\]/,
    );
  });

  it('always allows starting at record (produces everything fresh)', () => {
    expect(() => assertResumableAt('s', 'k', ws([]), 'record')).not.toThrow();
  });

  it('allows a step when every earlier step is complete', () => {
    const w = ws(['record', 'redact', 'triage', 'replay-and-diff']);
    expect(() => assertResumableAt('s', 'k', w, 'detect-candidates')).not.toThrow();
  });

  it('throws when an earlier step is missing', () => {
    const w = ws(['record', 'redact']); // missing triage + replay-and-diff
    expect(() => assertResumableAt('s', 'k', w, 'detect-candidates')).toThrow(
      /missing required earlier step\(s\) \[triage, replay-and-diff\]/,
    );
  });

  it('reports the furthest completed step in the error', () => {
    const w = ws(['record', 'redact', 'triage']);
    expect(() => assertResumableAt('s', 'k', w, 'generate')).toThrow(
      /Latest completed step: triage/,
    );
  });

  it('allows resuming a completed single-tool run (which never records plan-prereqs)', () => {
    // Single-tool runs skip shared-module planning, so plan-prereqs is never in
    // completedSteps even after a fully successful run. Resuming the per-tool
    // compile phases must still be allowed — regression: --from-step generate
    // used to throw "missing [plan-prereqs]" on every single-tool site.
    const singleTool = TEACH_STEPS.filter((s) => s !== 'plan-prereqs');
    for (const step of ['generate', 'compile-playbook', 'emit', 'register'] as const) {
      expect(() => assertResumableAt('s', 'k', ws(singleTool), step)).not.toThrow();
    }
  });

  it('still requires the non-skippable earlier steps (guard not neutered)', () => {
    // Excluding plan-prereqs must not weaken the rest of the guard: the other
    // earlier steps are still required and reported when missing.
    const w = ws(['record', 'redact']);
    expect(() => assertResumableAt('s', 'k', w, 'generate')).toThrow(
      /missing required earlier step\(s\) \[triage, replay-and-diff, detect-candidates\]/,
    );
  });

  it('ignores unknown step names in completedSteps (graceful degradation)', () => {
    // A corrupted/migrated state may carry a step not in TEACH_STEPS; it must be
    // ignored, not counted as progress — the furthest reached here is still redact.
    const w = ws([
      'record',
      'redact',
      'bogus-step-name',
    ] as unknown as WorkflowState['completedSteps']);
    expect(() => assertResumableAt('s', 'k', w, 'detect-candidates')).toThrow(
      /Latest completed step: redact/,
    );
  });
});

describe('validateToolScopedResumeStep', () => {
  it('accepts only phases in the atomic per-tool compile unit', () => {
    for (const step of ['generate', 'compile-playbook', 'emit'] as const) {
      expect(validateToolScopedResumeStep(step)).toBeNull();
    }
  });

  it('rejects recording, analysis, planning, and registration phases', () => {
    for (const step of TEACH_STEPS.filter(
      (candidate) => !['generate', 'compile-playbook', 'emit'].includes(candidate),
    )) {
      expect(validateToolScopedResumeStep(step)).toContain('--tool is only supported');
    }
  });
});

describe('resolveStepStartTarget (workflow selection + guard)', () => {
  it('throws when there is no prior run for the site', () => {
    const state: TeachState = { workflows: {} };
    expect(() => resolveStepStartTarget('s', state, 'detect-candidates')).toThrow(
      /no prior teach run/,
    );
  });

  it('picks the most-recently-updated resumable workflow', () => {
    const state: TeachState = {
      workflows: {
        old: ws(['record', 'redact', 'triage', 'replay-and-diff'], '2026-01-01T00:00:00Z'),
        recent: ws(
          ['record', 'redact', 'triage', 'replay-and-diff', 'detect-candidates'],
          '2026-06-01T00:00:00Z',
        ),
      },
    };
    const target = resolveStepStartTarget('s', state, 'detect-candidates');
    expect(target.workflowKey).toBe('recent');
  });

  it('skips newer incomplete non-pending entries when an older workflow is resumable', () => {
    const state: TeachState = {
      workflows: {
        valid: ws(
          ['record', 'redact', 'triage', 'replay-and-diff', 'detect-candidates'],
          '2026-01-01T00:00:00Z',
        ),
        orphan: ws(['record', 'redact'], '2026-06-01T00:00:00Z'),
      },
    };
    const target = resolveStepStartTarget('s', state, 'plan-prereqs');
    expect(target.workflowKey).toBe('valid');
  });

  it('propagates a guard failure when no workflow is resumable', () => {
    const state: TeachState = {
      workflows: {
        recent: ws(['record', 'redact'], '2026-06-01T00:00:00Z'),
      },
    };
    expect(() => resolveStepStartTarget('s', state, 'detect-candidates')).toThrow(
      /missing required earlier step/,
    );
  });

  it('ignores stale _pending_ entries when selecting the resume target', () => {
    // A _pending_ run interrupted after redact can carry a newer timestamp than a
    // completed workflow; it must not shadow the real one — it has no candidate and
    // never reached far enough, so selecting it would wrongly throw "run a full
    // teach first" even though a valid resume target exists.
    const state: TeachState = {
      workflows: {
        'search-flights': ws(
          TEACH_STEPS.filter((s) => s !== 'plan-prereqs'),
          '2026-01-01T00:00:00Z',
        ),
        _pending_1718000000000: ws(['record', 'redact'], '2026-06-01T00:00:00Z'),
      },
    };
    const target = resolveStepStartTarget('s', state, 'generate');
    expect(target.workflowKey).toBe('search-flights');
  });

  it('selects an explicitly named persisted tool for a bounded resume', () => {
    const state: TeachState = {
      workflows: {
        primary: {
          ...ws(['record', 'redact', 'triage', 'replay-and-diff', 'detect-candidates']),
          candidate: { toolName: 'search_items', primary: true } as WorkflowState['candidate'],
        },
        consumer: {
          ...ws(['record', 'redact', 'triage', 'replay-and-diff', 'detect-candidates']),
          candidate: { toolName: 'get_details', primary: false } as WorkflowState['candidate'],
        },
      },
    };
    expect(resolveStepStartTarget('s', state, 'generate', 'get_details').workflowKey).toBe(
      'consumer',
    );
  });
});

describe('isResumableAt (non-throwing resume predicate)', () => {
  it('always allows record (produces everything fresh)', () => {
    expect(isResumableAt(ws([]), 'record')).toBe(true);
  });

  it('treats a completed single-tool run (no plan-prereqs) as resumable', () => {
    const singleTool = TEACH_STEPS.filter((s) => s !== 'plan-prereqs');
    expect(isResumableAt(ws(singleTool), 'generate')).toBe(true);
    expect(isResumableAt(ws(singleTool), 'register')).toBe(true);
  });

  it('returns false when a required earlier step is missing', () => {
    expect(isResumableAt(ws(['record', 'redact']), 'generate')).toBe(false);
  });
});

describe('candidate resume reconstruction', () => {
  const SHARED: WorkflowState['completedSteps'] = [
    'record',
    'redact',
    'triage',
    'replay-and-diff',
    'detect-candidates',
  ];
  function toolWs(opts: {
    steps?: WorkflowState['completedSteps'];
    sessionPath?: string;
    candidate?: string;
  }): WorkflowState {
    return {
      sessionPath: opts.sessionPath ?? 'sessions/rec.json',
      completedSteps: opts.steps ?? [...SHARED],
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      candidate: opts.candidate
        ? {
            toolName: opts.candidate,
            description: opts.candidate,
            rationale: 'test candidate',
            confidence: 1,
            primary: false,
            requestSeqs: [],
            representativeSeqs: [],
            eventSeqs: [],
            expectedOutput: '',
            likelyParams: [],
            dependencySeqs: [],
            dependsOnTools: [],
          }
        : undefined,
    };
  }

  it('reconstructs persisted candidates for interactive resumes without --from-step', () => {
    expect(isCandidateBackedResume(toolWs({ candidate: 'tool-a' }))).toBe(true);
    expect(isCandidateBackedResume(toolWs({}))).toBe(false);
  });

  it('never cleans up excluded tools during an interactive candidate-backed resume', () => {
    const target = toolWs({ candidate: 'current' });
    const state: TeachState = {
      workflows: {
        current: target,
        'other-recording': toolWs({
          candidate: 'other-recording',
          sessionPath: 'sessions/other.json',
        }),
        incomplete: toolWs({ candidate: 'incomplete', steps: ['record', 'redact'] }),
      },
    };
    const selection = selectMultiToolResumePlans(state, 'current', 'generate');
    const incoming = new Set(selection.plans.map((plan) => plan.candidate.toolName));

    expect(selection.skipped.map(({ reason }) => reason).sort()).toEqual([
      'different-recording',
      'not-resumable',
    ]);
    expect(
      staleCompletedToolsForRun(
        ['current', 'other-recording', 'incomplete'],
        incoming,
        resolvedTeachRunPolicy('generate', isCandidateBackedResume(target)).cleanupStaleTools,
      ),
    ).toEqual([]);
  });

  it('gives interactive Continue/Redo the same resume policy as --from-step', () => {
    const continuePolicy = resolvedTeachRunPolicy('generate', true);
    expect(continuePolicy).toEqual({
      cleanupStaleTools: false,
      reuseExistingBuildPlan: true,
      reviseExistingArtifacts: true,
    });

    const redoPlanningPolicy = resolvedTeachRunPolicy('plan-prereqs', true);
    expect(redoPlanningPolicy).toEqual({
      cleanupStaleTools: false,
      reuseExistingBuildPlan: false,
      reviseExistingArtifacts: true,
    });
  });

  it('includes every same-recording tool that reached the step', () => {
    const state: TeachState = {
      workflows: {
        'tool-a': toolWs({ candidate: 'tool-a' }),
        'tool-b': toolWs({ candidate: 'tool-b' }),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'tool-a', 'generate');
    expect(sel.plans.map((p) => p.workflowKey).sort()).toEqual(['tool-a', 'tool-b']);
    expect(sel.skipped).toEqual([]);
  });

  it('keeps every eligible tool for interactive Continue and honors --primary-tool', () => {
    const state: TeachState = {
      workflows: {
        'tool-secondary': {
          ...toolWs({ candidate: 'tool-secondary' }),
          candidate: {
            toolName: 'tool-secondary',
            primary: false,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
        'tool-primary': {
          ...toolWs({ candidate: 'tool-primary' }),
          candidate: {
            toolName: 'tool-primary',
            primary: true,
            dependsOnTools: ['tool-upstream'],
          } as unknown as WorkflowState['candidate'],
        },
        'tool-upstream': {
          ...toolWs({ candidate: 'tool-upstream' }),
          candidate: {
            toolName: 'tool-upstream',
            primary: false,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };

    const all = selectMultiToolResumePlans(state, 'tool-secondary', 'generate');
    expect(all.plans.map((plan) => plan.workflowKey).sort()).toEqual([
      'tool-primary',
      'tool-secondary',
      'tool-upstream',
    ]);

    const primaryOnly = selectMultiToolResumePlans(state, 'tool-secondary', 'generate', {
      primaryTool: true,
    });
    expect(primaryOnly.plans.map((plan) => plan.workflowKey).sort()).toEqual([
      'tool-primary',
      'tool-upstream',
    ]);
  });

  it('closes an interactively resumed downstream tool over its prerequisites', () => {
    const state: TeachState = {
      workflows: {
        primary: {
          ...toolWs({ candidate: 'search_items' }),
          candidate: {
            toolName: 'search_items',
            primary: true,
            dependsOnTools: ['lookup_items'],
          } as unknown as WorkflowState['candidate'],
        },
        consumer: {
          ...toolWs({ candidate: 'get_details' }),
          candidate: {
            toolName: 'get_details',
            primary: false,
            dependsOnTools: ['search_items'],
          } as unknown as WorkflowState['candidate'],
        },
        lookup: {
          ...toolWs({ candidate: 'lookup_items' }),
          candidate: {
            toolName: 'lookup_items',
            primary: false,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };
    const selected = selectMultiToolResumePlans(state, 'consumer', 'generate', {
      toolName: 'get_details',
    });
    expect(selected.plans.map((plan) => plan.workflowKey).sort()).toEqual([
      'consumer',
      'lookup',
      'primary',
    ]);
  });

  it('fails when a selected tool has an unavailable prerequisite', () => {
    const state: TeachState = {
      workflows: {
        consumer: {
          ...toolWs({ candidate: 'get_details' }),
          candidate: {
            toolName: 'get_details',
            primary: true,
            dependsOnTools: ['search_items'],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };
    expect(() =>
      selectMultiToolResumePlans(state, 'consumer', 'generate', {
        toolName: 'get_details',
      }),
    ).toThrow(/required upstream tool "search_items" is unavailable.*detect-candidates/);
  });

  it('fails default and single-eligible primary resumes when a prerequisite was filtered out', () => {
    const state: TeachState = {
      workflows: {
        consumer: {
          ...toolWs({ candidate: 'get_details' }),
          candidate: {
            toolName: 'get_details',
            primary: true,
            dependsOnTools: ['search_items'],
          } as unknown as WorkflowState['candidate'],
        },
        producer: {
          ...toolWs({ candidate: 'search_items', steps: ['record', 'redact'] }),
          candidate: {
            toolName: 'search_items',
            primary: false,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };

    expect(() => selectMultiToolResumePlans(state, 'consumer', 'generate')).toThrow(
      /required upstream tool "search_items" is unavailable/,
    );
    expect(() =>
      selectMultiToolResumePlans(state, 'consumer', 'generate', { primaryTool: true }),
    ).toThrow(/required upstream tool "search_items" is unavailable/);
  });

  it('returns dependency-cycle diagnostics for resumed selections', () => {
    const state: TeachState = {
      workflows: {
        events: {
          ...toolWs({ candidate: 'list_events' }),
          candidate: {
            toolName: 'list_events',
            primary: true,
            dependsOnTools: ['get_place'],
          } as WorkflowState['candidate'],
        },
        place: {
          ...toolWs({ candidate: 'get_place' }),
          candidate: {
            toolName: 'get_place',
            primary: false,
            dependsOnTools: ['list_events'],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };

    const selection = selectMultiToolResumePlans(state, 'events', 'generate', {
      primaryTool: true,
    });
    expect(selection.cycles).toEqual([['list_events', 'get_place', 'list_events']]);
  });

  it('fails --primary-tool when the persisted primary is not resumable', () => {
    const state: TeachState = {
      workflows: {
        primary: {
          ...toolWs({ candidate: 'search_items', steps: [...SHARED] }),
          candidate: {
            toolName: 'search_items',
            primary: true,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
        secondary: {
          ...toolWs({ candidate: 'get_details', steps: [...SHARED, 'generate'] }),
          candidate: {
            toolName: 'get_details',
            primary: false,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };

    expect(() =>
      selectMultiToolResumePlans(state, 'secondary', 'compile-playbook', {
        primaryTool: true,
      }),
    ).toThrow(/Cannot resume primary tool "search_items".*not-resumable/);
  });

  it('does not fall back to a target excluded from the persisted build plan', () => {
    const state: TeachState = {
      workflows: {
        consumer: {
          ...toolWs({ candidate: 'get_details' }),
          candidate: {
            toolName: 'get_details',
            primary: true,
            dependsOnTools: [],
          } as unknown as WorkflowState['candidate'],
        },
      },
    };

    expect(() =>
      selectMultiToolResumePlans(state, 'consumer', 'generate', {
        plannedToolNames: new Set(['different_tool']),
      }),
    ).toThrow(/target is not-in-build-plan/);
  });

  it('excludes stale same-recording candidates that are absent from the current build plan', () => {
    const state: TeachState = {
      workflows: {
        'search-current': toolWs({ candidate: 'search-current' }),
        'compare-renamed': toolWs({ candidate: 'compare-renamed' }),
        'compare-stale': toolWs({ candidate: 'compare-stale' }),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'search-current', 'generate', {
      plannedToolNames: new Set(['search-current', 'compare-renamed']),
    });

    expect(sel.plans.map((plan) => plan.workflowKey).sort()).toEqual([
      'compare-renamed',
      'search-current',
    ]);
    expect(sel.skipped).toEqual([{ workflowKey: 'compare-stale', reason: 'not-in-build-plan' }]);
  });

  it('skips a tool from a different recording (would compile against the wrong session)', () => {
    const state: TeachState = {
      workflows: {
        'tool-a': toolWs({ sessionPath: 'sessions/rec1.json', candidate: 'tool-a' }),
        'tool-c': toolWs({ sessionPath: 'sessions/rec2.json', candidate: 'tool-c' }),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'tool-a', 'generate');
    expect(sel.plans.map((p) => p.workflowKey)).toEqual(['tool-a']);
    expect(sel.skipped).toEqual([{ workflowKey: 'tool-c', reason: 'different-recording' }]);
  });

  it('skips a same-recording tool that did not reach the step (would crash loading artifacts)', () => {
    const state: TeachState = {
      workflows: {
        'tool-a': toolWs({ steps: [...SHARED, 'generate'], candidate: 'tool-a' }),
        'tool-b': toolWs({ steps: [...SHARED], candidate: 'tool-b' }),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'tool-a', 'compile-playbook');
    expect(sel.plans.map((p) => p.workflowKey)).toEqual(['tool-a']);
    expect(sel.skipped).toEqual([{ workflowKey: 'tool-b', reason: 'not-resumable' }]);
  });

  it('ignores _pending_ placeholders', () => {
    const state: TeachState = {
      workflows: {
        'tool-a': toolWs({ candidate: 'tool-a' }),
        _pending_x: toolWs({ candidate: 'x' }),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'tool-a', 'generate');
    expect(sel.plans.map((p) => p.workflowKey)).toEqual(['tool-a']);
    expect(sel.skipped).toEqual([]);
  });
});

describe('candidate re-detection state reconciliation', () => {
  const candidate = (
    toolName: string,
    dependsOnTools: string[] = [],
  ): NonNullable<WorkflowState['candidate']> =>
    ({
      toolName,
      primary: toolName === 'search_items',
      requestSeqs: toolName === 'search_items' ? [1] : [2],
      dependencySeqs: [],
      dependsOnTools,
      likelyParams: [],
      expectedOutput: '',
    }) as unknown as NonNullable<WorkflowState['candidate']>;

  it('removes only unselected candidates from the same recording', () => {
    const state: TeachState = {
      workflows: {
        search_items: {
          ...ws(ANALYSIS_COMPLETED_STEPS),
          candidate: candidate('search_items'),
        },
        get_details: {
          ...ws(ANALYSIS_COMPLETED_STEPS),
          candidate: candidate('get_details'),
        },
        other_recording: {
          ...ws(ANALYSIS_COMPLETED_STEPS),
          sessionPath: 'sessions/other.json',
          candidate: candidate('other_tool'),
        },
      },
    };

    expect(
      pruneUnselectedCandidateWorkflows(state, 'sessions/rec.json', new Set(['search_items'])),
    ).toEqual(['get_details']);
    expect(Object.keys(state.workflows).sort()).toEqual(['other_recording', 'search_items']);
  });

  it('invalidates prior planning progress when the selected set or dependency graph changes', () => {
    const state: TeachState = {
      workflows: {
        search_items: {
          ...ws(ANALYSIS_COMPLETED_STEPS),
          candidate: candidate('search_items'),
        },
        get_details: {
          ...ws(ANALYSIS_COMPLETED_STEPS),
          candidate: candidate('get_details'),
        },
      },
    };

    expect(
      candidateSelectionChanged(state, 'sessions/rec.json', [
        candidate('search_items'),
        candidate('get_details'),
      ]),
    ).toBe(false);
    expect(candidateSelectionChanged(state, 'sessions/rec.json', [candidate('search_items')])).toBe(
      true,
    );
    expect(
      candidateSelectionChanged(state, 'sessions/rec.json', [
        candidate('search_items'),
        candidate('get_details', ['search_items']),
      ]),
    ).toBe(true);
    expect(
      candidateSelectionChanged(state, 'sessions/rec.json', [
        candidate('search_items'),
        {
          ...candidate('get_details'),
          representativeSeqs: [99],
          eventSeqs: [100],
          description: 'changed planning evidence',
        },
      ]),
    ).toBe(true);
    expect(
      candidateSelectionChanged(
        state,
        'sessions/rec.json',
        [candidate('search_items'), candidate('get_details')],
        {
          loginRequestSeqs: [7],
          credentialNames: [],
          tokenExtractionNotes: '',
          sharedHelperNotes: '',
          authRequestSeqs: [],
          authNotes: '',
        },
      ),
    ).toBe(true);
    expect(
      candidateSelectionChanged(
        state,
        'sessions/rec.json',
        [candidate('search_items'), candidate('get_details')],
        undefined,
        'new-classification-hash',
      ),
    ).toBe(true);
  });
});

describe('analysisBlockRunsForWindow', () => {
  const idx = (s: WorkflowState['completedSteps'][number]) => TEACH_STEPS.indexOf(s);
  const LAST = TEACH_STEPS.length - 1;

  it('runs when the window overlaps triage → detect-candidates', () => {
    expect(analysisBlockRunsForWindow(idx('record'), LAST)).toBe(true); // full run
    expect(analysisBlockRunsForWindow(idx('detect-candidates'), idx('detect-candidates'))).toBe(
      true,
    ); // --only detect-candidates
    expect(analysisBlockRunsForWindow(idx('triage'), idx('replay-and-diff'))).toBe(true);
  });

  it('does not run when the window is entirely before or after the block', () => {
    expect(analysisBlockRunsForWindow(idx('record'), idx('record'))).toBe(false); // --only record
    expect(analysisBlockRunsForWindow(idx('record'), idx('redact'))).toBe(false); // --to-step redact
    expect(analysisBlockRunsForWindow(idx('plan-prereqs'), idx('plan-prereqs'))).toBe(false); // --only plan-prereqs
    expect(analysisBlockRunsForWindow(idx('generate'), LAST)).toBe(false); // --from-step generate
  });
});

describe('resolveTeachPhaseWindow (CLI flag validation)', () => {
  it('expands --only to a single-phase window', () => {
    expect(resolveTeachPhaseWindow({ only: 'triage' })).toEqual({
      fromStep: 'triage',
      toStep: 'triage',
    });
  });

  it('passes a valid --from-step/--to-step window through', () => {
    expect(resolveTeachPhaseWindow({ 'from-step': 'redact', 'to-step': 'generate' })).toEqual({
      fromStep: 'redact',
      toStep: 'generate',
    });
  });

  it('rejects an invalid step name', () => {
    const r = resolveTeachPhaseWindow({ 'from-step': 'bogus' });
    expect('error' in r && r.error).toMatch(/invalid --from-step "bogus"/);
  });

  it('rejects --from-step ordered after --to-step', () => {
    const r = resolveTeachPhaseWindow({ 'from-step': 'generate', 'to-step': 'redact' });
    expect('error' in r && r.error).toMatch(/comes after/);
  });

  it('rejects --from-step combined with --from-session', () => {
    const r = resolveTeachPhaseWindow({ 'from-step': 'generate', 'from-session': 'x.json' });
    expect('error' in r && r.error).toMatch(/cannot combine with --from-session/);
  });

  it('rejects --from-session with a --to-step before redact', () => {
    const r = resolveTeachPhaseWindow({ 'from-session': 'x.json', 'to-step': 'record' });
    expect('error' in r && r.error).toMatch(/--from-session starts at "redact"/);
  });

  it('allows --from-session with --to-step redact or later', () => {
    expect(resolveTeachPhaseWindow({ 'from-session': 'x.json', 'to-step': 'triage' })).toEqual({
      fromStep: undefined,
      toStep: 'triage',
    });
  });

  it('returns an empty window when no phase flags are set', () => {
    expect(resolveTeachPhaseWindow({})).toEqual({ fromStep: undefined, toStep: undefined });
  });

  it('rejects --only combined with --from-step', () => {
    const r = resolveTeachPhaseWindow({ only: 'triage', 'from-step': 'redact' });
    expect('error' in r && r.error).toMatch(/--only cannot combine/);
  });

  it('rejects --only combined with --to-step', () => {
    const r = resolveTeachPhaseWindow({ only: 'triage', 'to-step': 'generate' });
    expect('error' in r && r.error).toMatch(/--only cannot combine/);
  });

  it('expands --only to a single-phase window for every step', () => {
    for (const step of TEACH_STEPS) {
      expect(resolveTeachPhaseWindow({ only: step })).toEqual({ fromStep: step, toStep: step });
    }
  });

  it('accepts --to-step at the first step (record) and last step (register)', () => {
    expect(resolveTeachPhaseWindow({ 'to-step': 'record' })).toEqual({
      fromStep: undefined,
      toStep: 'record',
    });
    expect(resolveTeachPhaseWindow({ 'to-step': 'register' })).toEqual({
      fromStep: undefined,
      toStep: 'register',
    });
  });

  it('accepts the full explicit range --from-step record --to-step register', () => {
    expect(resolveTeachPhaseWindow({ 'from-step': 'record', 'to-step': 'register' })).toEqual({
      fromStep: 'record',
      toStep: 'register',
    });
  });

  it('names --only (not --from-step) in error messages when --only was used', () => {
    const invalid = resolveTeachPhaseWindow({ only: 'bogus' });
    expect('error' in invalid && invalid.error).toMatch(/invalid --only "bogus"/);
    const withSession = resolveTeachPhaseWindow({ only: 'redact', 'from-session': 'x.json' });
    expect('error' in withSession && withSession.error).toMatch(/--only resumes a prior run/);
  });
});

describe('mergeAnalysisCompletedSteps (re-detect must not regress progress)', () => {
  it('returns just the analysis steps for a first run (no prior state)', () => {
    expect(mergeAnalysisCompletedSteps(undefined)).toEqual(ANALYSIS_COMPLETED_STEPS);
    expect(mergeAnalysisCompletedSteps([])).toEqual(ANALYSIS_COMPLETED_STEPS);
  });

  it('preserves later steps when re-detecting a fully-compiled tool', () => {
    // A completed single-tool run reached every step except plan-prereqs. Re-running
    // detect-candidates must NOT drop generate…register from completedSteps.
    const full = TEACH_STEPS.filter((s) => s !== 'plan-prereqs');
    const merged = mergeAnalysisCompletedSteps(full);
    for (const step of full) expect(merged).toContain(step);
    expect(merged).toContain('register');
  });

  it('does not duplicate steps already present', () => {
    const merged = mergeAnalysisCompletedSteps(['record', 'redact', 'generate']);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged).toContain('generate');
  });
});

describe('detectCandidatesCompletedSteps (re-detect same recording vs fresh recording)', () => {
  const completed = [...TEACH_STEPS]; // a fully-completed prior run (incl. plan-prereqs, register)
  const wsRec = (sessionPath: string, steps: WorkflowState['completedSteps']): WorkflowState => ({
    sessionPath,
    completedSteps: steps,
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  it('returns just the analysis steps when there is no prior workflow', () => {
    expect(detectCandidatesCompletedSteps(undefined, 'sessions/rec.json')).toEqual(
      ANALYSIS_COMPLETED_STEPS,
    );
  });

  it('preserves prior progress when re-detecting the SAME recording', () => {
    const merged = detectCandidatesCompletedSteps(
      wsRec('sessions/rec.json', completed),
      'sessions/rec.json',
    );
    expect(merged).toContain('plan-prereqs');
    expect(merged).toContain('register');
  });

  it('resets to analysis steps when a FRESH recording reuses the same toolName', () => {
    // Different sessionPath => the prior plan-prereqs marker must NOT be inherited,
    // or the alreadyPlanned shortcut would skip re-planning and compile the new
    // recording against the previous recording's shared modules.
    const result = detectCandidatesCompletedSteps(
      wsRec('sessions/old-rec.json', completed),
      'sessions/new-rec.json',
    );
    expect(result).toEqual(ANALYSIS_COMPLETED_STEPS);
    expect(result).not.toContain('plan-prereqs');
    expect(result).not.toContain('register');
  });
});
