# Security

Imprint records real browser sessions. That means it sees credentials, session cookies, PII, and anything else you type into the page. This document covers what Imprint does to protect that data, what it doesn't, and how to handle disclosures.

## What Imprint stores on disk

Recording produces:

| File | Contains | Where |
|---|---|---|
| `<ts>.jsonl` | Full request bodies, response bodies, headers (incl. `Authorization`, `Cookie`, `Set-Cookie`), cookie snapshots, storage snapshots | `~/.imprint/<site>/sessions/` |
| `<ts>.json` | Same, assembled | `~/.imprint/<site>/sessions/` |

A `teach`/`generate` compile also writes one short-lived artifact: `~/.imprint/<site>/.stealth-token.json` — a freshly-minted stealth-fetch token (anti-bot cookies + sensor headers) shared across the compile-time `bun test` processes so they don't each re-bootstrap headless Chromium. It is transient (ignored once older than 10 minutes), best-effort removed when the teach run ends, and lives outside the repo. It holds a live session token, so treat it like the rest of `~/.imprint/<site>/` — local-sensitive, never committed.

Sessions are **not** redacted on disk by default. `imprint generate` and `imprint compile-playbook` auto-redact in memory before LLM calls — if the session does not already contain `[REDACTED:` markers, the pipeline runs the full redaction pass and logs the count. If auto-redaction produces zero redactions on a session that contains auth-like requests, treat it as suspicious and run `imprint redact` manually to audit. `imprint redact` writes a reviewable redacted artifact you can audit or share.

MCP cleanup is conservative around recordings. `imprint mcp delete <site>` removes external MCP registrations only; `--local tool` removes generated tool directories but keeps sessions; `--local site` is the explicit option that removes the site directory and its recordings. Reversible disables for clients without native disable support write `<IMPRINT_HOME>/.mcp-disabled.json`; treat that file as local-sensitive too because it preserves the full MCP server definition, including any `env` values from the client config.

## Redaction pipeline

Always run `imprint redact` before:
- Auditing what will be visible to the LLM. `imprint generate` and `imprint compile-playbook` auto-redact in memory if needed, but a redacted file is easier to inspect.
- Sharing a session in a bug report or PR.
- Committing one to git.

```bash
imprint redact ~/.imprint/<site>/sessions/<ts>.json
# → ~/.imprint/<site>/sessions/<ts>.redacted.json
```

What gets scrubbed:
- Values of any field whose name matches the [SENSITIVE_KEYS](../src/imprint/redact.ts) list (passwords, tokens, API keys, session IDs, CSRF tokens, common patron-ID patterns, etc.) — replaced with redaction markers. New redacted artifacts use equality-preserving markers such as `[REDACTED:v3:id=7:len=24]`; old `[REDACTED:N]` markers remain accepted but do not preserve equality hints.
- Cookie and `Set-Cookie` values are redacted structure-aware: cookie names and safe attributes remain visible, while values become equality markers. This lets the compiler see that an earlier response cookie became a later request header without exposing the cookie value.
- Common free-form PII and secrets in text-like **request** bodies, JSON string values, URL path segments, captured storage, and captured DOM / WebSocket event details. This supplemental scan catches emails, phone numbers, SSNs, payment cards, JWTs, API keys, private keys, database URLs, webhook URLs, and package-registry tokens, plus keyword-anchored secret assignments (`password=…`, `*_SECRET=…`, OAuth secrets). The generic value-shape catch-alls were intentionally removed because they over-matched benign data (e.g. long numeric IDs).
- **Response bodies are redacted by sensitive field name only** — there is no free-form value scan on responses. This keeps redaction focused on the real secrets in a recording (post-login cookies and user-entered PII, both captured elsewhere) and, critically, avoids corrupting structured RPC envelopes (e.g. Google `batchexecute`) whose payloads are doubly-encoded JSON and would be broken by flat-text scrubbing.

Equality marker IDs are scoped to one redacted artifact. They contain no hash of the original secret, are not stable across redaction runs, and are never valid runtime placeholders. Generated workflows should reference semantic capture names such as `${state.csrf}`, never marker IDs.

## What redaction doesn't catch

This is a best-effort tool — we deliberately undersell it. It will NOT catch:

