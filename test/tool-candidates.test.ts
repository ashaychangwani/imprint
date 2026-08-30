import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ProviderDeadlineError,
  RunDeadline,
  type RunDeadlineRef,
} from '../src/imprint/provider-retry.ts';
import {
  SharedCompileContextSchema,
  buildSharedCompileContext,
  buildToolCandidatePayload,
  deriveStructuralCandidateDependencies,
  detectToolCandidates,
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

interface DetectorFixtureResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

interface DetectorFixtureControl {
  signal?: AbortSignal;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
}

function detectorFixtureResult(
  toolNames: string[],
  usage: Pick<DetectorFixtureResult, 'inputTokens' | 'outputTokens' | 'durationMs'> = {
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 20,
  },
): DetectorFixtureResult {
  return {
    text: JSON.stringify({
      sharedContext: {},
      candidates: toolNames.map((toolName, index) => ({
        toolName,
        description: `Fixture ${toolName}`,
        rationale: `Recorded evidence for ${toolName}`,
        confidence: 0.9,
        requestSeqs: [index === 0 ? 1 : 4],
      })),
    }),
    ...usage,
  };
}

function scriptedDetectorAnalyzer(
  steps: Array<DetectorFixtureResult | Error | (() => DetectorFixtureResult)>,
) {
  const payloads: unknown[] = [];
  const controls: Array<DetectorFixtureControl | undefined> = [];
  let calls = 0;
  return {
    analyzer: {
      analyze: async (
        _systemPrompt: string,
        payload: unknown,
        control?: DetectorFixtureControl,
      ): Promise<DetectorFixtureResult> => {
        payloads.push(payload);
        controls.push(control);
        const step = steps[calls++];
        if (!step) throw new Error('Unexpected detector call');
        if (step instanceof Error) throw step;
        return typeof step === 'function' ? step() : step;
      },
    },
    controls,
    payloads,
    callCount: () => calls,
  };
}

const multiFamilySession: Session = {
  ...session,
  requests: ['search', 'pricing'].flatMap((family, familyIndex) =>
    [1, 2, 3].map((value, valueIndex) => ({
      seq: familyIndex * 3 + valueIndex + 1,
      timestamp: (familyIndex * 3 + valueIndex + 1) * 100,
      method: 'GET',
      url: `https://www.example.com/api/${family}?fixture=${value}`,
      headers: {},
      resourceType: 'XHR' as const,
      response: { status: 200, headers: {}, body: `{"value":${value}}` },
    })),
  ),
};

describe('shipped candidate detector guidance', () => {
  it('keeps standalone lookup and read-only operations visible while leaving revision to master', () => {
    expect(detectorPrompt).toContain('Prefer more candidates over fewer');
    expect(detectorPrompt).toContain('A read-only query that returns data');
    expect(detectorPrompt).toContain('The master may later split them');
    expect(detectorPrompt).not.toContain('There must be exactly one primary candidate');
  });

  it('keeps narration and event citations in their real namespaces', () => {
    expect(detectorPrompt).toContain('A `narration[].seq` is not an event');
    expect(detectorPrompt).toContain('`requests[].repeatedSeqs` value');
    expect(detectorPrompt).toContain('`eventSeqs` may use only');
    expect(detectorPrompt).toContain('`events[].seq`');
  });
});

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
    expect(payload.requests[0]?.likelyLoginOrAuth).toBe(true);
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
    expect(payload.requests[1]?.likelyLoginOrAuth).toBe(true);
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

  it('does not confuse business tokens with authentication', () => {
    const tokenSession: Session = {
      ...session,
      requests: [
        ['property', '{"property_token":"fixture-property"}'],
        ['flight', '{"selection_token":"fixture-selection"}'],
        ['page', '{"next_page_token":"fixture-page"}'],
        ['login', '{"username":"fixture"}'],
        ['profile', '{"username":"${credential.username}"}'],
      ].map(([path, body], index) => ({
        seq: index + 1,
        timestamp: (index + 1) * 100,
        method: 'POST',
        url: `https://www.example.com/api/${path}`,
        headers: {},
        body,
        resourceType: 'Fetch' as const,
        response: { status: 200, headers: {}, body: '{}' },
      })),
    };

    const hints = buildToolCandidatePayload(tokenSession).requests.map(
      ({ likelyLoginOrAuth }) => likelyLoginOrAuth,
    );
    expect(hints).toEqual([false, false, false, true, true]);
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

describe('candidate anti-collapse retry', () => {
  it('retries a collapsed multi-family result and keeps the richer detection and usage', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['combined_operation']),
      detectorFixtureResult(['search_items', 'get_pricing'], {
        inputTokens: 21,
        outputTokens: 13,
        durationMs: 34,
      }),
    ]);

    const detection = await detectToolCandidates(multiFamilySession, undefined, {
      analyzer: scripted.analyzer,
      candidatePayload: payload,
    });

    expect(detection.candidates.map((candidate) => candidate.toolName)).toEqual([
      'search_items',
      'get_pricing',
    ]);
    expect(detection.inputTokens).toBe(21);
    expect(detection.outputTokens).toBe(13);
    expect(detection.durationMs).toBe(34);
    expect(scripted.callCount()).toBe(2);
    expect(scripted.payloads[0]).toBe(payload);
    expect(scripted.payloads[1]).toBe(payload);
  });

  it('does not retry when only one endpoint family is well represented', async () => {
    const payload = buildToolCandidatePayload({
      ...multiFamilySession,
      requests: multiFamilySession.requests.slice(0, 3),
    });
    const scripted = scriptedDetectorAnalyzer([detectorFixtureResult(['search_items'])]);

    await detectToolCandidates(multiFamilySession, undefined, {
      analyzer: scripted.analyzer,
      candidatePayload: payload,
    });

    expect(scripted.callCount()).toBe(1);
  });

  it('does not retry an already segmented multi-family result', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['search_items', 'get_pricing']),
    ]);

    await detectToolCandidates(multiFamilySession, undefined, {
      analyzer: scripted.analyzer,
      candidatePayload: payload,
    });

    expect(scripted.callCount()).toBe(1);
  });

  it('keeps the first result when the optional retry fails ordinarily', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['combined_operation']),
      new Error('fixture retry failure'),
    ]);

    const detection = await detectToolCandidates(multiFamilySession, undefined, {
      analyzer: scripted.analyzer,
      candidatePayload: payload,
    });

    expect(detection.candidates.map((candidate) => candidate.toolName)).toEqual([
      'combined_operation',
    ]);
    expect(detection.inputTokens).toBe(10);
    expect(detection.outputTokens).toBe(5);
    expect(detection.durationMs).toBe(20);
    expect(scripted.callCount()).toBe(2);
  });

  it('keeps the grounded first result when a richer retry invents a recording seq', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const ungroundedRetry = detectorFixtureResult(['search_items', 'get_pricing'], {
      inputTokens: 21,
      outputTokens: 13,
      durationMs: 34,
    });
    const retryBody = JSON.parse(ungroundedRetry.text) as {
      candidates: Array<{ requestSeqs: number[] }>;
    };
    if (!retryBody.candidates[1]) throw new Error('Expected the richer fixture candidate');
    retryBody.candidates[1].requestSeqs = [999];
    ungroundedRetry.text = JSON.stringify(retryBody);
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['combined_operation']),
      ungroundedRetry,
    ]);

    const detection = await detectToolCandidates(multiFamilySession, undefined, {
      analyzer: scripted.analyzer,
      candidatePayload: payload,
    });

    expect(detection.candidates.map((candidate) => candidate.toolName)).toEqual([
      'combined_operation',
    ]);
    expect(detection.inputTokens).toBe(10);
    expect(detection.outputTokens).toBe(5);
    expect(detection.durationMs).toBe(20);
    expect(scripted.callCount()).toBe(2);
  });

  it('keeps the first result when a richer retry violates master candidate structure', async () => {
    type RetryBody = {
      candidates: Array<{
        requestSeqs: number[];
        representativeSeqs?: number[];
        dependsOnTools?: string[];
      }>;
    };
    const cases: Array<(body: RetryBody) => void> = [
      (body) => {
        const second = body.candidates[1];
        if (!second) throw new Error('Expected the richer fixture candidate');
        second.representativeSeqs = [1];
      },
      (body) => {
        const first = body.candidates[0];
        const second = body.candidates[1];
        if (!first || !second) throw new Error('Expected both richer fixture candidates');
        first.dependsOnTools = ['get_pricing'];
        second.dependsOnTools = ['search_items'];
      },
    ];

    for (const mutate of cases) {
      const payload = buildToolCandidatePayload(multiFamilySession);
      const invalidRetry = detectorFixtureResult(['search_items', 'get_pricing'], {
        inputTokens: 21,
        outputTokens: 13,
        durationMs: 34,
      });
      const retryBody = JSON.parse(invalidRetry.text) as RetryBody;
      mutate(retryBody);
      invalidRetry.text = JSON.stringify(retryBody);
      const scripted = scriptedDetectorAnalyzer([
        detectorFixtureResult(['combined_operation']),
        invalidRetry,
      ]);

      const detection = await detectToolCandidates(multiFamilySession, undefined, {
        analyzer: scripted.analyzer,
        candidatePayload: payload,
      });

      expect(detection.candidates.map((candidate) => candidate.toolName)).toEqual([
        'combined_operation',
      ]);
      expect(detection.inputTokens).toBe(10);
      expect(detection.outputTokens).toBe(5);
      expect(detection.durationMs).toBe(20);
      expect(scripted.callCount()).toBe(2);
    }
  });

  it('propagates cancellation during the optional retry', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const controller = new AbortController();
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['combined_operation']),
      () => {
        controller.abort('fixture cancellation');
        throw new Error('provider stopped after cancellation');
      },
    ]);

    await expect(
      detectToolCandidates(multiFamilySession, undefined, {
        analyzer: scripted.analyzer,
        candidatePayload: payload,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(scripted.callCount()).toBe(2);
  });

  it('propagates provider deadlines and forwards the same run controls to both calls', async () => {
    const payload = buildToolCandidatePayload(multiFamilySession);
    const signal = new AbortController().signal;
    const runDeadline = new RunDeadline(Date.now() + 60_000);
    const deadlineError = new ProviderDeadlineError(runDeadline.deadlineMs);
    const scripted = scriptedDetectorAnalyzer([
      detectorFixtureResult(['combined_operation']),
      deadlineError,
    ]);

    await expect(
      detectToolCandidates(multiFamilySession, undefined, {
        analyzer: scripted.analyzer,
        candidatePayload: payload,
        signal,
        deadlineMs: runDeadline.deadlineMs,
        runDeadline,
      }),
    ).rejects.toBe(deadlineError);
    expect(scripted.callCount()).toBe(2);
    expect(scripted.controls).toEqual([
      { signal, deadlineMs: runDeadline.deadlineMs, runDeadline },
      { signal, deadlineMs: runDeadline.deadlineMs, runDeadline },
    ]);
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
