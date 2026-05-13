import { describe, expect, it } from 'bun:test';
import {
  buildSharedCompileContext,
  buildToolCandidatePayload,
  primaryToolCandidate,
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
