/**
 * Encrypted bundle round-trip tests. Exercises libsodium (real) and argon2id
 * KDF end-to-end against an in-memory backend. The test imports the same
 * fake backend used in credential-store.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { decryptBundle, exportBundle, importBundle } from '../src/imprint/credential-bundle.ts';
import {
  type CookieRecord,
  type CredentialBackend,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';

class InMemoryBackend implements CredentialBackend {
  readonly id = 'keyring' as const;
  private secrets = new Map<string, string>();
  private cookies = new Map<string, CookieRecord[]>();
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
  async listSites(): Promise<string[]> {
    return Array.from(this.cookies.keys()).sort();
  }
}

describe('credential-bundle export/import', () => {
  let backend: InMemoryBackend;

  beforeEach(async () => {
    backend = new InMemoryBackend();
    setBackendOverride(backend);
  });
  afterEach(() => {
    setBackendOverride(null);
    resetBackendCache();
  });

  it('round-trips secrets through export → decrypt → import', async () => {
    await backend.setSecret('southwest-seats', 'username', 'ashaychangwani');
    await backend.setSecret('southwest-seats', 'password', 'REDACTED-PASSWORD');
    await backend.setCookies('southwest-seats', [
      { name: 'sid', value: 'abc', domain: 'southwest.com', path: '/' },
    ]);

    const envelope = await exportBundle({
      backend,
      site: 'southwest-seats',
      passphrase: 'correct-horse-battery-staple',
    });

    expect(envelope.site).toBe('southwest-seats');
    expect(envelope.kdf.alg).toBe('argon2id');
    expect(envelope.cipher.alg).toBe('xsalsa20poly1305');
    expect(envelope.cipher.ctB64.length).toBeGreaterThan(0);

    // decrypt → contents are exactly what we put in
    const plain = await decryptBundle({
      envelope,
      passphrase: 'correct-horse-battery-staple',
    });
    expect(plain.secrets).toEqual({
      username: 'ashaychangwani',
      password: 'REDACTED-PASSWORD',
    });
    expect(plain.cookies).toHaveLength(1);

    // wipe + import to a fresh backend
    const target = new InMemoryBackend();
    const result = await importBundle({
      backend: target,
      envelope,
      passphrase: 'correct-horse-battery-staple',
    });
    expect(result.imported.sort()).toEqual(['password', 'username']);
    expect(await target.getSecret('southwest-seats', 'username')).toBe('ashaychangwani');
    expect(await target.getSecret('southwest-seats', 'password')).toBe('REDACTED-PASSWORD');
    expect(await target.getCookies('southwest-seats')).toHaveLength(1);
  }, 30_000); // argon2 derivation is intentionally slow; allow time

  it('rejects wrong passphrase', async () => {
    await backend.setSecret('s', 'k', 'v');
    const envelope = await exportBundle({
      backend,
      site: 's',
      passphrase: 'right-passphrase-12',
    });
    await expect(decryptBundle({ envelope, passphrase: 'wrong-passphrase-12' })).rejects.toThrow(
      /passphrase|tampered/i,
    );
  }, 30_000);

  it('rejects tampered ciphertext', async () => {
    await backend.setSecret('s', 'k', 'v');
    const envelope = await exportBundle({
      backend,
      site: 's',
      passphrase: 'pass-with-enough-chars',
    });
    // Mutate one byte in the ciphertext (after decode).
    const ct = Buffer.from(envelope.cipher.ctB64, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    envelope.cipher.ctB64 = ct.toString('base64');

    await expect(decryptBundle({ envelope, passphrase: 'pass-with-enough-chars' })).rejects.toThrow(
      /passphrase|tampered/i,
    );
  }, 30_000);

  it('refuses passphrases shorter than 8 chars', async () => {
    await backend.setSecret('s', 'k', 'v');
    await expect(exportBundle({ backend, site: 's', passphrase: 'short' })).rejects.toThrow(
      /at least 8/,
    );
  });
});
