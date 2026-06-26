import { describe, expect, it } from 'bun:test';
import {
  SharedCompileContextSchema,
  buildSharedCompileContext,
  buildToolCandidatePayload,
  primaryToolCandidate,
  sharedContextHasAuth,
  validateToolCandidateDetection,
} from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

const session: Session = {
  site: 'demo',
  startedAt: '2026-05-12T00:00:00.000Z',
  url: 'https://www.example.com/start',
  imprintVersion: '0.1.0',
  requests: [
    {
      seq: 1,
      timestamp: 100,
      method: 'POST',
      url: 'https://www.example.com/login',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"${credential.username}","password":"${credential.password}"}',
      resourceType: 'Fetch',
      response: { status: 200, headers: {}, body: '{"token":"abc"}' },
    },
    {
      seq: 2,
      timestamp: 200,
      method: 'GET',
      url: 'https://api.example.com/search?q=test',
      headers: { 'x-csrf-token': 'fixture-token' },
      resourceType: 'XHR',
      response: { status: 200, headers: {}, body: '{"items":[{"name":"Test"}]}' },
    },
    {
      seq: 3,
      timestamp: 300,
      method: 'GET',
      url: 'https://analytics.other.com/pixel',
      headers: {},
      resourceType: 'XHR',
    },
  ],
  events: [{ seq: 10, timestamp: 150, type: 'click', detail: '{"text":"Search"}' }],
  narration: [{ seq: 11, timestamp: 140, text: 'searching for test items' }],
  cookieSnapshots: [],
  storageSnapshots: [],
};