- **Custom field names** a site invents that don't match the `SENSITIVE_KEYS` patterns.
- **Contextual or site-specific secrets** that do not match either the structured key list or the supplemental free-form patterns.
- **Free-form PII echoed inside response bodies** — responses are scrubbed by field name only, so a secret a server returns under an unrecognized key (or inside an RPC envelope) is not value-scanned. Audit manually if a site returns sensitive data in responses.
- **Non-standard encodings** (compressed bodies, encrypted blobs, unusual base64 packing, or values split across fields).
- **WebSocket frame content beyond the captured preview**.

If you're using Imprint on a site with unusual auth, **audit the redacted session manually** before generating against it.

## Sensitive headers are visible to the compile agent by default

To wire an auth/session/gateway header (`Authorization`, `Cookie`, `X-API-Key`, `X-CSRF-Token`, …) as a contracted input, the compile agent has to be able to *read* its value — it cannot reason about a value it cannot see, and blinding it was the root cause of dropped auth/session inputs that shipped broken tools. So the redaction pass the compile agent's session goes through **no longer redacts sensitive-header values by default**:

- **Credential placeholdering still runs** — values the credential-extract pass identified (the password/username the user typed) are rewritten to `${credential.X}` before the agent ever sees them.
- **Free-form PII redaction still runs** — emails, phone numbers, and other value-pattern matches in bodies and event details are still scrubbed.
- **Only the blanket sensitive-*header* scrub is off.** Re-enable the legacy behavior with `IMPRINT_REDACT_SENSITIVE_HEADERS=1` (or `redactSensitiveHeaders: true` programmatically). `imprint redact` — the command that produces a file to *share* — always applies the full scrub including headers, regardless of this gate.

Two guards keep this from leaking secrets into shipped artifacts:

- **`reveal_request`** — an on-demand compile tool that returns the fully-unredacted request + response for a recorded seq, read straight from the recording on disk. The agent uses it to inspect a real header/body value before deciding how to wire it, and is instructed to emit the contracted placeholder, never the raw value.
- **Emit-time secret guard (`assertNoRawSecrets`)** — after the agent writes `workflow.json`/`parser.ts` (and after any deterministic input injection), Imprint scans the artifacts for raw values of the recording's own sensitive headers + known credential values. A match that maps to a contracted input is auto-rewritten to its placeholder; an unmapped match **blocks** the compile with an actionable error. Page-minted app constants (an `x-api-key`/gateway key the site bakes into its JS, identified by the same detector the redaction allowlist uses) are NOT treated as secrets — they are public config the agent is meant to hardcode; a per-user token is never page-minted (it appears only after the recorded login, and a persisted bearer is recognized via its stored token). The guarantee: shipped `workflow.json`/`parser.ts` contain only placeholders, never a raw per-user secret.

Because the agent now sees raw values, **`~/.imprint/<site>/<tool>/.compile-log.json`** (the full compile-agent conversation) may contain raw sensitive-header values from the recording. Treat it like the recording itself — local-only and sensitive, never committed. (The shipped `workflow.json`/`parser.ts` are still placeholder-only, enforced by the emit-time guard above.)

## Credential storage

`imprint login` writes per-site credentials through the credential backend. On desktops this uses the OS keychain when available; on headless machines it falls back to a libsodium-encrypted file under the OS-specific config directory. Earlier plaintext JSON stores remain readable for migration only.

```bash
imprint credential list <site>
imprint credential migrate
```

Stored credentials can include named secrets, cookies, and declared durable storage keys. Credentials never leave your machine unless you explicitly export an encrypted `.imprintbundle`. The LLM compile step works on redacted sessions only.

**Authenticate tools run their login in a real local browser (headed `cdp-replay`)** — the recorded credential POST + 2FA requests are replayed in-page from the live login document over TLS, the same bytes your own browser would send. Credentials stay placeholders (`${credential.*}`) in the saved `workflow.json`; the real values are read from the credential backend at runtime and are never written to the artifacts, logs, or any LLM prompt. The resulting session cookies (plus any declared `sessionCapture` token) are persisted back to the credential store for the site's data tools. (Diagnostic screenshots, written only to a temp dir on failure and never committed, can show a logged-in page — treat them as sensitive.) The browser window is visible during an auth run (auth is interactive — you approve the 2FA push/OTP) and closes at the end of the run.

