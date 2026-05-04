# Imprint

> **Teach an AI agent how to use any website. Once.**

Show Imprint a workflow in a real browser — drive the page, narrate what you're doing — and you get back two deterministic replay artifacts plus a generated MCP tool any AI agent can call from then on. No re-decisions, no exploration tokens, no "the LLM clicked the wrong button" variance. The recording **is** the executable.

```
record once  →  workflow.json + playbook.yaml + index.ts  →  MCP tool / cron job
```

---

## 60-second quickstart

```bash
git clone https://github.com/<you>/imprint.git
cd imprint
bun install && bun link
bunx playwright install chromium
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project

# 1. Drive the workflow once. Pick any site you want to automate.
imprint record mysite --url https://your-site-here.example.com
# (Chromium opens. Do the thing. Narrate. /done when finished.)

# 2. Pick the session you just recorded.
SESSION=$(ls examples/mysite/sessions/*.json | grep -v redacted | tail -1)

# 3. Scrub credentials, LLM-compile two replay artifacts, codegen the tool.
imprint redact "$SESSION"
imprint generate "${SESSION%.json}.redacted.json"
imprint compile-playbook "${SESSION%.json}.redacted.json"
imprint emit examples/mysite/workflow.json

# 4. (Optional) probe which backends work — caches the order so cron/MCP
#    skip futile rungs. Safe to skip on plain APIs; useful for bot-protected sites.
imprint probe-backends mysite

# 5. Expose as MCP for Claude Desktop / Cursor / Continue.dev
imprint mcp-server     # see docs/getting-started.md for claude_desktop_config.json
```

For the full walkthrough including Claude Desktop wire-up, see [docs/getting-started.md](docs/getting-started.md).

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
| `examples/echo` | Trivial MCP smoke-test fixture | `imprint mcp-server --site echo` |

---

## How it works

```
   imprint record  ─┐
                    ▼
              session.json
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  imprint generate     imprint compile-playbook
        │                       │
        ▼                       ▼
  workflow.json          playbook.yaml
        │
  imprint emit
        ▼
  examples/<site>/index.ts  ──┐
                              │
       imprint cron / mcp ────┼──► backend ladder
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

Verbs: `record`, `assemble`, `check`, `redact`, `generate`, `compile-playbook`, `emit`, `login`, `probe-backends`, `playbook`, `cron`, `mcp-server`.

---

## Docs

- **[docs/getting-started.md](docs/getting-started.md)** — full walkthrough, Claude Desktop wire-up
- **[docs/architecture.md](docs/architecture.md)** — data flow, module map, file taxonomy
- **[docs/glossary.md](docs/glossary.md)** — Session, Workflow, Playbook, Backend, Stealth-fetch, etc.
- **[docs/decisions.md](docs/decisions.md)** — the load-bearing calls (why YAML, why ladder, why MCP-stdio default)
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — predictable failures + fixes
- **[docs/notifications.md](docs/notifications.md)** — Pushover + ntfy setup, predicate language
- **[docs/capture-protocol.md](docs/capture-protocol.md)** — what a clean recording looks like
- **[docs/playbook-debugging.md](docs/playbook-debugging.md)** — when DOM walks misbehave
- **[docs/design.md](docs/design.md)** — original thesis (April 2026 office-hours)

---

## Status

v0.1 — pipeline complete, two demos live. v0.2 candidates in [TODOS.md](TODOS.md). Issues + PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
