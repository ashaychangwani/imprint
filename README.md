<h1 align="center">Imprint</h1>

<p align="center">
  <strong>Record a browser workflow once. Get a deterministic MCP tool forever.</strong>
</p>

<p align="center">
  <a href="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml"><img src="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/ashaychangwani/imprint/releases"><img src="https://img.shields.io/github/v/release/ashaychangwani/imprint?label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<br>

Today's browser-automation tools ask the LLM to figure out every click at runtime — burning tokens, failing unpredictably, and getting flagged by bot detection. Imprint flips that: **you show it the workflow once in a real browser, and it compiles a tool your agent can call deterministically from then on.**

<br>

<table>
<tr>
<td>

**1. Teach**
```bash
imprint teach southwest \
  --url https://southwest.com
```
Record the workflow in a live browser. Narrate what you're doing. Imprint watches.

</td>
<td>

**2. Compile**

Imprint generates two replay artifacts:
- `workflow.json` — API-level replay (fast)
- `playbook.yaml` — DOM-level replay (universal)

Plus a typed MCP tool your agent can call.

</td>
<td>

**3. Use**

Your agent gets a tool like `search_southwest_flights`. It calls it, gets structured results. No browser, no tokens, no variance.

</td>
</tr>
</table>

> All three steps happen in a single `imprint teach` command.

<br>

## See it in action

```bash
$ imprint cron southwest --once
```
```
stealth-fetch bootstrapping Chromium...       13.4s
stealth-fetch request complete                 1.2s

  SFO → LAX   2026-05-15   $87   Wanna Get Away
  SFO → LAX   2026-05-15  $142   Anytime
  SFO → LAX   2026-05-15  $177   Business Select
```

This is a live Southwest fare lookup that defeats Akamai bot detection — no paid proxy, no CAPTCHA solver. The recording handles it.

<br>

## Install

```bash
git clone https://github.com/ashaychangwani/imprint.git && cd imprint
bun install && bun link            # makes `imprint` available globally
bunx playwright install chromium   # browser engine for stealth-fetch + playbook
```

Set your LLM credentials and verify:

```bash
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
imprint doctor
```

Requires [Bun](https://bun.sh) >= 1.3 and a GCP project with [Vertex AI](https://cloud.google.com/vertex-ai) Anthropic models enabled.

<br>

## Platform support

`imprint teach` asks which platform you use at the end and handles the wiring:

| Platform | Integration |
|---|---|
| **Claude Code** | Automatic — runs `claude mcp add` for you |
| **Codex CLI** | Automatic — runs `codex mcp add` for you |
| **Claude Desktop** | Paste-ready JSON config |
| **Cursor** | Paste-ready JSON config |
| **Continue.dev** | Paste-ready JSON config |
| **OpenClaw** | MCP config + SKILL.md export |
| **Hermes** | MCP config + SKILL.md + cron mapping |

Each site registers as its own MCP server (`imprint-southwest`, `imprint-discoverandgo`, ...) so tools never collide.

See [Integrations](docs/integrations.md) for HTTP transport, Docker, and systemd options.

<br>

## The backend ladder

When an API call gets blocked, Imprint doesn't fail — it escalates:

| | Speed | Handles |
|---|---|---|
| **fetch** | ~200ms | Plain APIs, no bot protection |
| **stealth-fetch** | ~1s | Akamai, Cloudflare, DataDome |
| **playbook** | ~9s | Anything — full DOM replay as fallback |

Every recording compiles to *both* artifacts, so the ladder always has somewhere to go. If the API changes, the DOM playbook still works. If the page redesigns, re-record in two minutes.

<br>

## Imprint vs. the alternatives

| | Imprint | browser-use / Computer Use |
|---|---|---|
| **How it works** | Record once, replay deterministically | LLM decides every click at runtime |
| **Token cost** | Zero at runtime | Scales with workflow complexity |
| **Reliability** | Deterministic — same input, same output | Variable — LLM exploration can diverge |
| **Bot detection** | Real Chromium session + stealth-fetch | Detectable automation fingerprint |
| **When it breaks** | Automatic fallback via backend ladder | No fallback — fails or retries |
| **Time to result** | 200ms – 9s | 30s+ |

<br>

## Examples

| Example | What it demonstrates | Run it |
|---|---|---|
| [**southwest**](examples/southwest) | Live fare watcher, Akamai defeat via stealth-fetch, price-drop notifications | `imprint cron southwest --once` |
| [**discoverandgo**](examples/discoverandgo) | Authenticated booking via per-site credential store | `imprint cron discoverandgo --once` |
| [**echo**](examples/echo) | MCP smoke-test fixture (no network, no LLM) | `imprint mcp-server echo` |

<br>

## CLI

```
imprint --help              # all commands
imprint <command> --help    # per-command options
```

| | Commands |
|---|---|
| **Pipeline** | `teach` · `record` · `redact` · `generate` · `compile-playbook` · `emit` |
| **Runtime** | `cron` · `mcp-server` · `playbook` · `probe-backends` |
| **Utilities** | `login` · `assemble` · `check` · `doctor` |

<br>

## Docs

- [Getting Started](docs/getting-started.md) — full walkthrough
- [Integrations](docs/integrations.md) — per-platform setup
- [Architecture](docs/architecture.md) — data flow and module map
- [Security](docs/security.md) — redaction, credential handling, what gets stored
- [Troubleshooting](docs/troubleshooting.md) — common failures and fixes
- [Decisions](docs/decisions.md) — why YAML, why the ladder, why MCP-stdio
- [Glossary](docs/glossary.md) · [Capture Protocol](docs/capture-protocol.md) · [Playbook Debugging](docs/playbook-debugging.md) · [Notifications](docs/notifications.md)

<br>

## Contributing

193 tests. Conventional Commits enforced in CI. Run `bun run check` before submitting.

Good first contributions: new replay backends, notification predicates, auth extractors, example sites, docs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

<br>

## License

[MIT](LICENSE)
