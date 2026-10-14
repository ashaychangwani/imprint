import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import type { LiveIntegrationEvidence } from '../src/imprint/compile-verification.ts';
import {
  LIVE_FINESSE_CONCURRENCY,
  type LiveFinesseDependencies,
  runBestEffortLiveFinesse,
} from '../src/imprint/live-finesse-runner.ts';
import { ProviderReportedError } from '../src/imprint/provider-retry.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureTool(name: string): string {
  const siteDir = mkdtempSync(pathJoin(tmpdir(), 'imprint-finesse-fixture-'));
  roots.push(siteDir);
  const toolDir = pathJoin(siteDir, name);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(pathJoin(siteDir, '.build-plan.json'), '{"perTool":[]}\n');
  writeFileSync(
    pathJoin(toolDir, 'workflow.json'),
    JSON.stringify({
      toolName: name,
      toolKind: 'data',
      intent: { description: 'Search fixture records.' },
      parameters: [{ name: 'query', type: 'string', description: 'Search query.' }],
      requests: [{ method: 'GET', url: 'https://fixture.test/search?q={{query}}', headers: {} }],
      site: 'fixture',
    }),
  );
  writeFileSync(pathJoin(toolDir, 'integration.test.ts'), '// fixture integration suite\n');
  return toolDir;
}

function approvedReport() {
  return {
    status: 'approved' as const,
    summary: 'The baseline and query variation returned the expected records.',
    baseline: {
      verdict: 'semantically_correct' as const,
      reason: 'The baseline result matched the requested operation.',
    },
    parameters: [
      {
        name: 'query',
        verdict: 'works' as const,
        reason: 'Changing query changed the returned records.',
      },
    ],
    issues: [],
    gaps: [],
  };
}

describe('best-effort live finesse runner', () => {
  it('runs against a disposable site copy and returns persistable sidecars', async () => {
    const toolDir = fixtureTool('search_fixture');
    const siteDir = dirname(toolDir);
    const siblingDir = pathJoin(siteDir, 'authenticate_fixture');
    const sharedDir = pathJoin(siteDir, '.imprint-shared');
    mkdirSync(siblingDir);
    mkdirSync(sharedDir);
    writeFileSync(pathJoin(siblingDir, 'workflow.json'), '{"toolName":"authenticate_fixture"}\n');
    writeFileSync(pathJoin(sharedDir, 'request-state.ts'), 'export const state = 1;\n');
    writeFileSync(pathJoin(toolDir, '.live-verification.json'), 'canonical report\n');
    const canonicalWorkflow = readFileSync(pathJoin(toolDir, 'workflow.json'), 'utf8');
    let isolatedToolDir = '';
    const evidence: LiveIntegrationEvidence[] = [];
    const verify: NonNullable<LiveFinesseDependencies['verify']> = async (input) => {
      isolatedToolDir = input.toolDir;
      expect(input.toolDir).not.toBe(toolDir);
      expect(
        existsSync(pathJoin(dirname(input.toolDir), 'authenticate_fixture', 'workflow.json')),
      ).toBe(true);
      expect(
        existsSync(pathJoin(dirname(input.toolDir), '.imprint-shared', 'request-state.ts')),
      ).toBe(true);
      expect(existsSync(pathJoin(input.toolDir, '.live-verification.json'))).toBe(false);
      writeFileSync(pathJoin(input.toolDir, 'workflow.json'), 'mutated isolated workflow\n');
      writeFileSync(pathJoin(input.toolDir, '.live-verification.json'), '{"status":"approved"}\n');
      writeFileSync(
        pathJoin(input.toolDir, '.live-verification-evidence.json'),
        '[{"label":"query"}]\n',
      );
      writeFileSync(pathJoin(input.toolDir, '.live-verifier-log.jsonl'), '{"type":"done"}\n');
      return {
        report: approvedReport(),
        provider: 'codex-cli',
        model: 'fixture-verifier',
        attempts: 1,
        completedReview: true,
      };
    };

    const result = await runBestEffortLiveFinesse(
      { provider: 'codex-cli', toolDir, evidence },
      { verify },
    );

    expect(result).toMatchObject({
      status: 'completed',
      provider: 'codex-cli',
      model: 'fixture-verifier',
      attempts: 1,
      completedReview: true,
      report: approvedReport(),
      artifacts: {
        reportJson: '{"status":"approved"}\n',
        evidenceJson: '[{"label":"query"}]\n',
        logJsonl: '{"type":"done"}\n',
      },
    });
    expect(readFileSync(pathJoin(toolDir, 'workflow.json'), 'utf8')).toBe(canonicalWorkflow);
    expect(readFileSync(pathJoin(toolDir, '.live-verification.json'), 'utf8')).toBe(
      'canonical report\n',
    );
    expect(existsSync(isolatedToolDir)).toBe(false);
  });

  it('returns provider failures as advisory data and removes the isolated copy', async () => {
    const toolDir = fixtureTool('provider_failure_fixture');
    let isolatedToolDir = '';
    const verify: NonNullable<LiveFinesseDependencies['verify']> = async (input) => {
      isolatedToolDir = input.toolDir;
      writeFileSync(pathJoin(input.toolDir, '.live-verifier-log.jsonl'), '{"type":"provider"}\n');
      throw new ProviderReportedError(
        'codex-cli',
        { statuses: [503], messages: ['provider is temporarily overloaded'] },
        undefined,
        'capacity_or_overload',
      );
    };

    const result = await runBestEffortLiveFinesse(
      { provider: 'codex-cli', toolDir, evidence: [] },
      { verify },
    );

    expect(result.status).toBe('inconclusive');
    expect(result.completedReview).toBe(false);
    expect(result.message).toContain('provider is temporarily overloaded');
    expect(result.artifacts.logJsonl).toBe('{"type":"provider"}\n');
    expect(existsSync(isolatedToolDir)).toBe(false);
  });

  it('returns cancellation without invoking the verifier', async () => {
    const toolDir = fixtureTool('cancelled_fixture');
    const controller = new AbortController();
    controller.abort(new DOMException('user stopped finesse', 'AbortError'));
    let called = false;

    const result = await runBestEffortLiveFinesse(
      { provider: 'codex-cli', toolDir, evidence: [], signal: controller.signal },
      {
        verify: async () => {
          called = true;
          throw new Error('must not run');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'cancelled',
      completedReview: false,
      message: 'user stopped finesse',
    });
    expect(called).toBe(false);
  });

  it('serializes live finesse work at global concurrency one', async () => {
    expect(LIVE_FINESSE_CONCURRENCY).toBe(1);
    const firstTool = fixtureTool('first_fixture');
    const secondTool = fixtureTool('second_fixture');
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const verify: NonNullable<LiveFinesseDependencies['verify']> = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const current = calls;
      if (current === 1) markFirstStarted?.();
      else markSecondStarted?.();
      await new Promise<void>((resolve) => {
        if (current === 1) releaseFirst = resolve;
        else releaseSecond = resolve;
      });
      active--;
      return {
        report: approvedReport(),
        provider: 'codex-cli',
        model: 'fixture-verifier',
        attempts: 1,
        completedReview: true,
      };
    };

    const first = runBestEffortLiveFinesse(
      { provider: 'codex-cli', toolDir: firstTool, evidence: [] },
      { verify },
    );
    await firstStarted;
    const second = runBestEffortLiveFinesse(
      { provider: 'codex-cli', toolDir: secondTool, evidence: [] },
      { verify },
    );
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    releaseFirst?.();
    await secondStarted;
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    releaseSecond?.();
    await Promise.all([first, second]);
    expect(active).toBe(0);
  });
});
