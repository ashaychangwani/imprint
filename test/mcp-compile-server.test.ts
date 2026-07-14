import { describe, expect, it } from 'bun:test';
import { canAcceptInconclusiveDecision } from '../src/imprint/mcp-compile-server.ts';

describe('canAcceptInconclusiveDecision', () => {
  it('accepts an explicit compiler decision for the unchanged artifact', () => {
    expect(
      canAcceptInconclusiveDecision({
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
        acceptInconclusive: true,
        inconclusiveReason: 'The verifier only observed an unavailable backend.',
      }),
    ).toBe(true);
  });

  it('requires explicit reasoning', () => {
    expect(
      canAcceptInconclusiveDecision({
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
        acceptInconclusive: true,
        inconclusiveReason: '   ',
      }),
    ).toBe(false);
  });

  it('reruns verification after any compile artifact changes', () => {
    expect(
      canAcceptInconclusiveDecision({
        pendingFingerprint: 'before',
        currentFingerprint: 'after',
        acceptInconclusive: true,
        inconclusiveReason: 'The prior failure was infrastructure-only.',
      }),
    ).toBe(false);
  });
});
