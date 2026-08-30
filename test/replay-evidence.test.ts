import { describe, expect, it } from 'bun:test';
import {
  DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
  FOCUSED_EVIDENCE_CHARACTER_BUDGET,
  buildPromptEvidenceProjection,
  prepareRedactedTeachingSession,
} from '../src/imprint/master-teach-controller.ts';
import {
  createReplayRequestIdentityAllocator,
  resolveReplayInputValue,
} from '../src/imprint/replay-capture.ts';
import {
  compareIndependentExecution,
  discoveryEvidenceDocuments,
  focusedEvidenceDocuments,
  observeIndependentExecution,
} from '../src/imprint/replay-evidence.ts';
import { buildToolCandidatePayload } from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

function session(): Session {
  return {
    site: 'fixture',
    startedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://fixture.invalid',
    imprintVersion: '0.6.6',
    requests: [
      {
        seq: 10,
        timestamp: 10,
        method: 'GET',
        url: 'https://fixture.invalid/search',
        headers: {},
        resourceType: 'XHR',
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({ token: 'recording-token' }),
          mimeType: 'application/json',
        },
      },
      {
        seq: 20,
        timestamp: 20,
        method: 'POST',
        url: 'https://fixture.invalid/detail',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'recording-token',
          username: '${credential.username}',
          query: 'recorded',
        }),
        resourceType: 'XHR',
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true }),
          mimeType: 'application/json',
        },
      },
    ],
    events: [
      {
        seq: 15,
        timestamp: 15,
        type: 'input',
        detail: JSON.stringify({ selector: '#query', value: 'recorded' }),
      },
    ],
    narration: Array.from({ length: 20 }, (_, index) => ({
      seq: 100 + index,
      timestamp: index + 1,
      text: `narration ${index}`,
    })),
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function projectedValues(
  projection: ReturnType<typeof buildPromptEvidenceProjection>,
): Record<string, unknown>[] {
  return projection.payload.entries.flatMap((entry) =>
    entry.kind === 'untrusted_redacted_quote'
      ? [JSON.parse(entry.quote) as Record<string, unknown>]
      : [],
  );
}

