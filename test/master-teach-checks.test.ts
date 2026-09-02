import { describe, expect, it } from 'bun:test';
import {
  bindProducerResultToConsumer,
  extractJsonResultPath,
  invocationOutcomeCheck,
} from '../src/imprint/master-teach-checks.ts';
import { ReceiptFactSchema } from '../src/imprint/master-teach-prompt-projections.ts';

const privateSession = 'private-session-value';
const privateResult = 'private-result-value';
const privateHostSecret = 'private-host-secret';

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

  it('uses an explicit object count instead of counting the wrapper as one result', () => {
    const check = invocationOutcomeCheck({
      subject: 'live',
      invocationIndex: 0,
      outcome: {
        kind: 'returned',
        result: {
          ok: true,
          data: { entries: [], count: 0, route: { origin: 'AAA', destination: 'BBB' } },
        },
      },
    });

    expect(check.facts).toContainEqual({
      kind: 'result',
      subject: 'live',
      status: 'passed',
      resultCount: 0,
    });
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
