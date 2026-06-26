import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authExternalVerification } from '../src/imprint/auth-compile-tools.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

// Auth tools are ordinary laddered tools (toolKind: 'authenticate'). 2FA is
// modeled STRUCTURALLY, not by delivery channel: `otp` (a code typed back into a
// second request) and `push` (poll an endpoint until approved) — sms/email/totp
// all collapse to `otp`. These tests cover the collapsed authConfig schema and
// the structural verification the compile agent's done() runs. All values are
// synthetic (public repo).

// ─── Schema ─────────────────────────────────────────────────────────────────

describe('authConfig schema', () => {
  const base = {
    toolName: 'authenticate_x',
    toolKind: 'authenticate' as const,
    intent: { description: 'auth' },
    parameters: [],
    requests: [{ method: 'POST', url: 'https://x.example/login', headers: {} }],
    site: 'x',
  };

  it('defaults twoFactorType to "none"', () => {
    const wf = WorkflowSchema.parse({ ...base, authConfig: {} });
    expect(wf.authConfig?.twoFactorType).toBe('none');
  });

  it('accepts the collapsed structural types (otp / push / none)', () => {
    for (const twoFactorType of ['otp', 'push', 'none'] as const) {
      const wf = WorkflowSchema.parse({ ...base, authConfig: { twoFactorType } });
      expect(wf.authConfig?.twoFactorType).toBe(twoFactorType);
    }
  });

  it('rejects the old per-channel values (no backward-compat)', () => {
    for (const legacy of ['push_notification', 'sms_otp', 'email_otp', 'totp']) {
      expect(() =>
        WorkflowSchema.parse({ ...base, authConfig: { twoFactorType: legacy } }),
      ).toThrow();
    }
  });

  it('rejects an unknown twoFactorType', () => {
    expect(() =>
      WorkflowSchema.parse({ ...base, authConfig: { twoFactorType: 'carrier-pigeon' } }),
    ).toThrow();
  });

  it('round-trips pollTerminal + twoFactorContext', () => {
    const wf = WorkflowSchema.parse({
      ...base,
      authConfig: {
        twoFactorType: 'push',
        pollEndpoint: 'https://x.example/poll',
        pollTerminal: { name: 'approved', source: 'json', path: 'status' },
        twoFactorContext: ['mfaId'],
      },
    });
    expect(wf.authConfig?.pollTerminal).toMatchObject({ source: 'json', path: 'status' });
    expect(wf.authConfig?.twoFactorContext).toEqual(['mfaId']);
  });
});

// ─── External verification ──────────────────────────────────────────────────

