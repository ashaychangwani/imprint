# Security

Imprint records real browser sessions. That means it sees credentials, session cookies, PII, and anything else you type into the page. This document covers what Imprint does to protect that data, what it doesn't, and how to handle disclosures.

## What Imprint stores on disk

Recording produces:

| File | Contains | Where |
|---|---|---|
| `<ts>.jsonl` | Full request bodies, response bodies, headers (incl. `Authorization`, `Cookie`, `Set-Cookie`), cookie snapshots | `examples/<site>/sessions/` |
| `<ts>.json` | Same, assembled | `examples/<site>/sessions/` |

Sessions are **not** redacted by default. The raw recording exists for `imprint generate` to consume; redaction is a separate step.

## Redaction pipeline

Always run `imprint redact` before:
- Sending a session to the LLM (`imprint generate`, `imprint compile-playbook` do this automatically — they refuse to send a non-redacted session).
- Sharing a session in a bug report or PR.
- Committing one to git.

```bash
imprint redact examples/<site>/sessions/<ts>.json
# → examples/<site>/sessions/<ts>.redacted.json
```

What gets scrubbed:
- Values of any field whose name matches the [SENSITIVE_KEYS](../src/imprint/redact.ts) list (passwords, tokens, API keys, session IDs, CSRF tokens, common patron-ID patterns, etc.) — replaced with `[REDACTED:N]` markers (N = original length, so the LLM still sees shape).
- Common free-form PII and secrets in text-like response bodies, JSON string values, URL path segments, and captured DOM / WebSocket event details. This supplemental scan catches emails, phone numbers, SSNs, payment cards, JWTs, API keys, private keys, database URLs, webhook URLs, package-registry tokens, and common secret assignments.

## What redaction doesn't catch

This is a best-effort tool — we deliberately undersell it. It will NOT catch:

- **Custom field names** a site invents that don't match the `SENSITIVE_KEYS` patterns.
- **Contextual or site-specific secrets** that do not match either the structured key list or the supplemental free-form patterns.
- **Non-standard encodings** (compressed bodies, encrypted blobs, unusual base64 packing, or values split across fields).
- **WebSocket frame content beyond the captured preview**.

If you're using Imprint on a site with unusual auth, **audit the redacted session manually** before generating against it.

## Credential storage

`imprint login` writes per-site credentials to `~/.config/imprint/credentials/<site>.json` (or the OS equivalent — Imprint uses [`env-paths`](https://www.npmjs.com/package/env-paths)). Permissions are whatever your umask defaults to; on a multi-user box, restrict the directory:

```bash
chmod 700 ~/.config/imprint
chmod 600 ~/.config/imprint/credentials/*.json
```

Credentials never leave your machine. The LLM compile step works on redacted sessions only.

## Vertex AI / LLM data flow

When you run `imprint generate` or `imprint compile-playbook`, the (auto-redacted) session is sent to your Google Cloud project's Vertex AI endpoint. Two things to know:

1. **Vertex Anthropic logging policy** is governed by your GCP project's data-handling settings. By default Vertex doesn't retain prompts/completions for model training, but verify in your project's Cloud Logging / Cloud Audit settings.
2. **No third-party LLM gateway**. Imprint talks directly to Vertex (via `@anthropic-ai/vertex-sdk`); there's no intermediary collecting prompts.

To audit what Imprint is about to send before it goes:
```bash
imprint generate <session> --save-shrunken    # writes the LLM-bound payload to disk
```

## Reporting a vulnerability

Email security issues to <ashay@example.com> (replace with real address before publishing). Please don't open a public issue for security disclosures — give us a chance to fix before disclosure.

For non-security bugs, the public issue tracker is fine.

## Generated tools

The TS module emitted by `imprint emit` is the executable artifact your MCP / cron will call. It contains:

- The full `workflow.json` inlined as a constant (so the file is committable and self-contained).
- A thin wrapper around `runtime.executeWorkflow`.

It does NOT contain credentials — those are loaded from the credential store at runtime. Generated files can be committed to a private repo without exposing secrets, *provided* the workflow.json was generated from a redacted session (which it always is — `generate` enforces this).

If you committed a non-redacted workflow.json by mistake: rotate the cookies / tokens visible in it, then re-run `redact` + `generate` from a fresh recording.
