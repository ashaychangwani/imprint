/**
 * teach-plan helper tests. Covers the pure parserGuidance correction applied
 * when an unverified shared module is pruned from the build plan.
 */

import { describe, expect, it } from 'bun:test';
import { correctGuidanceForPrunedModules } from '../src/imprint/teach-plan.ts';

describe('correctGuidanceForPrunedModules', () => {
  it('appends a correction note when guidance names an unverified module', () => {
    const guidance = 'Call decodeBatchExecute from _shared/batchexecute.ts to decode the envelope.';
    const out = correctGuidanceForPrunedModules(guidance, new Set());
    expect(out).toContain(guidance); // original preserved
    expect(out).toContain('NOTE: shared module _shared/batchexecute.ts was NOT built');
    expect(out).toContain('implement its logic inline');
  });

  it('returns guidance unchanged when the named module is verified', () => {
    const guidance = 'Call decodeBatchExecute from _shared/batchexecute.ts.';
    const out = correctGuidanceForPrunedModules(guidance, new Set(['_shared/batchexecute.ts']));
    expect(out).toBe(guidance);
  });

  it('returns guidance unchanged when it references no shared modules', () => {
    const guidance = 'Walk the lodging list and emit {name, price}.';
    expect(correctGuidanceForPrunedModules(guidance, new Set())).toBe(guidance);
  });

  it('returns empty guidance unchanged', () => {
    expect(correctGuidanceForPrunedModules('', new Set())).toBe('');
  });

  it('handles multiple distinct pruned modules', () => {
    const guidance = 'Use _shared/a.ts and _shared/b.ts; keep _shared/c.ts.';
    const out = correctGuidanceForPrunedModules(guidance, new Set(['_shared/c.ts']));
    expect(out).toContain('_shared/a.ts was NOT built');
    expect(out).toContain('_shared/b.ts was NOT built');
    expect(out).not.toContain('_shared/c.ts was NOT built');
  });
});
