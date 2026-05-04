# Getting started

A working MCP tool from a fresh clone in about 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- Google Chrome (any modern build)
- A Google Cloud project with Vertex AI Anthropic models enabled (for the LLM compile step)

## Install

```bash
git clone https://github.com/<you>/imprint.git
cd imprint
bun install
bun link    # makes `imprint` available globally on PATH
bunx playwright install chromium    # for stealth-fetch + playbook backends
```

Set your Vertex project once:

```bash
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
export CLOUD_ML_REGION=us-east5    # optional; defaults to us-east5
```

## Your first tool — 60 seconds

Pick a site you want to automate. We'll use a search box on a public site as the example, but it works on any site you can drive in a browser (internal admin panels, dashboards, login-required tools, etc.).

```bash
# 1. Record yourself doing the thing once
imprint record acmecorp --url https://app.acmecorp.com
#   → Chromium opens. Drive the workflow. Narrate what you're doing.
#   → Press /done or Ctrl+C when finished.
#   → Output: examples/acmecorp/sessions/<timestamp>.{jsonl,json}

# 2. Scrub PII
imprint redact examples/acmecorp/sessions/<timestamp>.json
#   → Output: examples/acmecorp/sessions/<timestamp>.redacted.json

# 3. LLM-compile to two artifacts
imprint generate examples/acmecorp/sessions/<timestamp>.redacted.json
imprint compile-playbook examples/acmecorp/sessions/<timestamp>.redacted.json
#   → Outputs: examples/acmecorp/{workflow.json, playbook.yaml}

# 4. Emit the executable TS module
imprint emit examples/acmecorp/workflow.json
#   → Output: examples/acmecorp/index.ts

# 5. Probe which backends work
imprint probe-backends acmecorp
#   → Output: examples/acmecorp/backends.json

# 6. (Optional) test it directly
imprint mcp-server --site acmecorp    # stdio MCP server
```

You now have an MCP tool any agent can call.

## Wire it up to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imprint": {
      "command": "imprint",
      "args": ["mcp-server"]
    }
  }
}
```

Restart Claude Desktop. The tools you've generated will appear in the MCP tools panel — Claude can now call them.

## Wire it up to mcp-inspector (for debugging)

```bash
npx @modelcontextprotocol/inspector imprint mcp-server
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
imprint cron acmecorp
```

Optional: configure push notifications by setting `PUSHOVER_TOKEN` + `PUSHOVER_USER`, or `NTFY_URL`. See [docs/notifications.md](notifications.md).

## When something doesn't work

See [docs/troubleshooting.md](troubleshooting.md) for the predictable failures (Akamai 403, Playwright not installed, MCP client not seeing tools, etc.).

For deeper architectural context, [docs/architecture.md](architecture.md).
