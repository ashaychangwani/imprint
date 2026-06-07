# Integrations

How to connect Imprint MCP tools to your AI platform.

## Overview

`imprint teach` handles this automatically — it runs the full pipeline (record, redact, generate, compile-playbook, emit) and then asks which platform you use. After a tool has been emitted, run `imprint install <site>` any time to add the same MCP server to another platform. Remove platform registrations with `imprint uninstall <site>`.

This document is for the install/uninstall commands, manual setup, and advanced configuration.

Each site gets its own MCP server: `imprint mcp-server southwest` registers as `imprint-southwest`. This isolation ensures multiple Imprint tools coexist without name collisions.

> For sites that require authentication, run `imprint login <site>` or `imprint credential set <site> <name>` before starting the MCP server. The server will warn about missing credentials at startup.

## Install Command

Install an emitted local tool:

```bash
imprint install mysite --platform claude-code
```

Install a checked-in example without recording or compiling anything:

```bash
imprint install google-flights --source examples --platform claude-desktop
```

Run `imprint install` with no arguments for an interactive picker. The picker only shows AI platforms detected on the current machine. The command registers the MCP server with the right `IMPRINT_HOME` so generated tools use your local `~/.imprint` assets and examples use the repo's `examples/` assets. For config-file clients such as Claude Desktop, OpenClaw, and Hermes, Imprint writes an absolute Bun + CLI path instead of relying on the GUI app's shell PATH. Add `--print` to show the command/config without changing platform state.

## Uninstall Command

Remove a registered Imprint MCP server from a platform:

```bash
imprint uninstall mysite --platform claude-code
```

You can also run `imprint uninstall` with no arguments and answer the prompts, or choose "Uninstall an MCP server" from the interactive `imprint install` TUI. The picker only shows detected platforms that currently have installed `imprint-*` MCP servers, then lists those installed servers directly. For Claude Code and Codex, Imprint reads the platform's MCP list and runs the platform's MCP remove command. For Claude Desktop, OpenClaw, and Hermes, it reads and removes the `imprint-<site>` entry from the platform config file. Add `--print` to show the remove command/config edit without applying it.

## Audit and cleanup

Use `imprint mcp status` before debugging a client-specific tool list. It audits known Imprint-owned registrations across Claude Code, Codex CLI user/project config, Claude Desktop, OpenClaw, and Hermes, then compares them with local generated tools and `teach` checkpoint state under `IMPRINT_HOME`.

```bash
imprint mcp status
imprint mcp status --site mysite --json
```

Run `imprint mcp` for an interactive cleanup flow, or use direct commands in scripts:

```bash
imprint mcp disable imprint-mysite --client all --yes
imprint mcp enable imprint-mysite --client all --yes
imprint mcp delete imprint-mysite --client codex --yes
imprint mcp prune-state --site mysite --missing-session --yes
```

`disable` is reversible. Codex keeps the entry with `enabled = false`; other clients remove the active entry and store a restorable snapshot at `<IMPRINT_HOME>/.mcp-disabled.json`. That snapshot preserves the full server definition, including fields such as `env` and `cwd`. `delete` removes active MCP registrations and does not remove generated tools or recordings unless you pass `--local tool` or `--local site`.

Raw session recordings can include cookies or other sensitive browser state. Imprint only deletes recordings when you explicitly choose full local site deletion with `--local site`.

Claude Desktop, OpenClaw, and Hermes read their config at startup, so restart those clients after direct config edits. Claude Code and Codex pick up most changes in new sessions.

See [MCP Maintenance](mcp-maintenance.md) for status classifications, local artifact cleanup modes, and the full direct command reference.

---

## Claude Code

Claude Code is the CLI for Claude. It ships with first-class MCP support.

### Quick setup

```bash
claude mcp add --scope user imprint-google-flights -- imprint mcp-server google-flights
```

This registers the tool globally (available in every Claude Code session). To restrict to a single project:

```bash
claude mcp add --scope project imprint-google-flights -- imprint mcp-server google-flights
```

### Debugging

Enable MCP debug output to see tool calls and responses:

```bash
claude --mcp-debug
```

