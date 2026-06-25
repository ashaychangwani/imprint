/**
 * Local credential storage with pluggable backends.
 *
 * Resolution order (set once per process):
 *  1. KeyringBackend — `@napi-rs/keyring` against the OS keychain.
 *     Used when available; transparent (no passphrase) and OS-secured.
 *  2. EncryptedFileBackend — libsodium secretbox + argon2id over a single
 *     JSON file. Passphrase from $IMPRINT_PASSPHRASE or interactive prompt;
 *     cached in process. Used in headless contexts (e.g. Linux container
 *     without a desktop session) where the keyring isn't available.
 *  3. Legacy JSON read-only — old `~/.config/imprint/credentials/<site>.json`
 *     files are surfaced via `loadLegacyStore` for migration only; we never
 *     write back to them.
 *
 * Manifest (non-secret) lives at `~/.config/imprint/manifests/<site>.json`
 * and lists which secrets exist for which site. The manifest is what tells
 * a downstream agent (OpenClaw/Hermes) which credentials it needs to ask
 * for when consuming a shared skill.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { argon2id } from '@noble/hashes/argon2.js';
import envPaths from 'env-paths';

const PATHS = envPaths('imprint', { suffix: '' });
const SERVICE_NAME = 'imprint';

/** What kind of value a credential is. Only used for the manifest UI. */
export type CredentialKind = 'username' | 'password' | 'email' | 'token' | 'opaque';

export interface ManifestEntry {
  name: string;
  kind: CredentialKind;
  /** Optional human description (printed by `imprint credential list`). */
  description?: string;
  recordedAt: string;
}

interface SiteManifest {
  site: string;
  secrets: ManifestEntry[];
  cookies?: Array<{ name: string; value?: never }>; // value is never persisted in the manifest
  storage?: Array<{ origin: string; kind: StorageRecord['kind']; key: string; value?: never }>;
  updatedAt: string;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  hostOnly?: boolean;
  creationIndex?: number;
}

export interface StorageRecord {
  origin: string;
  kind: 'localStorage' | 'sessionStorage';
  key: string;
  value: string;
}

/** Backend abstraction. Implementations may be sync or async; we always
 *  await to keep the call sites uniform. */
export interface CredentialBackend {
  readonly id: 'keyring' | 'encrypted-file' | 'legacy-json';
  getSecret(site: string, name: string): Promise<string | null>;
  setSecret(site: string, name: string, value: string): Promise<void>;
  deleteSecret(site: string, name: string): Promise<void>;
  listSecrets(site: string): Promise<string[]>;
  /** Cookies are bulk-replaced rather than per-name because a login flow
   *  produces a fresh cookie set as one unit. */
  getCookies(site: string): Promise<CookieRecord[]>;
  setCookies(site: string, cookies: CookieRecord[]): Promise<void>;
  getStorage?(site: string): Promise<StorageRecord[]>;
  setStorage?(site: string, storage: StorageRecord[]): Promise<void>;
  /** Best-effort listing of every site this backend has data for. Used by
   *  `imprint credential list` (no <site> argument) and migration. */
  listSites(): Promise<string[]>;
}

// ─── KeyringBackend (primary) ──────────────────────────────────────────────

class KeyringBackend implements CredentialBackend {
  readonly id = 'keyring' as const;
  // Dynamically loaded; keep the module reference so tests can swap it.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require shape
  private Entry: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require shape
  private findCredentials: any;

  // biome-ignore lint/suspicious/noExplicitAny: dynamic require shape
  constructor(mod: { Entry: any; findCredentials: any }) {
    this.Entry = mod.Entry;
    this.findCredentials = mod.findCredentials;
  }

  private accountFor(site: string, name: string): string {
    return `${site}::${name}`;
  }

  private cookieAccount(site: string): string {
    return `${site}::__cookies__`;
  }

  private storageAccount(site: string): string {
    return `${site}::__storage__`;
  }

