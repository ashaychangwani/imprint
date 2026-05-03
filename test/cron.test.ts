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
  delete process.env.NTFY_URL;
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.NTFY_TOKEN;
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.IMPRINT_TEST_RESULT;
  // biome-ignore lint/performance/noDelete: env vars need real deletion
  delete process.env.IMPRINT_TEST_RESULT_SEQUENCE;
  // Reset per-call counters that the fake examples write to globalThis.
  const g = globalThis as Record<string, unknown>;
  g.__IMPRINT_TEST_CALL_COUNT = 0;
  g.__IMPRINT_TEST_FETCH_IMPL_CALLS = 0;
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
  requests: [{ method: 'GET', url: 'https://example.com/api/${site}', headers: {} }],
  site: '${site}',
};

function makeResult(mode, input) {
  if (mode === 'auth') {
    return { ok: false, error: 'AUTH_EXPIRED', message: 'auth expired',
             remediation: 'run imprint login ${site}' };
  }
  if (mode === 'forbidden') {
    return { ok: false, error: 'FORBIDDEN', message: 'bot detection — go away' };
  }
  if (mode === 'throw') throw new Error('boom');
  if (mode === 'fares') {
    return { ok: true, data: { items: [{ price: 89 }, { price: 149 }, { price: 199 }] } };
  }
  return { ok: true, data: { received: input } };
}