### Team sharing

Claude Code reads MCP config from `.mcp.json` in the project root. To share your Imprint tools with the team, commit `.mcp.json` to version control:

```json
{
  "mcpServers": {
    "imprint-mysite": {
      "command": "imprint",
      "args": ["mcp-server", "mysite"]
    }
  }
}
```

Install Imprint globally (`bun install -g imprint-mcp`) so the `imprint` command is on PATH, then Claude Code discovers the tools automatically.

---

## Codex CLI

Codex is another AI-powered CLI. It has MCP support via the `codex mcp` command.

### Quick setup

```bash
codex mcp add imprint-mysite -- imprint mcp-server mysite
```

### Environment variables

If `imprint` is not on your PATH, Codex won't find it. Either:

1. Install globally: `bun install -g imprint-mcp`, or
2. Use the absolute path to the Imprint CLI in the command:

```bash
codex mcp add imprint-mysite -- bunx imprint-mcp mcp-server mysite
```

---

## Claude Desktop

Claude Desktop reads MCP config from `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Manual setup

Add the following to the `mcpServers` object:

```json
{
  "mcpServers": {
    "imprint-mysite": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "mysite"]
    }
  }
}
```

If you have multiple Imprint sites, add one entry per site:

```json
{
  "mcpServers": {
    "imprint-southwest": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "southwest"]
    },
    "imprint-discoverandgo": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "discoverandgo"]
    }
  }
}
```

Restart Claude Desktop for the changes to take effect.

`imprint install` generates this form automatically. To find your Bun path manually, run `which bun`.

### PATH fallback

If your MCP client definitely inherits a PATH where `imprint` resolves to a runnable binary, this shorter form also works:

```json
{
  "mcpServers": {
    "imprint-mysite": {
      "command": "imprint",
      "args": ["mcp-server", "mysite"]
    }
  }
}
```

---

## OpenClaw

OpenClaw is an agent platform that runs workflows autonomously. It supports MCP tools and has a SKILL.md convention for documenting agent-facing skills.

### MCP setup

Add to `~/.openclaw/openclaw.json` under the `mcp.servers` key:

```json
{
  "mcp": {
    "servers": {
      "imprint-mysite": {
        "command": "/absolute/path/to/bun",
        "args": ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "mysite"]
      }
    }
  }
}
```

### SKILL.md export

`imprint teach` offers to export a SKILL.md file after generating the tool. This markdown file includes:

- Frontmatter with name, description, and version
- MCP integration instructions
- Workflow JSON for each selected tool (API replay artifact)
- Playbook YAML for each selected tool (DOM replay fallback)
- Parameter tables for each selected tool
- Backend ladder explanation

The SKILL.md is written to `./imprint-mysite/SKILL.md` (ready for `openclaw skill install ./imprint-mysite`).

Generated skill folders are portable — just install the `imprint` package on the receiving machine via `npm install imprint` or `bun install imprint`. The generated `index.ts` imports from `imprint/runtime` via a node_modules symlink that Imprint maintains automatically (created at `emit`, self-healed at runtime), not a local checkout path.

### Publishing to ClawHub

OpenClaw's skill-sharing registry is ClawHub. To publish your Imprint skill:

1. Export the SKILL.md via `imprint teach` or manually.
2. Follow [ClawHub's publishing guide](https://openclaw.ai/docs/clawhub).

---

## Hermes Agent

Hermes is an agent framework with built-in scheduling, MCP support, and a skill library.

### MCP setup

Use `imprint install` to write the MCP entry directly:

```bash
imprint install google-flights --source examples --platform hermes
```

In a Hermes container, Imprint writes to `$HERMES_HOME/config.yaml` when `HERMES_HOME` is set. Outside Hermes, it falls back to `~/.hermes/config.yaml`. You can install the full checked-in example set with:

```bash
for site in google-flights google-hotels southwest discoverandgo echo; do
  imprint install "$site" --source examples --platform hermes --no-interactive