**Serialized session state for the OTP step is stored like cookies.** Because `initiate` and `submit_otp` are separate stateless calls, an authenticate tool persists the post-login browser session — cookies **and** per-origin `localStorage` (`saveSiteStorage`) — so the second call can rehydrate it. `localStorage` is treated exactly like cookies: stored in the **same credential backend** (OS keyring or encrypted file, never plaintext on disk for those backends), gated to `toolKind === 'authenticate'`, never sent to any LLM, and only ever exported inside an encrypted `.imprintbundle` you create explicitly. `sessionStorage` is **not** captured (Playwright's `storageState()` omits it). Treat persisted `localStorage` as session-bearing material with the same sensitivity as cookies.

**2FA tokens are not persisted.** OTP flows can return a short-lived token from the login response (e.g. a reauth `mfaId`) that the `submit_otp` call needs. This `twoFactorContext` is **echoed to the caller in the `AWAITING_2FA` result and passed back in** on the next call — it is never written to disk (unlike cookies and `localStorage`). The OTP code itself stays a runtime parameter and is never stored — and when `imprint teach` *attempts* an unattended completion it uses a throwaway placeholder (`000000`), never a real code. This stateless round-trip means the chained token lives only for the duration of the two-call exchange, in the caller's hands.

**At most two real 2FA prompts per teach run.** During auth compilation the live verifier caps initiates that actually *deliver* a challenge at two (`IMPRINT_AUTH_MAX_INITIATE`), so a teach run can never spam your phone/inbox — you see at most two OTPs/pushes regardless of how many times the agent iterates. Login attempts that fail *before* delivering a challenge (e.g. an anti-bot edge 403, which sends nothing) don't count toward that user-visible cap but are bounded separately by an attempt cap (`IMPRINT_AUTH_MAX_INITIATE_ATTEMPTS`, default 5) so a blocked login can't loop.

## LLM data flow

When you run `imprint teach`, `imprint generate`, or `imprint compile-playbook`, the auto-redacted session is sent to the provider you selected or auto-detected:

1. **CLI providers** (`claude-cli`, `codex-cli`, `cursor-cli` for playbook compile) send prompts through the locally installed CLI and that provider's account/session.
2. **Anthropic API** sends directly to Anthropic using `ANTHROPIC_API_KEY`.

The compile agent's session summary includes inline request/response data for candidate-scoped requests (the requests relevant to the tool being compiled plus auth dependencies). Response bodies are smart-truncated and subject to a 30 KB summary budget. All inline data comes from the redacted session — credential values appear as `${credential.X}` placeholders and free-form PII as redaction markers. Sensitive-header values (auth/session/gateway tokens, cookies) are visible by default so the agent can wire them as contracted inputs (see "Sensitive headers are visible to the compile agent by default" above); the emit-time guard ensures they never survive into the shipped artifacts.

**Credential pass-through during teach.** When `imprint teach` extracts credentials during the redact step, it passes them to the compile agent's integration tests via the `IMPRINT_TEACH_CREDENTIALS` environment variable. This is a process-scoped JSON payload (`{ site, values }`) that lives only in the subprocess tree — it is never written to disk, logged, or sent to the LLM. The runtime merges these values into the credential store at test execution time so integration tests can verify workflows end-to-end.

To audit what Imprint sent during a compile, use local Phoenix tracing:
```bash
IMPRINT_TRACE=1 IMPRINT_TRACE_LLM_IO=1 PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 \
  imprint generate <session> --provider codex-cli
```

## Reporting a vulnerability

Email security issues to <security@imprint.dev> or [open a private security advisory](https://github.com/ashaychangwani/imprint/security/advisories/new) on GitHub. Please don't open a public issue for security disclosures — give us a chance to fix before disclosure.

For non-security bugs, the public issue tracker is fine.

## Generated tools

The TS module emitted by `imprint emit` is the executable artifact your MCP / cron will call. It contains:

- The full `workflow.json` inlined as a constant (so the file is committable).
- A thin wrapper around the local Imprint `runtime.executeWorkflow`.

It does NOT contain credential values, cookie values, storage values, or redaction marker maps — those are loaded from the credential store or captured at runtime. Generated files can be committed to a private repo without exposing secrets, *provided* the workflow.json was generated from a redacted session (which it always is — `generate` enforces this). Generated folders are portable — just install the `imprint` package on the receiving machine (`index.ts` imports from `imprint/runtime`, not a local checkout path).

If you committed a non-redacted workflow.json by mistake: rotate the cookies / tokens visible in it, then re-run `redact` + `generate` from a fresh recording.
