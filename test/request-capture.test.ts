import { describe, expect, test } from 'bun:test';
import { jsonpath, resolveJsonCapture } from '../src/imprint/request-capture.ts';

describe('jsonpath', () => {
  test('accepts an optional leading root marker', () => {
    const root = { access_token: 'token-value', nested: { id_token: 'id-value' } };

    expect(jsonpath(root, 'access_token')).toBe('token-value');
    expect(jsonpath(root, '$.access_token')).toBe('token-value');
    expect(jsonpath(root, '$.nested.id_token')).toBe('id-value');
    expect(jsonpath(root, '$')).toEqual(root);
  });

  test('keeps bracketed dotted keys literal', () => {
    const root = { 'customers.userInformation.accountNumber': '12345' };

    expect(jsonpath(root, '[customers.userInformation.accountNumber]')).toBe('12345');
    expect(jsonpath(root, '$.[customers.userInformation.accountNumber]')).toBe('12345');
  });

  test('supports compact and standard field predicates', () => {
    const root = {
      items: [
        { category: 'SECONDARY', token: 'secondary-token' },
        { category: 'PRIMARY', token: 'primary-token' },
      ],
    };

    expect(jsonpath(root, 'items[category=PRIMARY].token')).toBe('primary-token');
    expect(jsonpath(root, "$.items[?(@.category=='PRIMARY')].token")).toBe('primary-token');
    expect(jsonpath(root, '$.items[?(@.category=="PRIMARY")].token')).toBe('primary-token');
  });
});

describe('resolveJsonCapture', () => {
  test('decodes one JSON-string envelope and preserves a wire-escaped slash exactly', () => {
    const token = 'fixture/segment+token=';
    const encodedEnvelope = `{"session":{"token":"fixture\\/segment+token="}}`;
    const response = JSON.parse(JSON.stringify({ payload: encodedEnvelope }));

    expect(resolveJsonCapture(response, '$.payload', '$.session.token')).toBe(token);
  });

  test('returns undefined when the selected envelope is not valid JSON', () => {
    expect(resolveJsonCapture({ payload: 'not-json' }, 'payload', 'token')).toBe(undefined);
    expect(resolveJsonCapture({ payload: {} }, 'payload', 'token')).toBe(undefined);
  });
});
