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
  assertResumableAt,
  resolveStepStartTarget,
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
});
