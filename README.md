# Imprint

**Teach AI agents to use any website by demonstrating once.**

Imprint watches you do something on a website, captures the underlying API calls and your narration, and generates a deterministic [MCP server](https://modelcontextprotocol.io/) an agent can call from then on. Browser-use is great at one-shot exploration where the LLM re-decides every action at runtime. Imprint freezes the workflow into a cheap, fast, deterministic tool after one demonstration.

> **Status:** v0.1, in a 2-week sprint (April 2026) as a portfolio piece. The pipeline (`record` → `generate` → `emit` → `mcp-server` / `cron`) is built and validated end-to-end against the real Discover & Go museum-pass API. Three demos planned for the launch: Southwest seat tracker, Luma SF event finder, and an internal canteen ordering tool. See [TODOS.md](./TODOS.md) for v0.2 candidates.

## How it works

```
┌─────────────┐   record session     ┌──────────────┐
│  Headless   │ ──────────────────→  │ session.json │
│  Chromium   │   network + DOM      │   (JSONL)    │
│  via CDP    │   + text narration   └──────┬───────┘
└─────────────┘                              │
                                             ▼
                                      ┌──────────────┐
                                      │  Claude      │
                                      │  Sonnet 4.6  │
                                      │  identifies  │
                                      │  intent +    │
                                      │  parameters  │
                                      └──────┬───────┘
                                             ▼
                                      ┌──────────────┐
                                      │workflow.json │
                                      │ (chained     │
                                      │  request     │
                                      │  graph)      │
                                      └──────┬───────┘
                                             ▼
                                      ┌──────────────┐
                                      │  Codegen     │
                                      │  emits TS    │
                                      │  module      │
                                      └──────┬───────┘
                                             │
                          ┌──────────────────┴──────────────────┐
                          ▼                                     ▼
                   ┌──────────────┐                      ┌──────────────┐
                   │ MCP server   │                      │ node-cron    │
                   │ (Claude Desk)│                      │ poller       │
                   └──────┬───────┘                      └──────┬───────┘
                          └──────────────┬──────────────────────┘
                                         ▼
                                  ┌──────────────┐
                                  │ runWorkflow()│
                                  │ shared TS fn │
                                  └──────────────┘
```

## Quickstart

> Requires [Bun](https://bun.sh/) ≥ 1.3 and a Chromium-based browser.

```bash
git clone https://github.com/ashaychangwani/imprint
cd imprint
bun install
cp .env.example .env  # fill in the Vertex AI credentials

# Capture a teaching session (opens Chromium; type narration as you click).
# Use any site name — files land at examples/<site>/sessions/<timestamp>.jsonl
bun run dev record discoverandgo

# Scrub credentials, then send the redacted session to Claude for analysis
bun run dev redact examples/discoverandgo/sessions/<timestamp>.json
bun run dev generate examples/discoverandgo/sessions/<timestamp>.redacted.json

# Codegen the deterministic TS module from the workflow
bun run dev emit examples/discoverandgo/workflow.json

# Either expose every generated tool as MCP for Claude Desktop / Cursor…
bun run dev mcp-server

# …or schedule one as a cron job (drop a cron.json next to workflow.json first)
bun run dev cron discoverandgo
```

## CLI verbs

| Verb | What it does |
|------|---|
| `imprint record <site>` | Open Chromium, stream the teaching session to `examples/<site>/sessions/<ts>.jsonl`. Flags: `--url`, `--persist-profile`, `--out`. |
| `imprint assemble <session.jsonl>` | Reconstruct `session.json` from the streaming JSONL (recovery if `record` shutdown didn't finish). |
| `imprint check <session>` | Sanity-check a captured `session.json` or `.jsonl` for the rules in `docs/capture-protocol.md`. |
| `imprint redact <session.json>` | Scrub credentials + PII; write `<session>.redacted.json`. Run this before sharing or sending to the LLM. |
| `imprint generate <session>` | Run LLM intent-detection on a redacted session; write `workflow.json`. |
| `imprint emit <workflow>` | Generate the deterministic TS module at `examples/<site>/index.ts`. |
| `imprint login <site>` | Persist auth cookies for `<site>` from a captured session. |
| `imprint cron <site>` | Start the polling daemon for `examples/<site>/cron.json`. Flags: `--once`, `--run-now`, `--config <path>`. |
| `imprint mcp-server` | Run the MCP server (stdio default; `--http --port N` for HTTP). `--site <name>` restricts to one example. |

### Wiring up Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imprint": {
      "command": "bun",
      "args": ["run", "/abs/path/to/imprint/src/cli.ts", "mcp-server"]
    }
  }
}
```

Restart Claude Desktop. Your generated tools (e.g. `book_discoverandgo_museum_pass`) appear in the MCP tools panel. For other clients (Cursor, Continue.dev, mcp-inspector), point them at the same `bun run …/src/cli.ts mcp-server` command — the protocol is standard.

> **Env vars in stdio mode:** the MCP SDK strips spawned-process env down to a tiny safe-list (`HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`). If a workflow needs anything else (corporate `NODE_EXTRA_CA_CERTS`, an API key, etc.), add an `env` block to the config — keys you list there are merged into the safe defaults:
>
> ```json
> "imprint": {
>   "command": "bun",
>   "args": ["run", "/abs/path/to/imprint/src/cli.ts", "mcp-server"],
>   "env": { "NODE_EXTRA_CA_CERTS": "/path/to/corp-ca.pem" }
> }
> ```

### Polling with cron

Drop a `cron.json` next to your generated `workflow.json`, then run `imprint cron <site>`:

```jsonc
// examples/discoverandgo/cron.json
{
  "schedule": "0 0 * * *",                      // standard 5-field cron expression
  "params": {
    "offer_id": 1175,
    "offer_date": "2026-12-31",
    "notification_email": "you@example.com"
  }
}
```

```bash
imprint cron discoverandgo            # schedule and block until Ctrl-C
imprint cron discoverandgo --run-now  # also run once immediately
imprint cron discoverandgo --once     # run a single tick and exit
                                      # (use this from systemd timers / launchd / OS cron)
```

Set notification env vars to get a push on every failure (auth expired, network errors, rate limits). Pick whichever provider you prefer — set both and they fire in parallel:

| Provider | Env vars | Notes |
|---|---|---|
| **[Pushover](https://pushover.net/)** | `PUSHOVER_TOKEN`, `PUSHOVER_USER` | $5 one-time per platform. Polished iOS/Android/desktop apps. |
| **[ntfy](https://ntfy.sh/)** | `NTFY_URL` (e.g. `https://ntfy.sh/your-secret-topic`), `NTFY_TOKEN` (optional, for protected topics on self-hosted) | Free. Self-hostable. Pick a hard-to-guess topic name on the public server. |

With nothing configured, failures are logged to stderr only.

## Demos

Coming on launch day. Each lives in `examples/<name>/`:

- **Southwest seat tracker** — polls every 15 min, books your preferred seat the moment it opens up, push-notifies you
- **Luma event finder** — "find SF AI events this weekend" as an MCP tool
- **Office canteen ordering** — order lunch in 30 seconds via Claude Desktop

## Why this exists

I was tired of copying `curl` from devtools and pasting it into Claude every time I wanted to script a website. So I taught Claude to do the copying.

For the longer story, see [`docs/design.md`](./docs/design.md) (the original thesis) and [`docs/capture-protocol.md`](./docs/capture-protocol.md) (the rules a clean recording follows).

## License

MIT. See [LICENSE](./LICENSE).
