import { describe, expect, it } from 'bun:test';
import {
  acceptedRequestComparisonCheck,
  acceptedRequestNotCheckedCheck,
  apiReplayProofSatisfied,
  bindProducerResultToConsumer,
  browserReplayNotApplicableCheck,
  extractJsonResultPath,
  implementationBoundApiReplayProofSatisfied,
  invocationOutcomeCheck,
} from '../src/imprint/master-teach-checks.ts';
import { ReceiptFactSchema } from '../src/imprint/master-teach-prompt-projections.ts';

const privateQuery = 'private-query-value';
const privateSession = 'private-session-value';
const privateResult = 'private-result-value';
const privateHostSecret = 'private-host-secret';

const recordedRequests = [
  {
    seq: 11,
    method: 'POST',
    url: `https://fixture.invalid/items?q=${privateQuery}`,
    headers: {
      'content-type': 'application/json',
      'x-session': privateSession,
    },
    body: JSON.stringify({ query: privateQuery, page: 1 }),
  },
  {
    seq: 22,
    method: 'GET',
    url: 'https://fixture.invalid/items/one',
    headers: { accept: 'application/json' },
  },
  {
    seq: 33,
    method: 'GET',
    url: 'https://fixture.invalid/items/two',
    headers: { accept: 'application/json' },
  },
] as const;

const artifactRequests = [
  {
    recordingRequestSeq: 11,
    method: 'POST',
    url: 'https://fixture.invalid/items?q=${param.query}',
    headers: {
      'content-type': 'application/json',
      'x-session': '${state.session}',
    },
    body: JSON.stringify({ query: '${param.query}', page: 1 }),
  },
  {
    recordingRequestSeq: 22,
    method: 'GET',
    url: 'https://fixture.invalid/items/one',
    headers: { accept: 'application/json' },
  },
  {
    recordingRequestSeq: 33,
    method: 'GET',
    url: 'https://fixture.invalid/items/two',
    headers: { accept: 'application/json' },
  },
] as const;

const provenance = [
  { artifactRequestIndex: 0, recordingRequestSeq: 11 },
  { artifactRequestIndex: 1, recordingRequestSeq: 22 },
  { artifactRequestIndex: 2, recordingRequestSeq: 33 },
] as const;

