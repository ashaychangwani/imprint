# Integrations

How to connect Imprint MCP tools to your AI platform.

## Overview

`imprint teach` handles this automatically — it runs the full pipeline (record, redact, generate, compile-playbook, emit) and then asks which platform you use. For Claude Code and Codex, it runs the setup command directly. For Claude Desktop, OpenClaw, and Hermes, it prints a paste-ready snippet.

This document is for manual setup or advanced configuration.

Each site gets its own MCP server: `imprint mcp-server southwest` registers as `imprint-southwest`. This isolation ensures multiple Imprint tools coexist without name collisions.

---

## Claude Code

Claude Code is the CLI for Claude. It ships with first-class MCP support.

### Quick setup

```bash
claude mcp add --scope project imprint-mysite -- imprint mcp-server mysite
```

This registers the tool for the current project only. To make it available globally:

```bash
claude mcp add --scope user imprint-mysite -- imprint mcp-server mysite
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

Team members run `bun link` in the Imprint repo to make the `imprint` command available globally, then Claude Code discovers the tools automatically.

---

## Codex CLI

Codex is another AI-powered CLI. It has MCP support via the `codex mcp` command.

### Quick setup

```bash
codex mcp add imprint-mysite -- imprint mcp-server mysite
```

### Environment variables

If `imprint` is not on your PATH, Codex won't find it. Either:

1. Run `bun link` in the Imprint repo to make `imprint` global, or
2. Use the absolute path to the Imprint CLI in the command:

```bash
codex mcp add imprint-mysite -- bun run /absolute/path/to/imprint/src/cli.ts mcp-server mysite
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
      "command": "imprint",
      "args": ["mcp-server", "mysite"]
    }
  }
}
```

If you have multiple Imprint sites, add one entry per site:

```json
{
  "mcpServers": {
    "imprint-southwest": {
      "command": "imprint",
      "args": ["mcp-server", "southwest"]
    },
    "imprint-discoverandgo": {
      "command": "imprint",
      "args": ["mcp-server", "discoverandgo"]
    }
  }
}
```

Restart Claude Desktop for the changes to take effect.

### Absolute path fallback

If `imprint` is not on your PATH, use the absolute path to the CLI:

```json
{
  "mcpServers": {
    "imprint-mysite": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/imprint/src/cli.ts", "mcp-server", "mysite"]
    }
  }
}
```

---

## Cursor / Continue.dev

Cursor and Continue.dev support MCP via config files.

### Cursor

Add to `~/.cursor/config.json` (Linux/macOS) or `%APPDATA%\Cursor\config.json` (Windows):

```json
{
  "mcp": {
    "imprint-mysite": {
      "command": "imprint",
      "args": ["mcp-server", "mysite"]
    }
  }
}
```

### Continue.dev

Add to `~/.continue/config.json`:

```json
{
  "mcp": {
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
        "command": "imprint",
        "args": ["mcp-server", "mysite"]
      }
    }
  }
}
```

### SKILL.md export

`imprint teach` offers to export a SKILL.md file after generating the tool. This markdown file includes:

- Frontmatter with name, description, and version
- MCP integration instructions
- Workflow JSON (API replay artifact)
- Playbook YAML (DOM replay fallback)
- Parameter table
- Backend ladder explanation

The SKILL.md is written to `./imprint-mysite/SKILL.md` (ready for `openclaw skill install ./imprint-mysite`).

### Publishing to ClawHub

OpenClaw's skill-sharing registry is ClawHub. To publish your Imprint skill:

1. Export the SKILL.md via `imprint teach` or manually.
2. Follow [ClawHub's publishing guide](https://openclaw.ai/docs/clawhub).

---

## Hermes Agent

Hermes is an agent framework with built-in scheduling, MCP support, and a skill library.

### MCP setup

Add to `~/.hermes/config.yaml` under the `mcp_servers` key:

```yaml
mcp_servers:
  imprint-mysite:
    command: "imprint"
    args: ["mcp-server", "mysite"]
```

Restart Hermes for the changes to take effect.

### SKILL.md export

Similar to OpenClaw, Hermes reads SKILL.md files from `~/.hermes/skills/`. `imprint teach` offers to export a SKILL.md after generating the tool.

If `~/.hermes/` exists, the SKILL.md is written directly to `~/.hermes/skills/imprint-mysite/SKILL.md`. Otherwise it's written to `./imprint-mysite/SKILL.md`.

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

ENV ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project

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
WorkingDirectory=/path/to/imprint
Environment="ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project"
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
