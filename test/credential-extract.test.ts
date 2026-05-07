/**
 * Credential extraction tests. All fixtures are synthetic — never check real
 * credentials into this repo. See CLAUDE.md "Test data hygiene".
 */

import { describe, expect, it } from 'bun:test';
import { extractCredentials, parseFormBody } from '../src/imprint/credential-extract.ts';
import type { Session } from '../src/imprint/types.ts';

function emptySession(): Session {
  return {
    site: 'test',
    startedAt: new Date().toISOString(),
    url: 'https://example.com',
    imprintVersion: '0.1.0',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
  };
}

describe('parseFormBody', () => {
  it('parses basic url-encoded form body', () => {
    const pairs = parseFormBody('a=1&b=2&c=3');
    expect(pairs).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: 'c', value: '3' },
    ]);
  });

  it('URL-decodes both key and value', () => {
    const pairs = parseFormBody('username=fixture-user&password=fixture%40pass-9472');
    expect(pairs).toEqual([
      { key: 'username', value: 'fixture-user' },
      { key: 'password', value: 'fixture@pass-9472' },
    ]);
  });

  it('skips malformed pairs without an =', () => {
    const pairs = parseFormBody('a=1&malformed&b=2');
    expect(pairs).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });
});

describe('extractCredentials', () => {
  it('returns empty result for an empty session', () => {
    const out = extractCredentials(emptySession());
    expect(out.findings).toEqual([]);
    expect(out.replacements).toEqual([]);
  });

  it('finds username + password in form-encoded body', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'username=alice&password=hunter2&remember=true',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('alice');
    expect(out.findings[0]?.passwordValue).toBe('hunter2');
    expect(out.findings[0]?.requestSeq).toBe(1);
    expect(out.replacements).toHaveLength(2);
    const userR = out.replacements.find((r) => r.placeholder === '${credential.username}');
    expect(userR?.originalValue).toBe('alice');
    expect(userR?.location.kind).toBe('body-form');
    const pwdR = out.replacements.find((r) => r.placeholder === '${credential.password}');
    expect(pwdR?.originalValue).toBe('hunter2');
  });

  it('finds username + password in JSON body', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 2,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            login: { email: 'bob@example.com', password: 'hunter3' },
            extra: 'whatever',
          }),
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('bob@example.com');
    expect(out.findings[0]?.passwordValue).toBe('hunter3');
    expect(out.replacements[0]?.location.kind).toBe('body-json');
  });

  it('skips requests without password fields', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/search',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'email=alice@example.com&query=foo',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toEqual([]);
  });

  it('skips when no username partner is found', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/change-pwd',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'password=hunter2&otp=123456',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toEqual([]);
  });

  it('confirms via DOM submit event when present', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'username=alice&password=hunter2',
          resourceType: 'XHR',
        },
      ],
      events: [
        {
          seq: 1,
          timestamp: 90,
          type: 'submit',
          detail: JSON.stringify({
            selector: 'form#login',
            action: '/login',
            method: 'POST',
            fields: [
              { name: 'username', type: 'text', value: 'alice' },
              { name: 'password', type: 'password', value: '[redacted password]' },
            ],
          }),
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings[0]?.confirmedByDom).toBe(true);
  });
});

describe('extractCredentials — Southwest-shaped synthetic fixture', () => {
  // Mirrors Southwest's recorded login POST shape without using any real
  // credential. The point is to prove the extractor recognises the
  // /api/security/v4/security/token URL + form-urlencoded body shape, not
  // to depend on a specific user's recording.
  const SYNTHETIC_USERNAME = 'fixture-user';
  const SYNTHETIC_PASSWORD = 'fixture-pass-with-@-and-digits-123';
  const session: Session = {
    site: 'southwest-shaped',
    startedAt: new Date().toISOString(),
    url: 'https://www.southwest.com/account',
    imprintVersion: '0.1.0',
    requests: [
      {
        seq: 277,
        timestamp: 5000,
        method: 'POST',
        url: 'https://www.southwest.com/api/security/v4/security/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `username=${SYNTHETIC_USERNAME}&password=${encodeURIComponent(SYNTHETIC_PASSWORD)}&scope=openid&response_type=id_token+swa_token&client_id=test-client-id`,
        resourceType: 'XHR',
      },
    ],
    events: [],
    narration: [],
    cookieSnapshots: [],
  };

  it('extracts the synthetic Southwest-style login pair', () => {
    const out = extractCredentials(session);
    expect(out.findings.length).toBeGreaterThan(0);

    const sw = out.findings.find((f) => f.requestLabel.includes('/api/security/v4/security/token'));
    expect(sw).toBeDefined();
    expect(sw?.usernameValue).toBe(SYNTHETIC_USERNAME);
    expect(sw?.passwordValue).toBe(SYNTHETIC_PASSWORD);

    const userR = out.replacements.find(
      (r) => r.requestSeq === sw?.requestSeq && r.placeholder === '${credential.username}',
    );
    const pwdR = out.replacements.find(
      (r) => r.requestSeq === sw?.requestSeq && r.placeholder === '${credential.password}',
    );
    expect(userR?.originalValue).toBe(SYNTHETIC_USERNAME);
    expect(pwdR?.originalValue).toBe(SYNTHETIC_PASSWORD);
  });
});
