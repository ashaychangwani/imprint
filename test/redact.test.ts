/**
 * Redaction unit tests. Pure functions, no I/O.
 */

import { describe, expect, it } from 'bun:test';
import {
  redactBody,
  redactFormBody,
  redactHeaders,
  redactJsonBody,
  redactSession,
  redactUrl,
} from '../src/imprint/redact.ts';
import type { Session } from '../src/imprint/types.ts';

describe('redactFormBody', () => {
  it('redacts patronPassword (Discover & Go style)', () => {
    const body = 'dataType=json&method=Login&patronNumber=01336048586561&patronPassword=1070';
    const r = redactFormBody(body);
    expect(r.redactionsCount).toBe(2); // patronNumber + patronPassword
    expect(r.redacted).toContain('patronPassword=[REDACTED:4]');
    expect(r.redacted).toContain('patronNumber=[REDACTED:14]');
    expect(r.redacted).toContain('dataType=json');
    expect(r.redacted).toContain('method=Login');
  });

  it('handles snake_case and camelCase variations', () => {
    const body = 'access_token=abc123&apiKey=xyz&api_token=def';
    const r = redactFormBody(body);
    expect(r.redactionsCount).toBe(3);
    expect(r.redacted).not.toContain('abc123');
    expect(r.redacted).not.toContain('xyz');
    expect(r.redacted).not.toContain('def');
  });

  it('leaves non-sensitive fields alone', () => {
    const body = 'name=alice&email=alice@example.com&attractionId=7';
    const r = redactFormBody(body);
    expect(r.redactionsCount).toBe(0);
    expect(r.redacted).toBe(body);
  });
});

describe('redactJsonBody', () => {
  it('redacts nested credential fields', () => {
    const body = JSON.stringify({
      user: { name: 'alice', password: 'hunter2' },
      auth: { token: 'jwt.abc.def', expiresIn: 3600 },
      data: [1, 2, 3],
    });
    const r = redactJsonBody(body);
    expect(r.redactionsCount).toBe(2); // password + token
    const parsed = JSON.parse(r.redacted);
    expect(parsed.user.password).toMatch(/^\[REDACTED:\d+\]$/);
    expect(parsed.auth.token).toMatch(/^\[REDACTED:\d+\]$/);
    expect(parsed.user.name).toBe('alice');
    expect(parsed.data).toEqual([1, 2, 3]);
  });

  it('returns body unchanged on parse failure', () => {
    const body = 'not json';
    const r = redactJsonBody(body);
    expect(r.redacted).toBe(body);
    expect(r.redactionsCount).toBe(0);
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query params', () => {
    const url = 'https://api.example.com/x?accessToken=abc&user=alice&apikey=xyz';
    const r = redactUrl(url);
    expect(r.redactionsCount).toBe(2);
    expect(r.redacted).toContain('user=alice');
    expect(r.redacted).not.toContain('accessToken=abc');
    expect(r.redacted).not.toContain('apikey=xyz');
  });

  it('returns url unchanged on malformed input', () => {
    const url = 'not a url';
    const r = redactUrl(url);
    expect(r.redacted).toBe(url);
    expect(r.redactionsCount).toBe(0);
  });
});

describe('redactHeaders', () => {
  it('redacts Authorization, Cookie, X-API-Key', () => {
    const headers = {
      Authorization: 'Bearer abc.def.ghi',
      Cookie: 'session=xyz; csrf=123',
      'X-API-Key': 'sk-abc123',
      'Content-Type': 'application/json',
    };
    const r = redactHeaders(headers);
    expect(r.redactionsCount).toBe(3);
    expect(r.redacted.Authorization).toMatch(/^\[REDACTED:\d+\]$/);
    expect(r.redacted.Cookie).toMatch(/^\[REDACTED:\d+\]$/);
    expect(r.redacted['X-API-Key']).toMatch(/^\[REDACTED:\d+\]$/);
    expect(r.redacted['Content-Type']).toBe('application/json');
  });

  it('is case-insensitive on header names', () => {
    const headers = { authorization: 'Bearer x', AUTHORIZATION: 'Bearer y' };
    const r = redactHeaders(headers);
    expect(r.redactionsCount).toBe(2);
  });
});

describe('redactBody (router)', () => {
  it('routes form bodies based on content-type', () => {
    const r = redactBody('password=secret&name=alice', 'application/x-www-form-urlencoded');
    expect(r.redactionsCount).toBe(1);
    expect(r.redacted).toContain('name=alice');
  });

  it('routes JSON bodies based on content-type', () => {
    const r = redactBody('{"password":"secret"}', 'application/json');
    expect(r.redactionsCount).toBe(1);
    expect(r.redacted).toContain('REDACTED');
  });

  it('falls back to form parsing when content-type is missing but body looks form-encoded', () => {
    const r = redactBody('password=secret&name=alice');
    expect(r.redactionsCount).toBe(1);
  });
});

describe('redactSession', () => {
  const baseSession: Session = {
    site: 'test',
    startedAt: '2026-04-30T00:00:00.000Z',
    url: 'https://example.com/',
    imprintVersion: '0.1.0',
    requests: [
      {
        seq: 0,
        timestamp: 100,
        method: 'POST',
        url: 'https://example.com/login',
        headers: { Cookie: 'session=abc', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=hunter2&user=alice',
        resourceType: 'XHR',
        response: {
          status: 200,
          headers: { 'Set-Cookie': 'session=newvalue' },
          mimeType: 'application/json',
        },
      },
    ],
    events: [],
    narration: [],
    cookieSnapshots: [
      {
        takenAt: '2026-04-30T00:00:00.000Z',
        timestamp: 0,
        label: 'start',
        cookies: [
          { name: 'session', value: 'realsessionvalue', domain: '.example.com', path: '/' },
        ],
      },
    ],
  };

  it('scrubs request bodies, headers, and cookies', () => {
    const { session, stats } = redactSession(baseSession);

    expect(stats.totalRedactions).toBeGreaterThan(0);
    expect(stats.cookiesRedacted).toBe(1);

    const req = session.requests[0];
    expect(req).toBeDefined();
    if (!req) return;
    expect(req.body).not.toContain('hunter2');
    expect(req.body).toContain('user=alice'); // non-sensitive preserved
    expect(req.headers.Cookie).toMatch(/^\[REDACTED:\d+\]$/);
    expect(req.response?.headers['Set-Cookie']).toMatch(/^\[REDACTED:\d+\]$/);

    const snap = session.cookieSnapshots[0];
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.cookies[0]?.value).toMatch(/^\[REDACTED:\d+\]$/);
    expect(snap.cookies[0]?.name).toBe('session'); // names kept
    expect(snap.cookies[0]?.domain).toBe('.example.com');
  });

  it('preserves the rest of the session shape', () => {
    const { session } = redactSession(baseSession);
    expect(session.site).toBe('test');
    expect(session.url).toBe('https://example.com/');
    expect(session.requests.length).toBe(1);
  });
});
