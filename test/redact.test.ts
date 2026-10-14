import { describe, expect, it } from 'bun:test';
import { detectPageMintedHeaders, redactSession } from '../src/imprint/redact.ts';
import type { Session } from '../src/imprint/types.ts';
const userPlaceholder = '$' + '{credential.username}';
const passPlaceholder = '$' + '{credential.password}';
function fixture(body: string, contentType = 'application/json'): Session {
  return {
    site: 'fixture',
    url: 'https://fixture.invalid/',
    startedAt: '2026-01-01T00:00:00Z',
    imprintVersion: '0.1.0',
    narration: [],
    events: [],
    cookieSnapshots: [],
    storageSnapshots: [],
    requests: [
      {
        seq: 1,
        timestamp: 1,
        method: 'POST',
        url: 'https://fixture.invalid/data?token=ordinary-token',
        headers: {
          'content-type': contentType,
          authorization: 'Bearer ordinary-session',
          cookie: 'session=ordinary-cookie',
        },
        body,
        resourceType: 'XHR',
        response: {
          status: 200,
          headers: { 'set-cookie': 'session=ordinary-cookie' },
          mimeType: 'application/json',
          body: '{"email":"fixture@example.com","access_token":"ordinary-token","password":"server-generated"}',
        },
      },
    ],
  };
}
describe('credential-only recording protection', () => {
  it('preserves ordinary requests, responses, headers, PII, cookies, and storage exactly', () => {
    const session = fixture(
      '{"access_token":"opaque","email":"fixture@example.com","phone":"212-555-1234"}',
    );
    session.cookieSnapshots = [
      {
        timestamp: 1,
        takenAt: '2026-01-01T00:00:00Z',
        label: 'start',
        cookies: [{ name: 'session', value: 'cookie-token', domain: 'fixture.invalid', path: '/' }],
      },
    ];
    session.storageSnapshots = [
      {
        timestamp: 1,
        takenAt: '2026-01-01T00:00:00Z',
        label: 'start',
        origin: 'https://fixture.invalid',
        localStorage: { access_token: 'stored-token' },
        sessionStorage: { email: 'fixture@example.com' },
      },
    ];
    const result = redactSession(session);
    expect(result.session).toEqual(session);
    expect(result.stats.totalRedactions).toBe(0);
  });
  it('leaves framed, malformed and non-JSON bodies untouched', () => {
    for (const body of [
      ')]}\\n100\\n[["frame","opaque"]]',
      '0:T10,opaque-token',
      '{not-json',
      'a='.repeat(100),
      'A'.repeat(200),
    ]) {
      const session = fixture(body, 'text/plain');
      const response = session.requests[0]?.response;
      if (!response) throw new Error('missing fixture response');
      response.body = body;
      expect(redactSession(session).session).toEqual(session);
    }
  });
  it('substitutes known login credentials without rewriting unrelated wire bytes', () => {
    const session = fixture(
      'username=fixture-user&password=fixture-pass&token=keep%20this+format',
      'application/x-www-form-urlencoded',
    );
    const result = redactSession(session).session;
    expect(result.requests[0]?.body).toBe(
      `username=${userPlaceholder}&password=${passPlaceholder}&token=keep%20this+format`,
    );
    expect(result.requests[0]?.headers).toEqual(session.requests[0]?.headers);
    expect(result.requests[0]?.response).toEqual(session.requests[0]?.response);
    expect(session.requests[0]?.body).toContain('fixture-pass');
  });
  it('protects explicitly provided credentials in URLs and event text, including encoding', () => {
    const session = fixture('{"note":"untouched"}');
    const request = session.requests[0];
    if (!request) throw new Error('missing fixture request');
    request.url = 'https://fixture.invalid/login?value=fixture%2Bpass';
    session.events = [{ seq: 1, timestamp: 1, type: 'input', detail: '{"value":"fixture+pass"}' }];
    const result = redactSession(session, {
      replacements: [
        {
          requestSeq: 1,
          location: { kind: 'body-form', key: 'password' },
          originalValue: 'fixture+pass',
          placeholder: passPlaceholder,
        },
      ],
    });
    expect(result.session.requests[0]?.url).toContain(passPlaceholder);
    expect(result.session.events[0]?.detail).toContain(passPlaceholder);
    expect(redactSession(result.session).session).toEqual(result.session);
  });
});

describe('detectPageMintedHeaders', () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      site: 'test',
      url: 'https://example.com',
      startedAt: '2026-01-01T00:00:00Z',
      imprintVersion: '0.1.0',
      requests: [],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
      ...overrides,
    };
  }

  it('detects x-api-key as page-minted when it appears before user interaction with no producer', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 500,
          method: 'GET',
          url: 'https://example.com/',
          headers: {},
          resourceType: 'Document',
          response: { status: 200, headers: {}, mimeType: 'text/html' },
        },
        {
          seq: 2,
          timestamp: 2000,
          method: 'POST',
          url: 'https://example.com/api/data',
          headers: { 'X-API-Key': 'l7xx-app-constant-123', 'Content-Type': 'application/json' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, mimeType: 'application/json' },
        },
      ],
      events: [{ seq: 1, timestamp: 10000, type: 'click', detail: '{}' }],
    });
    expect(detectPageMintedHeaders(session)).toEqual(['x-api-key']);
  });

  it('does NOT flag headers whose values came from Set-Cookie', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 500,
          method: 'GET',
          url: 'https://example.com/',
          headers: {},
          resourceType: 'Document',
          response: {
            status: 200,
            headers: { 'Set-Cookie': 'auth-token=secret-from-server; Path=/' },
            mimeType: 'text/html',
          },
        },
        {
          seq: 2,
          timestamp: 2000,
          method: 'POST',
          url: 'https://example.com/api/data',
          headers: { 'X-Auth-Token': 'secret-from-server' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, mimeType: 'application/json' },
        },
      ],
      events: [{ seq: 1, timestamp: 10000, type: 'click', detail: '{}' }],
    });
    expect(detectPageMintedHeaders(session)).toEqual([]);
  });

  it('ignores cookie and set-cookie headers', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 500,
          method: 'GET',
          url: 'https://example.com/',
          headers: { Cookie: 'session=abc123' },
          resourceType: 'Document',
          response: { status: 200, headers: {}, mimeType: 'text/html' },
        },
      ],
      events: [{ seq: 1, timestamp: 10000, type: 'click', detail: '{}' }],
    });
    expect(detectPageMintedHeaders(session)).toEqual([]);
  });

  it('ignores headers that appear AFTER user interaction', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 15000,
          method: 'POST',
          url: 'https://example.com/api/data',
          headers: { 'X-API-Key': 'might-be-user-triggered' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, mimeType: 'application/json' },
        },
      ],
      events: [{ seq: 1, timestamp: 10000, type: 'click', detail: '{}' }],
    });
    expect(detectPageMintedHeaders(session)).toEqual([]);
  });

  it('treats all requests as pre-interaction when no events exist', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 500,
          method: 'POST',
          url: 'https://example.com/api',
          headers: { 'X-API-Key': 'app-constant' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, mimeType: 'application/json' },
        },
      ],
      events: [],
    });
    expect(detectPageMintedHeaders(session)).toEqual(['x-api-key']);
  });
});
