# Security

Imprint records real browser sessions. That means it sees credentials, session cookies, PII, and anything else you type into the page. This document covers what Imprint does to protect that data, what it doesn't, and how to handle disclosures.

## What Imprint stores on disk

Recording produces:

| File | Contains | Where |
|---|---|---|
| `<ts>.jsonl` | Full request bodies, response bodies, headers (incl. `Authorization`, `Cookie`, `Set-Cookie`), cookie snapshots, storage snapshots | `~/.imprint/<site>/sessions/` |
| `<ts>.json` | Same, assembled | `~/.imprint/<site>/sessions/` |

Sessions are **not** redacted on disk by default. `imprint generate` and `imprint compile-playbook` auto-redact in memory before LLM calls — if the session does not already contain `[REDACTED:` markers, the pipeline runs the full redaction pass and logs the count. If auto-redaction produces zero redactions on a session that contains auth-like requests, treat it as suspicious and run `imprint redact` manually to audit. `imprint redact` writes a reviewable redacted artifact you can audit or share.

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
- Common free-form PII and secrets in text-like response bodies, JSON string values, URL path segments, captured storage, and captured DOM / WebSocket event details. This supplemental scan catches emails, phone numbers, SSNs, payment cards, JWTs, API keys, private keys, database URLs, webhook URLs, package-registry tokens, and common secret assignments.

Equality marker IDs are scoped to one redacted artifact. They contain no hash of the original secret, are not stable across redaction runs, and are never valid runtime placeholders. Generated workflows should reference semantic capture names such as `${state.csrf}`, never marker IDs.

## What redaction doesn't catch

This is a best-effort tool — we deliberately undersell it. It will NOT catch:

- **Custom field names** a site invents that don't match the `SENSITIVE_KEYS` patterns.
- **Contextual or site-specific secrets** that do not match either the structured key list or the supplemental free-form patterns.
- **Non-standard encodings** (compressed bodies, encrypted blobs, unusual base64 packing, or values split across fields).
- **WebSocket frame content beyond the captured preview**.

If you're using Imprint on a site with unusual auth, **audit the redacted session manually** before generating against it.

## Credential storage

`imprint login` writes per-site credentials through the credential backend. On desktops this uses the OS keychain when available; on headless machines it falls back to a libsodium-encrypted file under the OS-specific config directory. Earlier plaintext JSON stores remain readable for migration only.

```bash
imprint credential list <site>
imprint credential migrate
```

Stored credentials can include named secrets, cookies, and declared durable storage keys. Credentials never leave your machine unless you explicitly export an encrypted `.imprintbundle`. The LLM compile step works on redacted sessions only.

## LLM data flow

When you run `imprint teach`, `imprint generate`, or `imprint compile-playbook`, the auto-redacted session is sent to the provider you selected or auto-detected:

1. **CLI providers** (`claude-cli`, `codex-cli`, `cursor-cli` for playbook compile) send prompts through the locally installed CLI and that provider's account/session.
2. **Anthropic API** sends directly to Anthropic using `ANTHROPIC_API_KEY`.
3. **Vertex** sends to your Google Cloud project's Vertex AI endpoint; retention and audit behavior are governed by your GCP project settings.

To audit what Imprint sent during a compile, use local Phoenix tracing:
```bash
IMPRINT_TRACE=1 IMPRINT_TRACE_LLM_IO=1 PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 \
  imprint generate <session> --provider codex-cli
```

## Reporting a vulnerability

Email security issues to <ashay@example.com> (replace with real address before publishing). Please don't open a public issue for security disclosures — give us a chance to fix before disclosure.

For non-security bugs, the public issue tracker is fine.

## Generated tools

The TS module emitted by `imprint emit` is the executable artifact your MCP / cron will call. It contains:

- The full `workflow.json` inlined as a constant (so the file is committable).
- A thin wrapper around the local Imprint `runtime.executeWorkflow`.

It does NOT contain credential values, cookie values, storage values, or redaction marker maps — those are loaded from the credential store or captured at runtime. Generated files can be committed to a private repo without exposing secrets, *provided* the workflow.json was generated from a redacted session (which it always is — `generate` enforces this). If you move the generated folder to another machine, install Imprint there and rerun `imprint emit <workflow.json> --force` so `index.ts` points at that machine's runtime.

If you committed a non-redacted workflow.json by mistake: rotate the cookies / tokens visible in it, then re-run `redact` + `generate` from a fresh recording.
