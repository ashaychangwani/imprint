# Imprint

**Teach AI agents to use any website by demonstrating once.**

Imprint watches you do something on a website, captures both the underlying API calls *and* the precise DOM events, and generates two deterministic artifacts an agent can call from then on:

1. A **[MCP server](https://modelcontextprotocol.io/)** that replays the captured API workflow. Cheap (~200ms per call), works for ~70% of sites.
2. A **markdown playbook** — a frozen click recipe with stable locator priorities, executable in any real browser. Slower (~5-10s per call) but works on bot-protected sites where API replay returns 403.

Other browser-tool frameworks (browser-use, Computer Use, openclaw) ask the LLM to *decide every click at runtime*. Token cost scales with workflow length; reliability is variable; bot-detection forces operators to pay for stealth APIs. Imprint's pitch is different: **the recording IS the executable.** The agent reads the playbook and follows it verbatim. Zero exploration tokens, zero re-decision variance, real Chromium → real `_abck` → no bot block.

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
cp .env.example .env       # fill in the Vertex AI credentials
bun link && bun link imprint   # one-time: expose `imprint` on your PATH

# Capture a teaching session (opens Chromium; type narration as you click).
# Use any site name — files land at examples/<site>/sessions/<timestamp>.jsonl
imprint record discoverandgo

# Scrub credentials, then send the redacted session to Claude for analysis
imprint redact examples/discoverandgo/sessions/<timestamp>.json
imprint generate examples/discoverandgo/sessions/<timestamp>.redacted.json

# Codegen the deterministic TS module from the workflow
imprint emit examples/discoverandgo/workflow.json

# Optional: also compile a DOM playbook for sites where the API path
# may get blocked by bot detection (Akamai/Cloudflare/etc).
imprint compile-playbook examples/discoverandgo/sessions/<timestamp>.redacted.json

# Optional: probe each backend once and cache the ranked order so cron
# + MCP skip futile rungs every tick.
imprint probe-backends discoverandgo

# Either expose every generated tool as MCP for Claude Desktop / Cursor…
imprint mcp-server

# …or schedule one as a cron job (drop a cron.json next to workflow.json first)
imprint cron discoverandgo
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
| `imprint compile-playbook <session>` | LLM-compile the captured DOM events into `examples/<site>/playbook.md` — the browser-replay artifact for sites the API path can't reach. |
| `imprint playbook <site>` | Run a playbook against a real Chromium. Flags: `--headed`, `--param k=v`, `--path <md>`. |
| `imprint probe-backends <site>` | Try fetch / stealth-fetch / playbook once and write `examples/<site>/backends.json` with the ranked order. cron + MCP read this so they skip futile rungs every tick. |
| `imprint login <site>` | Persist auth cookies for `<site>` from a captured session. |
| `imprint cron <site>` | Start the polling daemon for `examples/<site>/cron.json`. Flags: `--once`, `--run-now`, `--config <path>`. |
| `imprint mcp-server` | Run the MCP server (stdio default; `--http --port N` for HTTP). `--site <name>` restricts to one example. Sites with a playbook also expose `<toolName>_via_browser` as a fallback tool. |

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

#### Push on success too — `notifyWhen`

By default cron only pushes on failures. Add an optional `notifyWhen` block to also push when a successful tool result matches a condition. v0.1 ships one predicate, `price_below`, for fare/price watchers:

```jsonc
// examples/southwest/cron.json
{
  "schedule": "0 9 * * *",
  "params": { /* …captured search params… */ },
  "notifyWhen": {
    "type": "price_below",
    "threshold": 99,
    "pricePath": "bounds[].flights[].fares[].price.amount"
  }
}
```

`pricePath` is a dot-path; use `[]` to mean "iterate every element of this array". The predicate gathers every numeric leaf at that path, takes the minimum, and pushes if it's strictly below `threshold`. Numeric strings (e.g. Southwest returns `"108.40"`) are coerced. To find the right path for your captured workflow, run `imprint cron <site> --once` first — the success log line includes the raw response and you can read off the JSON path.

#### The replay-backend ladder — bot detection is no longer a dead end

Sites like Southwest, Ticketmaster, and anything behind Akamai / Cloudflare / DataDome return `403` to non-browser HTTP clients regardless of TLS-fingerprint spoofing. Imprint handles this by walking a **ladder** of progressively heavier replay backends, escalating only when the cheaper rung gets blocked:

| Backend | How | Per-call cost | Defeats |
|---|---|---|---|
| `fetch` | Captured `workflow.json` via Node `fetch` | ~200ms | Plain APIs |
| `stealth-fetch` | Bootstrap Playwright once to mint Akamai sensor tokens, then native `fetch` augmented with those tokens | ~12s bootstrap (one-time per process) + ~1s per call | Akamai, Cloudflare, DataDome (token-validation tier) |
| `playbook` | Full Playwright + stealth + DOM walk via `playbook.md` | ~9.4s per call | Universal — also handles sites that need form-fills, autocompletes, multi-page navigation |

Set `replayBackend` in `cron.json` (or omit for the default):

- `"fetch"` (default) — try the API only.
- `"stealth-fetch"` — skip the futile fetch attempt for known bot-protected sites.
- `"playbook"` — force the DOM path.
- **`"auto"` (recommended for bot-protected sites)** — walk the full ladder. Fetch first; on `FORBIDDEN`, escalate to stealth-fetch; on `FORBIDDEN`, escalate to playbook. Returns the first non-FORBIDDEN result. Other error classes (AUTH_EXPIRED, RATE_LIMITED, etc) don't escalate — those indicate problems no other backend can fix.

```jsonc
// examples/southwest/cron.json — bot-protected, uses auto ladder
{
  "schedule": "0 9 * * *",
  "replayBackend": "auto",
  "params": { /* …captured search params… */ },
  "notifyWhen": { "type": "price_below", "threshold": 99, "pricePath": "prices[]" }
}
```

A typical Southwest cron tick log (no probe yet — auto walks the full ladder):
```
[imprint cron] replayBackend: auto (ladder: fetch → stealth-fetch → playbook)
[imprint backend] trying fetch…
[imprint backend] fetch: FORBIDDEN in 321ms — escalating
[imprint backend] trying stealth-fetch…
[imprint stealth] bootstrapping…
[imprint stealth] bootstrapped in 5125ms — 18 cookies, 7 sensor headers
[imprint backend] stealth-fetch: OK in 10218ms
[imprint cron]   OK in 10588ms via stealth-fetch: {"prices":[108.4]}
```

The principle: as long as some backend would have worked, the call succeeds. "Imprint can't help here" is the failure mode this design eliminates.

#### One-time probe — skip the futile rungs

Walking the full ladder every tick wastes ~200ms on the fetch attempt that always 403s for bot-protected sites. Run `imprint probe-backends <site>` once after `emit` to find which backends work and persist the order to `examples/<site>/backends.json`:

```bash
imprint probe-backends southwest
# [imprint probe] probing fetch / stealth-fetch / playbook for search_southwest_flights…
# [imprint probe]   fetch: FORBIDDEN
# [imprint probe]   stealth-fetch: OK in 12419ms
# [imprint probe]   playbook: OK in 13597ms
# [imprint probe] wrote examples/southwest/backends.json — preferred: stealth-fetch → playbook
```

Subsequent cron ticks read the cache and start with the cheapest known-working backend:
```
[imprint cron] backends.json: probed 2026-05-03T22:23:26Z, preferred order: stealth-fetch → playbook
[imprint cron] replayBackend: auto (ladder: stealth-fetch → playbook)
[imprint backend] trying stealth-fetch…    ← starts here, skips the futile fetch
[imprint backend] stealth-fetch: OK in 10218ms
[imprint cron]   OK in 10218ms via stealth-fetch
```

The runtime ladder still serves as the fallback if the cached backend stops working between probes (token-validator changes, API moves behind a stricter WAF tier, etc). Re-run the probe whenever you re-record or the site changes its bot-detection posture.

```bash
# Compile the playbook for sites that need the DOM path
imprint compile-playbook examples/southwest/sessions/<ts>.redacted.json

# Standalone test of the playbook path
imprint playbook southwest --param origin_airport_code=SJC \
                           --param destination_airport_code=SAN \
                           --param departure_date=2026-06-20
```

The MCP server registers ONE tool per site (`<toolName>`); calls route through the ladder internally. An LLM client doesn't need to know about backends — `(backend: stealth-fetch)` is appended to the response text so it can see which path produced the answer.

> **Browser install:** stealth-fetch and the playbook backend use Playwright's bundled Chromium. If you haven't already, run `bunx playwright install chromium` once.

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
