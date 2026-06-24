/**
 * Credential storage backend tests. We swap in an in-memory fake backend via
 * setBackendOverride so we exercise the call paths without touching the OS
 * keychain. The encrypted-file backend is exercised by credential-bundle.test.ts
 * (via importBundle, which round-trips through libsodium).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type CookieRecord,
  type CredentialBackend,
  type StorageRecord,
  getCredentialBackend,
  loadSiteCredentials,
  resetBackendCache,
  saveSiteStorage,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';

class InMemoryBackend implements CredentialBackend {
  readonly id = 'keyring' as const;
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
});
