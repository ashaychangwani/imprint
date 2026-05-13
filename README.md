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

Raw recordings are stored locally under `~/.imprint/<site>/sessions/`, and each generated tool lives under `~/.imprint/<site>/<toolName>/` by default, outside the repo. The tracked `examples/` tree remains as source fixtures and demos.

</td>
<td width="33%">

### 2. Compile

Imprint generates two replay artifacts:

- **`workflow.json`** — API-level replay (fast)
- **`playbook.yaml`** — DOM-level fallback (universal)

Both artifacts are written into the generated tool directory (`~/.imprint/<site>/<toolName>/`). `compile-playbook` uses that nested location by default so cron and MCP discovery can see the fallback without a custom `--out`.

Credentials and PII are redacted automatically: known-sensitive fields keep their `[REDACTED:N]` shape markers, credential values become `${credential.NAME}` placeholders, and a supplemental free-form scan catches common emails, phone numbers, SSNs, payment cards, JWTs, API keys, private keys, database URLs, and webhook URLs before LLM compile.

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

Requires [Bun](https://bun.sh) >= 1.3. Imprint detects LLM providers from what's already on your system:

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

Shows which providers are detected. Interactive `imprint teach` prompts you to choose when multiple compatible compile providers are available, and also lists undetected providers as setup-help entries. Pick one of those help entries to see exactly which CLI or environment variable to add so it will be detected next time.

To force a specific provider and skip the picker, pass `--provider <name>` to `teach`, `generate`, or `compile-playbook`. Non-interactive runs keep first-match auto-detection so scripts do not hang.

<br>

## Local compile tracing

Slow or suspicious compiles can be inspected in a local [Phoenix](https://arize.com/docs/phoenix/self-hosting/deployment-options/terminal) trace UI.

```bash
# one-time install with uv
uv tool install arize-phoenix
phoenix serve

# in another terminal
IMPRINT_TRACE=1 \
IMPRINT_TRACE_BATCH=false \
IMPRINT_TRACE_LLM_IO=1 \
IMPRINT_TRACE_TOOL_IO=1 \
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 \
imprint teach namecheap-domains --from-session ~/.imprint/namecheap-domains/sessions/<ts>.json --provider codex-cli
```

Tracing records compile stages, agent tool calls, estimated token counts, and optional prompt/response bodies. Set `IMPRINT_TRACE_IO_MAX_CHARS` to raise or lower captured payload size. Set `IMPRINT_TRACE_INPUT_USD_PER_1M` and `IMPRINT_TRACE_OUTPUT_USD_PER_1M` to add estimated cost attributes.

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

## Sharing skills across machines

Teach on your laptop, ship the skill to a remote agent (OpenClaw, Hermes, a server-side cron host, ...). Skill folders committed to git contain **zero plaintext credentials** — only `${credential.NAME}` references and a `credentials.manifest.json` listing what's needed.

For credentials, use the **encrypted bundle** flow when you can't (or don't want to) re-type passwords on the receiving machine:

```bash
# On the laptop where you taught the skill:
imprint credential export southwest --out southwest.imprintbundle
# → prompts for a passphrase. The bundle is libsodium-encrypted with an
#   argon2id-derived key. Safe to send via Slack, email, scp, S3, etc.

# On the OpenClaw machine (or any other receiver):
imprint credential import southwest southwest.imprintbundle
# → prompts for the same passphrase. Decrypts; secrets land in the OS keychain.
```

Pass the passphrase **out-of-band** (Signal, phone, password manager share — *not* the same channel as the bundle file).

After import, the same `imprint mcp-server <site>` config you'd use locally works on the receiver — it resolves `${credential.X}` from that machine's keychain on every tool call. If anything's missing, `imprint mcp-server` and `imprint cron` log/fail with the exact `imprint credential set` and `imprint credential import` commands you need.

See [Sharing Skills](docs/credential-sharing.md) for the full flow including interactive `imprint credential set` (when you can re-type), threat model, rotation, and OpenClaw / Hermes wiring details.

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

The checked-in examples are fixtures. Runtime discovery reads `IMPRINT_HOME`
(`~/.imprint` by default), so run them with `IMPRINT_HOME=examples` or copy a
tool directory into your local Imprint home.

| Example | What it demonstrates | Run it |
|---|---|---|
| [**southwest**](examples/southwest) | Live fare watcher, defeats Akamai bot detection, price-drop notifications | `IMPRINT_HOME=examples imprint cron southwest --once` |
| [**google-flights**](examples/google-flights) | Real-time flight search across all carriers, parses Google's raw protobuf response | `IMPRINT_HOME=examples imprint mcp-server google-flights` |
| [**google-hotels**](examples/google-hotels) | Hotel search with star rating, guest scores, nightly + total prices | `IMPRINT_HOME=examples imprint mcp-server google-hotels` |
| [**discoverandgo**](examples/discoverandgo) | Authenticated booking via per-site credential store | `IMPRINT_HOME=examples imprint cron discoverandgo --once` |
| [**echo**](examples/echo) | MCP smoke-test fixture (no network, no LLM) | `IMPRINT_HOME=examples imprint mcp-server echo` |

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
| **Credentials** | `credential set` · `credential list` · `credential export` · `credential import` · `credential migrate` |
| **Utilities** | `login` · `assemble` · `check` · `doctor` |

`teach`, `generate`, and `compile-playbook` accept `--provider <name>` to override the auto-detected LLM (see [Install](#install) for the five valid names). `teach` and `generate` also take `--keep-test` to retain the agent-written `parser.test.ts` for debugging — it's deleted by default since it reads the gitignored redacted session via `$IMPRINT_SESSION_PATH` and isn't reproducible elsewhere.

<br>

## Docs

- [Getting Started](docs/getting-started.md) — full walkthrough
- [Integrations](docs/integrations.md) — per-platform setup
- [Sharing Skills](docs/credential-sharing.md) — laptop ↔ OpenClaw / Hermes / remote-agent provisioning
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
