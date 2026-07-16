/**
 * Redaction unit tests. Pure functions, no I/O.
 */

import { describe, expect, it } from 'bun:test';
import {
  detectPageMintedHeaders,
  redactBody,
  redactFormBody,
  redactHeaders,
  redactJsonBody,
  redactSession,
  redactUrl,
} from '../src/imprint/redact.ts';
import type { Session } from '../src/imprint/types.ts';

const syntheticJwt = (): string =>
  [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('.');

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
    const body = 'attractionId=7&color=blue&quantity=3';
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

  it('redacts free-form PII in string leaves without corrupting JSON', () => {
    const body = JSON.stringify({
      note: 'Email alice@example.com or call 555-123-4567',
      nested: { safe: 'version v1.2.3' },
    });
    const r = redactJsonBody(body);
    expect(r.freeformRedactions).toBeGreaterThanOrEqual(2);

    const parsed = JSON.parse(r.redacted);
    expect(parsed.note).not.toContain('alice@example.com');
    expect(parsed.note).not.toContain('555-123-4567');
    expect(parsed.nested.safe).toBe('version v1.2.3');
  });

  it('structurally redacts whitespace-prefixed JSON strings at every position', () => {
    const secret = 'fixture-secret-9472';
    const encoded = ` \n\t${JSON.stringify({ password: secret })}`;
    const bodies = [
      JSON.stringify(encoded),
      JSON.stringify({ value: encoded }),
      JSON.stringify([encoded]),
    ];

    for (const body of bodies) {
      const result = redactJsonBody(body, undefined, false, undefined, 64, {
        remaining: 32_768,
      });
      expect(result.redacted).not.toContain(secret);
      expect(result.redactionsCount).toBe(1);
    }
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query params', () => {
    const url = 'https://api.example.com/x?accessToken=abc&user=alice&apikey=xyz';
    const r = redactUrl(url);
    expect(r.redactionsCount).toBe(3);
    expect(r.redacted).not.toContain('user=alice');
    expect(r.redacted).not.toContain('accessToken=abc');
    expect(r.redacted).not.toContain('apikey=xyz');
  });

  it('returns url unchanged on malformed input', () => {
    const url = 'not a url';
    const r = redactUrl(url);
    expect(r.redacted).toBe(url);
    expect(r.redactionsCount).toBe(0);
  });

  it('redacts token-looking URL path segments while preserving origin and query', () => {
    const token = syntheticJwt();
    const r = redactUrl(`https://api.example.com/reset/${token}/done?color=blue`);

    expect(r.freeformRedactions).toBe(1);
    expect(r.redacted.startsWith('https://api.example.com/reset/')).toBe(true);
    expect(r.redacted).toContain('/done?color=blue');
    expect(r.redacted).not.toContain(token);
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
    expect(r.redacted.Cookie).toBe('session=[REDACTED:3]; csrf=[REDACTED:3]');
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

  it('redacts sensitive keys inside React Flight rows without corrupting framing', () => {
    const body = [
      '1:I[123,["chunk.js"],"module"]',
      '0:{"email":"person@example.com","password":"fixture-secret-9472","child":"$1"}',
      '2:T5,hello3:null',
      '',
    ].join('\n');
    const r = redactBody(body, 'text/x-component', undefined, undefined, false);

    expect(r.redactionsCount).toBe(2);
    expect(r.redacted).not.toContain('person@example.com');
    expect(r.redacted).not.toContain('fixture-secret-9472');
    expect(r.redacted).toContain('1:I[123,["chunk.js"],"module"]\n');
    expect(r.redacted).toContain('2:T5,hello3:null\n');
    expect(r.redacted).toContain('"child":"$1"');
  });

  it('redacts rendered PII in Flight JSON and byte-framed text rows', () => {
    const pii = 'person@example.com';
    const body = [
      `0:{"children":${JSON.stringify(pii)}}`,
      `1:T${Buffer.byteLength(pii).toString(16)},${pii}2:null`,
      '',
    ].join('\n');
    const r = redactBody(body, 'text/x-component', undefined, undefined, true);

    expect(r.redacted).not.toContain(pii);
    expect(r.freeformRedactions).toBe(2);
    const textRow = /1:T([0-9a-f]+),([^\n]+?)2:null/.exec(r.redacted);
    expect(textRow).not.toBeNull();
    if (!textRow?.[1] || textRow[2] === undefined) throw new Error('missing redacted T row');
    expect(Number.parseInt(textRow[1], 16)).toBe(Buffer.byteLength(textRow[2], 'utf8'));
  });

  it('redacts sensitive JSON encoded as a string inside a Flight array', () => {
    const secret = 'fixture-secret-9472';
    const body = `0:${JSON.stringify([`  ${JSON.stringify({ password: secret })}`])}\n`;
    const result = redactBody(body, 'text/x-component', undefined, undefined, true);

    expect(result.redacted).not.toContain(secret);
    expect(result.redacted).toContain('REDACTED');
    expect(result.redactionsCount).toBe(1);
  });

  it('preserves structured RPC envelopes encoded inside Flight strings', () => {
    const rpcPayload = JSON.stringify([['wrb.fr', 'rpc', '[\\"person@example.com\\"]']]);
    const envelopes = [`)]}'\n${rpcPayload}`, `${Buffer.byteLength(rpcPayload)}\n${rpcPayload}`];
    const body = `0:${JSON.stringify(envelopes)}\n`;
    const result = redactBody(body, 'text/x-component', undefined, undefined, true);

    expect(JSON.parse(result.redacted.slice(2).trim())).toEqual(envelopes);
    expect(result.freeformRedactions).toBe(0);
  });

  it('fails closed for a truncated Flight body', () => {
    const body = '0:{"children":"person@example.com"}';
    const r = redactBody(body, 'text/x-component', undefined, undefined, true);

    expect(r.redacted).toMatch(/^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/);
    expect(r.redacted).not.toContain('person@example.com');
    expect(r.redactionsCount).toBe(1);
  });

  it('redacts Flight resource hints and fails closed on unsupported binary rows', () => {
    const hintBody = [':HL["mailto:person@example.com","style"]', '0:{"children":"safe"}', ''].join(
      '\n',
    );
    const hint = redactBody(hintBody, 'text/x-component', undefined, undefined, true);
    expect(hint.redacted).not.toContain('person@example.com');
    expect(hint.freeformRedactions).toBe(1);

    const binaryBody = ['0:{"children":"safe"}', '1:o12,person@example.com', ''].join('\n');
    const binary = redactBody(binaryBody, 'text/x-component', undefined, undefined, true);
    expect(binary.redacted).toMatch(/^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/);
    expect(binary.redacted).not.toContain('person@example.com');
  });

  it('fails closed instead of overflowing on deeply nested Flight JSON', () => {
    const body = `0:${'['.repeat(500_000)}"person@example.com"${']'.repeat(500_000)}\n`;
    const startedAt = performance.now();
    expect(() => redactBody(body, 'text/x-component', undefined, undefined, true)).not.toThrow();
    expect(redactBody(body, 'text/x-component', undefined, undefined, true).redacted).toMatch(
      /^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('fails closed when tiny Flight rows exceed the shared metadata budget', () => {
    const rows: string[] = [];
    for (let index = 0; index < 17_000; index++) rows.push(`${index.toString(16)}:null`);
    const result = redactBody(
      `${rows.join('\n')}\n`,
      'text/x-component',
      undefined,
      undefined,
      true,
    );

    expect(result.redacted).toMatch(/^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/);
  });

  it('fails closed before parsing a single excessively wide Flight JSON row', () => {
    const body = `0:{"items":[${Array.from({ length: 40_000 }, () => '0').join(',')}]}\n`;
    const result = redactBody(body, 'text/x-component', undefined, undefined, true);
    expect(result.redacted).toMatch(/^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/);
  });

  it('does not count brackets inside Flight JSON strings toward the nesting limit', () => {
    const body = `0:${JSON.stringify({ text: `literal ${'['.repeat(1_000)}` })}\n`;
    expect(redactBody(body, 'text/x-component', undefined, undefined, false).redacted).toBe(body);
  });

  it('fails closed on deeply nested JSON encoded inside a Flight string', () => {
    const encoded = `${'['.repeat(20_000)}"person@example.com"${']'.repeat(20_000)}`;
    const body = `0:${JSON.stringify({ blob: encoded })}\n`;
    const startedAt = performance.now();
    const result = redactBody(body, 'text/x-component', undefined, undefined, true);

    expect(result.redacted).toMatch(/^\[REDACTED:UNSAFE_FLIGHT_BODY:\d+\]$/);
    expect(result.redacted).not.toContain('person@example.com');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('bounds traversal across shallow JSON-in-JSON layers', () => {
    let encoded = JSON.stringify({ password: 'fixture-secret-9472' });
    for (let index = 0; index < 10; index++) encoded = JSON.stringify([encoded]);

    expect(() =>
      redactJsonBody(encoded, undefined, true, undefined, 8, { remaining: 32_768 }),
    ).toThrow('JSON traversal depth exceeds redaction budget');
  });

  it('falls back to form parsing when content-type is missing but body looks form-encoded', () => {
    const r = redactBody('password=secret&name=alice');
    expect(r.redactionsCount).toBe(1);
  });

  it('redacts free-form PII and secrets in text bodies', () => {
    const jwt = syntheticJwt();
    const apiKeyLine = ['api_key: ', '1234567890abcdefghij.'].join('');
    const body = [
      'Contact alice@example.com or 555-123-4567.',
      'SSN 123-45-6789 card 4111 1111 1111 1111.',
      `Authorization: Bearer ${jwt}.`,
      apiKeyLine,
      'DATABASE_URL=postgres://user:pass@localhost:5432/app.',
    ].join(' ');
    const r = redactBody(body, 'text/plain');

    expect(r.freeformRedactions).toBeGreaterThanOrEqual(7);
    expect(r.redacted).not.toContain('alice@example.com');
    expect(r.redacted).not.toContain('555-123-4567');
    expect(r.redacted).not.toContain('123-45-6789');
    expect(r.redacted).not.toContain('4111 1111 1111 1111');
    expect(r.redacted).not.toContain(jwt);
    expect(r.redacted).not.toContain('1234567890abcdefghij');
    expect(r.redacted).not.toContain('user:pass');
  });

  it('does not redact common non-secret identifiers', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const commit = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const body = [
      'version v1.2.3',
      'request req-12345',
      `uuid ${uuid}`,
      `commit ${commit}`,
      'zip 94107',
      'normal url https://example.com/api/v1/users',
    ].join(' ');
    const r = redactBody(body, 'text/plain');

    expect(r.freeformRedactions).toBe(0);
    expect(r.redacted).toBe(body);
  });
});

describe('redactBody — structured RPC envelopes', () => {
  // Google batchexecute style: )]}' anti-XSSI guard + length-prefixed frame, where
  // a wrb.fr row's element[2] is a doubly-encoded JSON string packed with bare
  // numeric IDs. Flat-scanning this as text used to inject [REDACTED] mid-number
  // and break the inner JSON; the envelope guard must leave it byte-identical.
  const innerPayload = JSON.stringify([[null, [[1777892713752929, 16324447, 2805147253]]]]);
  const frame = JSON.stringify([['wrb.fr', null, innerPayload]]);
  const xssiBody = `)]}'\n\n${frame.length}\n${frame}`;

  it('leaves an XSSI-guarded envelope untouched even with freeform on', () => {
    const r = redactBody(xssiBody, 'application/json', undefined, undefined, true, undefined);
    expect(r.freeformRedactions).toBe(0);
    expect(r.redacted).toBe(xssiBody);
    expect(r.redacted).not.toContain('[REDACTED]');
    // The inner doubly-encoded payload still parses with its IDs intact.
    const rows = JSON.parse(r.redacted.slice(r.redacted.indexOf('[')));
    const inner = JSON.parse(rows[0][2]);
    expect(inner[0][1][0][0]).toBe(1777892713752929);
  });

  it('leaves a length-prefixed (non-guarded) frame untouched', () => {
    const body = `${frame.length}\n${frame}`;
    const r = redactBody(body, 'application/json', undefined, undefined, true, undefined);
    expect(r.freeformRedactions).toBe(0);
    expect(r.redacted).toBe(body);
  });

  it('leaves a while(1); XSSI-guarded envelope untouched', () => {
    const body = `while(1);${frame}`;
    const r = redactBody(body, 'application/json', undefined, undefined, true, undefined);
    expect(r.freeformRedactions).toBe(0);
    expect(r.redacted).toBe(body);
    expect(r.redacted).not.toContain('[REDACTED]');
  });

  it('leaves a for(;;); XSSI-guarded envelope untouched', () => {
    const body = `for(;;);${frame}`;
    const r = redactBody(body, 'application/json', undefined, undefined, true, undefined);
    expect(r.freeformRedactions).toBe(0);
    expect(r.redacted).toBe(body);
    expect(r.redacted).not.toContain('[REDACTED]');
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
    storageSnapshots: [],
  };

  it('redacts token-bearing Flight hints end to end', () => {
    const original = baseSession.requests[0];
    if (!original) throw new Error('missing base request');
    const flightSession: Session = {
      ...baseSession,
      requests: [
        {
          ...original,
          response: {
            status: 200,
            headers: { 'content-type': 'text/x-component' },
            mimeType: 'text/x-component',
            body: ':HL["mailto:person@example.com","style"]\n0:{"children":"safe"}\n',
          },
        },
      ],
    };
    const { session } = redactSession(flightSession);
    expect(session.requests[0]?.response?.body).not.toContain('person@example.com');
  });

  it('scrubs request bodies, headers, and cookies when redactSensitiveHeaders is on', () => {
    const { session, stats } = redactSession(baseSession, { redactSensitiveHeaders: true });

    expect(stats.totalRedactions).toBeGreaterThan(0);
    expect(stats.cookiesRedacted).toBe(1);

    const req = session.requests[0];
    expect(req).toBeDefined();
    if (!req) return;
    expect(req.body).not.toContain('hunter2');
    expect(req.body).not.toContain('user=alice'); // user is now sensitive
    expect(req.headers.Cookie).toMatch(/^session=\[REDACTED:v3:id=\d+:len=3\]$/);
    expect(req.response?.headers['Set-Cookie']).toMatch(/^session=\[REDACTED:v3:id=\d+:len=8\]$/);

    const snap = session.cookieSnapshots[0];
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.cookies[0]?.value).toMatch(/^\[REDACTED:v3:id=\d+:len=16\]$/);
    expect(snap.cookies[0]?.name).toBe('session'); // names kept
    expect(snap.cookies[0]?.domain).toBe('.example.com');
  });

  it('keeps sensitive request/response headers VISIBLE by default (redaction gate off)', () => {
    // The compile agent must see auth/session/gateway header values to wire them
    // as contracted inputs. The default no longer blinds it. Credential
    // placeholdering still runs (verified separately).
    const { session } = redactSession(baseSession);
    const req = session.requests[0];
    expect(req).toBeDefined();
    if (!req) return;
    expect(req.headers.Cookie).toBe('session=abc');
    expect(req.response?.headers['Set-Cookie']).toBe('session=newvalue');
  });

  it('re-enables sensitive-header redaction via IMPRINT_REDACT_SENSITIVE_HEADERS=1', () => {
    const prev = process.env.IMPRINT_REDACT_SENSITIVE_HEADERS;
    process.env.IMPRINT_REDACT_SENSITIVE_HEADERS = '1';
    try {
      const { session } = redactSession(baseSession);
      const req = session.requests[0];
      expect(req).toBeDefined();
      if (!req) return;
      expect(req.headers.Cookie).toMatch(/^session=\[REDACTED:v3:id=\d+:len=3\]$/);
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: env cleanup requires delete
        delete process.env.IMPRINT_REDACT_SENSITIVE_HEADERS;
      } else {
        process.env.IMPRINT_REDACT_SENSITIVE_HEADERS = prev;
      }
    }
  });

  it('preserves the rest of the session shape', () => {
    const { session } = redactSession(baseSession);
    expect(session.site).toBe('test');
    expect(session.url).toBe('https://example.com/');
    expect(session.requests.length).toBe(1);
  });

  it('redacts response bodies key-based only (no freeform), but still scans request bodies', () => {
    const session: Session = {
      ...baseSession,
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'reach me at alice@example.com' }),
          resourceType: 'XHR',
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: JSON.stringify({
              note: 'reach me at bob@example.com',
              access_token: 'sk-secret-xyz',
            }),
          },
        },
      ],
      cookieSnapshots: [],
    };
    const { session: out } = redactSession(session);
    const req = out.requests[0];
    expect(req).toBeDefined();
    if (!req) return;

    // Request side: user-entered PII is still value-pattern (freeform) redacted.
    expect(req.body).not.toContain('alice@example.com');

    // Response side: PII under a NON-sensitive key survives (freeform off),
    // but a sensitive KEY is still redacted by key-based redaction.
    const respParsed = JSON.parse(req.response?.body ?? '{}');
    expect(respParsed.note).toContain('bob@example.com');
    expect(respParsed.access_token).toMatch(/^\[REDACTED:v3:id=\d+:len=\d+\]$/);
  });

  it('rewrites credential values to ${credential.X} placeholders when given replacements', () => {
    const { session, stats } = redactSession(baseSession, {
      replacements: [
        {
          requestSeq: 0,
          location: { kind: 'body-form', key: 'password' },
          originalValue: 'hunter2',
          placeholder: '${credential.password}',
        },
        {
          requestSeq: 0,
          location: { kind: 'body-form', key: 'user' },
          originalValue: 'alice',
          placeholder: '${credential.username}',
        },
      ],
    });

    const req = session.requests[0];
    expect(req).toBeDefined();
    if (!req) return;
    expect(req.body).toContain('password=${credential.password}');
    expect(req.body).toContain('user=${credential.username}');
    expect(req.body).not.toContain('hunter2');
    expect(req.body).not.toContain('alice');
    expect(stats.placeholdersInjected).toBeGreaterThanOrEqual(2);
  });

  it('placeholders for json bodies are addressed by dot-path', () => {
    const session: Session = {
      ...baseSession,
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: { username: 'alice', password: 'hunter2' } }),
          resourceType: 'XHR',
        },
      ],
    };
    const { session: out } = redactSession(session, {
      replacements: [
        {
          requestSeq: 0,
          location: { kind: 'body-json', path: ['login', 'username'] },
          originalValue: 'alice',
          placeholder: '${credential.username}',
        },
        {
          requestSeq: 0,
          location: { kind: 'body-json', path: ['login', 'password'] },
          originalValue: 'hunter2',
          placeholder: '${credential.password}',
        },
      ],
    });
    const body = out.requests[0]?.body ?? '';
    expect(body).toContain('${credential.username}');
    expect(body).toContain('${credential.password}');
    expect(body).not.toContain('alice');
    expect(body).not.toContain('hunter2');
  });

  it('redacts captured WebSocket payload previews', () => {
    const session: Session = {
      ...baseSession,
      requests: [],
      events: [
        {
          seq: 1,
          timestamp: 150,
          type: 'ws-received',
          detail: JSON.stringify({
            url: 'wss://example.com/socket',
            opcode: 1,
            payloadDataPreview: 'support email alice@example.com',
          }),
        },
      ],
      cookieSnapshots: [],
    };
    const { session: out, stats } = redactSession(session);

    expect(stats.freeformRedactions).toBe(1);
    expect(out.events[0]?.detail).not.toContain('alice@example.com');
  });

  it('keeps credential placeholders ahead of generic free-form redaction', () => {
    const session: Session = {
      ...baseSession,
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            login: { username: 'alice@example.com', password: 'hunter2' },
          }),
          resourceType: 'XHR',
        },
      ],
      cookieSnapshots: [],
    };
    const { session: out } = redactSession(session, {
      replacements: [
        {
          requestSeq: 0,
          location: { kind: 'body-json', path: ['login', 'username'] },
          originalValue: 'alice@example.com',
          placeholder: '${credential.username}',
        },
        {
          requestSeq: 0,
          location: { kind: 'body-json', path: ['login', 'password'] },
          originalValue: 'hunter2',
          placeholder: '${credential.password}',
        },
      ],
    });

    const body = out.requests[0]?.body ?? '';
    expect(body).toContain('${credential.username}');
    expect(body).toContain('${credential.password}');
    expect(body).not.toContain('alice@example.com');
    expect(body).not.toContain('[REDACTED]');
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
