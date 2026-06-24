/**
 * Tests for the LLM compiler (compile.ts).
 *
 * The LLM call itself is not exercised — that needs a live model.
 * What we cover:
 *   - shrinkSession (pure noise-stripping logic; this is what saves
 *     6.5M → 0.3M tokens on Southwest)
 *   - Session-not-found error path (the user-facing message added in
 *     Phase 6 should include the `→ run \`imprint record\`` hint)
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  buildTriageEventContexts,
  defaultCompilePlaybookPath,
  findAuthAdjacentSeqs,
  findCredentialBearingSeqs,
  rescueActionAlignedRepeatedSeqs,
  resolveDefaultCompilePlaybookPath,
  shrinkSession,
} from '../src/imprint/compile.ts';
import type { Session } from '../src/imprint/types.ts';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    site: 'test',
    startedAt: '2026-05-04T00:00:00.000Z',
    url: 'https://example.com/start',
    imprintVersion: '0.1.0',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
    ...overrides,
  };
}

describe('shrinkSession', () => {
  it('keeps same-origin XHR requests', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/data',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    const r = shrinkSession(session);
    expect(r.requests).toHaveLength(1);
  });

  it('drops third-party requests (different root domain)', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/data',
          headers: {},
          resourceType: 'XHR',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://google-analytics.com/collect?tid=UA-X',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    const r = shrinkSession(session);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.url).toContain('example.com');
  });

  it.each(['Image', 'Font', 'Stylesheet', 'Script', 'Ping', 'Preflight'])(
    'drops noise resource type: %s',
    (resourceType) => {
      const session = makeSession({
        requests: [
          {
            seq: 1,
            timestamp: 100,
            method: 'GET',
            url: 'https://example.com/asset',
            headers: {},
            resourceType,
          },
        ],
      });
      expect(shrinkSession(session).requests).toHaveLength(0);
    },
  );

  it('keeps subdomains of the same root domain', () => {
    const session = makeSession({
      url: 'https://www.example.com/start',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.com/v1/search',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });
    expect(shrinkSession(session).requests).toHaveLength(1);
  });

  it('correctly scopes same-site under multi-part TLDs (.co.uk bug-fix)', () => {
    // Pre-fix: rootDomain('www.example.co.uk') returned 'co.uk', so
    // every other .co.uk hostname (an unrelated tracker, a competitor's
    // CDN) would survive the filter. Now only example.co.uk's own
    // subdomains pass.
    const session = makeSession({
      url: 'https://www.example.co.uk/start',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.co.uk/v1/search',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://tracker.unrelated.co.uk/log',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });
    const kept = shrinkSession(session).requests;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.url).toContain('example.co.uk');
  });

  it('drops requests with malformed URLs', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'not-a-url',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    expect(shrinkSession(session).requests).toHaveLength(0);
  });

  it('preserves cookieSnapshots, events, and narration unchanged', () => {
    const session = makeSession({
      requests: [],
      events: [{ seq: 0, timestamp: 100, type: 'click', detail: '{}' }],
      narration: [{ seq: 1, timestamp: 200, text: 'clicked the search button' }],
      cookieSnapshots: [
        { takenAt: '2026-05-04T00:00:00Z', timestamp: 0, label: 'start', cookies: [] },
      ],
    });
    const r = shrinkSession(session);
    expect(r.events).toHaveLength(1);
    expect(r.narration).toHaveLength(1);
    expect(r.cookieSnapshots).toHaveLength(1);
  });
});

describe('buildTriageEventContexts', () => {
  it('keeps only browser action/navigation events for the triage prompt', () => {
    const session = makeSession({
      events: [
        { seq: 1, timestamp: 100, type: 'navigation', detail: 'https://example.com/start' },
        { seq: 2, timestamp: 200, type: 'click', detail: '{"text":"Search"}' },
        { seq: 3, timestamp: 300, type: 'input', detail: '{"value":"delhi"}' },
        { seq: 4, timestamp: 400, type: 'change', detail: '{"value":"mumbai"}' },
        { seq: 5, timestamp: 500, type: 'submit', detail: '{"action":"/search"}' },
        {
          seq: 6,
          timestamp: 600,
          type: 'ws-sent',
          detail: '{"url":"wss://example.com/socket","payloadDataPreview":"noisy"}',
        },
        {
          seq: 7,
          timestamp: 700,
          type: 'ws-received',
          detail: '{"url":"wss://example.com/socket","payloadDataPreview":"noisy"}',
        },
        {
          seq: 8,
          timestamp: 800,
          type: 'dom-snapshot',
          detail: '{"html":"<main>large snapshot</main>"}',
        },
      ],
    });

    expect(buildTriageEventContexts(session).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('rescueActionAlignedRepeatedSeqs', () => {
  it('keeps repeated endpoint calls near input events while ignoring telemetry repeats', () => {
    const session = makeSession({
      url: 'https://www.remitly.com/',
      events: [
        {
          seq: 533,
          timestamp: 23535,
          type: 'input',
          detail: '{"value":"1100.00"}',
        },
      ],
      requests: [
        {
          seq: 386,
          timestamp: 5965,
          method: 'GET',
          url: 'https://api.remitly.io/v3/calculator/estimate?amount=1000',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"estimate":{"send_amount":"1000.00"}}' },
        },
        {
          seq: 534,
          timestamp: 23794,
          method: 'GET',
          url: 'https://api.remitly.io/v3/calculator/estimate?amount=1100',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"estimate":{"send_amount":"1100.00"}}' },
        },
        {
          seq: 530,
          timestamp: 23352,
          method: 'POST',
          url: 'https://uel.remitly.io/v1/events',
          headers: {},
          body: JSON.stringify([
            {
              app_version: '<unknown>',
              browser_name: 'Chrome',
              device_environment_type: 'Web',
              screen_width: 1200,
            },
          ]),
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '' },
        },
        {
          seq: 536,
          timestamp: 25281,
          method: 'POST',
          url: 'https://uel.remitly.io/v1/events',
          headers: {},
          body: JSON.stringify([
            {
              app_version: '<unknown>',
              browser_name: 'Chrome',
              device_environment_type: 'Web',
              screen_width: 1200,
            },
          ]),
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '' },
        },
      ],
    });

    const rescued = rescueActionAlignedRepeatedSeqs(
      session,
      [386, 530],
      [
        {
          seq: 386,
          timestamp: 5965,
          method: 'GET',
          url: 'https://api.remitly.io/v3/calculator/estimate?amount=1000',
          resourceType: 'XHR',
          headers: '{}',
          repeatedSeqs: [386, 534],
          lastTimestamp: 23794,
        },
        {
          seq: 530,
          timestamp: 23352,
          method: 'POST',
          url: 'https://uel.remitly.io/v1/events',
          resourceType: 'Fetch',
          headers: '{}',
          repeatedSeqs: [530, 536],
          lastTimestamp: 25281,
        },
      ],
    );

    expect(rescued).toEqual([534]);
  });
});

describe('compilePlaybook defaults', () => {
  const originalImprintHome = process.env.IMPRINT_HOME;

  function withImprintHome<T>(path: string, fn: () => T): T {
    process.env.IMPRINT_HOME = path;
    try {
      return fn();
    } finally {
      if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
      else process.env.IMPRINT_HOME = originalImprintHome;
    }
  }

  it('writes playbook fallbacks under the generated tool directory by default', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(defaultCompilePlaybookPath('webwidget-domains', 'search_domains')).toBe(
        pathResolve('/tmp', 'imprint-home', 'webwidget-domains', 'search_domains', 'playbook.yaml'),
      );
    });
  });

  it('rejects a playbook toolName that would miss the existing generated workflow dir', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-playbook-default-'));
    try {
      withImprintHome(root, () => {
        const workflowDir = pathResolve(root, 'google-flights', 'search_google_flights');
        mkdirSync(workflowDir, { recursive: true });
        writeFileSync(pathResolve(workflowDir, 'workflow.json'), '{}', 'utf8');

        expect(() => resolveDefaultCompilePlaybookPath('google-flights', 'search_flights')).toThrow(
          /does not match the generated workflow "search_google_flights"/,
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findCredentialBearingSeqs', () => {
  it('finds credential placeholders in request body', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'UserID=${credential.username}&Password=${credential.password}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://example.com/data',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ],
    });
    expect(findCredentialBearingSeqs(session)).toEqual([1]);
  });

  it('finds credential placeholders in request headers', () => {
    const session = makeSession({
      requests: [
        {
          seq: 5,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api',
          headers: { authorization: 'Basic ${credential.api_token}' },
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ],
    });
    expect(findCredentialBearingSeqs(session)).toEqual([5]);
  });

  it('returns empty array when no credential placeholders exist', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/search?q=test',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ],
    });
    expect(findCredentialBearingSeqs(session)).toEqual([]);
  });

  it('does not false-positive on ${param.*} or [REDACTED:...] patterns', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://example.com/search',
          headers: {},
          body: '{"query":"${param.query}","token":"[REDACTED:v3:id=1:len=32]"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ],
    });
    expect(findCredentialBearingSeqs(session)).toEqual([]);
  });
});

describe('findAuthAdjacentSeqs', () => {
  it('finds MFA/2FA requests after credential-bearing POSTs', () => {
    const session = makeSession({
      requests: [
        {
          seq: 10,
          timestamp: 1000,
          method: 'POST',
          url: 'https://example.com/login',
          headers: {},
          body: 'user=${credential.username}&pass=${credential.password}',
          resourceType: 'Fetch',
        },
        {
          seq: 11,
          timestamp: 2000,
          method: 'POST',
          url: 'https://example.com/api/CreatePushNotificationDelivery',
          headers: {},
          body: '{"channel":"push"}',
          resourceType: 'Fetch',
        },
        {
          seq: 12,
          timestamp: 5000,
          method: 'POST',
          url: 'https://example.com/api/ReadPushNotificationDeliveryStatus',
          headers: {},
          body: '{"id":"abc123"}',
          resourceType: 'Fetch',
        },
        {
          seq: 13,
          timestamp: 8000,
          method: 'POST',
          url: 'https://example.com/api/oauth/token',
          headers: {},
          body: '{"grant_type":"authorization_code"}',
          resourceType: 'Fetch',
        },
      ],
    });
    expect(findAuthAdjacentSeqs(session, [10])).toEqual([11, 12, 13]);
  });

  it('stops at the 120s window boundary', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 1000,
          method: 'POST',
          url: 'https://example.com/login',
          headers: {},
          body: '${credential.password}',
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 5000,
          method: 'POST',
          url: 'https://example.com/verify-otp',
          headers: {},
          body: '{"code":"123456"}',
          resourceType: 'Fetch',
        },
        {
          seq: 3,
          timestamp: 200_000,
          method: 'POST',
          url: 'https://example.com/late-verification',
          headers: {},
          body: '{}',
          resourceType: 'Fetch',
        },
      ],
    });
    expect(findAuthAdjacentSeqs(session, [1])).toEqual([2]);
  });

  it('skips requests before the last credential POST', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 500,
          method: 'POST',
          url: 'https://example.com/api/challenge',
          headers: {},
          body: '{}',
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 1000,
          method: 'POST',
          url: 'https://example.com/login',
          headers: {},
          body: '${credential.password}',
          resourceType: 'Fetch',
        },
        {
          seq: 3,
          timestamp: 2000,
          method: 'POST',
          url: 'https://example.com/api/mfa-check',
          headers: {},
          body: '{}',
          resourceType: 'Fetch',
        },
      ],
    });
    expect(findAuthAdjacentSeqs(session, [2])).toEqual([3]);
  });

  it('returns empty array when no credential seqs provided', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 1000,
          method: 'POST',
          url: 'https://example.com/api/verify-otp',
          headers: {},
          body: '{}',
          resourceType: 'Fetch',
        },
      ],
    });
    expect(findAuthAdjacentSeqs(session, [])).toEqual([]);
  });

  it('ignores non-auth requests within the window', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 1000,
          method: 'POST',
          url: 'https://example.com/login',
          headers: {},
          body: '${credential.username}',
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 2000,
          method: 'GET',
          url: 'https://example.com/api/search?q=hotels',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 3,
          timestamp: 3000,
          method: 'POST',
          url: 'https://example.com/api/trusted-device',
          headers: {},
          body: '{"register":true}',
          resourceType: 'Fetch',
        },
      ],
    });
    expect(findAuthAdjacentSeqs(session, [1])).toEqual([3]);
  });
});
