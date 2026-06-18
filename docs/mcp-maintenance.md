# MCP maintenance

Use `imprint mcp status` as the first audit command when an MCP client does not show the tools you expect, when you have old `imprint-*` entries in client config, or when an interrupted `teach` run left local state behind.

```bash
imprint mcp status
imprint mcp status --site mysite
imprint mcp status --site mysite --json
```

The audit covers Imprint-owned MCP registrations in:

- Claude Code
- Codex CLI user config (`~/.codex/config.toml`) and project config (`.codex/config.toml`)
- Claude Desktop
- OpenClaw
- Hermes

It also scans `IMPRINT_HOME` for generated tools, `.teach-state.json`, raw and redacted session files, and generated artifacts such as `index.ts`, `workflow.json`, `playbook.yaml`, `backends.json`, and `cron.json`.

## What status reports

`status` classifies local state into these categories:

| Status | Meaning |
|---|---|
| `complete` | A generated tool directory has an `index.ts`. |
| `incomplete` | A `teach` workflow lacks `emit`/`register` completion, or has no matching generated tool. |
| `missing-session` | `.teach-state.json` references a raw or redacted session file that is gone. |
| `stale-registration` | An external MCP registration points at `imprint mcp-server <site>`, but there is no complete generated tool for that site. |
| `stale-backends` | A tool's `backends.json` was written for an older `workflow.json`; runtime will ignore it and fall back to the default ladder until reprobed. |
| `invalid-backends` | A tool's `backends.json` cannot be parsed or fails schema validation; runtime will ignore it until reprobed. |

Each issue includes a next-step hint. In interactive mode, choose `Fix an issue` to apply the exact matching cleanup action instead of selecting a registration or site manually. The fix prompt is a multi-select: toggle individual issues with `space`, or pick `Select all issues` to fix everything in one pass.

Backend-cache issues are not registration problems: MCP clients can still connect and list tools. Refresh the cache with the reported `imprint probe-backends <site> --tool <toolName>` command, or use `imprint probe-backends <site> --all` to refresh every generated tool for the site.

`imprint mcp` never lists or deletes raw recordings. The recording is Imprint's source of truth, so untracked session files are out of scope for this command — only the explicit whole-site delete (below) removes recordings, and only when you opt into it.

Use JSON output for scripts:

```bash
imprint mcp status --json
```

## Interactive cleanup

Run `imprint mcp` with no subcommand for the interactive cleanup flow:

```bash
imprint mcp
```

The TUI can disable, re-enable, delete registrations, or prune stale `teach` state. It follows the same Clack prompt style as `imprint teach`.

If no active MCP registrations exist, the delete flow can still remove local Imprint artifacts for a selected site. Use the full-site option only when you also want to remove recordings.

## Direct commands

Direct mutating commands require `--yes` so scripts cannot accidentally edit MCP client config:

```bash
imprint mcp disable imprint-mysite --client all --yes
imprint mcp enable imprint-mysite --client all --yes
imprint mcp delete imprint-mysite --client codex --yes
imprint mcp prune-state --site mysite --missing-session --yes
imprint mcp prune-state --site mysite --incomplete --yes
```

`--client` can be one of `claude-code`, `codex`, `claude-desktop`, `openclaw`, `hermes`, or `all`.

## Disable vs delete

`disable` is reversible.

Codex supports native disabled MCP entries, so Imprint toggles `mcp_servers.<name>.enabled = false` in `~/.codex/config.toml`.

Other clients do not have a common native disable field. For those clients, Imprint removes the active config entry and stores a reversible snapshot in:

```text
<IMPRINT_HOME>/.mcp-disabled.json
```

The snapshot stores the Imprint MCP registration metadata plus the full original server object so `imprint mcp enable ...` can restore fields such as `env`, `cwd`, and client-specific settings. If the original registration contained secrets in environment variables, `<IMPRINT_HOME>/.mcp-disabled.json` will contain those same values. `enable` restores from that snapshot unless the same server name now exists in the target config, in which case it stops and reports the conflict.

`delete` removes active MCP registrations and does not create a restore snapshot.

## Local artifacts

By default, `delete` edits only external MCP registrations. It does not delete generated tools or recordings.

```bash
imprint mcp delete imprint-mysite --yes
```

To also delete generated tool directories while keeping recordings:

```bash
imprint mcp delete imprint-mysite --local tool --yes
```

To delete the whole local site directory, including recordings:

```bash
imprint mcp delete imprint-mysite --local site --yes
```

Raw recordings under `~/.imprint/<site>/sessions/` can contain cookies, credentials, storage snapshots, and other sensitive browser state. Imprint removes them only when you explicitly choose `--local site`.

## Client restarts

Claude Desktop, OpenClaw, and Hermes usually read MCP config at startup, so restart those apps after direct cleanup commands. Claude Code and Codex pick up most changes in new sessions.
