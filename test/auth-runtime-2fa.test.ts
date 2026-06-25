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
