# Getting started

A working MCP tool from a fresh clone in about 5 minutes.

The fastest path is `imprint teach`, which runs the full pipeline interactively and handles platform integration automatically. For manual step-by-step control, follow the commands below.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- Google Chrome (any modern build) or Playwright Chromium, which Imprint can install automatically when needed
- A compile-agent provider for `teach`/`generate`: Claude CLI, Codex CLI, or Anthropic API. Cursor CLI is supported for generic prompt/playbook compilation, not the agentic API workflow compiler yet.

## Install

### npm (recommended)

```bash
bun install -g imprint-mcp
```

### From source

```bash
git clone https://github.com/ashaychangwani/imprint.git
cd imprint
bun install
bun link                          # makes `imprint` global (needs ~/.bun/bin on PATH)
```

By default, all Imprint data lives in `~/.imprint/`. Set `IMPRINT_HOME` to relocate it.

If `imprint --help` says "command not found" after `bun link`, your `~/.bun/bin` isn't on `PATH`. Either add it (Bun's installer normally does this) or skip `bun link` and call everything via `bun src/cli.ts <verb>`.

Verify the install with the built-in environment check:

```bash
imprint doctor
# → checks Bun, Chromium, Playwright Chromium, LLM providers, push providers.
# → exits 0 if all required checks pass; 1 otherwise (CI-friendly).
```

## Install a checked-in example MCP

You can install one of the committed example MCPs without recording anything:

```bash
imprint install google-flights --source examples --platform claude-desktop
```

Swap `claude-desktop` for `claude-code`, `codex`, `openclaw`, or `hermes`. Add `--print` to preview the config without changing any client files.

For browser-backed examples such as Google Flights, Google Hotels, and Southwest, `imprint install` installs Playwright Chromium automatically on the same machine that will run the MCP server. If you are preparing an offline image, preinstall it with:

```bash
bunx playwright install chromium
```

In a Linux image that is missing browser libraries, install OS-level browser dependencies at image build time with:

```bash
bunx playwright install --with-deps chromium
```

### Hermes Agent / Docker

Hermes containers commonly expose their live config through `$HERMES_HOME/config.yaml`. Imprint detects that automatically, so a Hermes agent can set itself up from a shell with:

```bash
bun install -g imprint-mcp

for site in google-flights google-hotels southwest discoverandgo echo; do
  imprint install "$site" --source examples --platform hermes --no-interactive
done
```

Restart or reload Hermes after editing its config. The installed MCP entries will use `$HERMES_HOME/config.yaml` when `HERMES_HOME` is set, or `~/.hermes/config.yaml` outside Hermes. Browser-backed examples install Playwright Chromium into `$HERMES_HOME/.cache/ms-playwright` automatically and add `PLAYWRIGHT_BROWSERS_PATH` to the Hermes MCP entry.

## Your first tool — step by step

Pick a site you want to automate. Internal admin panels, dashboards, and authed tools all work — anything you can drive in a browser.

Pick a short, descriptive label for `<site>` — it becomes the directory name for generated tools and private recordings under `~/.imprint/` (or `IMPRINT_HOME`). Examples: `google-flights`, `southwest`, `company-dashboard`.

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
#   → Output: ~/.imprint/google-flights/<toolName>/workflow.json
imprint compile-playbook "${SESSION%.json}.redacted.json"
#   → Output: ~/.imprint/google-flights/<toolName>/playbook.yaml

# 5. Emit the executable TS module
imprint emit ~/.imprint/google-flights/search_google_flights/workflow.json
#   → Output: ~/.imprint/google-flights/search_google_flights/index.ts

# 6. (Optional) Probe which backends work and cache the order.
#    Safe to skip for plain APIs; useful for stateful or bot-protected sites.
imprint probe-backends google-flights --tool search_google_flights
#   Multi-tool site? Refresh every tool with: imprint probe-backends google-flights --all
#   → Output: ~/.imprint/google-flights/search_google_flights/backends.json

# 7. Test it
imprint mcp-server google-flights    # stdio MCP server
```

You now have an MCP tool any agent can call.

To add that same emitted MCP server to another platform later:

```bash
imprint install google-flights --platform claude-desktop
```

To remove it from a platform:

```bash
imprint uninstall google-flights --platform claude-desktop
```

To try a checked-in demo without recording or compiling:

```bash
imprint install google-flights --source examples --platform claude-code
```

Stateful workflows still run through the same generated tool. If a request sets a cookie or response value that a later request needs, the workflow compiler emits named captures and `${state.NAME}` placeholders. Plain HTTP producers stay on the fast `fetch` path; browser bootstrap is used only when the workflow declares that Chromium is needed to mint the state.

## Compile options

`imprint teach` prompts for a **provider** and **model** interactively. To skip the prompts or override defaults:

```bash
imprint teach google-flights --provider claude-cli --model claude-sonnet-4-6 --timeout 20m
```

Each tool has a **20-minute compile timeout** by default. The compile agent writes the MCP server and runs thorough verification tests — most complex tools take 10-15 minutes, so be patient. If your site is especially complex, increase the timeout with `--timeout`. If a tool fails to compile (e.g. timeout or bot defense), the other tools in the same recording still compile successfully. To persist the generated tests after compilation, set `IMPRINT_KEEP_TEST=1` or pass `--keep-test`.

To skip the replay-and-diff stage (the automated second pass that classifies values as constant vs browser-minted), add `--skip-replay`. This is faster but means the compile agent can't distinguish ephemeral values (timestamps, CSRF tokens) from constants, which may reduce workflow accuracy for sites with dynamic request parameters.

## Inspect slow compiles

For local trace visibility, run Phoenix and enable Imprint tracing:

```bash
uv tool install arize-phoenix
phoenix serve

IMPRINT_TRACE=1 \
IMPRINT_TRACE_BATCH=false \
IMPRINT_TRACE_LLM_IO=1 \
IMPRINT_TRACE_TOOL_IO=1 \
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 \
imprint teach google-flights --from-session "$SESSION" --provider codex-cli
```

In Phoenix you'll see every agent turn (`agent.turn.N`) with per-turn token counts, every LLM call (`llm.message_with_tools`) with model and token usage, and every tool dispatch (`agent.tool.X`) with timing. Add `IMPRINT_TRACE_LLM_IO=1` to capture prompts/responses and `IMPRINT_TRACE_TOOL_IO=1` to capture tool arguments and results. Raise `IMPRINT_TRACE_IO_MAX_CHARS` when you need longer payloads.

## Connect to your AI tool

`imprint teach` handles platform integration automatically at the end of the pipeline. For manual setup, see [docs/integrations.md](integrations.md).

Quick examples:

```bash
# Claude Code (one command):
claude mcp add --scope user imprint-google-flights -- imprint mcp-server google-flights

# Test with mcp-inspector:
npx @modelcontextprotocol/inspector imprint mcp-server google-flights
```

Audit the registration and local generated state any time a client does not show the tool:

```bash
imprint mcp status --site google-flights
```

For cleanup or stale `teach` checkpoints, use the interactive flow:

```bash
imprint mcp
```

See [MCP Maintenance](mcp-maintenance.md) for direct disable/delete/prune commands and recording deletion caveats.

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

See [docs/troubleshooting.md](troubleshooting.md) for the predictable failures (Akamai 403, Playwright not installed, MCP client not seeing tools, etc.). For MCP registration cleanup, start with [MCP Maintenance](mcp-maintenance.md).

For deeper architectural context, [docs/architecture.md](architecture.md).
