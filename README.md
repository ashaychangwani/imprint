# Imprint

> **Teach an AI agent how to use any website. Once.**

Show Imprint a workflow in a real browser — drive the page, narrate what you're doing — and you get back two deterministic replay artifacts plus a generated MCP tool any AI agent can call from then on. No re-decisions, no exploration tokens, no "the LLM clicked the wrong button" variance. The recording **is** the executable.

```
imprint teach google-flights --url https://flights.google.com
  → record → redact → generate → compile-playbook → emit
  → pick your platform → done
```

`<site>` is a label you choose — it names the output folder under `examples/`. Pick something short and descriptive.

---

## Quickstart

```bash
git clone https://github.com/ashaychangwani/imprint.git
cd imprint
bun install
bun link                          # makes `imprint` global
bunx playwright install chromium
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
imprint doctor                    # verify setup

# Teach your agent a new workflow (interactive — walks you through everything):
imprint teach google-flights --url https://flights.google.com
```

`imprint teach` records the workflow, compiles both artifacts (API workflow + DOM playbook), generates the tool, and asks which AI platform you use. It then either runs the setup command or prints a paste-ready snippet.

For the step-by-step walkthrough, see [docs/getting-started.md](docs/getting-started.md).

---

## Connect to your AI tool

`imprint teach` handles integration at the end of the pipeline. It supports:

| Platform | Setup method |
|----------|-------------|
| **Claude Code** | Runs `claude mcp add` — one command |
| **Codex CLI** | Runs `codex mcp add` — one command |
| **Claude Desktop** | Prints JSON snippet for config file |
| **OpenClaw** | Prints MCP config + optional SKILL.md export |
| **Hermes** | Prints MCP config + optional SKILL.md export + cron mapping |

Each site gets its own MCP server: `imprint mcp-server southwest` registers as `imprint-southwest`.

For manual setup or advanced configuration, see [docs/integrations.md](docs/integrations.md).

---

## Why use Imprint over the alternatives

Other browser-tool frameworks (browser-use, Computer Use, openclaw) ask the LLM to **decide every click at runtime**. Token cost scales with workflow length; reliability is variable; bot-detection forces operators to pay for stealth APIs.

Imprint is different: the recording is a frozen, deterministic artifact. The agent reads it and follows it verbatim. **Zero exploration tokens, zero re-decision variance**, and a real Chromium minted the auth tokens — so bot detection sees a real browser.

When the cheap API replay gets blocked, the **backend ladder** automatically escalates:

| Backend | Per call | Defeats |
|---|---|---|
| `fetch` | ~200ms | Plain APIs |
| `stealth-fetch` | ~12s bootstrap (one-time per process) + ~1s | Akamai, Cloudflare, DataDome (token-validation tier) |
| `playbook` | ~9.4s | Universal — handles form-fills, autocompletes, multi-page navigation |

Every recording compiles to BOTH `workflow.json` and `playbook.yaml`, so the ladder always has a fallback. **"Imprint can't help here" is the failure mode this design eliminates.**

---

## Demos

| Demo | What it shows | How to run |
|---|---|---|
| [`examples/southwest`](examples/southwest) | Live flight-fare watcher; defeats Akamai via `stealth-fetch`; pushes when prices drop below your threshold | `imprint cron southwest --once` |
| [`examples/discoverandgo`](examples/discoverandgo) | Authed museum-pass booking via the per-site credential store | `imprint cron discoverandgo --once` |
| [`examples/echo`](examples/echo) | Trivial MCP smoke-test fixture (no LLM, no network) | `imprint mcp-server echo` |

---

## How it works

```
   imprint teach  ─── interactive pipeline ───────────┐
                                                       │
   imprint record  ─┐                                 │
                    ▼                                  │
              session.json                             │
                    │                                  │
        ┌───────────┴───────────┐                      │
        ▼                       ▼                      │
  imprint generate     imprint compile-playbook        │
        │                       │                      │
        ▼                       ▼                      │
  workflow.json          playbook.yaml                 │
        │                                              │
  imprint emit                                         │
        ▼                                              │
  examples/<site>/index.ts  ──┐                        │
                              │                        │
       imprint cron / mcp ────┼──► backend ladder ◄────┘
                              │      fetch ─FORBIDDEN→
                              │      stealth-fetch ─→
                              │      playbook
                              │
                              └──► result
```

For the full architecture (module map, file taxonomy, design rationale), see [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md).

---

## CLI

```
imprint --help        # full verb list
imprint <verb> --help # per-verb help
```

Verbs: `teach`, `record`, `redact`, `generate`, `compile-playbook`, `emit`, `probe-backends`, `cron`, `mcp-server`, `playbook`, `login`, `assemble`, `check`, `doctor`.

---

## Docs

- **[docs/integrations.md](docs/integrations.md)** — per-platform setup: Claude Code, Codex, Claude Desktop, OpenClaw, Hermes
- **[docs/getting-started.md](docs/getting-started.md)** — full walkthrough, step-by-step
- **[docs/architecture.md](docs/architecture.md)** — data flow, module map, file taxonomy
- **[docs/glossary.md](docs/glossary.md)** — Session, Workflow, Playbook, Backend, Stealth-fetch, etc.
- **[docs/decisions.md](docs/decisions.md)** — the load-bearing calls (why YAML, why ladder, why MCP-stdio default)
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — predictable failures + fixes
- **[docs/notifications.md](docs/notifications.md)** — Pushover + ntfy setup, predicate language
- **[docs/security.md](docs/security.md)** — what Imprint stores, redaction guarantees, credential handling
- **[docs/capture-protocol.md](docs/capture-protocol.md)** — what a clean recording looks like
- **[docs/playbook-debugging.md](docs/playbook-debugging.md)** — when DOM walks misbehave
- **[docs/design.md](docs/design.md)** — original thesis (April 2026 office-hours)

---

## Status

v0.1 — pipeline complete, two demos live. v0.2 candidates in [TODOS.md](TODOS.md). What's changed: [CHANGELOG.md](CHANGELOG.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Issues + PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
