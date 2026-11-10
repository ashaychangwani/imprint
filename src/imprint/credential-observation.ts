/** Optional, value-free credential path diagnostics. A private per-run key makes
 * identities comparable across child processes without stable secret hashes. */
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface CredentialMaterial {
  site: string;
  cookies: unknown[];
  values: Record<string, string>;
  storage?: unknown[];
}

export interface CredentialObservation {
  scope: string;
  revision: string;
  source: string;
  cookieCount: number;
  valueCount: number;
  storageCount: number;
}

export interface DispatchObservation {
  invocationId: string;
  requestIndex: number;
  credentials: CredentialObservation;
  /** Runtime jar after mechanical normalization and earlier response updates. */
  effectiveCredentials?: CredentialObservation;
  /** Exact runtime-prepared headers/url/body, before transport-owned changes. */
  preparedRequestIdentity: string;
  requestTargetIdentity: string;
  preparedCookieHeaderIdentity?: string;
  cookieSource: 'browser-owned' | 'runtime-prepared';
}

interface BrowserCookieStateObservation extends CredentialObservation {
  cookieStates: Array<{ scopeIdentity: string; valueIdentity: string; stateIdentity: string }>;
  seed?: { attempted: number; accepted: number; rejected: number; failed: number };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function diagnosticKey(): Buffer | undefined {
  const path = process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
  if (!path) return undefined;
  try {
    const keyPath = `${path}.key`;
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    const key = readFileSync(keyPath);
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

function identity(key: Buffer, value: unknown): string {
  return createHmac('sha256', key).update(canonical(value)).digest('hex');
}

export function credentialObservation(
  material: CredentialMaterial,
  source: string,
): CredentialObservation | undefined {
  const key = diagnosticKey();
  if (!key) return undefined;
  return {
    scope: identity(key, 'credential-observation-scope'),
    revision: identity(key, {
      site: material.site,
      cookies: material.cookies,
      values: material.values,
      storage: material.storage ?? [],
    }),
    source,
    cookieCount: material.cookies.length,
    valueCount: Object.keys(material.values).length,
    storageCount: material.storage?.length ?? 0,
  };
}

/** Only accept typed metadata at this boundary; never raw credentials/requests. */
export function recordCredentialEvent(
  event:
    | 'load'
    | 'commit'
    | 'dispatch'
    | 'response'
    | 'browser-request'
    | 'browser-wire'
    | 'browser-response'
    | 'browser-state',
  facts:
    | CredentialObservation
    | DispatchObservation
    | {
        invocationId: string;
        requestIndex: number;
        status: number;
      }
    | BrowserCredentialObservation
    | BrowserCookieStateObservation,
): void {
  const path = process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({
        event,
        at: new Date().toISOString(),
        monotonicMs: performance.now(),
        pid: process.pid,
        ...facts,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Optional diagnostics cannot alter persistence or runtime outcomes.
  }
}

/** Compare exact cookie scopes across seed/bootstrap/request boundaries without
 * recording their names or values. These are facts, never auth verdicts. */
export function recordBrowserCookieState(
  material: CredentialMaterial,
  phase: 'cdp-before-seed' | 'cdp-after-bootstrap' | 'cdp-after-request',
  seed?: BrowserCookieStateObservation['seed'],
): void {
  const key = diagnosticKey();
  const observation = credentialObservation(material, phase);
  if (!key || !observation) return;
  recordCredentialEvent('browser-state', {
    ...observation,
    cookieStates: material.cookies.map((cookie) => {
      const entry = cookie as Record<string, unknown>;
      const domain = String(entry.domain ?? '');
      const scope = {
        name: entry.name,
        domain: domain.replace(/^\./, ''),
        path: entry.path ?? '/',
        hostOnly: entry.hostOnly ?? !domain.startsWith('.'),
      };
      return {
        scopeIdentity: identity(key, scope),
        valueIdentity: identity(key, entry.value),
        stateIdentity: identity(key, {
          ...scope,
          value: entry.value,
          secure: Boolean(entry.secure),
          httpOnly: Boolean(entry.httpOnly),
          sameSite: typeof entry.sameSite === 'string' ? entry.sameSite.toLowerCase() : undefined,
          expires:
            typeof entry.expires === 'number' && entry.expires > 0 ? entry.expires : undefined,
        }),
      };
    }),
    ...(seed ? { seed } : {}),
  });
}

export function dispatchObservation(input: {
  invocationId: string;
  requestIndex: number;
  material: CredentialMaterial;
  effectiveMaterial?: CredentialMaterial;
  source: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  browserOwned: boolean;
}): DispatchObservation | undefined {
  const key = diagnosticKey();
  const credentials = credentialObservation(input.material, input.source);
  if (!key || !credentials) return undefined;
  const observation: DispatchObservation = {
    invocationId: input.invocationId,
    requestIndex: input.requestIndex,
    credentials,
    ...(input.effectiveMaterial
      ? { effectiveCredentials: credentialObservation(input.effectiveMaterial, 'runtime-jar') }
      : {}),
    preparedRequestIdentity: identity(key, input.request),
    requestTargetIdentity: identity(key, {
      method: input.request.method.toUpperCase(),
      url: input.request.url,
    }),
    ...(Object.entries(input.request.headers).find(
      ([name]) => name.toLowerCase() === 'cookie',
    )?.[1] === undefined
      ? {}
      : {
          preparedCookieHeaderIdentity: identity(
            key,
            Object.entries(input.request.headers).find(
              ([name]) => name.toLowerCase() === 'cookie',
            )?.[1],
          ),
        }),
    cookieSource: input.browserOwned ? 'browser-owned' : 'runtime-prepared',
  };
  recordCredentialEvent('dispatch', observation);
  return observation;
}

interface BrowserCredentialObservation {
  transport: 'cdp' | 'browser-http';
  browserRequestIdentity: string;
  requestTargetIdentity?: string;
  wireHeadersIdentity?: string;
  cookieHeaderIdentity?: string;
  status?: number;
}

/** CDP's actual network header event; never retains header/cookie values or URL.
 * Request and extra-info events may arrive in either order, so join opaque IDs. */
export function recordBrowserCredentialObservation(input: {
  event: 'browser-request' | 'browser-wire' | 'browser-response';
  browserId: string;
  requestId: string;
  transport?: 'cdp' | 'browser-http';
  request?: { method?: string; url?: string };
  headers?: Record<string, unknown>;
  status?: number;
}): void {
  const key = diagnosticKey();
  if (!key) return;
  const cookie = Object.entries(input.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'cookie',
  )?.[1];
  recordCredentialEvent(input.event, {
    transport: input.transport ?? 'cdp',
    browserRequestIdentity: identity(key, {
      browserId: input.browserId,
      requestId: input.requestId,
    }),
    ...(input.request?.url
      ? {
          requestTargetIdentity: identity(key, {
            method: (input.request.method ?? 'GET').toUpperCase(),
            url: input.request.url,
          }),
        }
      : {}),
    ...(input.headers ? { wireHeadersIdentity: identity(key, input.headers) } : {}),
    ...(cookie === undefined ? {} : { cookieHeaderIdentity: identity(key, cookie) }),
    ...(input.status === undefined ? {} : { status: input.status }),
  });
}