describe('factual independent-execution evidence', () => {
  it('reports exact variation and prior-response correlation without assigning meaning', () => {
    const recording = session();
    const observation = compareIndependentExecution(
      recording,
      [
        {
          seq: 110,
          timestamp: 10,
          method: 'GET',
          url: 'https://fixture.invalid/search',
          headers: {},
          resourceType: 'xhr',
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({ token: 'independent-token' }),
            mimeType: 'application/json',
          },
        },
        {
          seq: 120,
          timestamp: 20,
          method: 'POST',
          url: 'https://fixture.invalid/detail',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'independent-token',
            username: 'alice@example.test',
            query: 'fresh',
          }),
          resourceType: 'xhr',
          response: { status: 200, headers: {}, body: JSON.stringify({ ok: true }) },
        },
      ],
      [
        {
          requestSeq: 20,
          location: { kind: 'body-json', path: ['username'] },
          originalValue: 'alice@example.test',
          placeholder: '${credential.username}',
        },
      ],
    );

    expect(observation.status).toBe('observed');
    if (observation.status !== 'observed') throw new Error('expected observed execution');
    const detail = observation.requests.find(
      ({ recordingRequestSeq }) => recordingRequestSeq === 20,
    );
    expect(detail?.alignmentConfidence).toBeGreaterThanOrEqual(0.7);
    expect(detail?.fields.find(({ location }) => location === 'body:/username')).toMatchObject({
      comparison: 'same',
    });
    expect(detail?.fields.find(({ location }) => location === 'body:/query')).toMatchObject({
      comparison: 'different',
      priorResponseCorrelation: null,
    });
    expect(detail?.fields.find(({ location }) => location === 'body:/token')).toMatchObject({
      comparison: 'different',
      priorResponseCorrelation: {
        responseRequestSeq: 10,
        responsePath: '$.token',
        observedIn: 'independent_execution',
      },
    });
  });

  it('keeps replay observation failure non-fatal and forwards extracted credentials', async () => {
    let replayCredentials: Record<string, string> | undefined;
    const unavailable = await observeIndependentExecution({
      session: session(),
      site: 'fixture',
      credentials: { username: 'alice@example.test' },
      replay: async (input) => {
        replayCredentials = input.credentials;
        throw new Error('browser did not start');
      },
    });
    expect(replayCredentials).toEqual({ username: 'alice@example.test' });
    expect(unavailable).toEqual({
      status: 'unavailable',
      requests: [],
      unmatchedRecordingRequestSeqs: [],
      message: 'browser did not start',
    });
  });

  it('does not infer variation or correlation from a missing repeated occurrence', () => {
    const recording = session();
    recording.requests = [
      {
        seq: 10,
        timestamp: 10,
        method: 'POST',
        url: 'https://fixture.invalid/repeat',
        headers: {},
        body: JSON.stringify({ query: 'first' }),
        resourceType: 'XHR',
      },
      {
        seq: 20,
        timestamp: 20,
        method: 'POST',
        url: 'https://fixture.invalid/repeat',
        headers: {},
        body: JSON.stringify({ query: 'second' }),
        resourceType: 'XHR',
      },
    ];
    const observation = compareIndependentExecution(recording, [
      {
        seq: 110,
        timestamp: 10,
        method: 'POST',
        url: 'https://fixture.invalid/repeat',
        headers: {},
        body: JSON.stringify({ query: 'second' }),
        resourceType: 'xhr',
      },
    ]);

    expect(observation.status).toBe('observed');
    if (observation.status !== 'observed') throw new Error('expected observed execution');
    expect(observation.requests).toHaveLength(1);
    expect(observation.requests[0]).toMatchObject({
      recordingRequestSeq: 10,
      independentRequestSeq: 110,
      alignmentStatus: 'ambiguous_repeated_occurrence',
      fields: [
        {
          location: 'body:/query',
          comparison: 'not_observed',
          priorResponseCorrelation: null,
        },
      ],
    });
    const evidence = focusedEvidenceDocuments({
      session: recording,
      scope: { requestSeqs: [10, 20], dependencySeqs: [], eventSeqs: [] },
      independent: observation,
    });
    const variationFacts = evidence
      .filter(({ value }) => value.kind === 'request_variation_and_response_correlation')
      .flatMap(({ value }) => (Array.isArray(value.fields) ? value.fields : []));
    expect(variationFacts).toContainEqual(
      expect.objectContaining({
        acceptedConsumerRequestSeq: 10,
        alignmentStatus: 'ambiguous_repeated_occurrence',
        comparison: 'not_observed',
        priorResponseCorrelation: null,
      }),
    );
    expect(variationFacts).not.toContainEqual(
      expect.objectContaining({
        acceptedConsumerRequestSeq: 10,
        comparison: expect.stringMatching(/^(same|different)$/),
      }),
    );
  });

  it('emits focused evidence in multiple bounded documents including late narration', () => {
    const recording = session();
    const observation = compareIndependentExecution(recording, []);
    const documents = focusedEvidenceDocuments({
      session: recording,
      scope: {
        toolId: 'detail',
        toolName: 'get_detail',
        requestSeqs: [10, 20],
        dependencySeqs: [],
        eventSeqs: [15],
      },
      independent: observation,
    });

    expect(documents.length).toBeGreaterThan(4);
    expect(JSON.stringify(documents)).toContain('narration 19');
    expect(JSON.stringify(documents)).toContain('acceptedConsumerRequestSeq');
    expect(JSON.stringify(documents)).toContain('event_driven_request_differences');
    expect(JSON.stringify(documents)).toContain('absenceOfCorrelationHasNoStrategyMeaning');
    for (const document of documents) {
      expect(Buffer.byteLength(JSON.stringify(document.value), 'utf8')).toBeLessThanOrEqual(4_000);
    }
  });

  it('chunks exact deep redacted request structure for JSON, forms, and framed JSON', () => {
    const recording = session();
    const nestedRequest = recording.requests[1];
    if (!nestedRequest) throw new Error('fixture nested request is missing');
    nestedRequest.url = 'https://fixture.invalid/detail?mode=full';
    nestedRequest.headers['x-fixture'] = 'header-value';
    nestedRequest.body = JSON.stringify({
      padding: 'x'.repeat(900),
      payload: JSON.stringify({ deep: { query: 'deep-redacted-value' } }),
    });
    recording.requests.push(
      {
        seq: 30,
        timestamp: 30,
        method: 'POST',
        url: 'https://fixture.invalid/form',
        headers: {},
        body: 'origin=SFO&destination=LAX',
        resourceType: 'XHR',
      },
      {
        seq: 40,
        timestamp: 40,
        method: 'POST',
        url: 'https://fixture.invalid/framed',
        headers: {},
        body: '18\n{"query":"framed"}',
        resourceType: 'XHR',
      },
    );
    const documents = focusedEvidenceDocuments({
      session: recording,
      scope: {
        toolId: 'detail',
        toolName: 'get_detail',
        requestSeqs: [20, 30, 40],
        dependencySeqs: [],
        eventSeqs: [],
      },
      independent: compareIndependentExecution(recording, []),
    });
    const structures = documents
      .map(({ value }) => value)
      .filter(({ kind }) => kind === 'focused_request_structure');

    expect(JSON.stringify(structures)).toContain('body:/payload/deep/query');
    expect(JSON.stringify(structures)).toContain('deep-redacted-value');
    expect(JSON.stringify(structures)).toContain('json-string');
    expect(JSON.stringify(structures)).toContain('query:mode[0]');
    expect(JSON.stringify(structures)).toContain('header:x-fixture');
    expect(structures.find(({ recordingRequestSeq }) => recordingRequestSeq === 30)).toMatchObject({
      bodyDecode: { status: 'decoded', format: 'form-urlencoded' },
    });
    expect(structures.find(({ recordingRequestSeq }) => recordingRequestSeq === 40)).toMatchObject({
      bodyDecode: { status: 'decoded', format: 'decimal-framed-json' },
    });
    for (const document of documents) {
      expect(Buffer.byteLength(JSON.stringify(document.value), 'utf8')).toBeLessThanOrEqual(4_000);
    }
  });

  it('gives the master complete compact evidence, including unclaimed operations', () => {
    const recording = session();
    recording.requests.push({
      seq: 30,
      timestamp: 30,
      method: 'GET',
      url: 'https://fixture.invalid/unclaimed',
      headers: {},
      resourceType: 'XHR',
      response: { status: 200, headers: {}, body: '{"unclaimed":true}' },
    });
    recording.events.push({
      seq: 25,
      timestamp: 25,
      type: 'click',
      detail: '{"selector":"#unclaimed"}',
    });
    const candidatePayload = buildToolCandidatePayload(recording);
    const documents = discoveryEvidenceDocuments({
      candidatePayload,
    });
    const projection = buildPromptEvidenceProjection(
      documents,
      new Map(),
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
      new Set([
        'discovery_detector_evidence',
        'discovery_detector_narration',
        'discovery_detector_events',
        'discovery_detector_requests',
      ]),
    );
    const values = projectedValues(projection);
    const projectedRequests = values
      .filter(({ kind }) => kind === 'discovery_detector_requests')
      .flatMap(({ requests }) => (Array.isArray(requests) ? requests : []));
    const projectedEvents = values
      .filter(({ kind }) => kind === 'discovery_detector_events')
      .flatMap(({ events }) => (Array.isArray(events) ? events : []));

    expect(projectedRequests.map(({ seq }) => seq)).toEqual(
      candidatePayload.requests.map(({ seq }) => seq),
    );
    expect(projectedRequests).toContainEqual(expect.objectContaining({ seq: 30 }));
    expect(projectedEvents).toContainEqual(expect.objectContaining({ seq: 25 }));
    expect(
      projectedRequests.every(
        (request) =>
          request.headers === undefined &&
          request.body === undefined &&
          request.responsePreview === undefined,
      ),
    ).toBe(true);
    expect(projectedEvents).toEqual(candidatePayload.events);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
    );
    expect(() =>
      buildPromptEvidenceProjection(
        documents,
        new Map(),
        1_000,
        new Set(['discovery_detector_requests']),
      ),
    ).toThrow('required discovery_detector_requests evidence cannot fit');
  });

  it('round-trips an oversized evidence document without clipping its JSON', () => {
    const escaped = '\\"'.repeat(3_000);
    const document = {
      provenance: 'recording_request' as const,
      value: {
        kind: 'discovery_detector_requests',
        requests: [{ seq: 30, bodyPrefix: escaped }],
      },
    };
    const projection = buildPromptEvidenceProjection(
      [document],
      new Map(),
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
      new Set(['discovery_detector_requests']),
    );
    const requestEntries = projection.payload.entries.flatMap((entry) =>
      entry.kind === 'untrusted_redacted_quote' && entry.provenance === 'recording_request'
        ? [entry]
        : [],
    );
    const projectedRequests = requestEntries.flatMap((entry) => {
      const value = JSON.parse(entry.quote) as { requests?: unknown[] };
      return value.requests ?? [];
    });

    expect(requestEntries.some(({ quote }) => Buffer.byteLength(quote, 'utf8') > 4_000)).toBe(true);
    expect(projectedRequests).toEqual(document.value.requests);
  });

  it('keeps every request visible when the detailed inventory exceeds the prompt budget', () => {
    const recording = session();
    recording.requests = Array.from({ length: 720 }, (_, index) => ({
      seq: index + 1,
      timestamp: index + 1,
      method: 'POST',
      url: `https://fixture.invalid/api/operation/${index}?variant=${index}`,
      headers: { 'x-large-fixture': 'h'.repeat(900) },
      body: JSON.stringify({ operation: index, payload: 'b'.repeat(900) }),
      resourceType: 'Fetch' as const,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        body: JSON.stringify({ operation: index, result: 'r'.repeat(700) }),
      },
    }));
    recording.events = [];
    recording.narration = [];
    const candidatePayload = buildToolCandidatePayload(recording, {
      trustSessionScope: true,
    });
    expect(JSON.stringify(candidatePayload).length).toBeGreaterThan(
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
    );

    const projection = buildPromptEvidenceProjection(
      discoveryEvidenceDocuments({ candidatePayload }),
      new Map(),
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
      new Set(['discovery_detector_evidence', 'discovery_detector_requests']),
    );
    const projectedRequests = projectedValues(projection)
      .filter(({ kind }) => kind === 'discovery_detector_requests')
      .flatMap(({ requests }) => (Array.isArray(requests) ? requests : []));

    expect(projectedRequests.map(({ seq }) => seq)).toEqual(
      candidatePayload.requests.map(({ seq }) => seq),
    );
    expect(
      projectedRequests.every(
        (request) =>
          request.headers === undefined &&
          request.body === undefined &&
          request.responsePreview === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
    );
  });

  it('keeps every focused request summary but limits detail to representatives and dependencies', () => {
    const recording = session();
    recording.requests.push({
      seq: 30,
      timestamp: 30,
      method: 'POST',
      url: 'https://fixture.invalid/later',
      headers: {},
      body: '{"later":"not-detailed"}',
      resourceType: 'XHR',
      response: { status: 200, headers: {}, body: '{"ok":true}' },
    });
    const documents = focusedEvidenceDocuments({
      session: recording,
      scope: {
        toolId: 'detail',
        toolName: 'get_detail',
        requestSeqs: [10, 20, 30],
        representativeSeqs: [20],
        dependencySeqs: [10],
        eventSeqs: [15],
      },
      independent: compareIndependentExecution(recording, []),
    });
    const projection = buildPromptEvidenceProjection(
      documents,
      new Map(),
      FOCUSED_EVIDENCE_CHARACTER_BUDGET,
    );
    const values = projectedValues(projection);
    const summaries = values
      .filter(({ kind }) => kind === 'focused_request_summaries')
      .flatMap(({ requests }) => (Array.isArray(requests) ? requests : []));
    const detailedSeqs = new Set(
      values
        .filter(({ kind }) => kind === 'focused_request_structure')
        .map(({ recordingRequestSeq }) => recordingRequestSeq),
    );
    const previewSeqs = new Set(
      values
        .filter(({ kind }) => kind === 'focused_request_preview')
        .map(({ recordingRequestSeq }) => recordingRequestSeq),
    );

    expect(summaries.map(({ recordingRequestSeq }) => recordingRequestSeq)).toEqual([10, 20, 30]);
    expect(detailedSeqs).toEqual(new Set([10, 20]));
    expect(previewSeqs).toEqual(new Set([10, 20]));
    expect(JSON.stringify(values)).not.toContain('not-detailed');
    expect(values.at(-1)).toMatchObject({ kind: 'prompt_evidence_omissions' });
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      FOCUSED_EVIDENCE_CHARACTER_BUDGET,
    );
    const deliberatelySmallProjection = buildPromptEvidenceProjection(documents, new Map(), 8_000);
    expect(JSON.stringify(deliberatelySmallProjection).length).toBeLessThanOrEqual(8_000);
    expect(projectedValues(deliberatelySmallProjection).at(-1)).toMatchObject({
      kind: 'prompt_evidence_omissions',
      truncated: true,
      omittedDocuments: expect.any(Number),
    });
    expect(() =>
      buildPromptEvidenceProjection(
        documents,
        new Map(),
        1_000,
        new Set(['focused_request_summaries']),
      ),
    ).toThrow('required focused_request_summaries evidence cannot fit');
  });

  it('uses every owned request as detail when the detector leaves representatives empty', () => {
    const documents = focusedEvidenceDocuments({
      session: session(),
      scope: {
        toolId: 'search',
        toolName: 'search_catalog',
        requestSeqs: [10, 20],
        representativeSeqs: [],
        dependencySeqs: [],
        eventSeqs: [15],
      },
      independent: compareIndependentExecution(session(), []),
    });
    const detailedSeqs = new Set(
      documents
        .filter(({ value }) => value.kind === 'focused_request_preview')
        .map(({ value }) => value.recordingRequestSeq),
    );
    expect(detailedSeqs).toEqual(new Set([10, 20]));
  });
});

