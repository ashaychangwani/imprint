/**
 * Encrypted credential bundle export/import.
 *
 * Use case: a user teaches a skill on their laptop and ships both the skill
 * folder AND the credentials to a remote OpenClaw/Hermes agent. The skill
 * folder lives in git (no plaintext), and credentials travel as a passphrase
 * -encrypted bundle file the user can transport via any channel.
 *
 * Bundle wire format (JSON envelope; bytes never touch disk unencrypted):
 * ```
 * {
 *   "version": 1,
 *   "site": "<site>",
 *   "createdAt": "<iso>",
 *   "kdf": { "alg": "argon2id", "t": 3, "m": 65536, "p": 4, "saltB64": "..." },
 *   "cipher": { "alg": "xsalsa20poly1305", "nonceB64": "...", "ctB64": "..." }
 * }
 * ```
 * Plaintext (after decrypt) = `{ secrets: Record<string,string>, cookies: CookieRecord[], storage?: StorageRecord[], manifest: ManifestEntry[] }`.
 */

import { argon2id } from '@noble/hashes/argon2.js';
import {
  type CookieRecord,
  type CredentialBackend,
  type ManifestEntry,
  type StorageRecord,
  readSiteManifest,
  writeSiteManifest,
} from './credential-store.ts';

interface BundlePlaintext {
  secrets: Record<string, string>;
  cookies: CookieRecord[];
  storage?: StorageRecord[];
  manifest: ManifestEntry[];
}

export interface BundleEnvelope {
  version: 1;
  site: string;
  createdAt: string;
  kdf: { alg: 'argon2id'; t: number; m: number; p: number; saltB64: string };
  cipher: { alg: 'xsalsa20poly1305'; nonceB64: string; ctB64: string };
}

const KDF_T = 3;
const KDF_M = 64 * 1024;
const KDF_P = 4;

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return argon2id(new TextEncoder().encode(passphrase), salt, {
    t: KDF_T,
    m: KDF_M,
    p: KDF_P,
    dkLen: 32,
  });
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// biome-ignore lint/suspicious/noExplicitAny: lazy libsodium ref
let sodiumPromise: Promise<any> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: lazy libsodium ref
async function getSodium(): Promise<any> {
  if (!sodiumPromise) {
    sodiumPromise = import('libsodium-wrappers').then(async (m) => {
      await m.default.ready;
      return m.default;
    });
  }
  return sodiumPromise;
}

export async function exportBundle(opts: {
  backend: CredentialBackend;
  site: string;
  passphrase: string;
}): Promise<BundleEnvelope> {
  if (opts.passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  const sodium = await getSodium();

  const names = await opts.backend.listSecrets(opts.site);
  const secrets: Record<string, string> = {};
  for (const n of names) {
    const v = await opts.backend.getSecret(opts.site, n);
    if (v !== null) secrets[n] = v;
  }
  const cookies = await opts.backend.getCookies(opts.site);
  const storage = (await opts.backend.getStorage?.(opts.site)) ?? [];
  const manifest = readSiteManifest(opts.site)?.secrets ?? [];

  const plaintext: BundlePlaintext = { secrets, cookies, storage, manifest };
  const text = new TextEncoder().encode(JSON.stringify(plaintext));

  const salt = sodium.randombytes_buf(16);
  const key = deriveKey(opts.passphrase, salt);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(text, nonce, key);

  return {
    version: 1,
    site: opts.site,
    createdAt: new Date().toISOString(),
    kdf: { alg: 'argon2id', t: KDF_T, m: KDF_M, p: KDF_P, saltB64: b64encode(salt) },
    cipher: { alg: 'xsalsa20poly1305', nonceB64: b64encode(nonce), ctB64: b64encode(ct) },
  };
}

export async function decryptBundle(opts: {
  envelope: BundleEnvelope;
  passphrase: string;
}): Promise<BundlePlaintext> {
  const sodium = await getSodium();
  if (opts.envelope.version !== 1) {
    throw new Error(`Unknown bundle version ${opts.envelope.version}.`);
  }
  if (opts.envelope.kdf.alg !== 'argon2id') {
    throw new Error(`Unsupported KDF "${opts.envelope.kdf.alg}".`);
  }
  if (opts.envelope.cipher.alg !== 'xsalsa20poly1305') {
    throw new Error(`Unsupported cipher "${opts.envelope.cipher.alg}".`);
  }

  const salt = b64decode(opts.envelope.kdf.saltB64);
  const nonce = b64decode(opts.envelope.cipher.nonceB64);
  const ct = b64decode(opts.envelope.cipher.ctB64);
  const key = argon2id(new TextEncoder().encode(opts.passphrase), salt, {
    t: opts.envelope.kdf.t,
    m: opts.envelope.kdf.m,
    p: opts.envelope.kdf.p,
    dkLen: 32,
  });

  let plain: Uint8Array;
  try {
    plain = sodium.crypto_secretbox_open_easy(ct, nonce, key);
  } catch {
    throw new Error('Wrong passphrase, or the bundle has been tampered with.');
  }
  return JSON.parse(new TextDecoder().decode(plain)) as BundlePlaintext;
}

export async function importBundle(opts: {
  backend: CredentialBackend;
  envelope: BundleEnvelope;
  passphrase: string;
  /** When true, abort if any secret already exists for this site. Default false (overwrite). */
  failOnConflict?: boolean;
}): Promise<{ imported: string[]; cookieCount: number; storageCount: number }> {
  const data = await decryptBundle({ envelope: opts.envelope, passphrase: opts.passphrase });
  const site = opts.envelope.site;

  if (opts.failOnConflict) {
    const existing = await opts.backend.listSecrets(site);
    const conflicts = existing.filter((n) => n in data.secrets);
    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to overwrite existing secrets for "${site}": ${conflicts.join(', ')}\n→ delete them first or rerun without --fail-on-conflict.`,
      );
    }
  }

  const imported: string[] = [];
  for (const [name, value] of Object.entries(data.secrets)) {
    await opts.backend.setSecret(site, name, value);
    imported.push(name);
  }

  if (data.cookies.length > 0) {
    await opts.backend.setCookies(site, data.cookies);
  }

  if (data.storage && data.storage.length > 0 && opts.backend.setStorage) {
    await opts.backend.setStorage(site, data.storage);
  }

  if (data.manifest.length > 0) {
    writeSiteManifest({
      site,
      secrets: data.manifest,
      updatedAt: new Date().toISOString(),
    });
  }

  return { imported, cookieCount: data.cookies.length, storageCount: data.storage?.length ?? 0 };
}