  async getSecret(site: string, name: string): Promise<string | null> {
    const entry = new this.Entry(SERVICE_NAME, this.accountFor(site, name));
    try {
      const v = entry.getPassword();
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  async setSecret(site: string, name: string, value: string): Promise<void> {
    const entry = new this.Entry(SERVICE_NAME, this.accountFor(site, name));
    entry.setPassword(value);
  }

  async deleteSecret(site: string, name: string): Promise<void> {
    const entry = new this.Entry(SERVICE_NAME, this.accountFor(site, name));
    try {
      entry.deletePassword();
    } catch {
      // Already absent — fine.
    }
  }

  async listSecrets(site: string): Promise<string[]> {
    // findCredentials returns every credential under our service; we filter
    // by site prefix.
    const all = this.findCredentials(SERVICE_NAME) as Array<{ account: string }>;
    const prefix = `${site}::`;
    const cookieAcct = this.cookieAccount(site);
    const storageAcct = this.storageAccount(site);
    return all
      .map((c) => c.account)
      .filter((acct) => acct.startsWith(prefix) && acct !== cookieAcct && acct !== storageAcct)
      .map((acct) => acct.slice(prefix.length));
  }

  async getCookies(site: string): Promise<CookieRecord[]> {
    const entry = new this.Entry(SERVICE_NAME, this.cookieAccount(site));
    try {
      const v = entry.getPassword();
      if (typeof v !== 'string' || v.length === 0) return [];
      return JSON.parse(v) as CookieRecord[];
    } catch {
      return [];
    }
  }

  async setCookies(site: string, cookies: CookieRecord[]): Promise<void> {
    const entry = new this.Entry(SERVICE_NAME, this.cookieAccount(site));
    if (cookies.length === 0) {
      try {
        entry.deletePassword();
      } catch {
        /* ignore */
      }
      return;
    }
    entry.setPassword(JSON.stringify(cookies));
  }

  async getStorage(site: string): Promise<StorageRecord[]> {
    const entry = new this.Entry(SERVICE_NAME, this.storageAccount(site));
    try {
      const v = entry.getPassword();
      if (typeof v !== 'string' || v.length === 0) return [];
      return JSON.parse(v) as StorageRecord[];
    } catch {
      return [];
    }
  }

  async setStorage(site: string, storage: StorageRecord[]): Promise<void> {
    const entry = new this.Entry(SERVICE_NAME, this.storageAccount(site));
    if (storage.length === 0) {
      try {
        entry.deletePassword();
      } catch {
        /* ignore */
      }
      return;
    }
    entry.setPassword(JSON.stringify(storage));
  }

  async listSites(): Promise<string[]> {
    const all = this.findCredentials(SERVICE_NAME) as Array<{ account: string }>;
    const sites = new Set<string>();
    for (const c of all) {
      const idx = c.account.indexOf('::');
      if (idx > 0) sites.add(c.account.slice(0, idx));
    }
    return Array.from(sites).sort();
  }
}

// ─── EncryptedFileBackend (fallback) ───────────────────────────────────────

interface EncryptedFileShape {
  /** Map of site → { secrets: { name → value }, cookies: CookieRecord[] }. */
  sites: Record<
    string,
    { secrets: Record<string, string>; cookies: CookieRecord[]; storage?: StorageRecord[] }
  >;
}

class EncryptedFileBackend implements CredentialBackend {
  readonly id = 'encrypted-file' as const;
  private filePath: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic libsodium ref
  private sodium: any;
  private cachedKey: Uint8Array | null = null;
  /** Cached decrypted shape — flushed back to disk on every mutation. */
  private cachedData: EncryptedFileShape | null = null;
  private passphraseProvider: () => Promise<string>;

  constructor(opts: {
    filePath: string;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic libsodium ref
    sodium: any;
    passphraseProvider: () => Promise<string>;
  }) {
    this.filePath = opts.filePath;
    this.sodium = opts.sodium;
    this.passphraseProvider = opts.passphraseProvider;
  }

  private async ensureKeyAndData(opts?: { forWrite?: boolean }): Promise<void> {
    if (this.cachedKey && this.cachedData) return;
    const sodium = this.sodium;

    if (!existsSync(this.filePath)) {
      // No store yet. For a READ (forWrite !== true), short-circuit with an
      // empty in-memory shape — there cannot be any credentials to return,
      // and prompting for a passphrase here would hang non-interactive
      // callers (CI, MCP server startup, cron). The store is materialised
      // on first WRITE, when we have a real value to protect.
      if (!opts?.forWrite) {
        this.cachedData = { sites: {} };
        return;
      }
      const passphrase = await this.passphraseProvider();
      const salt = sodium.randombytes_buf(16);
      this.cachedKey = deriveKey(passphrase, salt);
      this.cachedData = { sites: {} };
      this.persistWithSalt(salt);
      return;
    }

    const raw = readFileSync(this.filePath, 'utf8');
    let parsed: { saltB64: string; nonceB64: string; ctB64: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${this.filePath} is corrupted (not JSON). Delete it to start fresh, or restore from a credential bundle.`,
      );
    }
    const salt = b64decode(parsed.saltB64);
    const nonce = b64decode(parsed.nonceB64);
    const ct = b64decode(parsed.ctB64);

    // Try cached passphrase first if the user has set $IMPRINT_PASSPHRASE
    // and re-entered process.
    const passphrase = await this.passphraseProvider();
    const key = deriveKey(passphrase, salt);
    let plain: Uint8Array;
    try {
      plain = sodium.crypto_secretbox_open_easy(ct, nonce, key);
    } catch {
      throw new Error(
        `Wrong passphrase for ${this.filePath}.\n→ set $IMPRINT_PASSPHRASE or re-run with the correct passphrase. To start over, delete the file (you'll lose stored credentials).`,
      );
    }
    const text = new TextDecoder().decode(plain);
    this.cachedKey = key;
    this.cachedData = JSON.parse(text) as EncryptedFileShape;
  }

  private persistWithSalt(salt: Uint8Array): void {
    if (!this.cachedData || !this.cachedKey) return;
    const sodium = this.sodium;
    const text = JSON.stringify(this.cachedData);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(new TextEncoder().encode(text), nonce, this.cachedKey);
    const wire = {
      version: 1,
      saltB64: b64encode(salt),
      nonceB64: b64encode(nonce),
      ctB64: b64encode(ct),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(wire), 'utf8');
  }

  /** Persist using the SAME salt the file was loaded with. */
  private persist(): void {
    if (!this.cachedData) return;
    const raw = readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as { saltB64: string };
    this.persistWithSalt(b64decode(parsed.saltB64));
  }

  private siteData(site: string): {
    secrets: Record<string, string>;
    cookies: CookieRecord[];
    storage?: StorageRecord[];
  } {
    if (!this.cachedData) throw new Error('cachedData not initialized');
    let bucket = this.cachedData.sites[site];
    if (!bucket) {
      bucket = { secrets: {}, cookies: [], storage: [] };
      this.cachedData.sites[site] = bucket;
    }
    return bucket;
  }

  async getSecret(site: string, name: string): Promise<string | null> {
    await this.ensureKeyAndData();
    const bucket = this.cachedData?.sites[site];
    return bucket?.secrets[name] ?? null;
  }

  async setSecret(site: string, name: string, value: string): Promise<void> {
    await this.ensureKeyAndData({ forWrite: true });
    this.siteData(site).secrets[name] = value;
    this.persist();
  }

  async deleteSecret(site: string, name: string): Promise<void> {
    await this.ensureKeyAndData({ forWrite: true });
    const bucket = this.cachedData?.sites[site];
    if (bucket && name in bucket.secrets) {
      delete bucket.secrets[name];
      this.persist();
    }
  }

  async listSecrets(site: string): Promise<string[]> {
    await this.ensureKeyAndData();
    const bucket = this.cachedData?.sites[site];
    return bucket ? Object.keys(bucket.secrets) : [];
  }

  async getCookies(site: string): Promise<CookieRecord[]> {
    await this.ensureKeyAndData();
    return this.cachedData?.sites[site]?.cookies ?? [];
  }

  async setCookies(site: string, cookies: CookieRecord[]): Promise<void> {
    await this.ensureKeyAndData({ forWrite: true });
    this.siteData(site).cookies = cookies;
    this.persist();
  }

  async getStorage(site: string): Promise<StorageRecord[]> {
    await this.ensureKeyAndData();
    return this.cachedData?.sites[site]?.storage ?? [];
  }

  async setStorage(site: string, storage: StorageRecord[]): Promise<void> {
    await this.ensureKeyAndData({ forWrite: true });
    this.siteData(site).storage = storage;
    this.persist();
  }

  async listSites(): Promise<string[]> {
    await this.ensureKeyAndData();
    return Object.keys(this.cachedData?.sites ?? {}).sort();
  }
}

// ─── KDF + base64 helpers ──────────────────────────────────────────────────

const KDF_OPTS = {
  /** Iterations. Argon2 RFC 9106 minimum recommended interactive. */
  t: 3,
  /** Memory in KiB — 64 MiB. */
  m: 64 * 1024,
  /** Parallelism. */
  p: 4,
  /** Output 32 bytes for crypto_secretbox key. */
  dkLen: 32,
} as const;

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return argon2id(new TextEncoder().encode(passphrase), salt, KDF_OPTS);
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// ─── Manifest (non-secret, JSON file) ──────────────────────────────────────

function manifestPath(site: string): string {
  return pathJoin(PATHS.config, 'manifests', `${site}.json`);
}

export function readSiteManifest(site: string): SiteManifest | null {
  const p = manifestPath(site);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SiteManifest;
  } catch {
    return null;
  }
}

export function writeSiteManifest(manifest: SiteManifest): void {
  const p = manifestPath(manifest.site);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function deleteSiteManifest(site: string): void {
  const p = manifestPath(site);
  if (existsSync(p)) unlinkSync(p);
}

export function listManifestSites(): string[] {
  const dir = pathJoin(PATHS.config, 'manifests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Adds or updates a single manifest entry, persisting the file. */
export function upsertManifestEntry(
  site: string,
  entry: Omit<ManifestEntry, 'recordedAt'> & { recordedAt?: string },
): SiteManifest {
  const existing = readSiteManifest(site);
  const recordedAt = entry.recordedAt ?? new Date().toISOString();
  const next: SiteManifest = existing
    ? {
        site,
        secrets: existing.secrets
          .filter((s) => s.name !== entry.name)
          .concat({
            name: entry.name,
            kind: entry.kind,
            description: entry.description,
            recordedAt,
          }),
        cookies: existing.cookies,
        storage: existing.storage,
        updatedAt: new Date().toISOString(),
      }
    : {
        site,
        secrets: [
          {
            name: entry.name,
            kind: entry.kind,
            description: entry.description,
            recordedAt,
          },
        ],
        updatedAt: new Date().toISOString(),
      };
  writeSiteManifest(next);
  return next;
}

export function removeManifestEntry(site: string, name: string): SiteManifest | null {
  const existing = readSiteManifest(site);
  if (!existing) return null;
  const next: SiteManifest = {
    site,
    secrets: existing.secrets.filter((s) => s.name !== name),
    cookies: existing.cookies,
    storage: existing.storage,
    updatedAt: new Date().toISOString(),
  };
  if (next.secrets.length === 0) {
    deleteSiteManifest(site);
    return null;
  }
  writeSiteManifest(next);
  return next;
}

export function setManifestStorageKeys(
  site: string,
  storage: Array<{ origin: string; kind: StorageRecord['kind']; key: string }>,
): SiteManifest {
  const existing = readSiteManifest(site);
  const next: SiteManifest = existing
    ? {
        ...existing,
        storage: storage.map((s) => ({ origin: s.origin, kind: s.kind, key: s.key })),
        updatedAt: new Date().toISOString(),
      }
    : {
        site,
        secrets: [],
        storage: storage.map((s) => ({ origin: s.origin, kind: s.kind, key: s.key })),
        updatedAt: new Date().toISOString(),
      };
  writeSiteManifest(next);
  return next;
}

// ─── Backend resolution ────────────────────────────────────────────────────

let cachedBackend: CredentialBackend | null = null;
let cachedBackendOverride: CredentialBackend | null = null;

/** For tests: replace the backend used by getCredentialBackend. */
export function setBackendOverride(backend: CredentialBackend | null): void {
  cachedBackendOverride = backend;
  cachedBackend = null;
}

/** Reset the resolved backend so the next call re-resolves. Tests use this
 *  to recover from a swapped-in keyring module. */
export function resetBackendCache(): void {
  cachedBackend = null;
}

function defaultEncryptedFilePath(): string {
  return pathJoin(PATHS.config, 'secrets.enc');
}

/** Try loading @napi-rs/keyring; return null if it's unavailable in this
 *  environment (no Secret Service on Linux without a desktop session,
 *  locked keychain on first use, etc.). */
function tryLoadKeyring(): KeyringBackend | null {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic require
    const mod = require('@napi-rs/keyring') as any;
    if (!mod?.Entry || !mod?.findCredentials) return null;
    // Smoke-test by listing — this throws if the keyring backend isn't
    // actually usable (Linux Alpine without libsecret, etc.).
    try {
      mod.findCredentials(SERVICE_NAME);
    } catch {
      return null;
    }
    return new KeyringBackend(mod);
  } catch {
    return null;
  }
}

/** Resolves the active credential backend. Cached after first call. Not
 *  reentrant-safe but every call site awaits before its next read. */
export async function getCredentialBackend(opts?: {
  passphraseProvider?: () => Promise<string>;
  forceEncryptedFile?: boolean;
}): Promise<CredentialBackend> {
  if (cachedBackendOverride) return cachedBackendOverride;
  if (cachedBackend) return cachedBackend;

  const wantEnc = opts?.forceEncryptedFile === true || process.env.IMPRINT_BACKEND === 'file';

  if (!wantEnc) {
    const kr = tryLoadKeyring();
    if (kr) {
      cachedBackend = kr;
      return kr;
    }
  }

  // Fall back to encrypted file. We resolve libsodium lazily because it
  // pulls a chunk of WASM and we want the keyring path to stay zero-cost.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic libsodium ref
  const sodium: any = await import('libsodium-wrappers').then(async (m) => {
    await m.default.ready;
    return m.default;
  });

  const provider = opts?.passphraseProvider ?? defaultPassphraseProvider();
  cachedBackend = new EncryptedFileBackend({
    filePath: defaultEncryptedFilePath(),
    sodium,
    passphraseProvider: provider,
  });
  return cachedBackend;
}

let cachedPassphrase: string | null = null;

function defaultPassphraseProvider(): () => Promise<string> {
  return async () => {
    if (cachedPassphrase !== null) return cachedPassphrase;
    const env = process.env.IMPRINT_PASSPHRASE;
    if (env && env.length > 0) {
      cachedPassphrase = env;
      return env;
    }
    // Lazy-import @clack/prompts so non-interactive callers don't pay for it.
    const p = await import('@clack/prompts');
    const answer = await p.password({
      message: 'Passphrase for the encrypted credential store',
      mask: '*',
      validate: (v) =>
        !v || v.length < 8 ? 'Passphrase must be at least 8 characters.' : undefined,
    });
    if (p.isCancel(answer)) {
      throw new Error(
        'Passphrase prompt cancelled. Set $IMPRINT_PASSPHRASE to avoid the prompt in non-interactive contexts.',
      );
    }
    cachedPassphrase = answer as string;
    return cachedPassphrase;
  };
}

// ─── Legacy JSON store (read-only fallback) ────────────────────────────────

interface LegacyStoreShape {
  site: string;
  cookies: CookieRecord[];
  values: Record<string, string>;
}

export function legacyStorePath(site: string): string {
  return pathJoin(PATHS.config, 'credentials', `${site}.json`);
}

export function readLegacyStore(site: string): LegacyStoreShape | null {
  const p = legacyStorePath(site);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LegacyStoreShape;
  } catch {
    return null;
  }
}

export function listLegacyStoreSites(): string[] {
  const dir = pathJoin(PATHS.config, 'credentials');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.migrated'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function markLegacyStoreMigrated(site: string): void {
  const src = legacyStorePath(site);
  if (!existsSync(src)) return;
  const dest = `${src}.migrated`;
  writeFileSync(dest, readFileSync(src, 'utf8'), 'utf8');
  unlinkSync(src);
}

// ─── High-level convenience API ────────────────────────────────────────────

/** A site's full credential view: secrets values + cookies. Used by runtime. */
interface SiteCredentialView {
  site: string;
  cookies: CookieRecord[];
  values: Record<string, string>;
  storage: StorageRecord[];
}

/** Loads everything we know about a site, falling back through the backends.
 *  Used at request time by runtime.executeWorkflow. */
export async function loadSiteCredentials(site: string): Promise<SiteCredentialView> {
  const backend = await getCredentialBackend();
  const names = await backend.listSecrets(site);
  const values: Record<string, string> = {};
  for (const n of names) {
    const v = await backend.getSecret(site, n);
    if (v !== null) values[n] = v;
  }
  const cookies = await backend.getCookies(site);
  const storage = (await backend.getStorage?.(site)) ?? [];

  // Fall through to legacy if the backend has nothing.
  if (Object.keys(values).length === 0 && cookies.length === 0 && storage.length === 0) {
    const legacy = readLegacyStore(site);
    if (legacy) {
      return { site, cookies: legacy.cookies, values: legacy.values, storage: [] };
    }
  }
  return { site, cookies, values, storage };
}

/** Convenience wrapper to persist cookies after a successful auth tool run.
 *  Delegates to the active credential backend's setCookies. */
export async function saveSiteCookies(site: string, cookies: CookieRecord[]): Promise<void> {
  const backend = await getCredentialBackend();
  await backend.setCookies(site, cookies);
}

/** Convenience wrapper to persist browser storage (localStorage/sessionStorage)
 *  after a successful auth tool run, so a later stateless `submit_otp` call can
 *  rehydrate the same session state. Delegates to the backend's optional
 *  setStorage; no-ops on backends that don't support storage. */
export async function saveSiteStorage(site: string, storage: StorageRecord[]): Promise<void> {
  const backend = await getCredentialBackend();
  await backend.setStorage?.(site, storage);
}

/** Persist a single durable secret value (e.g. a bearer/access token captured
 *  from a completed login via authConfig.sessionCapture) so data tools reuse it
 *  as `${credential.NAME}` without re-running auth. */
export async function saveSiteSecret(site: string, name: string, value: string): Promise<void> {
  const backend = await getCredentialBackend();
  await backend.setSecret(site, name, value);
}
