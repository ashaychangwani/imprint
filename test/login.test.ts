import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCredentials } from '../src/imprint/login.ts';
import type { Session } from '../src/imprint/types.ts';

/**
 * `imprint login` credential extraction is GENERIC: it resolves each site's
 * request captures named by `authConfig.persist` (read from the site's compiled
 * workflow.json) against the recorded login response — there is no per-site
 * code. These tests prove the two shapes the old hardcoded extractors handled
 * (Discover & Go nested keys, Southwest dotted top-level keys) reproduce the
 * exact credential slot names via declarations alone.
 */

let home: string;
const originalImprintHome = process.env.IMPRINT_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'imprint-login-test-'));
  process.env.IMPRINT_HOME = home;
});

afterEach(() => {
  if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
  else process.env.IMPRINT_HOME = originalImprintHome;
  rmSync(home, { recursive: true, force: true });
});

function writeWorkflow(
  site: string,
  tool: string,
  captures: unknown[],
  persist = captures.map((capture) => (capture as { name: string }).name),
): void {
  const dir = join(home, site, tool);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workflow.json'),
    JSON.stringify({
      toolName: tool,
      intent: { description: 'test tool' },
      parameters: [],
      requests: [{ method: 'POST', url: 'https://example.test/login', headers: {}, captures }],
      toolKind: 'authenticate',
      authConfig: {
        entry: 'authenticate',
        actions: {
          authenticate: {
            parameters: [],
            steps: [{ request: 0, onError: 'fail' }],
            outcome: { type: 'success', evidence: [] },
          },
        },
        persist,
        crossOriginCookieReinjection: false,
      },
      site,
    }),
  );
}

function sessionWithLoginResponse(body: string): Session {
  return {
    requests: [
      {
        method: 'GET',
        url: 'https://example.test/page',
        headers: {},
        response: { status: 200, headers: {}, mimeType: 'text/html', body: '<html></html>' },
      },
      {
        method: 'POST',
        url: 'https://example.test/login',
        headers: {},
        response: { status: 200, headers: {}, mimeType: 'application/json', body },
      },
    ],
    events: [],
  } as unknown as Session;
}

describe('extractCredentials (generic persisted-capture resolver)', () => {
  it('resolves Discover & Go nested-key shape into the exact credential slots', () => {
    writeWorkflow('discoverandgo', 'book_pass', [
      { name: 'patron_id', source: 'json', path: 'patronID' },
      { name: 'session_id', source: 'json', path: 'session' },
      { name: 'patron_email', source: 'json', path: 'patronEmail' },
    ]);
    const session = sessionWithLoginResponse(
      JSON.stringify({ patronID: 'P123', session: 'S456', patronEmail: 'bob@example.com' }),
    );

    expect(extractCredentials('discoverandgo', session)).toEqual({
      patron_id: 'P123',
      session_id: 'S456',
      patron_email: 'bob@example.com',
    });
  });

  it('resolves Southwest dotted top-level keys via bracketed paths', () => {
    writeWorkflow('southwest', 'account', [
      {
        name: 'account_number',
        source: 'json',
        path: '[customers.userInformation.accountNumber]',
      },
      { name: 'primary_email', source: 'json', path: '[customers.userInformation.primaryEmail]' },
    ]);
    const session = sessionWithLoginResponse(
      JSON.stringify({
        'customers.userInformation.accountNumber': 'ACC999',
        'customers.userInformation.primaryEmail': 'sw@example.com',
      }),
    );

    expect(extractCredentials('southwest', session)).toEqual({
      account_number: 'ACC999',
      primary_email: 'sw@example.com',
    });
  });

  it('resolves a response_header capture', () => {
    writeWorkflow('acme', 'tool', [
      { name: 'csrf', source: 'response_header', header: 'x-csrf-token' },
    ]);
    const session: Session = {
      requests: [
        {
          method: 'POST',
          url: 'https://acme.test/login',
          headers: {},
          response: {
            status: 200,
            headers: { 'x-csrf-token': 'tok-789' },
            mimeType: 'application/json',
            body: '{}',
          },
        },
      ],
      events: [],
    } as unknown as Session;

    expect(extractCredentials('acme', session)).toEqual({ csrf: 'tok-789' });
  });

  it('returns nothing when the site declares no captures (no per-site fallback)', () => {
    writeWorkflow('plainsite', 'tool', []);
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('plainsite', session)).toEqual({});
  });

  it('returns nothing when the site has no compiled tools at all', () => {
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('unknownsite', session)).toEqual({});
  });

  it('skips a capture whose value is absent from every response', () => {
    writeWorkflow(
      'acme',
      'tool',
      [
        { name: 'patron_id', source: 'json', path: 'patronID' },
        { name: 'missing', source: 'json', path: 'nope' },
      ],
      ['patron_id', 'missing'],
    );
    const session = sessionWithLoginResponse(JSON.stringify({ patronID: 'P123' }));
    expect(extractCredentials('acme', session)).toEqual({ patron_id: 'P123' });
  });
});
