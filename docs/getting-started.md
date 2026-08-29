# Getting started

A working MCP tool from a fresh clone in about 5 minutes.

The normal path is `imprint teach`. It starts one fresh foreground run, builds
the complete tool set found in the recording, and returns only after the run
has completed or failed. Install the completed tools in your MCP client as a
separate step.

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

## Teach your first site

Pick a site you want to automate. Internal admin panels, dashboards, and authed tools all work — anything you can drive in a browser.

Pick a short, descriptive label for `<site>` — it becomes the directory name for generated tools and private recordings under `~/.imprint/` (or `IMPRINT_HOME`). Examples: `google-flights`, `southwest`, `company-dashboard`.

Start a fresh teach and record the operations you want the site toolset to
cover:

```bash
imprint teach google-flights --url https://flights.google.com
#   → Chromium opens. Drive the workflow end-to-end. Narrate what
#     you're doing in the terminal. Press /done (or Ctrl+C) when finished.
#   → The command stays open through planning, compilation, repair, and checks.
#   → Its final line reports completed, blocked, failed, cancelled, or
#     provider unavailable, together with the fresh run directory.
```

The master must account for every credible operation found in the recording.
A tool-boundary advisor may suggest merging or splitting operations, but the
master owns the editable final plan. It also chooses explicit build waves:
producers come before their consumers, while independent tools may compile
together.

Each tool then gets a small, focused planning and compilation job. Contract,
replay, live, and producer-consumer checks run when applicable. If a check
fails, the master can revise the affected plan or artifact and rerun that tool
and its dependants. An independent reviewer sees the final plan and the factual
check history before the run can complete.

There are no resume, phase-window, primary-tool, or partial-selection modes.
Old run directories remain useful for diagnosis, but every new command starts
a clean teach.

To teach again from a specific existing recording, use `--from-session`. This
still creates a fresh run:

```bash
imprint teach google-flights \
  --from-session ~/.imprint/google-flights/sessions/<session>.json
```

A completed teach leaves one generated directory per verified tool under
`~/.imprint/google-flights/`. API workflows are preferred. A
`playbook.yaml` is added only when the agent has evidence that the higher
replay paths are incompatible.

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

## Teach options

Imprint auto-detects an available provider and model. Override them when
needed:

```bash
imprint teach google-flights --provider claude-cli --model claude-sonnet-4-6 --timeout 12h
```

The timeout applies to the foreground teach run and defaults to 12 hours so a
large discovered tool set is not cut off by a single-tool-sized budget. Imprint may keep working on
independent tools after one tool fails, but the command does not report success
unless every planned tool is verified. To retain generated tests, set
`IMPRINT_KEEP_TEST=1` or pass `--keep-test`.

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
imprint teach google-flights \
  --from-session ~/.imprint/google-flights/sessions/<session>.json \
  --provider codex-cli
```

In Phoenix you'll see every agent turn (`agent.turn.N`) with per-turn token counts, every LLM call (`llm.message_with_tools`) with model and token usage, and every tool dispatch (`agent.tool.X`) with timing. Add `IMPRINT_TRACE_LLM_IO=1` to capture prompts/responses and `IMPRINT_TRACE_TOOL_IO=1` to capture tool arguments and results. Raise `IMPRINT_TRACE_IO_MAX_CHARS` when you need longer payloads.

## Connect to your AI tool

Teaching and client registration are separate. After a successful teach, run:

```bash
imprint install google-flights --platform claude-desktop
```

See [docs/integrations.md](integrations.md) for every supported client.

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

For registration cleanup, use the interactive flow:

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