describe('accepted request comparison facts', () => {
  it('records an unavailable recorded baseline as not checked, never passed or failed', () => {
    const check = acceptedRequestNotCheckedCheck({ provenance });

    expect(check.status).toBe('not_checked');
    expect(check.facts.map(({ status }) => status)).toEqual([
      'not_checked',
      'not_checked',
      'not_checked',
    ]);
    expect(check.facts.every(({ kind }) => kind === 'request_comparison')).toBe(true);
    expect(apiReplayProofSatisfied(check.facts)).toBe(true);
    expect(implementationBoundApiReplayProofSatisfied(check.facts, undefined)).toBe(false);
    expect(implementationBoundApiReplayProofSatisfied(check.facts, 'recorded_baseline')).toBe(
      false,
    );
    expect(implementationBoundApiReplayProofSatisfied(check.facts, 'unavailable')).toBe(true);
  });

  it('keeps render failure distinct from unchecked request bytes', () => {
    const check = acceptedRequestNotCheckedCheck({
      provenance,
      hostError: new Error('offline render failed'),
    });

    expect(check.status).toBe('failed');
    expect(check.facts.map(({ status }) => status)).toEqual([
      'not_checked',
      'not_checked',
      'not_checked',
      'failed',
    ]);
    expect(check.facts.at(-1)).toMatchObject({ kind: 'host_error' });
    expect(apiReplayProofSatisfied(check.facts)).toBe(false);
  });

  it('does not accept a partial or mismatched replay as an unavailable baseline', () => {
    const partial = acceptedRequestComparisonCheck({
      provenance,
      recordedRequests,
      artifactRequests,
      hostError: { artifactRequestIndex: 1, error: new Error('render stopped') },
    });
    const mismatch = acceptedRequestComparisonCheck({
      provenance,
      recordedRequests,
      artifactRequests: artifactRequests.map((request, index) =>
        index === 0 ? { ...request, method: 'DELETE' } : request,
      ),
    });

    expect(apiReplayProofSatisfied(partial.facts)).toBe(false);
    expect(apiReplayProofSatisfied(mismatch.facts)).toBe(false);
  });

  it('projects passing exact provenance as value-free facts', () => {
    const check = acceptedRequestComparisonCheck({
      provenance,
      recordedRequests,
      artifactRequests,
    });

    expect(check.status).toBe('passed');
    expect(check.facts.map(({ status }) => status)).toEqual(['passed', 'passed', 'passed']);
    expect(check.facts.map((fact) => ReceiptFactSchema.parse(fact))).toEqual(check.facts);
    expect(implementationBoundApiReplayProofSatisfied(check.facts, undefined)).toBe(true);
    expect(check.facts).toMatchObject([
      { artifactRequestIndex: 0, recordingSeq: 11, remainingComparisons: 2 },
      { artifactRequestIndex: 1, recordingSeq: 22, remainingComparisons: 1 },
      { artifactRequestIndex: 2, recordingSeq: 33, remainingComparisons: 0 },
    ]);
    const expectedBytes = Buffer.byteLength(
      JSON.stringify({
        method: 'POST',
        url: recordedRequests[0].url,
        headers: [
          ['content-type', 'application/json'],
          ['x-session', privateSession],
        ],
        body: recordedRequests[0].body,
      }),
      'utf8',
    );
    const actualBytes = Buffer.byteLength(
      JSON.stringify({
        method: 'POST',
        url: artifactRequests[0].url,
        headers: [
          ['content-type', 'application/json'],
          ['x-session', '${state.session}'],
        ],
        body: artifactRequests[0].body,
      }),
      'utf8',
    );
    expect(expectedBytes).not.toBe(actualBytes);
    expect(check.facts[0]).toMatchObject({ expectedBytes, actualBytes });

    const serialized = JSON.stringify(check);
    expect(serialized).not.toContain(privateQuery);
    expect(serialized).not.toContain(privateSession);
    expect(serialized).not.toContain('${param.query}');
    expect(serialized).not.toContain('fixture.invalid');
  });

  it('stops at the first mismatch and marks every remaining comparison not checked', () => {
    const check = acceptedRequestComparisonCheck({
      provenance,
      recordedRequests,
      artifactRequests: [
        artifactRequests[0],
        { ...artifactRequests[1], method: 'POST' },
        artifactRequests[2],
      ],
    });

    expect(check.status).toBe('failed');
    expect(check.facts.map(({ status }) => status)).toEqual(['passed', 'failed', 'not_checked']);
    expect(check.facts[1]).toMatchObject({
      kind: 'request_comparison',
      artifactRequestIndex: 1,
      recordingSeq: 22,
      remainingComparisons: 1,
      expectedBytes: Buffer.byteLength('GET', 'utf8'),
      actualBytes: Buffer.byteLength('POST', 'utf8'),
      firstMismatchByte: 0,
    });
    expect(check.facts[2]).not.toHaveProperty('expectedBytes');
    expect(check.facts[2]).not.toHaveProperty('actualBytes');
  });

  it('stops before a host failure and reports it while leaving later targets not checked', () => {
    const check = acceptedRequestComparisonCheck({
      provenance,
      recordedRequests,
      artifactRequests,
      hostError: {
        artifactRequestIndex: 1,
        error: new Error(`transport failed for ${privateHostSecret}`),
      },
    });

    expect(check.status).toBe('failed');
    expect(check.facts.map(({ status }) => status)).toEqual([
      'passed',
      'not_checked',
      'not_checked',
      'failed',
    ]);
    expect(check.facts.at(-1)).toEqual({
      kind: 'host_error',
      subject: 'request.host',
      status: 'failed',
      hostError: `transport failed for ${privateHostSecret}`,
    });
  });

  it('preflights later artifact identity before an earlier mismatch can stop comparisons', () => {
    const forgedLater = [
      { ...artifactRequests[0], method: 'GET' },
      artifactRequests[1],
      { ...artifactRequests[2], recordingRequestSeq: 999 },
    ];
    expect(() =>
      acceptedRequestComparisonCheck({
        provenance,
        recordedRequests,
        artifactRequests: forgedLater,
      }),
    ).toThrow('artifact requests do not match accepted provenance');

    const sparse = new Array<(typeof artifactRequests)[number]>(artifactRequests.length);
    sparse[0] = artifactRequests[0];
    sparse[1] = artifactRequests[1];
    expect(() =>
      acceptedRequestComparisonCheck({
        provenance,
        recordedRequests,
        artifactRequests: sparse,
      } as never),
    ).toThrow('artifact requests do not match accepted provenance');
  });

  it('preflights every required recorded request before comparing', () => {
    expect(() =>
      acceptedRequestComparisonCheck({
        provenance,
        recordedRequests: recordedRequests.slice(0, 2),
        artifactRequests: [{ ...artifactRequests[0], method: 'GET' }, ...artifactRequests.slice(1)],
      }),
    ).toThrow('recorded requests do not match accepted provenance');
  });
});

