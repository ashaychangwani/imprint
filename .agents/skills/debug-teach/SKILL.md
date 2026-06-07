---
name: debug-teach
version: 1.0.0
description: Debug an `imprint teach` run — env vars, CLI flags, log files, tracing, and diagnostic commands. Helps diagnose slow, stuck, or failing teach runs.
triggers:
  - debug teach
  - teach debug
  - teach is stuck
  - teach failing
  - teach logs
  - debug compile
  - why did teach fail
  - inspect teach run
allowed-tools:
  - Bash
  - Read
---

# Debug an `imprint teach` run

Use this when a teach run failed, is stuck, was slow, or produced broken tools.

## Step 1 — Determine what happened

Ask the user (or infer from context) which scenario applies:

| Scenario | Go to |
|---|---|
| Teach is **currently running** and looks stuck | Step 2a |
| Teach **finished but tools are broken** | Step 2b |
| Teach **errored out** | Step 2c |
| Teach **was slow** and user wants to know why | Use `/imprint-teach-deepdive` instead |

## Step 2a — Stuck teach (still running)

Check what stage it's in:

```bash
# See if the compile-log is being written (growing = still compiling)
ls -la ~/.imprint/<site>/*/.compile-log.json

# Check if Chrome is still alive (replay/record stage)
pgrep -fl chromium || pgrep -fl chrome

# If tracing was on, check the last span
bun run scripts/analyze-phoenix.ts --kind teach --last 1
```

Common stuck points:
- **Replay stage**: browser hung waiting for a network response. Kill and re-run; check `IMPRINT_REPLAY_DEBUG=1` output at `/tmp/imprint-replay-debug-*.log`
- **Compile agent looping**: the agent is retrying a failing verification. Check the tail of `.compile-log.json`
- **Shared module build**: a module failed to verify and is retrying. Look for `pruning` vs `built + verified` in stderr

## Step 2b — Teach finished but tools are broken

```bash
# Run audit to get a structured report
bun run src/cli.ts audit <site> --json

# Read the audit report
cat ~/.imprint/<site>/.audit-report.json | jq '{score, verdicts: [.verdicts[] | {tool: .tool, verdict: .verdict}]}'

# Read the compile agent's full conversation for a broken tool
cat ~/.imprint/<site>/<broken-tool>/.compile-log.json | jq '.[].role' | head -20

# Check the tool plan the agent was given
cat ~/.imprint/<site>/<broken-tool>/.tool-plan.md

# Test the playbook interactively
bun run src/cli.ts playbook <site> --headed --trace --param key=value
# Screenshots land at /tmp/imprint-playbook-<tool>-step<N>-<ts>.png
```

## Step 2c — Teach errored out

```bash
# Check the compile log for the error
cat ~/.imprint/<site>/<tool>/.compile-log.json | jq 'last'

# Validate the session recording is intact
bun run src/cli.ts check ~/.imprint/<site>/sessions/*.json

# Check environment
bun run src/cli.ts doctor
```

## Environment variables reference

### Verbosity & logging

| Variable | Effect |
|---|---|
| `IMPRINT_DEBUG=1` | Verbose stderr: every HTTP request, cookie/storage snapshots, Chromium stderr, full stack traces |
| `IMPRINT_QUIET=1` | Suppress all imprint logs |
| `IMPRINT_REPLAY_DEBUG=1` | Write timestamped replay events to `/tmp/imprint-replay-debug-<ts>.log` |

### Tracing (OpenTelemetry → Phoenix)

| Variable | Effect |
|---|---|
| `IMPRINT_TRACE=1` | Enable tracing (aliases: `IMPRINT_TRACING=1`, `OPENINFERENCE_TRACE=1`) |
| `PHOENIX_COLLECTOR_ENDPOINT` | Phoenix collector URL (auto-enables tracing) |
| `IMPRINT_TRACE_LLM_IO=1` | Capture prompt text + LLM responses in spans |
| `IMPRINT_TRACE_TOOL_IO=1` | Capture tool arguments + results in spans |
| `IMPRINT_TRACE_IO=1` | Shorthand for both LLM + tool I/O |
| `IMPRINT_TRACE_BATCH=0` | Flush spans immediately (useful for short/killed runs) |
| `IMPRINT_TRACE_PROJECT` | Phoenix project name (default: `imprint`) |

### Compile & planning knobs

| Variable | Effect |
|---|---|
| `IMPRINT_KEEP_TEST=1` | Keep generated `parser.test.ts` after compile |
| `IMPRINT_NO_BUILD_PLAN=1` | Skip shared-module planning |
| `IMPRINT_NO_TOOL_PLAN=1` | Skip per-tool implementation planning |
| `IMPRINT_NO_PREREQ_PLAN=1` | Skip prerequisite analysis |
| `IMPRINT_COMPILE_ACT_SPACING_MS=0` | Fast compile-time replay (default 25000ms) |

## Files written during teach

| Path | Contents |
|---|---|
| `~/.imprint/<site>/<tool>/.compile-log.json` | Full compile-agent conversation |
| `~/.imprint/<site>/<tool>/.tool-plan.md` | LLM-generated implementation plan |
| `~/.imprint/<site>/.audit-report.json` | Audit results (after `imprint audit`) |
| `~/.imprint/<site>/.audit-transcript.txt` | Audit session transcript |
| `/tmp/imprint-replay-debug-<ts>.log` | Replay debug log (`IMPRINT_REPLAY_DEBUG=1`) |
| `/tmp/imprint-playbook-<tool>-step<N>-<ts>.png` | Step screenshots (`--trace`) |

## Quick recipes

```bash
# Full-verbose teach
IMPRINT_DEBUG=1 IMPRINT_REPLAY_DEBUG=1 imprint teach <site> --url <url> 2>&1 | tee teach-run.log

# Teach with Phoenix tracing
IMPRINT_TRACE=1 IMPRINT_TRACE_LLM_IO=1 imprint teach <site> --url <url>

# Fast iteration (skip slow parts, reuse existing session)
IMPRINT_COMPILE_ACT_SPACING_MS=0 IMPRINT_NO_PREREQ_PLAN=1 \
  imprint teach <site> --skip-replay --from-session <path>

# Capture everything to a file
IMPRINT_DEBUG=1 imprint teach <site> --url <url> 2>&1 | tee teach-$(date +%s).log
```

## Diagnostic subcommands

| Command | Purpose |
|---|---|
| `imprint doctor` | Check environment (Bun, Chromium, LLM providers) |
| `imprint check <session>` | Validate captured session completeness |
| `imprint playbook <site> --headed --trace` | Interactive playbook test with screenshots |
| `imprint audit <site> --json` | Score tools; generate report + transcript |
| `imprint mcp status` | Audit MCP registrations + generated tools |
| `imprint probe-backends <site>` | Test backend ladder |