describe('tool candidate payload', () => {
  it('keeps same-site XHR/fetch metadata and marks auth dependencies', () => {
    const payload = buildToolCandidatePayload(session);
    expect(payload.requests.map((r) => r.seq)).toEqual([1, 2]);
    expect(payload.requests[0]?.credentialPlaceholders).toEqual(['username', 'password']);
    expect(payload.requests[0]?.likelyLoginOrAuth).toBe(true);
    expect(payload.requests[1]?.likelyLoginOrAuth).toBe(false);
  });

  it('excludes telemetry/beacon endpoints without dropping event-listing APIs', () => {
    const telemetrySession: Session = {
      ...session,
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://www.example.com/log?format=json&hasfast=true',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 204, headers: {}, body: '' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://www.example.com/gen_204?foo=bar',
          headers: {},
          resourceType: 'XHR',
          response: { status: 204, headers: {}, body: '' },
        },
        {
          seq: 3,
          timestamp: 250,
          method: 'POST',
          url: 'https://www.example.com/v1/events',
          headers: {},
          body: JSON.stringify([
            {
              app_version: '1.0.0',
              browser_name: 'Chrome',
              device_environment_type: 'Web',
              screen_width: 1200,
            },
          ]),
          resourceType: 'Fetch',
          response: { status: 204, headers: {}, body: '' },
        },
        {
          seq: 4,
          timestamp: 300,
          method: 'GET',
          url: 'https://www.example.com/search?q=test',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"items":[]}' },
        },
        {
          seq: 5,
          timestamp: 400,
          method: 'GET',
          url: 'https://www.example.com/login', // must NOT be excluded by the /log rule
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
        {
          seq: 6,
          timestamp: 500,
          method: 'GET',
          url: 'https://www.example.com/api/events',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"events":[{"id":"evt_1"}]}' },
        },
        {
          seq: 7,
          timestamp: 600,
          method: 'POST',
          url: 'https://www.example.com/v1/events/search',
          headers: {},
          body: '{"query":"conference"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"events":[{"id":"evt_2"}]}' },
        },
      ],
    };
    const payload = buildToolCandidatePayload(telemetrySession);
    const seqs = payload.requests.map((r) => r.seq);
    expect(seqs).toContain(4); // real search kept
    expect(seqs).toContain(5); // /login kept (word-boundary guard)
    expect(seqs).toContain(6); // product /events endpoint kept
    expect(seqs).toContain(7); // product /events/search endpoint kept
    expect(seqs).not.toContain(1); // /log dropped
    expect(seqs).not.toContain(2); // /gen_204 dropped
    expect(seqs).not.toContain(3); // analytics-style /events dropped
  });

  it('keeps cross-domain auth setup requests while dropping unrelated third parties', () => {
    const crossDomainAuthSession: Session = {
      ...session,
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://auth.example-idp.com/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: '{"username":"${credential.username}","password":"${credential.password}"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"token":"abc"}' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://api.example.com/search?q=test',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"items":[]}' },
        },
        {
          seq: 3,
          timestamp: 300,
          method: 'GET',
          url: 'https://analytics.other.com/pixel',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    };

    const payload = buildToolCandidatePayload(crossDomainAuthSession);

    expect(payload.requests.map((r) => r.seq)).toEqual([1, 2]);
    expect(payload.requests[0]?.likelyLoginOrAuth).toBe(true);
  });

  it('uses navigation or document URLs for scoping when session.url is about:blank', () => {
    const blankSession: Session = {
      ...session,
      url: 'about:blank',
      events: [
        {
          seq: 20,
          timestamp: 50,
          type: 'navigation',
          detail: 'https://www.example.com/start',
        },
      ],
      requests: [
        {
          seq: 1,
          timestamp: 75,
          method: 'GET',
          url: 'https://www.example.com/start',
          headers: {},
          resourceType: 'Document',
        },
        {
          seq: 2,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.example.com/search?q=test',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"items":[]}' },
        },
        {
          seq: 3,
          timestamp: 150,
          method: 'GET',
          url: 'https://analytics.other.com/pixel',
          headers: {},
          resourceType: 'XHR',
        },
        {
          seq: 4,
          timestamp: 200,
          method: 'POST',
          url: 'https://auth.other-idp.com/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: '{"username":"${credential.username}","password":"${credential.password}"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"token":"abc"}' },
        },
      ],
    };

    const payload = buildToolCandidatePayload(blankSession);

    expect(payload.requests.map((r) => r.seq)).toEqual([2, 4]);
    expect(payload.requests[1]?.likelyLoginOrAuth).toBe(true);
  });

  it('promotes all requests to a cross-origin host when any request carries auth signals', () => {
    const crossOriginApiSession: Session = {
      ...session,
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.backend.net/auth/login',
          headers: { authorization: '[REDACTED:v3:id=1:len=32]' },
          body: '{"user":"test"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"token":"abc"}' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://api.backend.net/menu/items',
          headers: { 'content-type': 'application/json' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"items":[]}' },
        },
        {
          seq: 3,
          timestamp: 300,
          method: 'POST',
          url: 'https://api.backend.net/cart/add',
          headers: { 'content-type': 'application/json' },
          body: '{"itemId":"123"}',
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"success":true}' },
        },
        {
          seq: 4,
          timestamp: 400,
          method: 'GET',
          url: 'https://analytics.tracker.io/collect',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    };

    const payload = buildToolCandidatePayload(crossOriginApiSession);
    expect(payload.requests.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('trusts triaged public cross-origin API scope while still dropping telemetry', () => {
    const remitlyTriagedSession: Session = {
      ...session,
      site: 'remitly',
      url: 'https://www.remitly.com/',
      requests: [
        {
          seq: 534,
          timestamp: 23794,
          method: 'GET',
          url: 'https://api.remitly.io/v3/calculator/estimate?conduit=USA%3AUSD-IND%3AINR&anchor=SEND&amount=1100',
          headers: { accept: 'application/json' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"estimate":{"send_amount":"1100.00"}}' },
        },
        {
          seq: 536,
          timestamp: 25281,
          method: 'POST',
          url: 'https://uel.remitly.io/v1/collect',
          headers: {},
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '' },
        },
        {
          seq: 537,
          timestamp: 25310,
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
          seq: 538,
          timestamp: 25400,
          method: 'GET',
          url: 'https://api.remitly.io/v1/events',
          headers: {},
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{"events":[{"id":"evt_1"}]}' },
        },
      ],
    };

    expect(buildToolCandidatePayload(remitlyTriagedSession).requests.map((r) => r.seq)).toEqual([]);
    expect(
      buildToolCandidatePayload(remitlyTriagedSession, { trustSessionScope: true }).requests.map(
        (r) => r.seq,
      ),
    ).toEqual([534, 538]);
  });

  it('compacts identical repeated requests before sending candidate context', () => {
    const duplicateSession: Session = {
      ...session,
      requests: [
        ...session.requests,
        {
          ...(session.requests[1] as Session['requests'][number]),
          seq: 4,
          timestamp: 250,
        },
      ],
    };

    const payload = buildToolCandidatePayload(duplicateSession);
    const repeated = payload.requests.find((r) => r.seq === 2);

    expect(payload.requests.map((r) => r.seq)).toEqual([1, 2]);
    expect(repeated?.repeatCount).toBe(2);
    expect(repeated?.repeatedSeqs).toEqual([2, 4]);
    expect(repeated?.lastTimestamp).toBe(250);
  });
});

