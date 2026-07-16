import { describe, expect, test } from 'bun:test';
import { jsonpath } from '../src/imprint/request-capture.ts';

describe('jsonpath', () => {
  test('accepts an optional leading root marker', () => {
    const root = { access_token: 'token-value', nested: { id_token: 'id-value' } };

    expect(jsonpath(root, 'access_token')).toBe('token-value');
    expect(jsonpath(root, '$.access_token')).toBe('token-value');
    expect(jsonpath(root, '$.nested.id_token')).toBe('id-value');
    expect(jsonpath(root, '$')).toEqual(root);
  });

  test('supports a root array after the root marker', () => {
    const root = [{ id: 137352 }, { id: 165264 }];

    expect(jsonpath(root, '[0].id')).toBe(137352);
    expect(jsonpath(root, '$[0].id')).toBe(137352);
    expect(jsonpath(root, '$[1].id')).toBe(165264);
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
