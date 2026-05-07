/**
 * Credential extraction tests. Real e2e against the southwest-seats fixture
 * when present (per saved feedback memory: prefer real fixtures over synthetic
 * mocks); falls back to synthetic sessions otherwise.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { extractCredentials, parseFormBody } from '../src/imprint/credential-extract.ts';
import { type Session, SessionSchema } from '../src/imprint/types.ts';

const SOUTHWEST_FIXTURE =
  '/Users/ashaychangwani/Desktop/repos/imprint/examples/southwest-seats/sessions/2026-05-06T07-20-10-599Z.json';

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
    const pairs = parseFormBody('username=ashaychangwani&password=REDACTED-PASSWORD');
    expect(pairs).toEqual([
      { key: 'username', value: 'ashaychangwani' },
      { key: 'password', value: 'REDACTED-PASSWORD' },
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

describe('extractCredentials — real southwest-seats fixture', () => {
  if (!existsSync(SOUTHWEST_FIXTURE)) {
    it.skip('fixture not present at expected path', () => {});
    return;
  }

  it('extracts the southwest login pair from the recorded session', () => {
    const raw = JSON.parse(readFileSync(SOUTHWEST_FIXTURE, 'utf8'));
    const session = SessionSchema.parse(raw);

    const out = extractCredentials(session);
    expect(out.findings.length).toBeGreaterThan(0);

    const sw = out.findings.find((f) => f.requestLabel.includes('/api/security/v4/security/token'));
    expect(sw).toBeDefined();
    expect(sw?.usernameValue).toBe('ashaychangwani');
    expect(sw?.passwordValue).toBe('REDACTED-PASSWORD');

    // Replacements line up with the finding.
    const userR = out.replacements.find(
      (r) => r.requestSeq === sw?.requestSeq && r.placeholder === '${credential.username}',
    );
    const pwdR = out.replacements.find(
      (r) => r.requestSeq === sw?.requestSeq && r.placeholder === '${credential.password}',
    );
    expect(userR?.originalValue).toBe('ashaychangwani');
    expect(pwdR?.originalValue).toBe('REDACTED-PASSWORD');
  });
});
