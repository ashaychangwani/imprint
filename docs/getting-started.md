# Getting started

A working MCP tool from a fresh clone in about 5 minutes.

The fastest path is `imprint teach`, which runs the full pipeline interactively and handles platform integration automatically. For manual step-by-step control, follow the commands below.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- Google Chrome (any modern build)
- A Google Cloud project with Vertex AI Anthropic models enabled (for the LLM compile step)

## Install

```bash
git clone https://github.com/ashaychangwani/imprint.git
cd imprint
bun install
bun link                          # makes `imprint` global (needs ~/.bun/bin on PATH)
bunx playwright install chromium  # for fetch-bootstrap, stealth-fetch, and playbook backends
```

If `imprint --help` says "command not found" after `bun link`, your `~/.bun/bin` isn't on `PATH`. Either add it (Bun's installer normally does this) or skip `bun link` and call everything via `bun src/cli.ts <verb>`.

Set your Vertex project once:

```bash
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
export CLOUD_ML_REGION=us-east5    # optional; defaults to us-east5
```

Verify the install with the built-in environment check:

```bash
imprint doctor
# → checks Bun, Chromium, Playwright Chromium, Vertex env, push providers.
# → exits 0 if all required checks pass; 1 otherwise (CI-friendly).
```

## Your first tool — step by step

Pick a site you want to automate. Internal admin panels, dashboards, and authed tools all work — anything you can drive in a browser.

Pick a short, descriptive label for `<site>` — it becomes the directory name for generated tools under `examples/` and private recordings under `~/.imprint/`. Examples: `google-flights`, `southwest`, `company-dashboard`.

```bash
# 1. Record yourself doing the thing once
imprint record google-flights --url https://flights.google.com
#   → Chromium opens. Drive the workflow end-to-end. Narrate what
#     you're doing in the terminal. Press /done (or Ctrl+C) when finished.
#   → Output: ~/.imprint/google-flights/sessions/<timestamp>.{jsonl,json}

# 2. Pick the session you just recorded
SESSION=$(ls ~/.imprint/google-flights/sessions/*.json | grep -v redacted | tail -1)

# 3. Scrub credentials and PII before sending to the LLM
imprint redact "$SESSION"
#   → Output: ~/.imprint/google-flights/sessions/<timestamp>.redacted.json

# 4. LLM-compile two artifacts (workflow.json + playbook.yaml)
imprint generate "${SESSION%.json}.redacted.json"
imprint compile-playbook "${SESSION%.json}.redacted.json"
#   → Outputs: examples/google-flights/search_google_flights/{workflow.json, playbook.yaml}

# 5. Emit the executable TS module
imprint emit examples/google-flights/search_google_flights/workflow.json
#   → Output: examples/google-flights/search_google_flights/index.ts

# 6. (Optional) Probe which backends work and cache the order.
#    Safe to skip for plain APIs; useful for stateful or bot-protected sites.
imprint probe-backends google-flights
#   → Output: examples/google-flights/search_google_flights/backends.json

# 7. Test it
imprint mcp-server google-flights    # stdio MCP server
```

You now have an MCP tool any agent can call.

Stateful workflows still run through the same generated tool. If a request sets a cookie or response value that a later request needs, the workflow compiler emits named captures and `${state.NAME}` placeholders. Plain HTTP producers stay on the fast `fetch` path; browser bootstrap is used only when the workflow declares that Chromium is needed to mint the state.

## Connect to your AI tool

`imprint teach` handles platform integration automatically at the end of the pipeline. For manual setup, see [docs/integrations.md](integrations.md).

Quick examples:

```bash
# Claude Code (one command):
claude mcp add --scope user imprint-google-flights -- imprint mcp-server google-flights

# Test with mcp-inspector:
npx @modelcontextprotocol/inspector imprint mcp-server google-flights
```

## Schedule it

Drop a `cron.json` next to your generated tool:

```json
{
  "schedule": "0 9 * * *",
  "params": { "city": "Oakland" },
  "replayBackend": "auto"
}
```

Then run the daemon:

```bash
imprint cron acmecorp                      # foreground daemon (Ctrl+C to stop)
imprint cron acmecorp --once               # single tick (for OS schedulers)
imprint cron acmecorp --once --quiet       # silent on success — pair with cron/systemd
```

`--quiet` suppresses all info logs on successful runs; failures still print to stderr. Use it from `cron`/`systemd timer`/`launchd` so you only get mail/alerts when something's actually broken.

Optional: configure push notifications by setting `PUSHOVER_TOKEN` + `PUSHOVER_USER`, or `NTFY_URL`. See [docs/notifications.md](notifications.md).

## When something doesn't work

See [docs/troubleshooting.md](troubleshooting.md) for the predictable failures (Akamai 403, Playwright not installed, MCP client not seeing tools, etc.).

For deeper architectural context, [docs/architecture.md](architecture.md).
