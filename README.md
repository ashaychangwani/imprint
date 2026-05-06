<h1 align="center">Imprint</h1>

<p align="center">
  <strong>Don't do anything twice. Teach your AI agent once, and it remembers forever.</strong>
</p>

<p align="center">
  <a href="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml"><img src="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ashaychangwani/cbd3134e06fb4fabf24aed94b251bdfd/raw/test-count.json" alt="Test count">
  <a href="https://github.com/ashaychangwani/imprint/releases"><img src="https://img.shields.io/github/v/release/ashaychangwani/imprint?label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://github.com/ashaychangwani/imprint/stargazers"><img src="https://img.shields.io/github/stars/ashaychangwani/imprint?style=social" alt="GitHub Stars"></a>
</p>

<br>

```bash
git clone https://github.com/ashaychangwani/imprint.git && cd imprint
bun install && bun link

imprint teach southwest --url https://www.southwest.com
```

That's it. Imprint opens a browser, you drive the workflow, and it compiles a deterministic **MCP tool** your AI agent can call from then on. No tokens burned on exploration, no "the LLM clicked the wrong button" variance. The recording *is* the executable.

<br>

## See it in action

After teaching, your agent has a tool called `search_southwest_flights`. Here's what happens when it runs:

```
$ imprint cron southwest --once

stealth-fetch bootstrapping Chromium...       13.4s
stealth-fetch request complete                 1.2s

  SFO → LAX   2026-05-15   $87   Wanna Get Away
  SFO → LAX   2026-05-15  $142   Anytime
  SFO → LAX   2026-05-15  $177   Business Select
```

Live Southwest fares, defeating Akamai bot detection — no paid proxy, no CAPTCHA solver.

<br>

## How it works

<table>
<tr>
<td width="33%">

### 1. Teach

```bash
imprint teach mysite \
  --url https://example.com
```

A browser opens. You drive the workflow and narrate what you're doing. Imprint records every network request and DOM interaction.

</td>
<td width="33%">

### 2. Compile

Imprint generates two replay artifacts:

- **`workflow.json`** — API-level replay (fast)
- **`playbook.yaml`** — DOM-level fallback (universal)

Credentials and PII are redacted automatically.

</td>
<td width="34%">

### 3. Use

A typed MCP tool is generated and wired into your AI platform. Your agent calls it like any other tool — structured input in, structured results out.

</td>
</tr>
</table>

> All three steps happen in a single `imprint teach` command.

<br>

## Why Imprint?

Other browser-tool frameworks (browser-use, Computer Use) ask the LLM to **decide every click at runtime**.

| | Imprint | browser-use / Computer Use |
|---|---|---|
| **How it works** | Record once, replay deterministically | LLM decides every click at runtime |
| **Token cost** | Zero at runtime | Scales with workflow complexity |
| **Reliability** | Deterministic — same input, same output | Variable — exploration can diverge |
| **Bot detection** | Real Chromium + stealth-fetch | Detectable automation fingerprint |
| **When it breaks** | Automatic fallback via backend ladder | No fallback |
| **Time to result** | 200ms – 9s | 30s+ |

<br>

## Install

```bash
git clone https://github.com/ashaychangwani/imprint.git && cd imprint
bun install && bun link
```

Requires [Bun](https://bun.sh) >= 1.3. Imprint auto-detects an LLM provider from what's already on your system — first match wins:

| Priority | Provider | Triggered by |
|---|---|---|
| 1 | `claude-cli` | `claude` on PATH (Claude Code subscription) |
| 2 | `codex-cli` | `codex` on PATH (Codex subscription) |
| 3 | `cursor-cli` | `cursor` on PATH (Cursor subscription) |
| 4 | `anthropic-api` | `ANTHROPIC_API_KEY` env var |
| 5 | `vertex` | `ANTHROPIC_VERTEX_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT` env var |

```bash
imprint doctor
```

Shows which provider was picked. To force a specific one, pass `--provider <name>` to `teach`, `generate`, or `compile-playbook`.

<br>

## Platform support

At the end of `imprint teach`, you pick your AI platform and Imprint handles the wiring:

| Platform | Integration |
|---|---|
| **Claude Code** | Automatic — runs `claude mcp add` for you |
| **Codex CLI** | Automatic — runs `codex mcp add` for you |
| **Claude Desktop** | Paste-ready JSON config |
| **OpenClaw** | MCP config + SKILL.md export |
| **Hermes** | MCP config + SKILL.md + cron mapping |

Each site registers as its own MCP server (`imprint-southwest`, `imprint-discoverandgo`, ...) so tools never collide. See [Integrations](docs/integrations.md) for HTTP transport, Docker, and systemd options.

<br>

## The backend ladder

When an API call gets blocked, Imprint doesn't fail — it escalates:

| | Speed | Handles |
|---|---|---|
| **fetch** | ~200ms | Plain APIs, no bot protection |
| **stealth-fetch** | ~12s first call, ~1s after | Akamai, Cloudflare, DataDome |
| **playbook** | ~9s | Anything — full DOM replay as fallback |

Every recording compiles to *both* `workflow.json` and `playbook.yaml`, so the ladder always has somewhere to go. If the API changes, the DOM playbook still works. If the page redesigns, re-record in two minutes.

<br>

## Examples

| Example | What it demonstrates | Run it |
|---|---|---|
| [**southwest**](examples/southwest) | Live fare watcher, defeats Akamai bot detection, price-drop notifications | `imprint cron southwest --once` |
| [**google-flights**](examples/google-flights) | Real-time flight search across all carriers, parses Google's raw protobuf response | `imprint mcp-server google-flights` |
| [**google-hotels**](examples/google-hotels) | Hotel search with star rating, guest scores, nightly + total prices | `imprint mcp-server google-hotels` |
| [**discoverandgo**](examples/discoverandgo) | Authenticated booking via per-site credential store | `imprint cron discoverandgo --once` |
| [**echo**](examples/echo) | MCP smoke-test fixture (no network, no LLM) | `imprint mcp-server echo` |

<br>

## CLI reference

```
imprint --help              # all commands
imprint <command> --help    # per-command options
```

| | Commands |
|---|---|
| **Pipeline** | `teach` · `record` · `redact` · `generate` · `compile-playbook` · `emit` |
| **Runtime** | `cron` · `mcp-server` · `playbook` · `probe-backends` |
| **Utilities** | `login` · `assemble` · `check` · `doctor` |

`teach`, `generate`, and `compile-playbook` accept `--provider <name>` to override the auto-detected LLM (see [Install](#install) for the five valid names). `teach` and `generate` also take `--keep-test` to retain the agent-written `parser.test.ts` for debugging — it's deleted by default since it reads the gitignored redacted session via `$IMPRINT_SESSION_PATH` and isn't reproducible elsewhere.

<br>

## Docs

- [Getting Started](docs/getting-started.md) — full walkthrough
- [Integrations](docs/integrations.md) — per-platform setup
- [Architecture](docs/architecture.md) — data flow and module map
- [Security](docs/security.md) — redaction, credential handling, what gets stored
- [Troubleshooting](docs/troubleshooting.md) — common failures and fixes
- [Decisions](docs/decisions.md) · [Glossary](docs/glossary.md) · [Capture Protocol](docs/capture-protocol.md) · [Playbook Debugging](docs/playbook-debugging.md) · [Notifications](docs/notifications.md)

<br>

## Contributing

Conventional Commits enforced in CI. Run `bun run check` before submitting.

Good first contributions: replay backends, notification predicates, auth extractors, example sites, docs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

<br>

## License

[MIT](LICENSE)
