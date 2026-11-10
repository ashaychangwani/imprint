# Sensitive data and credentials

Imprint is a local development tool. It preserves recorded and live API data so
agents can understand requests, responses, and producer-consumer relationships.

## Credential-only substitution

Imprint replaces known user-supplied login values with named credential
placeholders. Password inputs are also masked in captured DOM events. The login
extractor identifies username/password pairs in submitted requests; explicit
credential replacements and values in the credential store remain supported.

Already-redacted recordings keep existing `${credential.NAME}` references.
These references are excluded from extracted literal credentials, so they cannot
overwrite stored secrets. Auth verification resolves them through the local
credential backend; an absent value remains a missing credential.

During auth discovery, browser fill actions resolve credential and current
human-answer references inside the host. Known credentials and values supplied
through those fill actions are masked before captured evidence reaches agents
or the private auth evidence session. Network captures retain other ordinary
request/response data under the same visibility policy as recordings. The
working session and live provenance index use private (`0600`) files; the original
recordings are not overwritten.

There is no automatic PII, token-shape, cookie, storage, header, or response-field
redaction. Email addresses, phone numbers, API tokens, session cookies, and opaque
continuation values remain visible unless they are the exact known login value
being protected. API framing and ordinary wire bytes are not rewritten by a
generic scanner.

The historical command `imprint redact <session.json>` now performs only this
credential substitution. Its `.redacted.json` output is **not safe to share**.
The command replaces that file atomically with private (`0600`) permissions.
The old `--keep-header` flag is accepted for compatibility but has no effect:
headers are retained. `IMPRINT_REDACT_SENSITIVE_HEADERS` no longer enables a
second masking policy.

Optional credential-path diagnostics contain opaque keyed identities and counts,
not secret/request values. `IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH` writes private
JSONL plus a private sibling `.key` file. Keep that key local: it scopes comparisons
within the run and prevents stable hashes of low-entropy secrets from becoming
public identifiers. Prepared headers and browser-owned cookies remain distinct
observations. These diagnostics do not redact other recording or trace artifacts.

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

Foreground terminal questions can collect secret input with masking. Agents
receive temporary `${prompt.<id>}` references; host verification resolves them
without adding the answer to agent messages. Ordinary answers are visible to the
agent. Secret answers live in memory for the run and are cleared when it ends;
they are not added to stored credentials automatically. Compiler subprocesses
reach the parent terminal through a run-local loopback bridge. This does not
change the visibility of recorded data or unrelated live cookies and tokens.
Declared nonsecret auth choices are returned as typed visible values; secret
and free-text auth responses remain opaque references.

A successful browser-backed data call may update the saved cookie snapshot it
loaded, using a conditional write that leaves newer authentication untouched.
This updates cookies only; it does not replace saved secrets or browser storage.
Manual or synthetic credential overrides without a durable read version do not
write back. Cookie-seeding failures prevent a partial browser snapshot from
being saved as removals. Host-only and domain cookie scopes remain distinct,
even when name, domain host and path otherwise match. Restoration retains that
distinction rather than turning a domain cookie into a host-only cookie.

Run-owned authentication contexts retain their browser and compiler conversation
for later recovery, and close when the teach ends. Auth checkpoint references
remain usable during repairs to the current challenge, then expire at the next
authentication request or explicit fresh verification session. Retaining context
does not answer a new MFA question or authorize reusing an earlier approval.

Removing generic redaction does not change cancellation, schema validation,
execution permissions, or the treatment of irreversible actions. Those are
separate from data visibility.

## Sharing and recovery

Do not attach raw recordings or logs to public issues. Review and remove anything
you do not want to disclose before sharing a file. If you expose a live credential
or session token, revoke or rotate it at the relevant service.

Report security issues privately to <security@imprint.dev> or through the
[private advisory form](https://github.com/ashaychangwani/imprint/security/advisories/new).
