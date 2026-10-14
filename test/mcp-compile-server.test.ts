import { describe, expect, it } from 'bun:test';
import {
  COMPILE_SENTINELS,
  canWaiveIrreversibleLiveVerification,
  compileDoneToolDescription,
} from '../src/imprint/mcp-compile-server.ts';
import type { Workflow } from '../src/imprint/types.ts';

describe('compile MCP sentinels', () => {
  it('keeps factual completion and failure channels distinct', () => {
    expect(COMPILE_SENTINELS.done).toBe('.compile-done.json');
    expect(COMPILE_SENTINELS.giveUp).toBe('.compile-give-up.json');
  });

  it('describes master MVP done as a deterministic handoff', () => {
    const description = compileDoneToolDescription('master_mvp');
    expect(description).toContain('deterministic artifact, schema, test, and type facts');
    expect(description).toContain('hands the artifact back to the master for live verification');
    expect(description).not.toContain('independent external verification');
  });
});

describe('irreversible compile completion', () => {
  const workflow = {
    requests: [{ effect: 'irreversible' }],
  } as Workflow;

  it('waives only live execution after deterministic checks pass', () => {
    expect(canWaiveIrreversibleLiveVerification([], workflow)).toBe(true);
    expect(canWaiveIrreversibleLiveVerification(['request.test.ts failed'], workflow)).toBe(false);
    expect(canWaiveIrreversibleLiveVerification([], undefined)).toBe(false);
  });
});
