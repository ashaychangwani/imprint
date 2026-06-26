import { describe, expect, it } from 'bun:test';
import {
  deriveCredentialEntryPageUrl,
  ensureAuthBootstrap,
} from '../src/imprint/auth-bootstrap.ts';
import { type Session, WorkflowSchema } from '../src/imprint/types.ts';

/** Minimal synthetic session builder — only the fields the helper reads. */
function session(requests: Array<Partial<Session['requests'][number]>>): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.com/',
    imprintVersion: '0.0.0-test',
    requests: requests.map((r, i) => ({
      seq: r.seq ?? i,
      timestamp: r.timestamp ?? i,
      method: r.method ?? 'GET',
      url: r.url ?? 'https://example.com/',
      headers: r.headers ?? {},
      body: r.body,
      resourceType: r.resourceType ?? 'XHR',
      response: r.response,
    })),
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

const LOGIN_URL = 'https://api.example.com/login';

describe('deriveCredentialEntryPageUrl', () => {
  it('(1) prefers the credential POST Referer (the page the form was submitted from)', () => {
    const s = session([
      {
        seq: 0,
        resourceType: 'Document',
        url: 'https://example.com/home',
        response: { status: 200, headers: {}, body: '<html></html>', mimeType: 'text/html' },
      },
      {
        seq: 5,
        method: 'POST',
        url: LOGIN_URL,
        headers: { Referer: 'https://www.example.com/account/login?next=/x' },
        body: 'username=fixture-user&password=hunter2',
      },
    ]);
    expect(deriveCredentialEntryPageUrl(s, [5], ['username', 'password'])).toBe(
      'https://www.example.com/account/login',
    );
  });

  it('(2) falls back to the Document whose form action targets the login endpoint', () => {
    const s = session([
      {
        seq: 1,
        resourceType: 'Document',
        url: 'https://www.example.com/signin',
        response: {
          status: 200,
          headers: {},
          mimeType: 'text/html',
          body: '<form action="/login" method="post"><input name="username"></form>',
        },
      },
      { seq: 4, method: 'POST', url: LOGIN_URL, body: 'username=fixture-user&password=hunter2' },
    ]);
    expect(deriveCredentialEntryPageUrl(s, [4], ['username', 'password'])).toBe(
      'https://www.example.com/signin',
    );
  });

  it('(2b) matches the Document by credential field names when no form action resolves', () => {
    const s = session([
      {
        seq: 1,
        resourceType: 'Document',
        url: 'https://www.example.com/login-page',
        response: {
          status: 200,
          headers: {},
          mimeType: 'text/html',
          body: '<input name="eliloUserID"><input name="eliloPassword">',
        },
      },
      { seq: 4, method: 'POST', url: LOGIN_URL, body: '{"eliloUserID":"u","eliloPassword":"p"}' },
    ]);
    expect(deriveCredentialEntryPageUrl(s, [4], ['eliloUserID', 'eliloPassword'])).toBe(
      'https://www.example.com/login-page',
    );
  });

  it('(3) falls back to the last Document before the credential POST', () => {
    const s = session([
      {
        seq: 1,
        resourceType: 'Document',
        url: 'https://www.example.com/start',
        response: { status: 200, headers: {}, body: '<html></html>', mimeType: 'text/html' },
      },
      { seq: 4, method: 'POST', url: LOGIN_URL, body: 'username=fixture-user&password=hunter2' },
    ]);
    // No Referer, no form match → last Document before the POST.
    expect(deriveCredentialEntryPageUrl(s, [4], ['username', 'password'])).toBe(
      'https://www.example.com/start',
    );
  });

  it('prefers the login page over an earlier home page (closest-before / form match)', () => {
    const s = session([
      {
        seq: 1,
        resourceType: 'Document',
        url: 'https://www.example.com/',
        response: { status: 200, headers: {}, body: '<html>home</html>', mimeType: 'text/html' },
      },
      {
        seq: 2,
        resourceType: 'Document',
        url: 'https://www.example.com/login',
        response: {
          status: 200,
          headers: {},
          mimeType: 'text/html',
          body: '<form action="/login"><input name="username"></form>',
        },
      },
      { seq: 4, method: 'POST', url: LOGIN_URL, body: 'username=fixture-user&password=hunter2' },
    ]);
    expect(deriveCredentialEntryPageUrl(s, [4], ['username', 'password'])).toBe(
      'https://www.example.com/login',
    );
  });

  it('returns undefined when the recording offers no usable page', () => {
    const s = session([
      { seq: 4, method: 'POST', url: LOGIN_URL, body: 'username=fixture-user&password=hunter2' },
    ]);
    expect(deriveCredentialEntryPageUrl(s, [4], ['username', 'password'])).toBeUndefined();
  });
});

describe('ensureAuthBootstrap', () => {
  const s = session([
    {
      seq: 5,
      method: 'POST',
      url: LOGIN_URL,
      headers: { Referer: 'https://www.example.com/login' },
      body: 'username=fixture-user&password=hunter2',
    },
  ]);

  it('injects a derived bootstrap into an auth workflow that lacks one', () => {
    const wf: { toolKind?: string; bootstrap?: unknown } = { toolKind: 'authenticate' };
    const r = ensureAuthBootstrap(wf, s, [5], ['username', 'password']);
    expect(r.changed).toBe(true);
    expect(wf.bootstrap).toEqual({
      url: 'https://www.example.com/login',
      waitUntil: 'domcontentloaded',
      waitMs: 4000,
    });
  });

  it('never overwrites an agent-provided bootstrap', () => {
    const wf = { toolKind: 'authenticate', bootstrap: { url: 'https://agent.example.com/x' } };
    const r = ensureAuthBootstrap(wf, s, [5], ['username', 'password']);
    expect(r.changed).toBe(false);
    expect(wf.bootstrap).toEqual({ url: 'https://agent.example.com/x' });
  });

  it('never injects into a non-auth tool', () => {
    const wf: { toolKind?: string; bootstrap?: unknown } = { toolKind: 'data' };
    const r = ensureAuthBootstrap(wf, s, [5], ['username', 'password']);
    expect(r.changed).toBe(false);
    expect(wf.bootstrap).toBeUndefined();
  });
});

describe('WorkflowSchema accepts a top-level bootstrap (Fix 3A example)', () => {
  it('parses a minimal auth workflow with a top-level bootstrap block', () => {
    const wf = {
      toolName: 'authenticate_fixture',
      toolKind: 'authenticate',
      intent: { description: 'auth' },
      site: 'fixture-site',
      bootstrap: { url: 'https://example.com/login', waitUntil: 'domcontentloaded', waitMs: 4000 },
      parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
      requests: [{ method: 'POST', url: LOGIN_URL, headers: {} }],
    };
    const parsed = WorkflowSchema.parse(wf);
    expect(parsed.bootstrap?.url).toBe('https://example.com/login');
    expect(parsed.bootstrap?.waitUntil).toBe('domcontentloaded');
  });
});
