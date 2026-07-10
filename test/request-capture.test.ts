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

  test('keeps bracketed dotted keys literal', () => {
    const root = { 'customers.userInformation.accountNumber': '12345' };

    expect(jsonpath(root, '[customers.userInformation.accountNumber]')).toBe('12345');
    expect(jsonpath(root, '$.[customers.userInformation.accountNumber]')).toBe('12345');
  });

  test('supports compact and standard field predicates', () => {
    const root = {
      challenges: [
        { category: 'SMS', token: 'sms-token' },
        { category: 'PUSH_NOTIFICATION', token: 'push-token' },
      ],
    };

    expect(jsonpath(root, 'challenges[category=PUSH_NOTIFICATION].token')).toBe('push-token');
    expect(jsonpath(root, "$.challenges[?(@.category=='PUSH_NOTIFICATION')].token")).toBe(
      'push-token',
    );
    expect(jsonpath(root, '$.challenges[?(@.category=="PUSH_NOTIFICATION")].token')).toBe(
      'push-token',
    );
  });
});
