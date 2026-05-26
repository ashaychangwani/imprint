/**
 * Tests for the sensitive-key dictionaries that drive both redaction and
 * credential-pair extraction. Synthetic strings only — see CLAUDE.md "Test
 * data hygiene".
 */

import { describe, expect, it } from 'bun:test';
import {
  isLoginFieldKey,
  isSensitiveCredentialKey,
  isSensitiveHeader,
  isSensitiveKey,
  isUsernameLikeKey,
  normalizeKey,
} from '../src/imprint/sensitive-keys.ts';

describe('normalizeKey', () => {
  it('lowercases and strips underscores + hyphens', () => {
    expect(normalizeKey('User_Name')).toBe('username');
    expect(normalizeKey('access-token')).toBe('accesstoken');
    expect(normalizeKey('J_PASSWORD')).toBe('jpassword');
  });
});

describe('isSensitiveCredentialKey — broadened password dictionary', () => {
  const passwordLike = [
    'password',
    'Password',
    'PASSWORD',
    'passwd',
    'pwd',
    'pin',
    'pass',
    'secret',
    'j_password',
    'J_Password',
    'userpassword',
    'user_password',
    'loginpassword',
    'login_password',
    'accountpassword',
    'patronpassword',
    'patron_password',
  ];
  for (const k of passwordLike) {
    it(`matches "${k}"`, () => {
      expect(isSensitiveCredentialKey(k)).toBe(true);
    });
  }

  const notPassword = [
    'username',
    'email',
    'authcode',
    'api_key',
    'csrf_token',
    'fingerprint',
    'dob',
    'phone',
    'firstname',
    'cardnumber',
  ];
  for (const k of notPassword) {
    it(`does not match "${k}"`, () => {
      expect(isSensitiveCredentialKey(k)).toBe(false);
    });
  }
});

describe('isUsernameLikeKey — partner-of-password dictionary', () => {
  const usernameLike = [
    'user',
    'username',
    'User_Name',
    'userid',
    'user_id',
    'login',
    'loginid',
    'login_email',
    'email',
    'email_address',
    'EmailAddress',
    'account',
    'account_id',
    'patron',
    'patron_id',
    'patron_number',
    'j_username',
    'J_Username',
    'signin',
    'sign_in_id',
    'usr',
    'uid',
    'memberid',
    'member_name',
    'customerid',
    'customer_number',
    'clientid',
  ];
  for (const k of usernameLike) {
    it(`matches "${k}"`, () => {
      expect(isUsernameLikeKey(k)).toBe(true);
    });
  }

  const notUsername = [
    'password',
    'authcode',
    'api_key',
    'csrf_token',
    'fingerprint',
    'firstname',
    'phone',
    'address',
    'order_id',
    'item_id',
    'store_id',
  ];
  for (const k of notUsername) {
    it(`does not match "${k}"`, () => {
      expect(isUsernameLikeKey(k)).toBe(false);
    });
  }
});

describe('isLoginFieldKey', () => {
  it('matches either half of a login pair', () => {
    expect(isLoginFieldKey('userid')).toBe(true);
    expect(isLoginFieldKey('password')).toBe(true);
    expect(isLoginFieldKey('j_username')).toBe(true);
    expect(isLoginFieldKey('j_password')).toBe(true);
  });

  it('does not match unrelated credential-shaped keys', () => {
    expect(isLoginFieldKey('csrf_token')).toBe(false);
    expect(isLoginFieldKey('api_key')).toBe(false);
    expect(isLoginFieldKey('fingerprint')).toBe(false);
  });
});

describe('isSensitiveKey (broad redaction list — regression coverage)', () => {
  it('still matches the original entries after broadening', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('email')).toBe(true);
    expect(isSensitiveKey('ssn')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
  });
});

describe('isSensitiveHeader', () => {
  it('matches canonical auth headers', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('cookie')).toBe(true);
    expect(isSensitiveHeader('X-API-Key')).toBe(true);
  });

  it('does not match arbitrary headers', () => {
    expect(isSensitiveHeader('Content-Type')).toBe(false);
    expect(isSensitiveHeader('User-Agent')).toBe(false);
  });
});
