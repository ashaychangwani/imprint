<div align="center">

# imprint

**Teach your AI agent any website. Once.**

Record a real browser session, get a deterministic MCP tool back.\
No tokens burned on exploration. No "the LLM clicked the wrong button."\
The recording *is* the executable.

[![Tests](https://github.com/ashaychangwani/imprint/actions/workflows/test.yml/badge.svg)](https://github.com/ashaychangwani/imprint/actions/workflows/test.yml)
![Test count](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ashaychangwani/cbd3134e06fb4fabf24aed94b251bdfd/raw/test-count.json)
[![Release](https://img.shields.io/github/v/release/ashaychangwani/imprint?label=release)](https://github.com/ashaychangwani/imprint/releases)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ashaychangwani/imprint?style=social)](https://github.com/ashaychangwani/imprint/stargazers)

</div>

---

## Quick Start

```bash
bun install -g imprint-mcp
imprint teach southwest --url https://www.southwest.com
```

A browser opens. You drive the workflow and narrate what you're doing. Imprint records every request and interaction, then compiles a deterministic **MCP tool** your agent can call forever.

---

## See It in Action

After teaching, your agent gets a tool called `search_namecheap_domains`. The compile agent reverse-engineered the site's CRC32 URL signing from a captured JS bundle, chains five API endpoints, and merges availability + pricing + aftermarket data:

```
$ claude "search for getimprint on Namecheap, under $20/yr renewal"

  getimprint.com     taken         registered 2008         GoDaddy.com, LLC
  getimprint.dev     available     $12.98/yr (19% off)     renews $20.98/yr
  getimprint.org     available     $7.48/yr (42% off)      renews $15.98/yr
  getimprint.fyi     available     $6.98/yr                renews $9.68/yr
  getimprint.xyz     available     $2.00/yr (90% off)      renews $19.48/yr
```

Real-time domain availability with per-request URL signing — the agent wrote the signing function itself by reading the site's JS bundle.

---

## How It Works

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   1. TEACH  │ ───▶ │  2. COMPILE  │ ───▶ │   3. USE    │
│             │      │              │      │             │
│ Open a real │      │ Generates:   │      │ A typed MCP │
│ browser,    │      │              │      │ tool your   │
│ drive the   │      │ workflow.json│      │ agent calls │
│ workflow,   │      │ (API replay) │      │ like any    │
│ narrate.    │      │              │      │ other tool. │
│             │      │ playbook.yaml│      │             │
│ Imprint     │      │ (DOM replay) │      │ Works with  │
│ records     │      │              │      │ Claude,     │
│ everything. │      │ request-     │      │ Codex, any  │
│             │      │ transform.ts │      │ MCP client. │
│             │      │ (signing)    │      │             │
└─────────────┘      └──────────────┘      └─────────────┘
```

> All three steps happen in a single `imprint teach` command.

Credentials and PII are **redacted automatically** — credential values become `${credential.NAME}` placeholders, and a supplemental scan catches emails, phone numbers, API keys, JWTs, and more before anything reaches the LLM.

---

## Why Imprint?

Other browser-tool frameworks ask the LLM to **decide every click at runtime**. Imprint takes a fundamentally different approach:

| | **Imprint** | **browser-use / Computer Use** |
|:--|:--|:--|
| **Approach** | Record once, replay deterministically | LLM decides every click at runtime |
| **Token cost** | Zero at runtime | Scales with workflow complexity |
| **Reliability** | Deterministic — same input, same output | Variable — exploration can diverge |
| **Bot detection** | Real Chromium + stealth-fetch | Detectable automation fingerprint |
| **Fallback** | Automatic ladder (API → DOM) | None |
| **Speed** | 200ms – 9s | 30s+ |

---

## Installation

### Recommended

```bash
bun install -g imprint-mcp
```

> Requires [Bun](https://bun.sh) >= 1.3. Or run without installing: `bunx imprint-mcp teach <site> --url <url>`

### Standalone Binary

```bash
curl -fsSL https://raw.githubusercontent.com/ashaychangwani/imprint/main/scripts/install.sh | bash
```

### From Source

```bash
git clone https://github.com/ashaychangwani/imprint.git && cd imprint
bun install && bun link
```

### Browser Setup

Commands that open a browser (`teach`, `record`, `login`, `playbook`) need Playwright's Chromium:

```bash
bunx playwright install chromium
```

### LLM Providers

Imprint auto-detects what's available on your system. Run `imprint doctor` to see detected providers.

| Priority | Provider | Detected via |
|:--|:--|:--|
| 1 | Claude Code | `claude` on PATH |
| 2 | Codex CLI | `codex` on PATH |
| 3 | Anthropic API | `ANTHROPIC_API_KEY` env var |
| 4 | Cursor | `cursor` on PATH |

Override with `--provider <name>` and `--model <name>`.

---

## The Backend Ladder

When an API call gets blocked, Imprint doesn't jump to DOM replay. It escalates through the cheapest backend that works:

```
  fetch            ~200ms    Plain APIs, persisted cookies
    │
    ▼
  fetch-bootstrap  browser   Mints cookies, CSRF tokens, storage
    │               + API
    ▼
  stealth-fetch    ~1-12s    Defeats Akamai, Cloudflare, DataDome
    │
    ▼
  playbook         ~9s       Full DOM replay — universal fallback
```

Every recording compiles to *both* `workflow.json` and `playbook.yaml`, so the ladder always has a DOM fallback.

---

## Platform Support

At the end of `imprint teach`, pick your AI platform and Imprint wires it up:

| Platform | Integration |
|:--|:--|
| **Claude Code** | Automatic — runs `claude mcp add` |
| **Codex CLI** | Automatic — runs `codex mcp add` |
| **Claude Desktop** | Paste-ready JSON config |
| **OpenClaw** | MCP config + SKILL.md export |
| **Hermes** | MCP config + SKILL.md + cron mapping |

Each site registers as its own MCP server (`imprint-southwest`, `imprint-google-flights`, ...) so tools never collide.

---

## Examples

| Example | Description |
|:--|:--|
| [**southwest**](examples/southwest) | Live fare search — defeats Akamai bot detection |
| [**google-flights**](examples/google-flights) | Real-time flight search, parses Google's protobuf response |
| [**google-hotels**](examples/google-hotels) | Hotel search with ratings, prices, and booking options |
| [**namecheap-domains**](examples/namecheap-domains) | Domain search with CRC32 URL signing reverse-engineered from JS |
| [**discoverandgo**](examples/discoverandgo) | Authenticated booking via per-site credential store |
| [**echo**](examples/echo) | MCP smoke-test fixture |

Install any example into your MCP client:

```bash
imprint install google-flights --source examples --platform claude-desktop
```

---

## CLI Reference

```bash
imprint --help              # all commands
imprint <command> --help    # per-command options
```

| Category | Commands |
|:--|:--|
| **Pipeline** | `teach` · `record` · `redact` · `generate` · `compile-playbook` · `emit` |
| **Runtime** | `cron` · `mcp-server` · `playbook` · `probe-backends` · `audit` |
| **Credentials** | `credential set` · `credential list` · `credential export` · `credential import` · `credential migrate` |
| **Utilities** | `mcp` · `login` · `assemble` · `check` · `doctor` · `install` · `uninstall` |

---

## Sharing Skills

Teach on your laptop, ship to a remote agent. Skill folders contain **zero plaintext credentials** — only `${credential.NAME}` placeholders and a manifest listing what the receiver must provision.

```bash
# Export (encrypted with libsodium + argon2id)
imprint credential export southwest --out southwest.imprintbundle

# Import on another machine
imprint credential import southwest southwest.imprintbundle
```

Send the bundle over any channel. Pass the passphrase **out-of-band**.

See [Sharing Skills](docs/credential-sharing.md) for the full flow.

---

## Documentation

| | |
|:--|:--|
| [Getting Started](docs/getting-started.md) | Full walkthrough |
| [Architecture](docs/architecture.md) | Data flow and module map |
| [Integrations](docs/integrations.md) | Per-platform setup |
| [Security](docs/security.md) | Redaction, credential handling, what gets stored |
| [Sharing Skills](docs/credential-sharing.md) | Credential export/import and remote provisioning |
| [MCP Maintenance](docs/mcp-maintenance.md) | Audit, disable, restore, and prune MCP state |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and fixes |
| [Tracing](docs/tracing.md) | Local compile tracing with Phoenix |

<details>
<summary>More docs</summary>

- [Decisions](docs/decisions.md) — design rationale
- [Glossary](docs/glossary.md) — terms and concepts
- [Capture Protocol](docs/capture-protocol.md) — CDP recording details
- [Playbook Debugging](docs/playbook-debugging.md) — DOM replay debugging
- [Notifications](docs/notifications.md) — alert setup

</details>

---

## Contributing

Conventional Commits enforced in CI. Run `bun run check` before submitting.

Good first contributions: replay backends, notification predicates, auth extractors, example sites, docs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

---

<div align="center">

**[MIT License](LICENSE)**

</div>
