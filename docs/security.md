# Sensitive data and credentials

Imprint is a local development tool. It preserves recorded and live API data so
agents can understand requests, responses, and producer-consumer relationships.

## Credential-only substitution

Imprint replaces known user-supplied login values with named credential
placeholders. Password inputs are also masked in captured DOM events. The login
extractor identifies username/password pairs in submitted requests; explicit
credential replacements and values in the credential store remain supported.

There is no automatic PII, token-shape, cookie, storage, header, or response-field
redaction. Email addresses, phone numbers, API tokens, session cookies, and opaque
continuation values remain visible unless they are the exact known login value
being protected. API framing and ordinary wire bytes are not rewritten by a
generic scanner.

The historical command `imprint redact <session.json>` now performs only this
credential substitution. Its `.redacted.json` output is **not safe to share**.
The old `--keep-header` flag is accepted for compatibility but has no effect:
headers are retained. `IMPRINT_REDACT_SENSITIVE_HEADERS` no longer enables a
second masking policy.

## Files and provider visibility

Recordings, teach workspaces, generated tools, verifier evidence, and logs can
contain session tokens and personal data. Keep them local and review them before
sharing, uploading, or committing. This also applies to files whose names contain
“redacted” or “sanitized”; those names are retained for format compatibility.

Teaching sends selected recording and live-result evidence to the chosen model
provider. This evidence now includes ordinary token and cookie values and any
personal data in the response. Trace logs can contain the same information.
Choose sites and provider settings accordingly.

## Credential storage and execution

Named credentials are loaded from the configured credential backend, with OS
keychain and encrypted-file support. Runtime credential placeholders remain
supported. Existing recordings and generated workflow formats are unchanged.

Authentication verification keeps known user-supplied login values masked in
diagnostics, but does not hide unrelated session cookies or server continuation
state. Passwords and other explicit login values should remain credential
references in generated artifacts.

Removing generic redaction does not change cancellation, schema validation,
execution permissions, or the treatment of irreversible actions. Those are
separate from data visibility.

## Sharing and recovery

Do not attach raw recordings or logs to public issues. Review and remove anything
you do not want to disclose before sharing a file. If you expose a live credential
or session token, revoke or rotate it at the relevant service.

Report security issues privately to <security@imprint.dev> or through the
[private advisory form](https://github.com/ashaychangwani/imprint/security/advisories/new).