describe('browser replay applicability', () => {
  it('returns N/A facts without representing an attempted request comparison', () => {
    const check = browserReplayNotApplicableCheck();

    expect(check).toEqual({
      status: 'not_applicable',
      facts: [
        {
          kind: 'invocation',
          subject: 'replay',
          status: 'not_applicable',
          invocationIndex: 0,
        },
      ],
    });
    expect(check.facts.some(({ kind }) => kind === 'request_comparison')).toBe(false);
  });
});

describe('safe result paths and chain binding', () => {
  it('extracts own JSON properties and numeric indices', () => {
    const result = {
      results: [{ token: 'opaque-token' }],
      nested: { 'item-id': 17 },
    };

    expect(extractJsonResultPath(result, 'results[0].token')).toEqual({
      ok: true,
      value: 'opaque-token',
    });
    expect(extractJsonResultPath(result, '$.nested["item-id"]')).toEqual({
      ok: true,
      value: 17,
    });
    expect(extractJsonResultPath(['first'], '[0]')).toEqual({
      ok: true,
      value: 'first',
    });
    const inherited = Object.create({ leaked: 'inherited-value' });
    expect(extractJsonResultPath(inherited, 'leaked')).toEqual({
      ok: false,
      reason: 'missing_path',
    });
    expect(
      extractJsonResultPath(
        JSON.parse('{"__proto__":{"token":"own-value"}}'),
        '["__proto__"].token',
      ),
    ).toEqual({
      ok: true,
      value: 'own-value',
    });
  });

  it('reports a missing result path without guessing another value', () => {
    expect(extractJsonResultPath({ results: [] }, 'results[0].token')).toEqual({
      ok: false,
      reason: 'missing_path',
    });
  });

  it('uses ordinary enumerable values while retaining non-JSON diagnostics', () => {
    let getterReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        getterReads++;
        return privateResult;
      },
    });
    const symbolValue = { value: 1 };
    Object.defineProperty(symbolValue, Symbol('extra'), {
      value: 2,
      enumerable: true,
    });
    const nonEnumerable = { value: 1 };
    Object.defineProperty(nonEnumerable, 'extra', {
      value: 2,
      enumerable: false,
    });
    const sparse = new Array(1);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const customArray = ['value'];
    Object.setPrototypeOf(customArray, Object.create(Array.prototype));
    const customObject = Object.create({ inherited: true }) as Record<string, unknown>;
    customObject.value = 1;

    expect(extractJsonResultPath(accessor, 'value')).toEqual({
      ok: true,
      value: privateResult,
    });
    expect(getterReads).toBe(1);
    for (const value of [sparse, cyclic, Number.POSITIVE_INFINITY, { value: Number.NaN }]) {
      expect(extractJsonResultPath(value, '$')).toEqual({
        ok: false,
        reason: 'non_json_value',
      });
    }
    for (const value of [symbolValue, nonEnumerable, customArray, customObject]) {
      expect(extractJsonResultPath(value, '$').ok).toBe(true);
    }
  });

  it('binds the exact scalar only to a matching declared consumer parameter', () => {
    const bound = bindProducerResultToConsumer({
      edge: {
        producerResultPath: 'results[0].token',
        consumerParameter: 'selection_token',
      },
      producerResult: { results: [{ token: privateResult }] },
      consumerParameterDeclarations: [{ name: 'selection_token', type: 'string' }],
      consumerParameters: { locale: 'en' },
    });

    expect(bound).toEqual({
      ok: true,
      parameters: { locale: 'en', selection_token: privateResult },
    });
    expect(
      bindProducerResultToConsumer({
        edge: {
          producerResultPath: 'results[0].token',
          consumerParameter: 'selection_token',
        },
        producerResult: { results: [{ token: 19 }] },
        consumerParameterDeclarations: [{ name: 'selection_token', type: 'string' }],
      }),
    ).toEqual({ ok: false, reason: 'parameter_type_mismatch' });
  });

  it('copies ordinary own consumer parameters without mutating the input', () => {
    let getterReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'locale', {
      enumerable: true,
      get() {
        getterReads++;
        return 'en';
      },
    });
    const symbolValue = { locale: 'en' };
    Object.defineProperty(symbolValue, Symbol('extra'), {
      value: 'hidden',
      enumerable: true,
    });
    const nonEnumerable = { locale: 'en' };
    Object.defineProperty(nonEnumerable, 'extra', {
      value: 'hidden',
      enumerable: false,
    });
    const customPrototype = Object.create({ inherited: 'hidden' }) as Record<string, string>;
    customPrototype.locale = 'en';

    const bind = (consumerParameters: unknown) =>
      bindProducerResultToConsumer({
        edge: {
          producerResultPath: 'token',
          consumerParameter: 'selection_token',
        },
        producerResult: { token: privateResult },
        consumerParameterDeclarations: [{ name: 'selection_token', type: 'string' }],
        consumerParameters: consumerParameters as never,
      });
    for (const parameters of [{ 'bad-name': 'value' }, { count: Number.POSITIVE_INFINITY }]) {
      expect(bind(parameters)).toEqual({
        ok: false,
        reason: 'invalid_consumer_parameters',
      });
    }
    for (const parameters of [accessor, symbolValue, nonEnumerable, customPrototype]) {
      expect(bind(parameters)).toEqual({
        ok: true,
        parameters: { locale: 'en', selection_token: privateResult },
      });
    }
    expect(getterReads).toBe(1);
    expect(accessor).not.toHaveProperty('selection_token');

    const nullPrototype = Object.create(null) as Record<string, string>;
    Object.defineProperty(nullPrototype, 'locale', {
      value: 'en',
      enumerable: true,
    });
    expect(bind(nullPrototype)).toEqual({
      ok: true,
      parameters: { locale: 'en', selection_token: privateResult },
    });

    const specialName = bindProducerResultToConsumer({
      edge: { producerResultPath: 'token', consumerParameter: '__proto__' },
      producerResult: { token: privateResult },
      consumerParameterDeclarations: [{ name: '__proto__', type: 'string' }],
    });
    expect(specialName.ok).toBe(true);
    if (specialName.ok) {
      expect(Object.hasOwn(specialName.parameters, '__proto__')).toBe(true);
      expect(specialName.parameters.__proto__).toBe(privateResult);
    }
  });
});

