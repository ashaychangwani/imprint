# Echo — MCP smoke-test fixture

> A network-free MCP tool used by the smoke-test scripts. Not a real demo — exists so you can verify your MCP wiring works without needing outbound HTTPS or a recorded session.

## What this shows off

- The minimum viable shape of a generated tool: `WORKFLOW` constant + a `camelCase(toolName)` async function returning `ToolResult`.
- Useful when debugging Claude Desktop / mcp-inspector wire-up — if `echo_test` doesn't show up in the tools panel, your MCP config is wrong (not your network).

## Run it

```bash
# Inspect via mcp-inspector (recommended for debugging)
npx @modelcontextprotocol/inspector imprint mcp-server echo

# Or run the included client smoke test
bun scripts/mcp-client-test.ts
```

## What you should see

```
[imprint mcp] registered echo_test (echo) — 1 param(s)
[imprint mcp] stdio transport ready (1 tool)
```

The mcp-inspector UI lists `echo_test`. Calling it with `{"message": "hi"}` returns `{"echoed":"hi","ts":"..."}`.

## Files

| File | What |
|---|---|
| `echo_test/index.ts` | The complete tool — no `workflow.json`, no recording, no compile pipeline. Pure code. |

## Why this exists

Recording a session, redacting it, calling the LLM, emitting code — that's the happy path. When the happy path is broken, you want a fixture that strips every variable except "is the MCP wiring correct." Echo is that fixture.
