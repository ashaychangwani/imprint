import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  COMPILE_SENTINELS,
  canAcceptInconclusiveDecision,
  compileArtifactFingerprint,
  compileDeadlineAfterVerification,
} from '../src/imprint/mcp-compile-server.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
