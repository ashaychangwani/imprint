/**
 * Credential storage backend tests. We swap in an in-memory fake backend via
 * setBackendOverride so we exercise the call paths without touching the OS
 * keychain. The encrypted-file backend is exercised by credential-bundle.test.ts
 * (via importBundle, which round-trips through libsodium).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCredentialLock } from '../src/imprint/credential-lock.ts';
import {
  type CookieRecord,
  type CredentialBackend,
  type StorageRecord,
  commitSiteAuthState,
  compareAndSwapSiteCookies,
  getCredentialBackend,
  loadSiteCredentials,
  resetBackendCache,
  saveSiteStorage,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';

const directories: string[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const cookie = (value: string, name = 'sid'): CookieRecord => ({
  name,
  value,
  domain: 'fixture.invalid',
  path: '/',
});

class InMemoryBackend implements CredentialBackend {
  readonly id = 'keyring' as const;
  readonly lockDirectory = mkdtempSync(join(tmpdir(), 'imprint-credentials-'));
  constructor() {
    directories.push(this.lockDirectory);
  }
  private secrets = new Map<string, string>();
  private cookies = new Map<string, CookieRecord[]>();
  private storage = new Map<string, StorageRecord[]>();
  private k(site: string, name: string): string {
    return `${site}::${name}`;
  }
  async getSecret(site: string, name: string): Promise<string | null> {
    return this.secrets.get(this.k(site, name)) ?? null;
  }
  async setSecret(site: string, name: string, value: string): Promise<void> {
    this.secrets.set(this.k(site, name), value);
  }
  async deleteSecret(site: string, name: string): Promise<void> {
    this.secrets.delete(this.k(site, name));
  }
  async listSecrets(site: string): Promise<string[]> {
    const prefix = `${site}::`;
    return Array.from(this.secrets.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
  async getCookies(site: string): Promise<CookieRecord[]> {
    return this.cookies.get(site) ?? [];
  }
  async setCookies(site: string, cookies: CookieRecord[]): Promise<void> {
    this.cookies.set(site, cookies);
  }
  async getStorage(site: string): Promise<StorageRecord[]> {
    return this.storage.get(site) ?? [];
  }
  async setStorage(site: string, storage: StorageRecord[]): Promise<void> {
    this.storage.set(site, storage);
  }
  async listSites(): Promise<string[]> {
    const sites = new Set<string>();
    for (const k of this.secrets.keys()) {
      const idx = k.indexOf('::');
      if (idx > 0) sites.add(k.slice(0, idx));
    }
    for (const s of this.cookies.keys()) sites.add(s);
    for (const s of this.storage.keys()) sites.add(s);
    return Array.from(sites).sort();
  }
}

describe('credential-store backend overrides', () => {
  beforeEach(() => {
    setBackendOverride(null);
    resetBackendCache();
  });
  afterEach(() => {
    setBackendOverride(null);
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('can set and read secrets through an injected backend', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);

    const backend = await getCredentialBackend();
    expect(backend).toBe(fake);

    await backend.setSecret('southwest-seats', 'username', 'fixture-user');
    await backend.setSecret('southwest-seats', 'password', 'hunter2');

    expect(await backend.getSecret('southwest-seats', 'username')).toBe('fixture-user');
    expect(await backend.listSecrets('southwest-seats')).toEqual(['username', 'password']);

    await backend.deleteSecret('southwest-seats', 'password');
    expect(await backend.getSecret('southwest-seats', 'password')).toBeNull();
  });

  it('cookies are bulk-set/retrieved per site', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);

    const backend = await getCredentialBackend();
    const cookies: CookieRecord[] = [
      { name: 'sid', value: 'abc', domain: 'example.com', path: '/' },
      { name: 'pref', value: 'dark', domain: 'example.com', path: '/' },
    ];
    await backend.setCookies('example', cookies);
    expect(await backend.getCookies('example')).toEqual(cookies);
  });

  it('loadSiteCredentials returns empty view when nothing stored', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    const view = await loadSiteCredentials('unknown-site');
    expect(view.values).toEqual({});
    expect(view.cookies).toEqual([]);
    expect(view.storage).toEqual([]);
  });

  it('loadSiteCredentials surfaces all stored secrets, cookies, and storage', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    await fake.setSecret('s1', 'username', 'alice');
    await fake.setSecret('s1', 'password', 'hunter2');
    await fake.setCookies('s1', [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }]);
    await fake.setStorage('s1', [
      { origin: 'https://example.com', kind: 'localStorage', key: 'access_token', value: 'tok' },
    ]);

    const view = await loadSiteCredentials('s1');
    expect(view.values).toEqual({ username: 'alice', password: 'hunter2' });
    expect(view.cookies).toHaveLength(1);
    expect(view.storage).toEqual([
      { origin: 'https://example.com', kind: 'localStorage', key: 'access_token', value: 'tok' },
    ]);
  });

  it('saveSiteStorage round-trips localStorage records through the backend', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    const records: StorageRecord[] = [
      {
        origin: 'https://fix.example',
        kind: 'localStorage',
        key: 'sessionHandle',
        value: 'SYNTH-1',
      },
      { origin: 'https://fix.example', kind: 'localStorage', key: 'authBlob', value: 'SYNTH-2' },
    ];
    await saveSiteStorage('fix', records);
    const view = await loadSiteCredentials('fix');
    expect(view.storage).toEqual(records);
  });

  it('saveSiteStorage no-ops gracefully on a backend without setStorage', async () => {
    // A legacy backend implements neither getStorage nor setStorage. saveSiteStorage
    // must tolerate it (optional chaining) rather than throwing.
    const legacyLike: CredentialBackend = {
      id: 'legacy-json',
      async getSecret() {
        return null;
      },
      async setSecret() {},
      async deleteSecret() {},
      async listSecrets() {
        return [];
      },
      async getCookies() {
        return [];
      },
      async setCookies() {},
      async listSites() {
        return [];
      },
    };
    setBackendOverride(legacyLike);
    await saveSiteStorage('fix', [
      { origin: 'https://fix.example', kind: 'localStorage', key: 'k', value: 'v' },
    ]);
    // No throw; storage is simply not persisted.
    const view = await loadSiteCredentials('fix');
    expect(view.storage).toEqual([]);
  });

  it('publishes full renewed cookie snapshots for subsequent fresh loads, including removals', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    await fake.setSecret('fixture', 'password', 'synthetic-password');
    await fake.setStorage('fixture', [
      {
        origin: 'https://fixture.invalid',
        kind: 'localStorage',
        key: 'mode',
        value: 'synthetic-mode',
      },
    ]);
    await fake.setCookies('fixture', [cookie('old'), cookie('removed', 'obsolete')]);
    const original = await loadSiteCredentials('fixture');
    const result = await compareAndSwapSiteCookies('fixture', original.revision, [
      cookie('renewed'),
    ]);
    expect(result.status).toBe('updated');
    expect(result.revision).not.toBe(original.revision);
    const first = await loadSiteCredentials('fixture');
    const second = await loadSiteCredentials('fixture');
    expect(first).toEqual(second);
    expect(first.revision).toBe(result.revision);
    expect(first.cookies).toEqual([cookie('renewed')]);
    expect(first.values).toEqual(original.values);
    expect(first.storage).toEqual(original.storage);
    const firstCookie = first.cookies[0];
    if (!firstCookie) throw new Error('Missing renewed cookie');
    firstCookie.value = 'caller-mutation';
    expect((await loadSiteCredentials('fixture')).cookies).toEqual([cookie('renewed')]);
  });

  it('does not write unchanged state or overwrite a newer auth/storage revision', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    await fake.setCookies('fixture', [cookie('old')]);
    const original = await loadSiteCredentials('fixture');
    const writes = spyOn(fake, 'setCookies');
    expect(
      (await compareAndSwapSiteCookies('fixture', original.revision, original.cookies)).status,
    ).toBe('unchanged');
    expect(writes).not.toHaveBeenCalled();
    await commitSiteAuthState('fixture', [cookie('new-auth')], { token: 'synthetic-new-auth' });
    writes.mockClear();
    expect(
      (await compareAndSwapSiteCookies('fixture', original.revision, [cookie('stale-browser')]))
        .status,
    ).toBe('stale');
    expect(writes).not.toHaveBeenCalled();
    const current = await loadSiteCredentials('fixture');
    await saveSiteStorage('fixture', [
      {
        origin: 'https://fixture.invalid',
        kind: 'sessionStorage',
        key: 'changed',
        value: 'synthetic-new',
      },
    ]);
    expect(
      (await compareAndSwapSiteCookies('fixture', current.revision, [cookie('stale-storage')]))
        .status,
    ).toBe('stale');
    expect((await loadSiteCredentials('fixture')).cookies).toEqual([cookie('new-auth')]);
    writes.mockRestore();
  });

  it('serializes a browser CAS and fresh reads behind a complete auth commit', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    await fake.setCookies('fixture', [cookie('old')]);
    const original = await loadSiteCredentials('fixture');
    const paused = deferred();
    const resume = deferred();
    const setSecret = fake.setSecret.bind(fake);
    fake.setSecret = async (site, name, value) => {
      await setSecret(site, name, value);
      paused.resolve();
      await resume.promise;
    };
    const commit = commitSiteAuthState('fixture', [cookie('new-auth')], {
      token: 'synthetic-token',
    });
    await paused.promise;
    let readSettled = false;
    const read = loadSiteCredentials('fixture').then((view) => {
      readSettled = true;
      return view;
    });
    const stale = compareAndSwapSiteCookies('fixture', original.revision, [
      cookie('stale-browser'),
    ]);
    await Bun.sleep(30);
    expect(readSettled).toBe(false);
    resume.resolve();
    await commit;
    expect((await stale).status).toBe('stale');
    expect((await read).values).toEqual({ token: 'synthetic-token' });
    expect((await loadSiteCredentials('fixture')).cookies).toEqual([cookie('new-auth')]);
  });

  it('rolls back a cancelled cookie write without changing other durable material', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    await fake.setCookies('fixture', [cookie('old')]);
    await fake.setSecret('fixture', 'password', 'synthetic-password');
    const original = await loadSiteCredentials('fixture');
    const abort = new AbortController();
    const setCookies = fake.setCookies.bind(fake);
    fake.setCookies = async (site, cookies) => {
      await setCookies(site, cookies);
      if (cookies[0]?.value === 'cancelled-new')
        abort.abort(new DOMException('Cancelled fixture', 'AbortError'));
    };
    await expect(
      compareAndSwapSiteCookies('fixture', original.revision, [cookie('cancelled-new')], {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await loadSiteCredentials('fixture')).toEqual(original);
    expect(readdirSync(fake.lockDirectory)).toEqual([]);
  });

  it('cancels a waiting CAS without writing or releasing the current owner', async () => {
    const fake = new InMemoryBackend();
    setBackendOverride(fake);
    const original = await loadSiteCredentials('fixture');
    const entered = deferred();
    const resume = deferred();
    const holder = withCredentialLock(fake.lockDirectory, undefined, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    const abort = new AbortController();
    const pending = compareAndSwapSiteCookies('fixture', original.revision, [cookie('never')], {
      signal: abort.signal,
    });
    abort.abort(new DOMException('Cancelled fixture', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(fake.lockDirectory).filter((name) => name.endsWith('.json'))).toHaveLength(
      1,
    );
    resume.resolve();
    await holder;
    expect(await loadSiteCredentials('fixture')).toEqual(original);
  });
});