describe('invocation outcome facts', () => {
  it('counts returned top-level results without copying their values', () => {
    const check = invocationOutcomeCheck({
      subject: 'live',
      invocationIndex: 2,
      durationMs: 19,
      executionMechanism: 'cdp-replay',
      outcome: {
        kind: 'returned',
        result: {
          ok: true,
          data: [{ value: privateResult }, { value: privateSession }],
        },
      },
    });

    expect(check).toEqual({
      status: 'passed',
      facts: [
        {
          kind: 'invocation',
          subject: 'live',
          status: 'passed',
          invocationIndex: 2,
          durationMs: 19,
          executionMechanism: 'cdp-replay',
        },
        { kind: 'result', subject: 'live', status: 'passed', resultCount: 2 },
      ],
    });
    expect(JSON.stringify(check)).not.toContain(privateResult);
    expect(JSON.stringify(check)).not.toContain(privateSession);
  });

  it('reports bounded host errors and emits no unbounded outcome fields', () => {
    const check = invocationOutcomeCheck({
      subject: 'chain',
      invocationIndex: 0,
      outcome: {
        kind: 'host_error',
        error: new Error(`host rejected ${privateHostSecret}`),
      },
    });

    expect(check.status).toBe('failed');
    expect(check.facts.map(({ kind }) => kind)).toEqual(['invocation', 'result', 'host_error']);
    expect(check.facts.at(-1)).toMatchObject({
      hostError: `host rejected ${privateHostSecret}`,
    });
    expect(check.facts.map((fact) => ReceiptFactSchema.parse(fact))).toEqual(check.facts);
  });

  it('does not copy a returned failure message into receipt facts', () => {
    const check = invocationOutcomeCheck({
      subject: 'live',
      invocationIndex: 0,
      outcome: {
        kind: 'returned',
        result: {
          ok: false,
          error: 'BAD_RESPONSE',
          message: `response contained ${privateResult}`,
        },
      },
    });

    expect(check.status).toBe('failed');
    expect(JSON.stringify(check)).not.toContain(privateResult);
  });
});
