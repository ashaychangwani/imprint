import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { parseCompileDoneSentinel } from '../src/imprint/compile-done-sentinel.ts';

const dirs: string[] = [];

function toolDir(): string {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-done-sentinel-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compile done sentinel verification boundary', () => {
  it('accepts a master MVP only with explicit mode and deferred semantic facts', () => {
    const dir = toolDir();
    const accepted = parseCompileDoneSentinel(
      JSON.stringify({
        summary: 'minimum useful artifact',
        verification: 'mechanical_passed',
        verificationMode: 'master_mvp',
        liveVerified: false,
        semanticVerification: { status: 'not_run' },
      }),
      { toolDir: dir, expectedMode: 'master_mvp' },
    );

    expect(accepted).toEqual({
      ok: true,
      message: 'minimum useful artifact',
      verification: {
        mode: 'master_mvp',
        deterministic: 'passed',
        semantic: 'not_run',
      },
    });

    for (const receipt of [
      {
        verification: 'mechanical_passed',
        liveVerified: false,
        semanticVerification: { status: 'not_run' },
      },
      {
        verification: 'mechanical_passed',
        verificationMode: 'master_mvp',
        liveVerified: false,
      },
    ]) {
      const rejected = parseCompileDoneSentinel(JSON.stringify(receipt), {
        toolDir: dir,
        expectedMode: 'master_mvp',
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain('master_mvp success requires explicit');
    }
  });

  it('rejects full success inferred from a bare mechanical receipt', () => {
    const parsed = parseCompileDoneSentinel(JSON.stringify({ verification: 'mechanical_passed' }), {
      toolDir: toolDir(),
      expectedMode: 'full',
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('full success requires explicit');
  });

  it('accepts full success only when the explicit semantic facts and durable report agree', () => {
    const dir = toolDir();
    const report = {
      status: 'approved',
      summary: 'The live result satisfies the tool intent.',
      baseline: { verdict: 'semantically_correct', reason: 'Observed expected records.' },
      parameters: [],
      issues: [],
      gaps: [],
      evidenceArtifact: '.live-verification-evidence.json',
      logArtifact: '.live-verifier-log.jsonl',
    };
    writeFileSync(pathJoin(dir, '.live-verification.json'), JSON.stringify(report), 'utf8');
    writeFileSync(pathJoin(dir, report.evidenceArtifact), '{}', 'utf8');
    writeFileSync(pathJoin(dir, report.logArtifact), '{}\n', 'utf8');

    const receipt = {
      summary: 'fully verified artifact',
      verification: 'mechanical_passed',
      verificationMode: 'full',
      liveVerified: true,
      semanticVerification: {
        status: 'approved',
        completed: true,
        provider: 'codex-cli',
        model: 'fixture-verifier',
        attempts: 1,
        evidenceArtifact: report.evidenceArtifact,
        logArtifact: report.logArtifact,
      },
    };
    const accepted = parseCompileDoneSentinel(JSON.stringify(receipt), {
      toolDir: dir,
      expectedMode: 'full',
    });
    expect(accepted).toEqual({
      ok: true,
      message: 'fully verified artifact',
      verification: {
        mode: 'full',
        deterministic: 'passed',
        semantic: 'approved',
        reportPath: pathJoin(dir, '.live-verification.json'),
      },
    });

    const incomplete = parseCompileDoneSentinel(
      JSON.stringify({
        ...receipt,
        semanticVerification: { ...receipt.semanticVerification, completed: false },
      }),
      { toolDir: dir, expectedMode: 'full' },
    );
    expect(incomplete.ok).toBe(false);
    expect(incomplete.message).toContain('completed approved semantic-review facts');

    writeFileSync(
      pathJoin(dir, '.live-verification.json'),
      JSON.stringify({ ...report, status: 'inconclusive' }),
      'utf8',
    );
    const rejected = parseCompileDoneSentinel(JSON.stringify(receipt), {
      toolDir: dir,
      expectedMode: 'full',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('semantic report status is inconclusive');
  });

  it('never accepts a success receipt that still carries deterministic failures', () => {
    const parsed = parseCompileDoneSentinel(
      JSON.stringify({
        verification: 'not_applicable',
        verificationMode: 'master_mvp',
        liveVerified: false,
        safetyWaiver: 'irreversible',
        semanticVerification: { status: 'not_applicable' },
        failures: ['request.test.ts failed'],
      }),
      { toolDir: toolDir(), expectedMode: 'master_mvp' },
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('receipt contains failures');
    expect(parsed.message).toContain('request.test.ts failed');
  });
});