export async function ${fnName}(input, opts) {
  globalThis.__IMPRINT_TEST_LAST_INPUT = input;
  // Track call count for SEQUENCE mode and to mark which backend ran
  // (when fetchImpl is injected, that's the stealth-fetch backend).
  globalThis.__IMPRINT_TEST_CALL_COUNT = (globalThis.__IMPRINT_TEST_CALL_COUNT ?? 0) + 1;
  if (opts && opts.fetchImpl) {
    globalThis.__IMPRINT_TEST_FETCH_IMPL_CALLS = (globalThis.__IMPRINT_TEST_FETCH_IMPL_CALLS ?? 0) + 1;
  }
  const seq = process.env.IMPRINT_TEST_RESULT_SEQUENCE;
  if (seq) {
    const modes = seq.split(',');
    const idx = (globalThis.__IMPRINT_TEST_CALL_COUNT - 1) % modes.length;
    return makeResult(modes[idx] ?? 'ok', input);
  }
  return makeResult(process.env.IMPRINT_TEST_RESULT ?? 'ok', input);
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

describe('ntfy hook', () => {
  it('POSTs to NTFY_URL with title + body when configured and the tool fails', async () => {
    writeFakeExample('with_ntfy', []);
    writeConfig('with_ntfy', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    process.env.NTFY_URL = 'https://ntfy.example.com/imprint-test';
    const captured: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const fakeNotifyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headersObj: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        headersObj[k] = String(v);
      }
      captured.push({
        url: String(url),
        headers: headersObj,
        body: String(init?.body ?? ''),
      });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'with_ntfy',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(captured).toHaveLength(1);
    const got = captured[0];
    if (!got) throw new Error('unreachable: captured length already asserted');
    expect(got.url).toBe('https://ntfy.example.com/imprint-test');
    expect(got.headers.Title).toContain('with_ntfy');
    expect(got.body).toContain('AUTH_EXPIRED');
    expect(got.body).toContain('auth expired');
    expect(got.headers.Authorization).toBeUndefined();
  });

  it('adds a Bearer Authorization header when NTFY_TOKEN is set', async () => {
    writeFakeExample('ntfy_auth', []);
    writeConfig('ntfy_auth', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    process.env.NTFY_URL = 'https://ntfy.private.example/topic';
    process.env.NTFY_TOKEN = 'tk_secret';
    const captured: Array<{ headers: Record<string, string> }> = [];
    const fakeNotifyFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headersObj: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        headersObj[k] = String(v);
      }
      captured.push({ headers: headersObj });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'ntfy_auth',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(captured).toHaveLength(1);
    const got = captured[0];
    if (!got) throw new Error('unreachable: captured length already asserted');
    expect(got.headers.Authorization).toBe('Bearer tk_secret');
  });

  it('fires both Pushover and ntfy when both are configured', async () => {
    writeFakeExample('both_providers', []);
    writeConfig('both_providers', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    process.env.PUSHOVER_TOKEN = 'tok';
    process.env.PUSHOVER_USER = 'user';
    process.env.NTFY_URL = 'https://ntfy.sh/imprint-both';
    const calls: string[] = [];
    const fakeNotifyFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'both_providers',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((u) => u.includes('pushover.net'))).toBe(true);
    expect(calls.some((u) => u.includes('ntfy.sh'))).toBe(true);
  });

  it('skips ntfy entirely when NTFY_URL is not set', async () => {
    writeFakeExample('no_ntfy', []);
    writeConfig('no_ntfy', { schedule: '* * * * *', params: {} });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    // Neither provider configured.
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'no_ntfy',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(called).toBe(false);
  });
});

describe('notifyWhen (push-on-success predicate)', () => {
  it('fires a push when price_below matches', async () => {
    writeFakeExample('fares_match', []);
    writeConfig('fares_match', {
      schedule: '* * * * *',
      params: {},
      notifyWhen: { type: 'price_below', threshold: 100, pricePath: 'items[].price' },
    });
    process.env.IMPRINT_TEST_RESULT = 'fares';
    process.env.NTFY_URL = 'https://ntfy.example.com/match';
    const calls: Array<{ url: string; body: string }> = [];
    const fakeNotifyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'fares_match',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(calls).toHaveLength(1);
    const got = calls[0];
    if (!got) throw new Error('unreachable');
    // The fixture's lowest price is 89; threshold is 100; expect a push
    // mentioning the actual lowest.
    expect(got.body).toContain('$89');
  });

  it('does NOT push when price_below does not match', async () => {
    writeFakeExample('fares_nomatch', []);
    writeConfig('fares_nomatch', {
      schedule: '* * * * *',
      params: {},
      notifyWhen: { type: 'price_below', threshold: 50, pricePath: 'items[].price' },
    });
    process.env.IMPRINT_TEST_RESULT = 'fares';
    process.env.NTFY_URL = 'https://ntfy.example.com/nomatch';
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'fares_nomatch',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(called).toBe(false);
  });

  it('still pushes on failure regardless of notifyWhen', async () => {
    writeFakeExample('fail_with_when', []);
    writeConfig('fail_with_when', {
      schedule: '* * * * *',
      params: {},
      notifyWhen: { type: 'price_below', threshold: 999, pricePath: 'items[].price' },
    });
    process.env.IMPRINT_TEST_RESULT = 'auth';
    process.env.NTFY_URL = 'https://ntfy.example.com/fail';
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'fail_with_when',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    expect(called).toBe(true);
  });

  it('logs predicate evaluation errors but does not crash the loop', async () => {
    writeFakeExample('bad_path', []);
    writeConfig('bad_path', {
      schedule: '* * * * *',
      params: {},
      // pricePath expects items[] to be an array, but the fixture's "ok" mode
      // returns { received: input } — so items is undefined and the walker
      // returns []. Use a path that explicitly mis-types to force a throw.
      notifyWhen: { type: 'price_below', threshold: 999, pricePath: 'received.foo[].bar' },
    });
    // Default 'ok' mode → { received: input }. received.foo is undefined →
    // walker bails to []. We want an actual throw, so trigger via the fares
    // fixture but use a path that descends into a number.
    process.env.IMPRINT_TEST_RESULT = 'fares';
    // Override path: items[].price.deeper — descends INTO the number 89.
    writeConfig('bad_path', {
      schedule: '* * * * *',
      params: {},
      notifyWhen: { type: 'price_below', threshold: 999, pricePath: 'items[].price.deeper' },
    });
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runCron({
      site: 'bad_path',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    // Threw → caught + logged → no push fired.
    expect(called).toBe(false);
  });
});

describe('replayBackend', () => {
  it('errors clearly when replayBackend=playbook but no playbook.md exists', async () => {
    writeFakeExample('no_playbook', []);
    writeConfig('no_playbook', {
      schedule: '* * * * *',
      params: {},
      replayBackend: 'playbook',
    });
    await expect(runCron({ site: 'no_playbook', examplesDir: root, once: true })).rejects.toThrow(
      /playbook\.md.*doesn't exist/,
    );
  });

  it('runs the API path when replayBackend=fetch (default) and no playbook exists', async () => {
    writeFakeExample('plain_fetch', []);
    writeConfig('plain_fetch', { schedule: '* * * * *', params: {} });
    // No notifyWhen → no push expected even on success. Just verify no throw.
    await runCron({ site: 'plain_fetch', examplesDir: root, once: true });
  });

  it('replayBackend=auto without a playbook behaves like fetch', async () => {
    writeFakeExample('auto_no_playbook', []);
    writeConfig('auto_no_playbook', {
      schedule: '* * * * *',
      params: {},
      replayBackend: 'auto',
    });
    // Even with auto, no playbook means we never try to fall back.
    process.env.IMPRINT_TEST_RESULT = 'auth';
    let called = false;
    const fakeNotifyFetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    process.env.PUSHOVER_TOKEN = 'tok';
    process.env.PUSHOVER_USER = 'user';
    await runCron({
      site: 'auto_no_playbook',
      examplesDir: root,
      once: true,
      notifyFetchImpl: fakeNotifyFetch,
    });
    // The failure surfaces as the API result and triggers a notify.
    expect(called).toBe(true);
  });
});