describe('authExternalVerification', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const writeWorkflow = (workflow: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'imprint-auth-verify-'));
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify(workflow));
    return dir;
  };

  // Minimal well-formed authenticate workflow (no 2FA).
  const validWorkflow = () => ({
    toolName: 'authenticate_x',
    toolKind: 'authenticate' as string,
    intent: { description: 'auth' },
    parameters: [] as unknown[],
    requests: [{ method: 'POST', url: 'https://x.example/login', headers: {} }] as unknown[],
    site: 'x',
    authConfig: { twoFactorType: 'none' } as Record<string, unknown>,
  });

  it('passes a well-formed authenticate workflow', () => {
    expect(authExternalVerification(writeWorkflow(validWorkflow()))).toEqual([]);
  });

  it('flags a workflow whose toolKind is not authenticate', () => {
    const wf = validWorkflow();
    wf.toolKind = 'data';
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('authenticate'))).toBe(true);
  });

  it('flags a workflow with no requests', () => {
    const wf = validWorkflow();
    wf.requests = [];
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('requests'))).toBe(true);
  });

  // ── Structural 2FA assertions ──────────────────────────────────────────────

  it("flags 'push' without a pollEndpoint", () => {
    const wf = validWorkflow();
    wf.authConfig = { twoFactorType: 'push' };
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('pollEndpoint'))).toBe(true);
  });

  it("passes 'push' with a pollEndpoint", () => {
    const wf = validWorkflow();
    wf.authConfig = { twoFactorType: 'push', pollEndpoint: 'https://x.example/poll' };
    expect(authExternalVerification(writeWorkflow(wf))).toEqual([]);
  });

  it("flags 'otp' without an otp_code parameter", () => {
    const wf = validWorkflow();
    wf.authConfig = { twoFactorType: 'otp', initiateRequestCount: 1 };
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('otp_code'))).toBe(true);
  });

  it("flags 'otp' whose submit_otp reads ${state.X} not carried across the gap", () => {
    const wf = validWorkflow();
    wf.parameters = [{ name: 'otp_code', type: 'string', description: 'code' }];
    wf.requests = [
      {
        method: 'POST',
        url: 'https://x.example/login',
        headers: {},
        body: 'u=${credential.username}',
      },
      {
        method: 'POST',
        url: 'https://x.example/otp',
        headers: {},
        body: 'm=${state.mfaId}&c=${param.otp_code}',
      },
    ];
    wf.authConfig = { twoFactorType: 'otp', initiateRequestCount: 1, twoFactorContext: [] };
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('mfaId'))).toBe(true);
  });

  it("passes 'otp' when the chained state is listed in twoFactorContext", () => {
    const wf = validWorkflow();
    wf.parameters = [{ name: 'otp_code', type: 'string', description: 'code' }];
    wf.requests = [
      {
        method: 'POST',
        url: 'https://x.example/login',
        headers: {},
        body: 'u=${credential.username}',
      },
      {
        method: 'POST',
        url: 'https://x.example/otp',
        headers: {},
        body: 'm=${state.mfaId}&c=${param.otp_code}',
      },
    ];
    wf.authConfig = { twoFactorType: 'otp', initiateRequestCount: 1, twoFactorContext: ['mfaId'] };
    expect(authExternalVerification(writeWorkflow(wf))).toEqual([]);
  });

  it("passes 'otp' when the chained state is captured on an initiate request", () => {
    const wf = validWorkflow();
    wf.parameters = [{ name: 'otp_code', type: 'string', description: 'code' }];
    wf.requests = [
      {
        method: 'POST',
        url: 'https://x.example/login',
        headers: {},
        body: 'u=${credential.username}',
        captures: [{ name: 'mfaId', source: 'json', path: 'reauth.mfaId' }],
      },
      {
        method: 'POST',
        url: 'https://x.example/otp',
        headers: {},
        body: 'm=${state.mfaId}&c=${param.otp_code}',
      },
    ];
    wf.authConfig = { twoFactorType: 'otp', initiateRequestCount: 1, twoFactorContext: [] };
    expect(authExternalVerification(writeWorkflow(wf))).toEqual([]);
  });

  it("flags 'otp' with UNSET initiateRequestCount — completion captures must not count as initiate coverage", () => {
    // With no initiateRequestCount there is no initiate phase, so the `mfaId`
    // capture below is on a completion-phase request and must NOT cover the
    // ${state.mfaId} read. (The earlier `slice(0, initiateCount || undefined)`
    // bug returned ALL requests for an unset count, wrongly marking it covered.)
    const wf = validWorkflow();
    wf.parameters = [{ name: 'otp_code', type: 'string', description: 'code' }];
    wf.requests = [
      {
        method: 'POST',
        url: 'https://x.example/login',
        headers: {},
        body: 'u=${credential.username}',
        captures: [{ name: 'mfaId', source: 'json', path: 'reauth.mfaId' }],
      },
      {
        method: 'POST',
        url: 'https://x.example/otp',
        headers: {},
        body: 'm=${state.mfaId}&c=${param.otp_code}',
      },
    ];
    // initiateRequestCount intentionally omitted.
    wf.authConfig = { twoFactorType: 'otp', twoFactorContext: [] };
    const failures = authExternalVerification(writeWorkflow(wf));
    expect(failures.some((f) => f.includes('mfaId'))).toBe(true);
  });
});