done
```

Browser-backed examples install Playwright Chromium automatically on the machine running Hermes. When `HERMES_HOME` is set, Imprint uses `$HERMES_HOME/.cache/ms-playwright` and writes `PLAYWRIGHT_BROWSERS_PATH` into the MCP entry. Use `--skip-browser-install` only when an offline image already contains the browser.

```bash
imprint install google-flights --source examples --platform hermes --no-interactive
```

If you are building a fresh Linux image that lacks browser libraries, run `bunx playwright install --with-deps chromium` during image setup.

To edit the config manually instead, add this under the `mcp_servers` key in `$HERMES_HOME/config.yaml` (or `~/.hermes/config.yaml` outside Hermes):

```yaml
mcp_servers:
  imprint-mysite:
    command: "/absolute/path/to/bun"
    args: ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "mysite"]
```

Restart Hermes for the changes to take effect.

### SKILL.md export

Similar to OpenClaw, Hermes reads SKILL.md files from `~/.hermes/skills/`. `imprint teach` offers to export a SKILL.md after generating the tool.

If `~/.hermes/` exists, the SKILL.md is written directly to `~/.hermes/skills/imprint-mysite/SKILL.md`. Otherwise it's written to `./imprint-mysite/SKILL.md`.

For remote Hermes hosts, install the `imprint` package on that host (the generated wrappers import from `imprint/runtime`, so the package must be installed but no re-emit is needed). To share a taught MCP, copy or publish the generated site directory, install the package on the target host, then run `imprint install <site> --platform hermes` there so Hermes gets a local config entry with the correct asset path.

### Cron mapping

Imprint has a built-in cron daemon (`imprint cron`). Hermes has its own scheduler. To map an Imprint cron config to Hermes:

1. Generate a cron.json via `imprint teach` or manually:

```json
{
  "schedule": "0 9 * * *",
  "params": { "city": "Oakland" },
  "replayBackend": "auto"
}
```

2. Add the equivalent schedule to Hermes:

```bash
hermes cron add "0 9 * * *" "Run imprint-mysite with city=Oakland"
```

Or configure it in `~/.hermes/config.yaml`:

```yaml
schedules:
  - name: "imprint-mysite-daily"
    cron: "0 9 * * *"
    tool: "imprint-mysite"
    params:
      city: "Oakland"
```

The SKILL.md exported by `imprint teach` includes a Hermes cron mapping section if a cron.json exists.

---

## Deploying for always-on agents

For production agents that run 24/7 (e.g., a bot monitoring flight prices), you may want to run `imprint mcp-server` as a persistent HTTP service instead of spawning it per request.

### HTTP transport

```bash
imprint mcp-server mysite --http --port 8765
```

This starts an HTTP MCP server on port 8765. Configure your MCP client to connect via HTTP instead of stdio.

### Docker

Example `Dockerfile`:

```dockerfile
FROM oven/bun:1.3

WORKDIR /app
COPY . .
RUN bun install
RUN bunx playwright install chromium --with-deps

EXPOSE 8765
CMD ["bun", "src/cli.ts", "mcp-server", "mysite", "--http", "--port", "8765"]
```

Build and run:

```bash
docker build -t imprint-mysite .
docker run -p 8765:8765 imprint-mysite
```

### systemd unit

For Linux servers, a systemd service:

```ini
[Unit]
Description=Imprint MCP server for mysite
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=<imprint-clone-dir>
ExecStart=/usr/local/bin/bun src/cli.ts mcp-server mysite --http --port 8765
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable imprint-mysite
sudo systemctl start imprint-mysite
```

### Health check

The HTTP server exposes a health endpoint:

```bash
curl http://localhost:8765/health
# → {"status": "ok"}
```

Use this for Docker health checks, systemd watchdogs, or load balancer probes.

---

## Generic MCP client

If you're building a custom MCP client or using a platform not listed above:

### stdio transport

```bash
imprint mcp-server mysite
```

This spawns a stdio-based MCP server. The client communicates via stdin/stdout using JSON-RPC 2.0.

### HTTP transport

```bash
imprint mcp-server mysite --http --port 8765
```

The client makes HTTP POST requests to `http://localhost:8765/mcp` with JSON-RPC payloads.

See the [MCP specification](https://modelcontextprotocol.io/docs/specification) for the protocol details.