describe('teaching recording credential preparation', () => {
  it('uses shipped credential extraction before generic redaction', () => {
    const recording = session();
    const loginRequest = recording.requests[1];
    if (!loginRequest) throw new Error('fixture login request is missing');
    loginRequest.body = JSON.stringify({
      username: 'alice@example.test',
      password: 'correct horse battery staple',
    });
    const prepared = prepareRedactedTeachingSession(recording);

    expect(prepared.session.requests[1]?.body).toContain('${credential.username}');
    expect(prepared.session.requests[1]?.body).toContain('${credential.password}');
    expect(prepared.credentialValues).toEqual({
      username: 'alice@example.test',
      password: 'correct horse battery staple',
    });
    expect(prepared.credentialReplacements).toHaveLength(2);
  });
});

describe('raw replay capture mechanics', () => {
  it('keeps request identity stable when responses finish out of order', () => {
    const timestamps = [1_010, 1_020];
    const allocate = createReplayRequestIdentityAllocator(1_000, () => timestamps.shift() ?? 1_020);
    const first = allocate();
    const second = allocate();

    expect([second, first]).toEqual([
      { seq: 1, timestamp: 20 },
      { seq: 0, timestamp: 10 },
    ]);
  });

  it('accepts an empty input value and resolves complete credential placeholders', () => {
    expect(resolveReplayInputValue('', {})).toBe('');
    expect(resolveReplayInputValue(undefined, {})).toBeNull();
    expect(resolveReplayInputValue('${credential.username}', { username: 'alice' })).toBe('alice');
    expect(resolveReplayInputValue('${credential.missing}', {})).toBeNull();
  });
});
