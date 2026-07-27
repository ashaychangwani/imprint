import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialBackend,
  type StorageRecord,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import { extractCredentials, login } from '../src/imprint/login.ts';
import type { Session } from '../src/imprint/types.ts';

/**
 * `imprint login` credential extraction is GENERIC: it resolves each site's
 * request captures named by `authConfig.persist` (read from the site's compiled
 * workflow.json) against the recorded login response — there is no per-site
 * code. These tests prove the two shapes the old hardcoded extractors handled
 * (Discover & Go nested keys, Southwest dotted top-level keys) reproduce the
 * exact credential slot names via declarations alone.
 */

let home: string;
let storedStorage: StorageRecord[];
const originalImprintHome = process.env.IMPRINT_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'imprint-login-test-'));
  process.env.IMPRINT_HOME = home;
  storedStorage = [];
  const backend: CredentialBackend = {
    id: 'encrypted-file',
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
    async getStorage() {
      return storedStorage;
    },
    async setStorage(_site, storage) {
      storedStorage = storage;
    },
    async listSites() {
      return [];
    },
  };
  setBackendOverride(backend);
});

afterEach(() => {
  if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
  else process.env.IMPRINT_HOME = originalImprintHome;
  setBackendOverride(null);
  resetBackendCache();
  rmSync(home, { recursive: true, force: true });
});

function writeWorkflow(
  site: string,
  tool: string,
  captures: unknown[],
  persist = captures.map((capture) => (capture as { name: string }).name),
  recordingRequestSeq?: number,
  requestUrl = 'https://example.test/login',
  requestBody?: string,
  repeatCapture?: unknown,
  persistBindings: Record<string, string> = {},
): void {
  const dir = join(home, site, tool);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workflow.json'),
    JSON.stringify({
      toolName: tool,
      intent: { description: 'test tool' },
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: requestUrl,
          headers: {},
          ...(requestBody === undefined ? {} : { body: requestBody }),
          captures,
          ...(recordingRequestSeq === undefined ? {} : { recordingRequestSeq }),
        },
      ],
      toolKind: 'authenticate',
      authConfig: {
        entry: 'authenticate',
        actions: {
          authenticate: {
            parameters: [],
            steps: [
              {
                request: 0,
                onError: repeatCapture ? 'retry' : 'fail',
                ...(repeatCapture
                  ? { repeat: { until: repeatCapture, intervalMs: 1, maxAttempts: 2 } }
                  : {}),
              },
            ],
            outcome: { type: 'success', evidence: [] },
          },
        },
        persist,
        persistBindings,
        crossOriginCookieReinjection: false,
      },
      site,
    }),
  );
}

function sessionWithLoginResponse(body: string): Session {
  return {
    requests: [
      {
        method: 'GET',
        url: 'https://example.test/page',
        headers: {},
        response: { status: 200, headers: {}, mimeType: 'text/html', body: '<html></html>' },
      },
      {
        method: 'POST',
        url: 'https://example.test/login',
        headers: {},
        response: { status: 200, headers: {}, mimeType: 'application/json', body },
      },
    ],
    events: [],
  } as unknown as Session;
}

