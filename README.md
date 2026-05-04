<p align="center">
  <strong>Imprint</strong><br>
  <em>Teach an AI agent how to use any website. Once.</em>
</p>

<p align="center">
  <a href="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml"><img src="https://github.com/ashaychangwani/imprint/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/ashaychangwani/imprint/releases"><img src="https://img.shields.io/github/v/release/ashaychangwani/imprint?label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.3-black" alt="Bun"></a>
</p>

---

Browser-tool frameworks like browser-use and Computer Use ask the LLM to **decide every click at runtime**. That means unpredictable token costs, flaky execution, and constant bot-detection battles.

Imprint takes a different approach: **you record once, and the recording becomes the executable.** One command opens a browser, you drive the workflow, and Imprint compiles it into a deterministic MCP tool your AI agent can call forever.

```
imprint teach southwest --url https://southwest.com
```

That's it. Your agent now has a tool called `search_southwest_flights` that works reliably, every time.

---

## How it works

```
You record a workflow        Imprint compiles two artifacts       Your agent calls the MCP tool
in a real browser             (API replay + DOM fallback)          and gets results back
                                                                  
  imprint teach              workflow.json   playbook.yaml        agent: "find flights
       |                          |               |                SFO → LAX tomorrow"
       v                          v               v                       |
  [Browser session]  ──>    [API workflow]   [DOM playbook]  ──>   [deterministic result]
```

The **backend ladder** tries the fastest method first and escalates automatically:

| Backend | Speed | What it defeats |
|---|---|---|
| `fetch` | ~200ms | Plain APIs |
| `stealth-fetch` | ~1s | Akamai, Cloudflare, DataDome |
| `playbook` | ~9s | Everything else (DOM replay) |

If the API changes, the DOM playbook still works. If the page redesigns, re-record in 2 minutes. **There is always a fallback.**

---

## Get started

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- A Google Cloud project with [Vertex AI](https://cloud.google.com/vertex-ai) Anthropic models enabled

### Install

```bash
git clone https://github.com/ashaychangwani/imprint.git
cd imprint
bun install
bun link
bunx playwright install chromium
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
```

Verify everything works:

```bash
imprint doctor
```

### Teach your first workflow

```bash
imprint teach mysite --url https://example.com
```

This single command:
1. Opens a browser for you to drive the workflow
2. Records every network request and DOM interaction
3. Redacts credentials and PII automatically
4. Compiles an API workflow + DOM playbook
5. Generates a typed MCP tool
6. Connects it to your AI platform

At the end, `imprint teach` asks which platform you use and handles the integration automatically.

For the full step-by-step walkthrough, see [Getting Started](docs/getting-started.md).

---

## Works with your AI platform

`imprint teach` handles setup at the end of the pipeline. Supported platforms:

| Platform | How it connects |
|---|---|
| **Claude Code** | Runs `claude mcp add` automatically |
| **Codex CLI** | Runs `codex mcp add` automatically |
| **Claude Desktop** | Prints paste-ready JSON config |
| **Cursor** | Prints paste-ready JSON config |
| **Continue.dev** | Prints paste-ready JSON config |
| **OpenClaw** | MCP config + optional SKILL.md export |
| **Hermes** | MCP config + SKILL.md export + cron mapping |

Each site gets its own isolated MCP server. `imprint mcp-server southwest` registers as `imprint-southwest`, so tools from different sites never collide.

For manual setup or advanced options (HTTP transport, Docker, systemd), see [Integrations](docs/integrations.md).

---

## Real-world examples

### Southwest flight watcher

Defeats Akamai bot detection. Watches fares daily, notifies you when prices drop.

```bash
imprint cron southwest --once
```

```
stealth-fetch bootstrapping Chromium...       13.4 s
stealth-fetch request complete                 1.2 s
SFO → LAX  2026-05-15  $87 (Wanna Get Away)
```

See [`examples/southwest`](examples/southwest) for the full setup.

### Discover & Go museum booking

Authenticated workflow using the per-site credential store. Books museum passes through a member portal.

```bash
imprint cron discoverandgo --once
```

See [`examples/discoverandgo`](examples/discoverandgo) for the full setup.

---

## Why not just use browser-use / Computer Use?

| | Imprint | Browser-use / Computer Use |
|---|---|---|
| **Token cost** | Zero exploration tokens | Scales with workflow length |
| **Reliability** | Deterministic replay | LLM decides every click |
| **Bot detection** | Real browser session + stealth-fetch | Detectable automation |
| **Fallback** | API replay + DOM playbook ladder | None |
| **Speed** | 200ms - 9s depending on backend | 30s+ per workflow |
| **Setup** | Record once, done forever | Configure per run |

---

## CLI reference

```bash
imprint --help            # all commands
imprint <command> --help  # per-command options
```

**Core pipeline:** `teach` · `record` · `redact` · `generate` · `compile-playbook` · `emit`

**Run & serve:** `cron` · `mcp-server` · `playbook` · `probe-backends`

**Utilities:** `login` · `assemble` · `check` · `doctor`

---

## Documentation

| Doc | What's in it |
|---|---|
| [Getting Started](docs/getting-started.md) | Full walkthrough, step by step |
| [Integrations](docs/integrations.md) | Per-platform setup and advanced config |
| [Architecture](docs/architecture.md) | Data flow, module map, file taxonomy |
| [Glossary](docs/glossary.md) | Session, Workflow, Playbook, Backend, and more |
| [Decisions](docs/decisions.md) | Why YAML, why ladder, why MCP-stdio default |
| [Security](docs/security.md) | What Imprint stores, redaction guarantees, credential handling |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and fixes |
| [Capture Protocol](docs/capture-protocol.md) | What a clean recording looks like |
| [Playbook Debugging](docs/playbook-debugging.md) | When DOM walks misbehave |
| [Notifications](docs/notifications.md) | Pushover + ntfy setup |

---

## Contributing

Contributions are welcome. The codebase has 193 tests and enforces Conventional Commits in CI.

```bash
bun run check   # typecheck + lint + test + dead-code scan
```

Good first contributions: new replay backends, notification predicates, per-site auth extractors, docs improvements, or new example sites.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and guidelines.

---

## License

[MIT](LICENSE)
