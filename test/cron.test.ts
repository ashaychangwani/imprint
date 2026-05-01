/**
 * Tests for `imprint cron`. We never actually let node-cron schedule
 * anything in tests — every assertion uses `--once` mode (runOnce path)
 * or pure validation paths so the suite stays fast and deterministic.
 *
 * The test fixtures write a temporary examples/ tree with a generated
 * tool that returns whatever ToolResult we configure via env hooks.
 * That keeps each test free of network calls and gives us full control
 * over the success / failure paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { runCron } from '../src/imprint/cron.ts';
import { CronConfigSchema } from '../src/imprint/types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-cron-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  // `delete` is the only way to fully unset an env var; assigning undefined
  // would make process.env.X read back as the literal string "undefined".
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.PUSHOVER_TOKEN;
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.PUSHOVER_USER;
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.IMPRINT_TEST_RESULT;
});

/**
 * Write a fake example whose generated tool reads its outcome from the
 * IMPRINT_TEST_RESULT env var. Lets each test choose `ok` / `auth` /
 * `network` without rewriting fixtures.
 */
function writeFakeExample(site: string, params: Array<{ name: string; type: string }>): void {
  const dir = pathResolve(root, site);
  mkdirSync(dir, { recursive: true });
  const fnName = site
    .split('_')
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
  const paramSchema = JSON.stringify(params.map((p) => ({ ...p, description: 'test' })));
  writeFileSync(
    pathResolve(dir, 'index.ts'),
    `
export const WORKFLOW = {
  toolName: '${site}',
  intent: { description: 'test fixture' },
  parameters: ${paramSchema},
  requests: [],
  site: '${site}',
};
export async function ${fnName}(input) {
  globalThis.__IMPRINT_TEST_LAST_INPUT = input;
  const mode = process.env.IMPRINT_TEST_RESULT ?? 'ok';
  if (mode === 'auth') {
    return { ok: false, error: 'AUTH_EXPIRED', message: 'auth expired',
             remediation: 'run imprint login ${site}' };
  }
  if (mode === 'throw') throw new Error('boom');
  return { ok: true, data: { received: input } };
}
`,
    'utf8',
  );
}

function writeConfig(site: string, body: object): string {
  const path = pathResolve(root, site, 'cron.json');
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
  return path;
}

describe('CronConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const r = CronConfigSchema.safeParse({ schedule: '* * * * *', params: { x: 1 } });
    expect(r.success).toBe(true);
  });

  it('defaults params to {} when omitted', () => {
    const r = CronConfigSchema.parse({ schedule: '* * * * *' });
    expect(r.params).toEqual({});
  });

  it('rejects when schedule is missing', () => {
    const r = CronConfigSchema.safeParse({ params: {} });
    expect(r.success).toBe(false);
  });

  it('rejects non-primitive param values', () => {
    const r = CronConfigSchema.safeParse({ schedule: '* * * * *', params: { x: { nested: 1 } } });
    expect(r.success).toBe(false);
  });
});

describe('runCron({ once: true })', () => {
  it('invokes the tool once with the configured params on the ok path', async () => {
    writeFakeExample('echo_once', [{ name: 'msg', type: 'string' }]);
    writeConfig('echo_once', { schedule: '* * * * *', params: { msg: 'hi' } });
    await runCron({ site: 'echo_once', examplesDir: root, once: true });
    // The fake tool stashes its input on globalThis for verification.
    expect((globalThis as Record<string, unknown>).__IMPRINT_TEST_LAST_INPUT).toEqual({
      msg: 'hi',
    });
  });

  it('rejects an invalid cron expression before scheduling', async () => {
    writeFakeExample('bad_sched', []);
    writeConfig('bad_sched', { schedule: 'not a cron expression', params: {} });
    await expect(runCron({ site: 'bad_sched', examplesDir: root, once: true })).rejects.toThrow(
      /Invalid cron expression/,
    );
  });

  it('rejects when params do not match the workflow contract', async () => {
    writeFakeExample('typed', [{ name: 'count', type: 'number' }]);
    writeConfig('typed', { schedule: '* * * * *', params: { count: 'not-a-number' } });
    await expect(runCron({ site: 'typed', examplesDir: root, once: true })).rejects.toThrow(
      /params invalid/,
    );
  });

  it('throws when cron.json is missing', async () => {
    writeFakeExample('no_config', []);
    await expect(runCron({ site: 'no_config', examplesDir: root, once: true })).rejects.toThrow(
      /cron\.json not found/,
    );
  });

  it('throws when no generated tool exists for the site', async () => {
    // Config exists but no example dir — write the config under a bare folder.
    mkdirSync(pathResolve(root, 'orphan'), { recursive: true });
    writeFileSync(
      pathResolve(root, 'orphan', 'cron.json'),
      JSON.stringify({ schedule: '* * * * *', params: {} }),
      'utf8',
    );
    await expect(runCron({ site: 'orphan', examplesDir: root, once: true })).rejects.toThrow(
      /No generated tool found/,
    );
  });

  it('rejects --once combined with --run-now', async () => {
    writeFakeExample('combo', []);
    writeConfig('combo', { schedule: '* * * * *', params: {} });
    await expect(
      runCron({ site: 'combo', examplesDir: root, once: true, runNow: true }),
    ).rejects.toThrow(/cannot combine --once with --run-now/);
  });

  it('catches an exception thrown by the tool function', async () => {
    writeFakeExample('thrower', []);
    writeConfig('thrower', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'throw';
    // Should not reject — runOnce surfaces the throw as an UNKNOWN ToolResult.
    await runCron({ site: 'thrower', examplesDir: root, once: true });
  });
});

describe('Pushover hook', () => {
  it('skips notification when env vars are missing', async () => {
    writeFakeExample('no_push', []);
    writeConfig('no_push', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    let called = false;
    const fakeNotifyFetch = (async (..._args: unknown[]) => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'no_push',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(called).toBe(false);
  });

  it('POSTs to Pushover when env vars are set and the tool fails', async () => {
    writeFakeExample('with_push', []);
    writeConfig('with_push', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    process.env.PUSHOVER_TOKEN = 'tok';
    process.env.PUSHOVER_USER = 'user';
    const captured: Array<{ url: string; body: string }> = [];
    const fakeNotifyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('{"status":1}', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'with_push',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(captured).toHaveLength(1);
    const got = captured[0];
    if (!got) throw new Error('unreachable: captured length already asserted');
    expect(got.url).toContain('pushover.net');
    expect(got.body).toContain('token=tok');
    expect(got.body).toContain('user=user');
    expect(got.body).toContain('AUTH_EXPIRED');
  });

  it('does not POST on a successful run even when env vars are set', async () => {
    writeFakeExample('success_push', []);
    writeConfig('success_push', { schedule: '* * * * *', params: {} });
    process.env.PUSHOVER_TOKEN = 'tok';
    process.env.PUSHOVER_USER = 'user';
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'success_push',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(called).toBe(false);
  });
});
