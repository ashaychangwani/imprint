/**
 * Runtime 2FA tests for executeAuthWorkflow — structural, channel-agnostic.
 *
 * Covers (1) the recording-grounded push poll terminal (a capture that resolves
 * only on the approved poll, replacing the old hardcoded body.includes()), and
 * (2) the stateless initiate→submit_otp state-chain (a token the initiate
 * response returns in its body is echoed in the AWAITING_2FA envelope and seeded
 * back via initialState so ${state.X} resolves on the second call).
 *
 * All values are synthetic — this is a public repo.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  type CookieRecord,
  type CredentialBackend,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import { type CredentialStore, executeWorkflow } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

// In-memory credential backend so saveSiteCookies() never touches the keychain
// or disk during tests.
function memBackend(): CredentialBackend {
  const cookies = new Map<string, CookieRecord[]>();
  const secrets = new Map<string, Map<string, string>>();
  const bag = (site: string) => {
    let m = secrets.get(site);
    if (!m) {
      m = new Map();
      secrets.set(site, m);
    }
    return m;
  };
  return {
    id: 'encrypted-file',
    async getSecret(site, name) {
      return bag(site).get(name) ?? null;
    },
    async setSecret(site, name, value) {
      bag(site).set(name, value);
    },
    async deleteSecret(site, name) {
      bag(site).delete(name);
    },
    async listSecrets(site) {
      return [...bag(site).keys()];
    },
    async getCookies(site) {
      return cookies.get(site) ?? [];
    },
    async setCookies(site, c) {
      cookies.set(site, c);
    },
    async listSites() {
      return [...new Set([...cookies.keys(), ...secrets.keys()])];
    },
  };
}

const creds: CredentialStore = { site: 'fix', cookies: [], values: { username: 'SYNTH-USER' } };

afterEach(() => {
  setBackendOverride(null);
  resetBackendCache();
});

describe('push poll terminal (recording-grounded)', () => {
  setBackendOverride(memBackend());

  const pushWorkflow = (pollTerminal?: unknown): Workflow =>
    ({
      toolName: 'authenticate_fix',
      toolKind: 'authenticate',
      intent: { description: 'auth' },
      parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
      requests: [{ method: 'POST', url: 'https://fix.example/login', headers: {} }],
      site: 'fix',
      authConfig: {
        twoFactorType: 'push',
        initiateRequestCount: 1,
        pollEndpoint: 'https://fix.example/poll',
        pollIntervalMs: 1,
        maxPollAttempts: 5,
        ...(pollTerminal ? { pollTerminal } : {}),
      },
    }) as Workflow;

  // A recording-grounded terminal: a field that exists ONLY in the approved
  // poll response (pending polls carry only `status`).
  const terminal = {
    name: 'sessionToken',
    source: 'json',
    path: 'sessionToken',
    required: false,
  };

  it('approves only when the terminal capture resolves on the approved poll', async () => {
    setBackendOverride(memBackend());
    let polls = 0;
    const fetchMock = (async (url: string) => {
      if (String(url).includes('/poll')) {
        polls += 1;
        // pending twice, then approved — `sessionToken` appears only on approval.
        const body =
          polls >= 3 ? '{"status":"approved","sessionToken":"SYNTH-TOK"}' : '{"status":"pending"}';
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: pushWorkflow(terminal),
      params: { action: 'complete' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(polls).toBe(3); // stopped exactly at the approved poll, not the first
  });

  it('does NOT approve while the terminal field is absent (pending)', async () => {
    setBackendOverride(memBackend());
    const fetchMock = (async (url: string) =>
      String(url).includes('/poll')
        ? new Response('{"status":"pending"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: pushWorkflow(terminal),
      params: { action: 'complete' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not approved/i);
  });

  it('bounds each poll with a timeout so a hung pollEndpoint cannot hang complete forever', async () => {
    setBackendOverride(memBackend());
    let polls = 0;
    // A poll that accepts the connection but never responds — it settles ONLY when
    // the per-poll AbortController fires. Without the timeout this single fetch (and
    // thus the whole `complete` call) would hang forever and the budget never advances.
    const fetchMock = (async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/poll')) {
        polls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: pushWorkflow(terminal),
      params: { action: 'complete' },
      credentials: creds,
      fetchImpl: fetchMock,
      requestTimeoutMs: 20, // each hung poll aborts fast; the loop still advances
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not approved/i);
    expect(polls).toBe(5); // every attempt ran and timed out — no hang, no early stop
  });

  it('honors IMPRINT_AUTH_POLL_ATTEMPTS to bound an unattended push attempt', async () => {
    // teach sets this env for an unattended 2FA *attempt* so the push poll fails
    // fast instead of running the artifact's generous default (maxPollAttempts:5
    // here). With the override at 2 and a never-approving poll, it stops at 2.
    setBackendOverride(memBackend());
    const prev = process.env.IMPRINT_AUTH_POLL_ATTEMPTS;
    process.env.IMPRINT_AUTH_POLL_ATTEMPTS = '2';
    try {
      let polls = 0;
      const fetchMock = (async (url: string) => {
        if (String(url).includes('/poll')) {
          polls += 1;
          return new Response('{"status":"pending"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;

      const r = await executeWorkflow({
        workflow: pushWorkflow(terminal),
        params: { action: 'complete' },
        credentials: creds,
        fetchImpl: fetchMock,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/not approved after 2/i);
      expect(polls).toBe(2); // bounded by the env override, not the artifact's 5
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: env cleanup requires delete
        delete process.env.IMPRINT_AUTH_POLL_ATTEMPTS;
      } else {
        process.env.IMPRINT_AUTH_POLL_ATTEMPTS = prev;
      }
    }
  });

  it('falls back to a fresh session Set-Cookie when no pollTerminal is declared', async () => {
    setBackendOverride(memBackend());
    let polls = 0;
    const fetchMock = (async (url: string) => {
      if (String(url).includes('/poll')) {
        polls += 1;
        // first poll: no cookie (still pending); second: a session cookie appears.
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (polls >= 2) headers['set-cookie'] = 'sid=SYNTH-SESSION; Path=/';
        return new Response('{}', { status: 200, headers });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: pushWorkflow(), // no pollTerminal → set-cookie fallback
      params: { action: 'complete' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(polls).toBe(2);
  });

  it('sends the declared pollBody (templated) + content-type + method on each poll (Fix 4)', async () => {
    setBackendOverride(memBackend());
    let capturedBody: string | undefined;
    let capturedCt: string | undefined;
    let capturedMethod: string | undefined;
    let polls = 0;
    const fetchMock = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/poll')) {
        polls += 1;
        capturedMethod = init?.method;
        capturedBody = typeof init?.body === 'string' ? init.body : undefined;
        capturedCt = new Headers(init?.headers as Record<string, string>).get('content-type') ?? '';
        const body =
          polls >= 2 ? '{"status":"approved","sessionToken":"SYNTH-TOK"}' : '{"status":"pending"}';
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const wf = pushWorkflow(terminal);
    // Declare a templated poll body (the recorded status endpoint requires it).
    (wf.authConfig as NonNullable<Workflow['authConfig']>).pollBody =
      '{"user":"${credential.username}"}';
    (wf.authConfig as NonNullable<Workflow['authConfig']>).pollContentType = 'application/json';
    (wf.authConfig as NonNullable<Workflow['authConfig']>).pollMethod = 'POST';

    const r = await executeWorkflow({
      workflow: wf,
      params: { action: 'complete' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(capturedMethod).toBe('POST');
    expect(capturedCt).toBe('application/json');
    // `${credential.username}` resolved from the store, not sent as a literal.
    expect(capturedBody).toBe('{"user":"SYNTH-USER"}');
  });
});

describe('initiate→submit_otp state chain (stateless)', () => {
  const otpWorkflow = (): Workflow =>
    ({
      toolName: 'authenticate_fix',
      toolKind: 'authenticate',
      intent: { description: 'auth' },
      parameters: [
        { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
        { name: 'otp_code', type: 'string', description: 'code' },
      ],
      requests: [
        {
          method: 'POST',
          url: 'https://fix.example/login',
          headers: {},
          body: 'u=${credential.username}',
          captures: [{ name: 'mfaId', source: 'json', path: 'reauth.mfaId' }],
        },
        {
          method: 'POST',
          url: 'https://fix.example/otp',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'm=${state.mfaId}&c=${param.otp_code}',
        },
      ],
      site: 'fix',
      authConfig: {
        twoFactorType: 'otp',
        initiateRequestCount: 1,
        twoFactorContext: ['mfaId'],
      },
    }) as Workflow;

  it('echoes the captured token on AWAITING_2FA and threads it back on submit_otp', async () => {
    setBackendOverride(memBackend());
    const sent: Array<{ url: string; body: string }> = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).includes('/login')) {
        return new Response('{"reauth":{"mfaId":"SYNTH-MFA-1"}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    // Phase 1: initiate → AWAITING_2FA carrying the captured mfaId.
    const init = await executeWorkflow({
      workflow: otpWorkflow(),
      params: { action: 'initiate' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(init.ok).toBe(false);
    if (init.ok) throw new Error('expected AWAITING_2FA');
    expect(init.error).toBe('AWAITING_2FA');
    expect(init.twoFactorContext).toEqual({ mfaId: 'SYNTH-MFA-1' });

    // Phase 2: submit_otp with the echoed context seeded as initialState.
    const done = await executeWorkflow({
      workflow: otpWorkflow(),
      params: { action: 'submit_otp', otp_code: 'SYNTH-OTP-9' },
      credentials: creds,
      fetchImpl: fetchMock,
      initialState: init.twoFactorContext,
    });
    expect(done.ok).toBe(true);

    const otpReq = sent.find((s) => s.url.includes('/otp'));
    expect(otpReq).toBeDefined();
    // Both the chained ${state.mfaId} and the live ${param.otp_code} resolved.
    expect(otpReq?.body).toBe('m=SYNTH-MFA-1&c=SYNTH-OTP-9');
  });

  it('leaves ${state.mfaId} unresolved if the context is NOT threaded back', async () => {
    setBackendOverride(memBackend());
    const fetchMock = (async (url: string) =>
      String(url).includes('/login')
        ? new Response('{"reauth":{"mfaId":"SYNTH-MFA-1"}}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;

    // submit_otp WITHOUT initialState → the stateless second call has no mfaId,
    // so substitution of ${state.mfaId} fails (STATE_MISSING), proving the
    // echo/thread-back is load-bearing rather than incidental.
    const done = await executeWorkflow({
      workflow: otpWorkflow(),
      params: { action: 'submit_otp', otp_code: 'SYNTH-OTP-9' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(done.ok).toBe(false);
  });

  it('persists a sessionCapture token from the completion response as a durable secret', async () => {
    const backend = memBackend();
    setBackendOverride(backend);
    // OTP workflow whose completion (submit_otp) response returns a bearer token
    // a data tool will reuse. authConfig.sessionCapture declares it durable.
    const wf = (): Workflow =>
      ({
        toolName: 'authenticate_fix',
        toolKind: 'authenticate',
        intent: { description: 'auth' },
        parameters: [
          { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          { name: 'otp_code', type: 'string', description: 'code' },
        ],
        requests: [
          { method: 'POST', url: 'https://fix.example/login', headers: {} },
          {
            method: 'POST',
            url: 'https://fix.example/otp',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'c=${param.otp_code}',
          },
        ],
        site: 'fix',
        authConfig: {
          twoFactorType: 'otp',
          initiateRequestCount: 1,
          sessionCapture: [{ name: 'access_token', source: 'json', path: 'token' }],
        },
      }) as Workflow;

    const fetchMock = (async (url: string) =>
      String(url).includes('/otp')
        ? new Response('{"token":"SYNTH-BEARER-1"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const done = await executeWorkflow({
      workflow: wf(),
      params: { action: 'submit_otp', otp_code: 'SYNTH-OTP-9' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(done.ok).toBe(true);
    // The token from the completion response is now a durable credential a data
    // tool resolves as ${credential.access_token} — no re-auth needed.
    expect(await backend.getSecret('fix', 'access_token')).toBe('SYNTH-BEARER-1');
  });
});

describe('predicate capture path (variable-order arrays)', () => {
  setBackendOverride(memBackend());

  it('selects the array element by a field match, not by index', async () => {
    setBackendOverride(memBackend());
    let usedBody = '';
    const fetchMock = (async (url: string, init?: { body?: unknown }) => {
      if (String(url).includes('/challenge')) {
        // PUSH is NOT element [0] — a fixed `[0]` would capture the SMS token.
        return new Response(
          '{"challenges":[{"type":"sms","token":"SMS-WRONG"},{"type":"push","token":"PUSH-RIGHT"}]}',
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      usedBody = String(init?.body ?? '');
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const wf: Workflow = {
      toolName: 'authenticate_fix',
      toolKind: 'authenticate',
      intent: { description: 'auth' },
      parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
      site: 'fix',
      requests: [
        {
          method: 'POST',
          url: 'https://fix.example/challenge',
          headers: {},
          captures: [{ name: 'pushTok', source: 'json', path: 'challenges[type=push].token' }],
        },
        {
          method: 'POST',
          url: 'https://fix.example/use',
          headers: {},
          body: 'tok=${state.pushTok}',
        },
      ],
      authConfig: { twoFactorType: 'none', initiateRequestCount: 2 },
    } as Workflow;

    const r = await executeWorkflow({
      workflow: wf,
      params: { action: 'initiate' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(usedBody).toContain('PUSH-RIGHT');
    expect(usedBody).not.toContain('SMS-WRONG');
  });
});

describe('optional request flag', () => {
  setBackendOverride(memBackend());

  const wf = (trustOptional: boolean): Workflow =>
    ({
      toolName: 'authenticate_fix',
      toolKind: 'authenticate',
      intent: { description: 'auth' },
      parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
      site: 'fix',
      requests: [
        { method: 'POST', url: 'https://fix.example/login', headers: {} },
        { method: 'POST', url: 'https://fix.example/trust', headers: {}, optional: trustOptional },
        { method: 'POST', url: 'https://fix.example/finish', headers: {} },
      ],
      authConfig: { twoFactorType: 'none', initiateRequestCount: 3 },
    }) as Workflow;

  // A best-effort step (e.g. "remember this device") that 4xx's on replay must not
  // abort the login when flagged optional.
  const fetchMock = (async (url: string) =>
    String(url).includes('/trust')
      ? new Response('{"error":"DEVICE_ALREADY_TRUSTED"}', { status: 400 })
      : new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;

  it('skips a non-2xx optional request and continues to the final request', async () => {
    setBackendOverride(memBackend());
    const seen: string[] = [];
    const wrapped = (async (url: string, init?: unknown) => {
      seen.push(String(url));
      return (fetchMock as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: wf(true),
      params: { action: 'initiate' },
      credentials: creds,
      fetchImpl: wrapped,
    });
    expect(r.ok).toBe(true);
    expect(seen.some((u) => u.includes('/finish'))).toBe(true); // ran past the 400
  });

  it('aborts on the same non-2xx request when it is NOT optional', async () => {
    setBackendOverride(memBackend());
    const r = await executeWorkflow({
      workflow: wf(false),
      params: { action: 'initiate' },
      credentials: creds,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
  });
});
