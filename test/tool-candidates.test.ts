import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  SharedCompileContextSchema,
  buildSharedCompileContext,
  buildToolCandidatePayload,
  deriveStructuralCandidateDependencies,
  mergeCandidateDependencies,
  sharedContextHasAuth,
  validateToolCandidateDetection,
} from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

const detectorPrompt = readFileSync(
  new URL('../prompts/tool-candidate-detection.md', import.meta.url),
  'utf8',
);

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

describe('shipped candidate detector guidance', () => {
  it('keeps standalone lookup and read-only operations visible while leaving revision to master', () => {
    expect(detectorPrompt).toContain('Prefer more candidates over fewer');
    expect(detectorPrompt).toContain('A read-only query that returns data');
    expect(detectorPrompt).toContain('The master may later split them');
    expect(detectorPrompt).not.toContain('There must be exactly one primary candidate');
  });
});

describe('tool candidate payload', () => {
  it('keeps same-site XHR/fetch metadata and credential placeholders', () => {
    const payload = buildToolCandidatePayload(session);
    expect(payload.requests.map((r) => r.seq)).toEqual([1, 2]);
    expect(payload.requests[0]?.credentialPlaceholders).toEqual(['username', 'password']);
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

  it('keeps non-telemetry cross-domain requests while dropping telemetry', () => {
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
  });

  it('ignores document loads while preserving cross-origin XHR and fetch evidence', () => {
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
  });

  it('keeps public cross-origin API requests without requiring auth signals', () => {
    const crossOriginApiSession: Session = {
      ...session,
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.backend.net/auth/login',
          headers: { 'content-type': 'application/json' },
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

  it('keeps public cross-origin APIs by default and preserves an exact trusted scope', () => {
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

    expect(buildToolCandidatePayload(remitlyTriagedSession).requests.map((r) => r.seq)).toEqual([
      534, 538,
    ]);
    expect(
      buildToolCandidatePayload(remitlyTriagedSession, { trustSessionScope: true }).requests.map(
        (r) => r.seq,
      ),
    ).toEqual([534, 536, 537, 538]);
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
  it('keeps an empty detector result for the master to review', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [],
    });
    expect(detection.candidates).toEqual([]);
  });

  it('keeps a recording-grounded browser candidate with no API requests', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName: 'submit_form',
          description: 'Submit the recorded form',
          rationale: 'the useful operation is visible in browser events',
          confidence: 0.75,
          requestSeqs: [],
          eventSeqs: [10, 11],
        },
      ],
    });
    expect(detection.candidates[0]?.requestSeqs).toEqual([]);
    expect(detection.candidates[0]?.eventSeqs).toEqual([10, 11]);
  });

  it('keeps candidate-specific dependency seqs out of shared login context', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: { loginRequestSeqs: [1], credentialNames: ['username'] },
      candidates: [
        {
          toolName: 'search_items',
          description: 'Search items',
          rationale: 'recorded search intent',
          confidence: 0.9,
          requestSeqs: [2],
          dependencySeqs: [1, 4],
        },
        {
          toolName: 'list_orders',
          description: 'List orders',
          rationale: 'secondary intent',
          confidence: 0.7,
          requestSeqs: [8],
          dependencySeqs: [7, 9],
        },
      ],
    });
    const shared = buildSharedCompileContext(detection);
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
          rationale: 'recorded search intent',
          confidence: 0.9,
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
          rationale: 'recorded search intent',
          confidence: 0.9,
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

  it('normalizes omitted detector dependency metadata to an empty list', () => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName: 'search_items',
          description: 'Search items',
          rationale: 'recorded search intent',
          confidence: 0.9,
          requestSeqs: [2],
        },
      ],
    });
    expect(detection.candidates[0]?.dependsOnTools).toEqual([]);
  });

  it('rejects self and unknown callable dependencies instead of silently dropping them', () => {
    expect(() =>
      validateToolCandidateDetection({
        sharedContext: {},
        candidates: [
          {
            toolName: 'get_details',
            description: 'Get details',
            rationale: 'recorded detail intent',
            confidence: 0.9,
            requestSeqs: [2],
            dependsOnTools: ['get_details', 'missing_tool'],
          },
        ],
      }),
    ).toThrow(/cannot depend on itself|unknown dependency/);
  });
});

describe('candidate dependency graph', () => {
  const candidate = (toolName: string, requestSeqs: number[], dependencySeqs: number[] = []) => {
    const detection = validateToolCandidateDetection({
      sharedContext: {},
      candidates: [
        {
          toolName,
          description: toolName,
          rationale: toolName,
          confidence: 0.9,
          requestSeqs,
          dependencySeqs,
        },
      ],
    });
    const result = detection.candidates[0];
    if (!result) throw new Error('candidate fixture was unexpectedly empty');
    return result;
  };

  it('derives direct structural edges and ignores unowned, self, and ambiguous seqs', () => {
    const graph = deriveStructuralCandidateDependencies([
      candidate('lookup_items', [1]),
      candidate('search_items', [2], [1, 2, 99]),
      candidate('shared_a', [4]),
      candidate('shared_b', [4]),
      candidate('get_details', [3], [2, 4]),
    ]);
    expect(graph.map((item) => [item.toolName, item.dependsOnTools])).toEqual([
      ['lookup_items', []],
      ['search_items', ['lookup_items']],
      ['shared_a', []],
      ['shared_b', []],
      ['get_details', ['search_items']],
    ]);
  });

  it('merges grounded dependency edges without selecting a subset', () => {
    const structural = deriveStructuralCandidateDependencies([
      candidate('get_details', [3], [2]),
      candidate('lookup_items', [1]),
      candidate('search_items', [2], [1]),
      candidate('independent_tool', [4]),
    ]);
    const merged = mergeCandidateDependencies(structural, [
      { consumerTool: 'get_details', producerTool: 'search_items' },
      { consumerTool: 'missing', producerTool: 'lookup_items' },
      { consumerTool: 'search_items', producerTool: 'search_items' },
    ]);
    expect(merged.map((item) => [item.toolName, item.dependsOnTools])).toEqual([
      ['get_details', ['search_items']],
      ['lookup_items', []],
      ['search_items', ['lookup_items']],
      ['independent_tool', []],
    ]);
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

  it('true when related auth requests were detected', () => {
    expect(sharedContextHasAuth({ ...base, authRequestSeqs: [43] })).toBe(true);
  });
});
