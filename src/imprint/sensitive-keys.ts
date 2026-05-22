/**
 * Shared list of sensitive credential key names. Used by `redact.ts` to scrub
 * values, and by `credential-extract.ts` to detect login pairs.
 *
 * Case-insensitive; underscores and hyphens are stripped before matching, so
 * `password`, `Pass_Word`, `PASS-WORD`, `pwd` all match.
 */

const SENSITIVE_KEYS = [
  // Credentials — login identifiers
  'user',
  'username',
  'user_name',
  'userid',
  'user_id',
  'login',
  'loginid',
  'login_id',
  // Credentials — passwords & secrets
  'pass',
  'password',
  'passwd',
  'pwd',
  'pin',
  'secret',
  'credential',
  'credentials',
  // Tokens & session identifiers
  'token',
  'auth',
  'authcode',
  'auth_code',
  'apikey',
  'api_key',
  'apitoken',
  'api_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessionid',
  'session_id',
  'sessiontoken',
  'session_token',
  'authorization',
  'authentication',
  'bearer',
  // CSRF / XSRF
  'csrf',
  'csrf_token',
  'csrftoken',
  'xsrf',
  'xsrf_token',
  'xsrftoken',
  // MFA / OTP
  'otp',
  'totp',
  'mfa_code',
  'mfacode',
  'verification_code',
  'verificationcode',
  'oktaemail',
  'okta_email',
  // Device / browser fingerprinting
  'fingerprint',
  // Site-specific (Discover & Go uses these)
  'patronpassword',
  'patron_password',
  'patronnumber',
  'patron_number',
  'cardnumber',
  'card_number',
  'librarycard',
  'library_card',
  // Stripe / payments
  'cvc',
  'cvv',
  'cardnum',
  'card_num',
  'creditcard',
  'credit_card',
  'cc_number',
  // PII — contact
  'email',
  'emailaddress',
  'email_address',
  'phone',
  'phonenumber',
  'phone_number',
  'mobile',
  'cell',
  'sms',
  'smsnumber',
  'sms_number',
  // PII — names
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  'nameoncard',
  'name_on_card',
  // PII — government / identity
  'ssn',
  'socialsecurity',
  'social_security',
  'dateofbirth',
  'date_of_birth',
  'dob',
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** Subset of SENSITIVE_KEYS that specifically denote a credential (not PII).
 *  Used by credential-extract.ts when looking for the password half of a
 *  login form pair — we don't want to treat e.g. `dob` as a password. */
const PASSWORD_LIKE_KEYS = new Set(
  ['password', 'passwd', 'pwd', 'pin', 'patronpassword', 'patron_password'].map((k) =>
    k.toLowerCase(),
  ),
);

const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-api-key',
  'x-apikey',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'proxy-authorization',
];

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS.map((h) => h.toLowerCase()));

export const normalizeKey = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');

/** True if the key name suggests a sensitive value (auth, payment, PII). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

/** True if the key name suggests a *password* specifically (not arbitrary
 *  PII). Used when pairing a username + password in extraction. */
export function isSensitiveCredentialKey(key: string): boolean {
  return PASSWORD_LIKE_KEYS.has(normalizeKey(key));
}

export function isSensitiveHeader(header: string): boolean {
  return SENSITIVE_HEADER_SET.has(header.toLowerCase());
}
