import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetCompileCdpPoolForTest,
  __resetCompilePacingForTest,
  __setCdpBrowserFetchFactoryForTest,
  runWorkflowWithLadder,
} from '../src/imprint/backend-ladder.ts';
import type { MintedJar } from '../src/imprint/cdp-browser-fetch.ts';
import { withCredentialLock } from '../src/imprint/credential-lock.ts';
import {
  type CookieRecord,
  type CredentialBackend,
  type StorageRecord,
  loadSiteCredentials,
  saveSiteCookies,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import { loadCredentialStore } from '../src/imprint/runtime.ts';

class FixtureBackend implements CredentialBackend {
  readonly id = 'keyring' as const;
  lockDirectory?: string;
  cookies: CookieRecord[] = [];
  storage: StorageRecord[] = [];
  values: Record<string, string> = { username: 'fixture-user' };
  async getSecret(_site: string, name: string) {
    return this.values[name] ?? null;
  }
  async setSecret(_site: string, name: string, value: string) {
    this.values[name] = value;
  }
  async deleteSecret(_site: string, name: string) {
    delete this.values[name];
  }
  async listSecrets() {
    return Object.keys(this.values);
  }
  async getCookies() {
    return structuredClone(this.cookies);
  }
  async setCookies(_site: string, cookies: CookieRecord[]) {
    this.cookies = structuredClone(cookies);
  }
  async getStorage() {
    return structuredClone(this.storage);
  }
  async setStorage(_site: string, storage: StorageRecord[]) {
    this.storage = structuredClone(storage);
  }
  async listSites() {
    return ['fixture-writeback'];
  }
}

describe('durable browser cookie handoff across ordinary tools', () => {
  const site = 'fixture-writeback';
  const cookie = (value: string): CookieRecord => ({
    name: '__Host-session',
    value,
    domain: 'fixture.invalid',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: true,
  });
  let root: string;
  let backend: FixtureBackend;
  let seeds: MintedJar['cookies'][];
  let beforeResponse: (() => Promise<void>) | undefined;
  let afterSnapshot: (() => void) | undefined;
  let rejected: boolean;
  let rotate: boolean;
  let independentHttpCookie: boolean;
  let httpStatus: number;
  let previousSpacing: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imprint-browser-writeback-'));
    backend = new FixtureBackend();
    backend.lockDirectory = join(root, 'credential-lock');
    backend.cookies = [
      cookie('fixture-before'),
      { ...cookie('fixture-obsolete'), name: 'removed' },
    ];
    backend.storage = [
      {
        origin: 'https://fixture.invalid',
        kind: 'localStorage',
        key: 'device',
        value: 'fixture-device',
      },
    ];
    setBackendOverride(backend);
    seeds = [];
    beforeResponse = undefined;
    afterSnapshot = undefined;
    rejected = false;
    rotate = true;
    independentHttpCookie = false;
    httpStatus = 200;
    previousSpacing = process.env.IMPRINT_COMPILE_ACT_SPACING_MS;
    process.env.IMPRINT_COMPILE_ACT_SPACING_MS = '0';
    __resetCompilePacingForTest();
    __setCdpBrowserFetchFactoryForTest((options) => {
      let cookies: MintedJar['cookies'] = (options.seedCookies ?? []).map((entry) => ({
        ...entry,
        path: entry.path ?? '/',
      }));
      seeds.push(structuredClone(cookies));
      let snapshots = 0;
      const respond = async () => {
        await beforeResponse?.();
        if (rotate) cookies = [cookie('fixture-renewed')];
        return new Response('{"hotels":[{"id":"fixture-hotel"}]}', {
          status: httpStatus,
          headers: independentHttpCookie
            ? { 'set-cookie': 'api_session=fixture-api; Path=/; Secure; HttpOnly' }
            : {},
        });
      };
      return {
        fetchImpl: respond as unknown as typeof fetch,
        navigate: respond,
        snapshotCookies: async () => structuredClone(cookies),
        snapshotExistingCookies: async () => structuredClone(cookies),
        ensureBootstrapped: async () => [],
        mintJar: async () => {
          if (++snapshots > 1) afterSnapshot?.();
          return {
            cookies: structuredClone(cookies),
            ua: 'fixture-UA',
            html: '',
            bootstrapEpoch: Date.now(),
            abckFlag: '?',
            seedCookieDiagnostics: {
              attempted: options.seedCookies?.length ?? 0,
              accepted: rejected ? 0 : (options.seedCookies?.length ?? 0),
              rejected: rejected ? 1 : 0,
              failed: 0,
              issues: [],
              issuesTruncated: false,
            },
          };
        },
        close: async () => {},
      };
    });
  });
  afterEach(() => {
    __resetCompileCdpPoolForTest();
    __setCdpBrowserFetchFactoryForTest(null);
    setBackendOverride(null);
    if (previousSpacing === undefined)
      Reflect.deleteProperty(process.env, 'IMPRINT_COMPILE_ACT_SPACING_MS');
    else process.env.IMPRINT_COMPILE_ACT_SPACING_MS = previousSpacing;
    rmSync(root, { recursive: true, force: true });
  });
  function workflow(name: string) {
    const dir = join(root, site, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'workflow.json');
    writeFileSync(
      path,
      JSON.stringify({
        site,
        toolName: name,
        intent: { description: 'synthetic cookie handoff' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://fixture.invalid/properties', headers: {} }],
      }),
    );
    return path;
  }
  const run = (workflowPath: string, signal?: AbortSignal) =>
    runWorkflowWithLadder({
      workflowPath,
      params: {},
      forceBackend: 'cdp-replay',
      signal,
    });

  it('loads renewed cookies and removals in a fresh tool with a separate artifact cache', async () => {
    expect((await run(workflow('research'))).result.ok).toBe(true);
    expect((await run(workflow('normal_consumer'))).result.ok).toBe(true);
    expect(seeds[1]).toEqual([expect.objectContaining(cookie('fixture-renewed'))]);
    const stored = await loadSiteCredentials(site);
    expect(stored.cookies.map(({ name }) => name)).toEqual(['__Host-session']);
    expect(stored.values).toEqual({ username: 'fixture-user' });
    expect(stored.storage).toEqual(backend.storage);
  });

  it('also writes back when a supported integration passes its freshly loaded store explicitly', async () => {
    const credentials = await loadCredentialStore(site);
    expect(credentials?.durableRevision).toBeDefined();
    await runWorkflowWithLadder({
      workflowPath: workflow('explicit'),
      params: {},
      forceBackend: 'cdp-replay',
      credentials: credentials ?? undefined,
    });
    expect((await loadSiteCredentials(site)).cookies[0]?.value).toBe('fixture-renewed');
  });

  it('does not overwrite authentication committed while an older browser was executing', async () => {
    beforeResponse = async () => {
      await saveSiteCookies(site, [cookie('fixture-new-auth')]);
    };
    expect((await run(workflow('older_browser'))).result.ok).toBe(true);
    expect((await loadSiteCredentials(site)).cookies[0]?.value).toBe('fixture-new-auth');
  });

  it('does not turn rejected cookie seeds into durable deletions', async () => {
    rejected = true;
    await run(workflow('rejected_seed'));
    expect((await loadSiteCredentials(site)).cookies.map(({ value }) => value)).toEqual([
      'fixture-before',
      'fixture-obsolete',
    ]);
  });

  it('does not write back after cancellation during the final browser snapshot', async () => {
    const cancel = new AbortController();
    afterSnapshot = () => cancel.abort(new Error('fixture cancellation'));
    await expect(run(workflow('cancelled'), cancel.signal)).rejects.toThrow('fixture cancellation');
    expect((await loadSiteCredentials(site)).cookies[0]?.value).toBe('fixture-before');
  });

  it('never writes synthetic credential overrides without a durable read version', async () => {
    await runWorkflowWithLadder({
      workflowPath: workflow('synthetic'),
      params: {},
      forceBackend: 'cdp-replay',
      credentials: { site, cookies: [cookie('fixture-synthetic')], values: {} },
    });
    expect((await loadSiteCredentials(site)).cookies[0]?.value).toBe('fixture-before');
  });

  it('keeps independent HTTP Set-Cookie changes alongside the complete browser snapshot', async () => {
    rotate = false;
    independentHttpCookie = true;
    await run(workflow('mixed_transport'));
    expect((await loadSiteCredentials(site)).cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'api_session', value: 'fixture-api' }),
        expect.objectContaining(cookie('fixture-before')),
      ]),
    );
  });

  it('does not rotate the durable version or recreate a warm browser for unchanged cookies', async () => {
    const workflowPath = workflow('unchanged');
    await run(workflowPath);
    const first = await loadSiteCredentials(site);
    await run(workflowPath);
    const second = await loadSiteCredentials(site);
    expect(second.revision).toBe(first.revision);
    expect(seeds).toHaveLength(1);
  });

  it('records after-failure cookie identities without launching another browser or committing them', async () => {
    const prior = process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
    const path = join(root, 'private-facts.jsonl');
    process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH = path;
    try {
      httpStatus = 401;
      const result = await run(workflow('rejected_session'));
      expect(result.result).toMatchObject({ ok: false, error: 'AUTH_EXPIRED', status: 401 });
      const events = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        events.filter(({ event }) => event === 'browser-state').map(({ source }) => source),
      ).toEqual(['cdp-before-seed', 'cdp-after-bootstrap', 'cdp-after-request']);
      expect(seeds).toHaveLength(1);
      expect((await loadSiteCredentials(site)).cookies[0]?.value).toBe('fixture-before');
      expect(readFileSync(path, 'utf8')).not.toContain('fixture-renewed');
    } finally {
      if (prior === undefined)
        Reflect.deleteProperty(process.env, 'IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH');
      else process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH = prior;
    }
  });

  it('cancels a consumer waiting for another credential writer without launching a browser', async () => {
    const cancel = new AbortController();
    let release!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withCredentialLock(backend.lockDirectory ?? '', undefined, async () => {
      admitted();
      await gate;
    });
    await ready;
    try {
      const pending = run(workflow('blocked_reader'), cancel.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancel.abort(new Error('fixture blocked read cancellation'));
      await expect(pending).rejects.toThrow('fixture blocked read cancellation');
      expect(seeds).toHaveLength(0);
    } finally {
      release();
      await held;
    }
  });
});
