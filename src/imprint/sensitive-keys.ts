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

// `normalizeKey` (defined below) lowercases and strips `_`/`-` — set
// membership goes through it, so we MUST pre-normalize the stored entries
// or lookups for e.g. `j_password` (→ `jpassword`) will miss a stored
// `j_password`. Hoisting a local copy of the rule rather than ordering
// gymnastics keeps the file linear.
const _normalize = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map(_normalize));

/** Subset of SENSITIVE_KEYS that specifically denote a credential (not PII).
 *  Used by credential-extract.ts when looking for the password half of a
 *  login form pair — we don't want to treat e.g. `dob` as a password.
 *
 *  Inclusion criterion: a key name that, when present in a request body
 *  alongside a username-like partner, almost always means "this is the
 *  password the user typed at login time." Be liberal here — false positives
 *  cost the user one extra prompt confirmation; false negatives ship broken
 *  tools. New additions should reference a real recorded site that broke
 *  without them.
 *
 *  Sites observed needing each entry:
 *    - password / passwd / pwd:                most modern APIs
 *    - pin:                                    bank / utility login forms
 *    - pass:                                   legacy PHP forms (e.g. SMF)
 *    - secret:                                 OAuth ROPC payloads
 *    - j_password:                             Java EE / Spring Security default form-login
 *    - userpassword / loginpassword / accountpassword:
 *                                              vendor SSO portals that namespace fields
 *    - patronpassword / patron_password:       Discover & Go libraries (kept for back-compat)
 */
const PASSWORD_LIKE_ENTRIES = [
  'password',
  'passwd',
  'pwd',
  'pin',
  'pass',
  'secret',
  'j_password',
  'userpassword',
  'loginpassword',
  'accountpassword',
  'patronpassword',
  'patron_password',
];
const PASSWORD_LIKE_KEYS = new Set(PASSWORD_LIKE_ENTRIES.map(_normalize));

/** Subset of SENSITIVE_KEYS that specifically denote a username/email/login
 *  identifier — the partner half of a username+password login pair.
 *
 *  Same inclusion criterion as PASSWORD_LIKE_KEYS: liberal coverage of real
 *  recorded forms, narrow enough not to match arbitrary identifiers. Note
 *  this set is intentionally distinct from `email`, `phone` etc. in
 *  SENSITIVE_KEYS — those get redacted as PII regardless, but only the
 *  subset here qualifies as the "username partner" the credential extractor
 *  pairs with a password.
 *
 *  Sites observed needing each entry:
 *    - user / username / user_name / userid / user_id:
 *                                              most APIs
 *    - login / loginid / login_id / login_email:
 *                                              REST endpoints that name the form field after the action
 *    - email / emailaddress / email_address:   email-as-username flows
 *    - account / accountid / account_id:       enterprise SSO portals
 *    - patron / patronnumber / patron_number / patronid / patron_id:
 *                                              library systems (Discover & Go)
 *    - j_username:                             Java EE / Spring Security default form-login
 *    - signin / signinid / sign_in_id:         vendor SSO portals (Okta-style)
 *    - usr / uid:                              legacy CGI / older PHP
 *    - memberid / member_id / membername / member_name:
 *                                              membership-driven sites (gyms, clubs)
 *    - customerid / customer_id / customernumber / customer_number:
 *                                              ecommerce account portals
 *    - clientid / client_id / clientnumber / client_number:
 *                                              B2B portals (CAUTION: also matches OAuth client_id;
 *                                              credential-extract.ts gates on having a password
 *                                              partner in the same parent, so OAuth token endpoints
 *                                              that pass client_id without a password won't match)
 */
const USERNAME_LIKE_KEYS = new Set(
  [
    'user',
    'username',
    'user_name',
    'userid',
    'user_id',
    'login',
    'loginid',
    'login_id',
    'loginemail',
    'login_email',
    'email',
    'emailaddress',
    'email_address',
    'account',
    'accountid',
    'account_id',
    'patron',
    'patronnumber',
    'patron_number',
    'patronid',
    'patron_id',
    'j_username',
    'signin',
    'signinid',
    'sign_in_id',
    'usr',
    'uid',
    'memberid',
    'member_id',
    'membername',
    'member_name',
    'customerid',
    'customer_id',
    'customernumber',
    'customer_number',
    'clientid',
    'client_id',
    'clientnumber',
    'client_number',
  ].map(_normalize),
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

/** Sensitive headers that are INHERENTLY per-session/per-user auth — they carry a
 *  credential, never public app config. Unlike `x-api-key` / `x-csrf-token` (which a
 *  site can legitimately bake into its JS as a constant), an `Authorization` /
 *  session-token header is never a "page-minted constant", so it must never be
 *  exempted from the emit-time secret guard. Used by `detectPageMintedHeaders`. */
const ALWAYS_SECRET_HEADER_SET = new Set([
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-session-token',
]);

export const normalizeKey = _normalize;

/** True if the key name suggests a sensitive value (auth, payment, PII). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

/** True if the key name suggests a *password* specifically (not arbitrary
 *  PII). Used when pairing a username + password in extraction. */
export function isSensitiveCredentialKey(key: string): boolean {
  return PASSWORD_LIKE_KEYS.has(normalizeKey(key));
}

/** True if the key name suggests a username/email/login identifier — the
 *  partner half of a login pair. Used in credential extraction and in the
 *  pre-emit guardrail that flags workflows templating credentials as plain
 *  parameters. */
export function isUsernameLikeKey(key: string): boolean {
  return USERNAME_LIKE_KEYS.has(normalizeKey(key));
}

/** True for either half of a login pair (username or password). Used by the
 *  pre-emit guardrail and the post-redact pairing audit, which both need to
 *  decide "is this parameter name credential-shaped?" without caring which
 *  half. */
export function isLoginFieldKey(key: string): boolean {
  const n = normalizeKey(key);
  return PASSWORD_LIKE_KEYS.has(n) || USERNAME_LIKE_KEYS.has(n);
}

/** Raw password-like key strings (pre-normalization) for callers that need
 *  substring matching against raw body text rather than parsed key lookup. */
export function passwordLikeTokens(): readonly string[] {
  return PASSWORD_LIKE_ENTRIES;
}

export function isSensitiveHeader(header: string): boolean {
  return SENSITIVE_HEADER_SET.has(header.toLowerCase());
}

/** True for a header that inherently carries a per-session/per-user credential
 *  (Authorization / session token) — never a public page constant. */
export function isAlwaysSecretHeader(header: string): boolean {
  return ALWAYS_SECRET_HEADER_SET.has(header.toLowerCase());
}