describe('extractCredentials (generic persisted-capture resolver)', () => {
  it('stores a renamed capture under its declared durable interface', () => {
    writeWorkflow(
      'fixture',
      'authenticate_fixture',
      [{ name: 'compiled_capture', source: 'json', path: 'value' }],
      ['durable_interface'],
      undefined,
      'https://example.test/login',
      undefined,
      undefined,
      { durable_interface: 'compiled_capture' },
    );
    const session = sessionWithLoginResponse(JSON.stringify({ value: 'resolved-value' }));

    expect(extractCredentials('fixture', session)).toEqual({
      durable_interface: 'resolved-value',
    });
  });

  it('extracts a persisted value from a JSON-string response envelope', () => {
    writeWorkflow(
      'fixture',
      'authenticate_fixture',
      [
        {
          name: 'nested_token',
          source: 'json',
          path: '$.payload',
          decodeJsonPath: '$.session.token',
        },
      ],
      ['nested_token'],
      2,
    );
    const token = 'fixture/segment+token=';
    const encodedEnvelope = `{"session":{"token":"fixture\\/segment+token="}}`;
    const session = sessionWithLoginResponse(JSON.stringify({ payload: encodedEnvelope }));
    const request = session.requests[1];
    if (!request) throw new Error('bad fixture');
    request.seq = 2;

    expect(extractCredentials('fixture', session)).toEqual({ nested_token: token });
  });

  it('resolves Discover & Go nested-key shape into the exact credential slots', () => {
    writeWorkflow('discoverandgo', 'book_pass', [
      { name: 'patron_id', source: 'json', path: 'patronID' },
      { name: 'session_id', source: 'json', path: 'session' },
      { name: 'patron_email', source: 'json', path: 'patronEmail' },
    ]);
    const session = sessionWithLoginResponse(
      JSON.stringify({ patronID: 'P123', session: 'S456', patronEmail: 'bob@example.com' }),
    );

    expect(extractCredentials('discoverandgo', session)).toEqual({
      patron_id: 'P123',
      session_id: 'S456',
      patron_email: 'bob@example.com',
    });
  });

  it('resolves Southwest dotted top-level keys via bracketed paths', () => {
    writeWorkflow('southwest', 'account', [
      {
        name: 'account_number',
        source: 'json',
        path: '[customers.userInformation.accountNumber]',
      },
      { name: 'primary_email', source: 'json', path: '[customers.userInformation.primaryEmail]' },
    ]);
    const session = sessionWithLoginResponse(
      JSON.stringify({
        'customers.userInformation.accountNumber': 'ACC999',
        'customers.userInformation.primaryEmail': 'sw@example.com',
      }),
    );

    expect(extractCredentials('southwest', session)).toEqual({
      account_number: 'ACC999',
      primary_email: 'sw@example.com',
    });
  });

  it('resolves a response_header capture', () => {
    writeWorkflow('acme', 'tool', [
      { name: 'csrf', source: 'response_header', header: 'x-csrf-token' },
    ]);
    const session: Session = {
      requests: [
        {
          method: 'POST',
          url: 'https://example.test/login',
          headers: {},
          response: {
            status: 200,
            headers: { 'x-csrf-token': 'tok-789' },
            mimeType: 'application/json',
            body: '{}',
          },
        },
      ],
      events: [],
    } as unknown as Session;

    expect(extractCredentials('acme', session)).toEqual({ csrf: 'tok-789' });
  });

  it('resolves the synthetic final URL capture from the recorded request URL', () => {
    writeWorkflow('acme', 'tool', [
      { name: 'final_url', source: 'response_header', header: 'x-imprint-final-url' },
    ]);
    const session = sessionWithLoginResponse('{}');

    expect(extractCredentials('acme', session)).toEqual({
      final_url: 'https://example.test/login',
    });
  });

  it('returns nothing when the site declares no captures (no per-site fallback)', () => {
    writeWorkflow('plainsite', 'tool', []);
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('plainsite', session)).toEqual({});
  });

  it('returns nothing when the site has no compiled tools at all', () => {
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('unknownsite', session)).toEqual({});
  });

  it('skips a capture whose value is absent from every response', () => {
    writeWorkflow(
      'acme',
      'tool',
      [
        { name: 'patron_id', source: 'json', path: 'patronID' },
        { name: 'missing', source: 'json', path: 'nope' },
      ],
      ['patron_id', 'missing'],
    );
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('acme', session)).toEqual({ patron_id: 'P123' });
  });

  it('resolves a persisted capture only from its producing recorded request', () => {
    writeWorkflow(
      'acme',
      'tool',
      [{ name: 'access_token', source: 'json', path: 'token' }],
      ['access_token'],
      2,
    );
    const session = sessionWithLoginResponse(JSON.stringify({ token: 'right-token' }));
    const unrelatedRequest = session.requests[0];
    const loginRequest = session.requests[1];
    if (!unrelatedRequest || !loginRequest) throw new Error('bad fixture');
    session.requests[0] = {
      ...unrelatedRequest,
      seq: 1,
      response: {
        status: 200,
        headers: {},
        mimeType: 'application/json',
        body: JSON.stringify({ token: 'wrong-token' }),
      },
    };
    session.requests[1] = { ...loginRequest, seq: 2 };

    expect(extractCredentials('acme', session)).toEqual({ access_token: 'right-token' });
  });

  it('falls back to the grounded URL template when a fresh recording renumbers requests', () => {
    writeWorkflow(
      'acme',
      'tool',
      [{ name: 'access_token', source: 'json', path: 'token' }],
      ['access_token'],
      99,
      'https://example.test/login?state=${state.login_state}',
    );
    const session = sessionWithLoginResponse(JSON.stringify({ token: 'fresh-token' }));
    const request = session.requests[1];
    if (!request) throw new Error('bad fixture');
    request.seq = 4;
    request.url = 'https://example.test/login?state=fresh-state-123';

    expect(extractCredentials('acme', session)).toEqual({ access_token: 'fresh-token' });
  });

  it('uses the templated request body and skips stale exact-sequence responses', () => {
    writeWorkflow(
      'acme',
      'tool',
      [{ name: 'access_token', source: 'json', path: 'token' }],
      ['access_token'],
      2,
      'https://example.test/login',
      'operation=login&username=${credential.username}',
    );
    const session = sessionWithLoginResponse('{}');
    const stale = session.requests[1];
    if (!stale?.response) throw new Error('bad fixture');
    const response = stale.response;
    stale.seq = 2;
    stale.body = 'operation=login&username=old-user';
    session.requests.push({
      ...stale,
      seq: 8,
      body: 'operation=refresh&username=current-user',
      response: { ...response, body: '{"token":"wrong-operation"}' },
    });
    session.requests.push({
      ...stale,
      seq: 9,
      body: 'operation=login&username=current-user',
      response: { ...response, body: '{"token":"fresh-token"}' },
    });

    expect(extractCredentials('acme', session)).toEqual({ access_token: 'fresh-token' });
  });

  it('does not match a bodyless workflow request to a recorded request with a body', () => {
    writeWorkflow(
      'acme',
      'tool',
      [{ name: 'access_token', source: 'json', path: 'token' }],
      ['access_token'],
      2,
    );
    const session = sessionWithLoginResponse('{}');
    const stale = session.requests[1];
    if (!stale?.response) throw new Error('bad fixture');
    stale.seq = 2;
    session.requests.push({
      ...stale,
      seq: 8,
      body: 'operation=other',
      response: { ...stale.response, body: '{"token":"wrong-token"}' },
    });
    session.requests.push({
      ...stale,
      seq: 9,
      response: { ...stale.response, body: '{"token":"right-token"}' },
    });

    expect(extractCredentials('acme', session)).toEqual({ access_token: 'right-token' });
  });

  it('extracts a persisted polling capture from its referenced request', () => {
    writeWorkflow('acme', 'poll', [], ['poll_token'], 5, 'https://example.test/login', undefined, {
      name: 'poll_token',
      source: 'json',
      path: 'poll.token',
    });
    const session = sessionWithLoginResponse('{"poll":{"token":"poll-value"}}');
    const request = session.requests[1];
    if (!request) throw new Error('bad fixture');
    request.seq = 5;

    expect(extractCredentials('acme', session)).toEqual({ poll_token: 'poll-value' });
  });

  it('rejects conflicting persisted capture producers across workflows', () => {
    writeWorkflow(
      'acme',
      'first',
      [{ name: 'access_token', source: 'json', path: 'token' }],
      ['access_token'],
      1,
    );
    writeWorkflow(
      'acme',
      'second',
      [{ name: 'access_token', source: 'response_header', header: 'x-token' }],
      ['access_token'],
      2,
    );

    expect(() => extractCredentials('acme', sessionWithLoginResponse('{}'))).toThrow(
      'conflicting producing requests',
    );
  });

  it('persists the latest available storage snapshot for every origin', async () => {
    const sessionPath = join(home, 'storage-session.json');
    writeFileSync(
      sessionPath,
      JSON.stringify({
        site: 'storage-site',
        startedAt: '2026-07-13T00:00:00.000Z',
        url: 'https://storage.test/login',
        imprintVersion: '0.6.0',
        requests: [],
        events: [],
        narration: [],
        cookieSnapshots: [],
        storageSnapshots: [
          {
            takenAt: '2026-07-13T00:00:00.000Z',
            timestamp: 0,
            label: 'start',
            origin: 'https://identity.test',
            localStorage: { identity_token: 'identity-value' },
            sessionStorage: {},
          },
          {
            takenAt: '2026-07-13T00:00:01.000Z',
            timestamp: 1000,
            label: 'end',
            origin: 'https://storage.test',
            localStorage: { local_token: 'local-value' },
            sessionStorage: { challenge: 'session-value' },
          },
        ],
      }),
    );

    const result = await login({ site: 'storage-site', fromSession: sessionPath });

    expect(result.storageCount).toBe(3);
    expect(storedStorage).toEqual([
      {
        origin: 'https://identity.test',
        kind: 'localStorage',
        key: 'identity_token',
        value: 'identity-value',
      },
      {
        origin: 'https://storage.test',
        kind: 'localStorage',
        key: 'local_token',
        value: 'local-value',
      },
      {
        origin: 'https://storage.test',
        kind: 'sessionStorage',
        key: 'challenge',
        value: 'session-value',
      },
    ]);
  });
});
