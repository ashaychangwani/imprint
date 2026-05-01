# Imprint

**Teach AI agents to use any website by demonstrating once.**

Imprint watches you do something on a website, captures the underlying API calls and your narration, and generates a deterministic [MCP server](https://modelcontextprotocol.io/) an agent can call from then on. Browser-use is great at one-shot exploration where the LLM re-decides every action at runtime. Imprint freezes the workflow into a cheap, fast, deterministic tool after one demonstration.

> **Status:** v0.1, built in a 2-week sprint in April 2026 as a portfolio piece. Three demos ship: Southwest seat tracker, Luma SF event finder, and an internal canteen ordering tool. See [TODOS.md](./TODOS.md) for v0.2 candidates.

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
cp .env.example .env  # add your ANTHROPIC_API_KEY

# Capture a teaching session
bun run dev record southwest

# Generate the workflow + MCP server
bun run dev generate examples/southwest/sessions/<latest>.json
bun run dev emit examples/southwest/workflow.json

# Run the cron poller
bun run dev cron southwest
```

## CLI verbs

| Verb | What it does |
|------|---|
| `imprint record <site>` | Open Chromium, capture a teaching session to `session.json` |
| `imprint generate <session>` | Run LLM intent-detection on a saved session, write `workflow.json` |
| `imprint emit <workflow>` | Generate the MCP server TypeScript module |
| `imprint login <site>` | Open Chromium for user-driven login, persist cookies |
| `imprint cron <example>` | Start the polling daemon for a generated workflow |
| `imprint mcp-server <example>` | Speak MCP stdio protocol — for Claude Desktop / agents |

## Demos

Coming on launch day. Each lives in `examples/<name>/`:

- **Southwest seat tracker** — polls every 15 min, books your preferred seat the moment it opens up, Pushover-notifies you
- **Luma event finder** — "find SF AI events this weekend" as an MCP tool
- **Office canteen ordering** — order lunch in 30 seconds via Claude Desktop

## Why this exists

I was tired of copying `curl` from devtools and pasting it into Claude every time I wanted to script a website. So I taught Claude to do the copying.

For the longer story, see [`docs/design.md`](./docs/design.md) (the original April-2 thesis) and the v0.1 sprint design in [`docs/sprint.md`](./docs/sprint.md) (added later).

## License

MIT. See [LICENSE](./LICENSE).