describe('tool candidate validation', () => {
  it('reports an empty detector result as a friendly Imprint error', () => {
    expect(() =>
      validateToolCandidateDetection({
        sharedContext: {},
        candidates: [],
      }),
    ).toThrow(/did not identify any tool candidates backed by requests/);
  });

  it('requires exactly one primary candidate', () => {
    expect(() =>
      validateToolCandidateDetection({
        sharedContext: {},
        candidates: [
          {
            toolName: 'search_items',
            description: 'Search items',
            rationale: 'primary intent',
            confidence: 0.9,
            primary: true,
            requestSeqs: [2],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validateToolCandidateDetection({
        sharedContext: {},
        candidates: [
          {
            toolName: 'search_items',
            description: 'Search items',
            rationale: 'primary intent',
            confidence: 0.9,
            primary: false,
            requestSeqs: [2],
          },
        ],
      }),
    ).toThrow(/exactly one primary/);
  });

  it('keeps candidate-specific dependency seqs out of shared login context', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: { loginRequestSeqs: [1], credentialNames: ['username'] },
      candidates: [
        {
          toolName: 'search_items',
          description: 'Search items',
          rationale: 'primary intent',
          confidence: 0.9,
          primary: true,
          requestSeqs: [2],
          dependencySeqs: [1, 4],
        },
        {
          toolName: 'list_orders',
          description: 'List orders',
          rationale: 'secondary intent',
          confidence: 0.7,
          primary: false,
          requestSeqs: [8],
          dependencySeqs: [7, 9],
        },
      ],
    });
    const primary = primaryToolCandidate(detection);
    const secondary = detection.candidates[1];
    const shared = buildSharedCompileContext(
      detection,
      secondary ? [primary, secondary] : [primary],
    );
    expect(shared.loginRequestSeqs).toEqual([1]);
    expect(shared.credentialNames).toEqual(['username']);
  });

  it('normalizes array-like likely param type hints to compiler primitives', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName: 'search_domain_extensions',
          description: 'Search domain extensions',
          rationale: 'primary intent',
          confidence: 0.9,
          primary: true,
          requestSeqs: [2],
          likelyParams: [
            {
              name: 'extensions',
              type: 'string[]',
              description: 'Domain extensions to include in the search',
            },
          ],
        },
      ],
    });

    expect(detection.candidates[0]?.likelyParams[0]?.type).toBe('string');
  });

  it('drops unsupported likely param type hints without rejecting candidates', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName: 'search_domain_extensions',
          description: 'Search domain extensions',
          rationale: 'primary intent',
          confidence: 0.9,
          primary: true,
          requestSeqs: [2],
          likelyParams: [
            {
              name: 'filters',
              type: 'object',
              description: 'Additional search filters',
            },
          ],
        },
      ],
    });

    expect(detection.candidates[0]?.likelyParams[0]?.type).toBeUndefined();
  });
});

describe('sharedContextHasAuth', () => {
  const base = SharedCompileContextSchema.parse({});

  it('false for undefined or a no-auth recording', () => {
    expect(sharedContextHasAuth(undefined)).toBe(false);
    expect(sharedContextHasAuth(base)).toBe(false);
  });

  it('true when a login was recorded (no 2FA) — so an auth tool is still built', () => {
    expect(sharedContextHasAuth({ ...base, loginRequestSeqs: [42] })).toBe(true);
  });

  it('true when credentials were detected', () => {
    expect(sharedContextHasAuth({ ...base, credentialNames: ['username'] })).toBe(true);
  });

  it('true when 2FA was detected', () => {
    expect(sharedContextHasAuth({ ...base, twoFactorDetected: true })).toBe(true);
  });
});
