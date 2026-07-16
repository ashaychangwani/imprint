import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  COMPILE_SENTINELS,
  canAcceptInconclusiveDecision,
  compileArtifactFingerprint,
  compileDeadlineAfterVerification,
  inconclusiveDecisionAtSemanticCap,
} from '../src/imprint/mcp-compile-server.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('canAcceptInconclusiveDecision', () => {
  it('accepts an explicit compiler decision for the unchanged artifact', () => {
    expect(
      canAcceptInconclusiveDecision({
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        completedReview: true,
        infrastructureOnly: true,
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
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        completedReview: true,
        infrastructureOnly: true,
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
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        completedReview: true,
        infrastructureOnly: true,
        pendingFingerprint: 'before',
        currentFingerprint: 'after',
        acceptInconclusive: true,
        inconclusiveReason: 'The prior failure was infrastructure-only.',
      }),
    ).toBe(false);
  });

  it('cannot accept before the semantic review cap', () => {
    expect(
      canAcceptInconclusiveDecision({
        semanticVerificationCycles: 1,
        maxVerificationCycles: 5,
        completedReview: true,
        infrastructureOnly: true,
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
        acceptInconclusive: true,
        inconclusiveReason: 'The first review was infrastructure-only.',
      }),
    ).toBe(false);
  });

  it('cannot accept a synthesized provider failure with no completed review', () => {
    expect(
      canAcceptInconclusiveDecision({
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        completedReview: false,
        infrastructureOnly: true,
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
        acceptInconclusive: true,
        inconclusiveReason: 'The provider failed to start.',
      }),
    ).toBe(false);
  });

  it('cannot accept a report that labels a core tool defect inconclusive', () => {
    expect(
      canAcceptInconclusiveDecision({
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        completedReview: true,
        infrastructureOnly: false,
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
        acceptInconclusive: true,
        inconclusiveReason: 'Ship despite the reported tool defect.',
      }),
    ).toBe(false);
  });
});

describe('inconclusiveDecisionAtSemanticCap', () => {
  it('holds an unchanged fifth-cycle inconclusive result for the explicit compiler decision', () => {
    expect(
      inconclusiveDecisionAtSemanticCap({
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        pendingFingerprint: 'same',
        currentFingerprint: 'same',
      }),
    ).toBe('await-compiler-decision');
  });

  it('fails closed when artifacts change after the fifth inconclusive review', () => {
    expect(
      inconclusiveDecisionAtSemanticCap({
        semanticVerificationCycles: 5,
        maxVerificationCycles: 5,
        pendingFingerprint: 'before',
        currentFingerprint: 'after',
      }),
    ).toBe('fail-artifact-changed');
  });

  it('allows a changed artifact to receive another review before the cap', () => {
    expect(
      inconclusiveDecisionAtSemanticCap({
        semanticVerificationCycles: 4,
        maxVerificationCycles: 5,
        pendingFingerprint: 'before',
        currentFingerprint: 'after',
      }),
    ).toBe('continue-verification');
  });
});

describe('compileArtifactFingerprint', () => {
  it('changes when the runtime request transform changes', () => {
    const toolDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-fingerprint-'));
    tempDirs.push(toolDir);
    writeFileSync(pathJoin(toolDir, 'workflow.json'), '{}');
    writeFileSync(pathJoin(toolDir, 'request-transform.ts'), 'export const transform = () => 1;');
    const before = compileArtifactFingerprint(toolDir);

    writeFileSync(pathJoin(toolDir, 'request-transform.ts'), 'export const transform = () => 2;');

    expect(compileArtifactFingerprint(toolDir)).not.toBe(before);
  });
});

describe('compileDeadlineAfterVerification', () => {
  it('preserves completed verification time for subsequent compiler reasoning', () => {
    const toolDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-deadline-'));
    tempDirs.push(toolDir);
    writeFileSync(
      pathJoin(toolDir, COMPILE_SENTINELS.verificationState),
      JSON.stringify({ excludedMs: 4_000 }),
    );

    expect(compileDeadlineAfterVerification(toolDir, 10_000, 20_000)).toBe(14_000);
  });

  it('credits active verification only up to its bounded lifecycle deadline', () => {
    const toolDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-deadline-'));
    tempDirs.push(toolDir);
    writeFileSync(
      pathJoin(toolDir, COMPILE_SENTINELS.verificationState),
      JSON.stringify({ excludedMs: 500, activeSinceMs: 1_000, activeUntilMs: 4_000 }),
    );

    expect(compileDeadlineAfterVerification(toolDir, 10_000, 2_500)).toBe(12_000);
    expect(compileDeadlineAfterVerification(toolDir, 10_000, 8_000)).toBe(13_500);
  });
});
