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
    storageSnapshots: [],
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

describe('extractCredentials — userid / loginid variants', () => {
  it('finds userid + password in form-encoded body', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/auth',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'userid=fixture-user&password=fixture-pass-9472',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-9472');
    expect(out.replacements).toHaveLength(2);
  });

  it('finds user_id + password in JSON body', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_id: 'fixture-user', password: 'fixture-pass-9472' }),
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-9472');
  });

  it('finds loginid + pwd in form-encoded body', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'loginid=fixture-user&pwd=fixture-pass-9472&remember=1',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-9472');
  });
});

describe('extractCredentials — body-shape-agnostic dispatch', () => {
  it('finds credentials in a JSON body even when Content-Type is text/plain', () => {
    // Synthetic Nextep-shaped body: JSON, nested under a key, with an
    // embedded URL containing `=`. Content-Type is text/plain — the bug
    // before the fix sent this down the form-urlencoded path and missed
    // the credential pair entirely.
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/execute',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({
            authcode: 'fixture-token-uuid',
            name: 'LOGIN',
            locationid: 'STORE01',
            LOGIN: {
              userid: 'fixture-user@example.com',
              password: 'fixture-pass-9472',
              context: 'mobileWeb',
              url: 'https://example.com/cmp/?storeid=STORE01',
            },
          }),
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user@example.com');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-9472');
    expect(out.replacements[0]?.location.kind).toBe('body-json');
  });

  it('finds credentials in a JSON body with NO Content-Type header at all', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: {},
          body: JSON.stringify({ username: 'fixture-user', password: 'fixture-pass' }),
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
  });

  it('finds credentials in a form body even when Content-Type lies as application/json', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/json' }, // wrong on purpose
          body: 'username=fixture-user&password=fixture-pass-9472&remember=1',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-9472');
  });

  it('finds credentials in a multipart/form-data body', () => {
    const boundary = '----WebKitFormBoundaryFixture123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="username"',
      '',
      'fixture-user',
      `--${boundary}`,
      'Content-Disposition: form-data; name="password"',
      '',
      'fixture-pass-multipart',
      `--${boundary}`,
      'Content-Disposition: form-data; name="csrf_token"',
      '',
      'csrf-token-value',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-multipart');
  });

  it('finds credentials wrapped in a form field (payload={…})', () => {
    const inner = JSON.stringify({ username: 'fixture-user', password: 'fixture-pass-wrap' });
    const body = `payload=${encodeURIComponent(inner)}&action=login`;
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-wrap');
  });

  it('finds credentials in the URL query string for a GET-based login', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://legacy.example.com/cgi/login?username=fixture-user&password=fixture-pass-qs&next=/home',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-qs');
  });

  it('finds OAuth ROPC credentials (grant_type=password, username, password)', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://auth.example.com/oauth/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body:
            'grant_type=password' +
            '&username=fixture-user' +
            '&password=fixture-pass-ropc' +
            '&client_id=test-client' +
            '&scope=openid',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-ropc');
  });

  it('finds Java EE / Spring Security form-login fields (j_username + j_password)', () => {
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://j2ee.example.com/j_security_check',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'j_username=fixture-user&j_password=fixture-pass-jee',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.usernameValue).toBe('fixture-user');
    expect(out.findings[0]?.passwordValue).toBe('fixture-pass-jee');
  });

  it('does NOT match an OAuth client-credentials body (client_id only, no password)', () => {
    // Defense against false positives from the broadened username dict —
    // client_credentials grant has no real password partner.
    const session: Session = {
      ...emptySession(),
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://auth.example.com/oauth/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body:
            'grant_type=client_credentials' +
            '&client_id=test-client-id' +
            '&client_secret=test-client-secret-value',
          resourceType: 'XHR',
        },
      ],
    };
    const out = extractCredentials(session);
    // `client_secret` matches PASSWORD_LIKE_KEYS (`secret`)... actually
    // `client_secret` normalizes to `clientsecret` which is NOT in the set.
    // So no password match → no findings. Asserting this so a future
    // dictionary tweak that adds `clientsecret` doesn't silently start
    // pairing client_id+client_secret as a login pair.
    expect(out.findings).toEqual([]);
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
    storageSnapshots: [],
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
