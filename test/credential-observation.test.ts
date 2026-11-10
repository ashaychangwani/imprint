import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialObservation,
  dispatchObservation,
  recordBrowserCookieState,
  recordBrowserCredentialObservation,
} from '../src/imprint/credential-observation.ts';
import {
  type CredentialBackend,
  commitSiteAuthState,
  loadSiteCredentials,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import { executeWorkflow } from '../src/imprint/runtime.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const original = process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
const dirs: string[] = [];
afterEach(() => {
  setBackendOverride(null);
  resetBackendCache();
  // biome-ignore lint/performance/noDelete: assigning undefined sets the literal string in process.env
  if (original === undefined) delete process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
  else process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function enable() {
  const dir = mkdtempSync(join(tmpdir(), 'imprint-credential-observation-'));
  dirs.push(dir);
  process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH = join(dir, 'facts.jsonl');
  return process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH;
}
const material = {
  site: 'fixture',
  cookies: [
    { name: 'session', value: 'synthetic-secret-cookie', domain: 'fixture.invalid', path: '/' },
  ],
  values: { password: 'synthetic-secret-password' },
  storage: [],
};

describe('credential path identities', () => {
  it('compares cookie scopes, values and attributes separately without retaining secrets', () => {
    const path = enable();
    recordBrowserCookieState(material, 'cdp-before-seed');
    recordBrowserCookieState(
      {
        ...material,
        cookies: material.cookies.map((cookie) => ({
          ...cookie,
          hostOnly: true,
          creationIndex: 42,
          expires: -1,
        })),
      },
      'cdp-after-bootstrap',
      { attempted: 1, accepted: 1, rejected: 0, failed: 0 },
    );
    recordBrowserCookieState(
      {
        ...material,
        cookies: material.cookies.map((cookie) => ({
          ...cookie,
          value: 'synthetic-renewed-value',
        })),
      },
      'cdp-after-request',
    );
    const text = readFileSync(path, 'utf8');
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[1].cookieStates).toEqual(events[0].cookieStates);
    expect(events[2].cookieStates[0].scopeIdentity).toBe(events[0].cookieStates[0].scopeIdentity);
    expect(events[2].cookieStates[0].valueIdentity).not.toBe(
      events[0].cookieStates[0].valueIdentity,
    );
    for (const secret of ['synthetic-', 'fixture.invalid', 'password', 'session'])
      expect(text).not.toContain(secret);
  });
  it('compares revisions only inside one private observation scope', () => {
    enable();
    const first = credentialObservation(material, 'durable-store');
    expect(first).toBeDefined();
    expect(credentialObservation(material, 'explicit-override')?.revision).toBe(first?.revision);
    expect(
      credentialObservation({ ...material, cookies: [] }, 'explicit-override')?.revision,
    ).not.toBe(first?.revision);
    enable();
    expect(credentialObservation(material, 'durable-store')?.scope).not.toBe(first?.scope);
    expect(credentialObservation(material, 'durable-store')?.revision).not.toBe(first?.revision);
  });

  it('records only metadata and distinguishes prepared from browser-owned cookies', () => {
    const path = enable();
    const facts = dispatchObservation({
      invocationId: 'fixture-invocation',
      requestIndex: 0,
      material,
      source: 'explicit-override',
      browserOwned: true,
      request: {
        method: 'POST',
        url: 'https://fixture.invalid/private?token=synthetic-secret-query',
        headers: { authorization: 'synthetic-secret-auth' },
        body: 'synthetic-secret-body',
      },
    });
    expect(facts?.cookieSource).toBe('browser-owned');
    const text = readFileSync(path, 'utf8');
    for (const secret of ['synthetic-secret', 'fixture.invalid', 'authorization', 'password'])
      expect(text).not.toContain(secret);
    expect(statSync(`${path}.key`).mode & 0o777).toBe(0o600);
  });

  it('binds runtime response facts to the actual invocation and supplied revision', async () => {
    const path = enable();
    const observations: unknown[] = [];
    const workflow = WorkflowSchema.parse({
      site: 'fixture',
      toolName: 'fixture_read',
      intent: { description: 'Synthetic rotating state' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://fixture.invalid/data', headers: {} }],
    });
    const result = await executeWorkflow({
      workflow,
      params: {},
      credentials: material,
      fetchImpl: (async (_input: Parameters<typeof fetch>[0]) =>
        new Response('{}', { status: 401 })) as typeof fetch,
      onResponse: (observation) => observations.push(observation),
    });
    expect(result).toMatchObject({ ok: false, error: 'AUTH_EXPIRED', status: 401 });
    expect(observations).toMatchObject([
      {
        status: 401,
        dispatch: {
          requestIndex: 0,
          cookieSource: 'runtime-prepared',
          credentials: { revision: credentialObservation(material, 'fixture')?.revision },
        },
      },
    ]);
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual(['dispatch', 'response']);
    expect(events[1].invocationId).toBe(events[0].invocationId);
  });

  it('joins actual browser header observations without persisting wire values', () => {
    const path = enable();
    recordBrowserCredentialObservation({
      event: 'browser-wire',
      browserId: 'fixture-browser',
      requestId: 'fixture-request',
      headers: {
        Cookie: 'session=synthetic-secret-cookie',
        Authorization: 'synthetic-secret-auth',
      },
    });
    recordBrowserCredentialObservation({
      event: 'browser-request',
      browserId: 'fixture-browser',
      requestId: 'fixture-request',
      request: {
        method: 'GET',
        url: 'https://fixture.invalid/private?token=synthetic-secret-query',
      },
    });
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0].browserRequestIdentity).toBe(events[1].browserRequestIdentity);
    expect(events[0].cookieHeaderIdentity).toBeDefined();
    expect(events[1].requestTargetIdentity).toBeDefined();
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-secret');
    expect(readFileSync(path, 'utf8')).not.toContain('fixture.invalid');
  });

  it('connects durable load, committed rotation and next dispatch without secret hashes shared across runs', async () => {
    const path = enable();
    let cookies: import('../src/imprint/credential-store.ts').CookieRecord[] = structuredClone(
      material.cookies,
    );
    const secrets = new Map(Object.entries(material.values));
    const backend: CredentialBackend = {
      id: 'encrypted-file',
      getSecret: async (_site, name) => secrets.get(name) ?? null,
      setSecret: async (_site, name, value) => {
        secrets.set(name, value);
      },
      deleteSecret: async (_site, name) => {
        secrets.delete(name);
      },
      listSecrets: async () => [...secrets.keys()],
      getCookies: async () => cookies,
      setCookies: async (_site, next) => {
        cookies = next;
      },
      listSites: async () => ['fixture'],
    };
    setBackendOverride(backend);
    const first = await loadSiteCredentials('fixture');
    const firstRevision = credentialObservation(first, 'fixture')?.revision;
    await commitSiteAuthState('fixture', [], { password: 'synthetic-rotated-password' });
    const workflow = WorkflowSchema.parse({
      site: 'fixture',
      toolName: 'fixture_after_rotation',
      intent: { description: 'Synthetic state rotation' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://fixture.invalid/data', headers: {} }],
    });
    await executeWorkflow({
      workflow,
      params: {},
      fetchImpl: (async (_input: Parameters<typeof fetch>[0]) =>
        Response.json({ ok: true })) as typeof fetch,
    });
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const commit = [...events].reverse().find((event) => event.event === 'commit');
    const dispatch = [...events].reverse().find((event) => event.event === 'dispatch');
    expect(commit.revision).not.toBe(firstRevision);
    expect(dispatch.credentials.revision).toBe(commit.revision);
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-rotated-password');
  });
});
