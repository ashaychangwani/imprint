/**
 * Tests for the `imprint teach --from-step/--to-step/--only` dependency guard:
 * starting at a phase is only allowed when a prior run reached/crossed every
 * earlier phase, so its outputs can be reused. Pure/synthetic — no network.
 */
import { describe, expect, it } from 'bun:test';
import {
  TEACH_STEPS,
  type TeachState,
  type WorkflowState,
  analysisBlockRunsForWindow,
  assertResumableAt,
  isResumableAt,
  resolveStepStartTarget,
  resolveTeachPhaseWindow,
  selectMultiToolResumePlans,
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
  it('always allows starting at record (produces everything fresh)', () => {
    expect(() => assertResumableAt('s', 'k', ws([]), 'record')).not.toThrow();
  });

  it('allows a step when every earlier step is complete', () => {
    const w = ws(['record', 'redact', 'replay-and-diff', 'triage']);
    expect(() => assertResumableAt('s', 'k', w, 'detect-candidates')).not.toThrow();
  });

  it('throws when an earlier step is missing', () => {
    const w = ws(['record', 'redact']); // missing replay-and-diff + triage
    expect(() => assertResumableAt('s', 'k', w, 'detect-candidates')).toThrow(
      /missing required earlier step\(s\) \[replay-and-diff, triage\]/,
    );
  });

  it('reports the furthest completed step in the error', () => {
    const w = ws(['record', 'redact', 'replay-and-diff']);
    expect(() => assertResumableAt('s', 'k', w, 'generate')).toThrow(
      /Latest completed step: replay-and-diff/,
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
      /missing required earlier step\(s\) \[replay-and-diff, triage, detect-candidates\]/,
    );
  });
});

describe('resolveStepStartTarget (workflow selection + guard)', () => {
  it('throws when there is no prior run for the site', () => {
    const state: TeachState = { workflows: {} };
    expect(() => resolveStepStartTarget('s', state, 'detect-candidates')).toThrow(
      /no prior teach run/,
    );
  });

  it('picks the most-recently-updated workflow', () => {
    const state: TeachState = {
      workflows: {
        old: ws(['record', 'redact', 'replay-and-diff', 'triage'], '2026-01-01T00:00:00Z'),
        recent: ws(
          ['record', 'redact', 'replay-and-diff', 'triage', 'detect-candidates'],
          '2026-06-01T00:00:00Z',
        ),
      },
    };
    const target = resolveStepStartTarget('s', state, 'detect-candidates');
    expect(target.workflowKey).toBe('recent');
  });

  it('propagates the guard failure of the selected (most-recent) workflow', () => {
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

describe('selectMultiToolResumePlans (multi-tool --from-step reconstruction)', () => {
  const SHARED: WorkflowState['completedSteps'] = [
    'record',
    'redact',
    'replay-and-diff',
    'triage',
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
        ? ({ toolName: opts.candidate } as unknown as WorkflowState['candidate'])
        : undefined,
    };
  }

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

  it('ignores _pending_ placeholders and candidate-less workflows', () => {
    const state: TeachState = {
      workflows: {
        'tool-a': toolWs({ candidate: 'tool-a' }),
        _pending_x: toolWs({ candidate: 'x' }),
        'no-candidate': toolWs({}),
      },
    };
    const sel = selectMultiToolResumePlans(state, 'tool-a', 'generate');
    expect(sel.plans.map((p) => p.workflowKey)).toEqual(['tool-a']);
    expect(sel.skipped).toEqual([]);
  });
});

describe('analysisBlockRunsForWindow', () => {
  const idx = (s: WorkflowState['completedSteps'][number]) => TEACH_STEPS.indexOf(s);
  const LAST = TEACH_STEPS.length - 1;

  it('runs when the window overlaps replay-and-diff → detect-candidates', () => {
    expect(analysisBlockRunsForWindow(idx('record'), LAST)).toBe(true); // full run
    expect(analysisBlockRunsForWindow(idx('detect-candidates'), idx('detect-candidates'))).toBe(
      true,
    ); // --only detect-candidates
    expect(analysisBlockRunsForWindow(idx('replay-and-diff'), idx('triage'))).toBe(true);
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
});
