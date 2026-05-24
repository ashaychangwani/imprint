# scripts/

Smoke-tests + ad-hoc diagnostic scripts. **None of these ship with `imprint` itself** — the published CLI verbs are in `src/cli.ts`. These exist so contributors can poke at specific subsystems in isolation (no LLM, no full pipeline).

## Smoke tests (run anytime to verify a subsystem)

| Script | What it tests |
|---|---|
| [`mcp-smoke-test.ts`](mcp-smoke-test.ts) | Spins up the in-process MCP server, lists tools, calls `echo`. No external deps. Best signal that the MCP wire-up isn't broken after a refactor. |
| [`mcp-client-test.ts`](mcp-client-test.ts) | Same shape but exercises the SDK's stdio client transport. |
| [`mcp-http-client-test.ts`](mcp-http-client-test.ts) | Same again over Streamable HTTP transport. |

```bash
bun scripts/mcp-smoke-test.ts      # tests MCP server (~1s)
```

## Sprint scratchpads (Discover & Go bring-up)

The `dg-*` scripts were one-shot debug tools used during the initial Discover & Go demo bring-up. They directly call `executeWorkflow()` against the live D&G backend. Kept for reference; not part of any test suite.

If you're curious how the runtime loads `${credential.X}` substitutions or how a multi-request workflow chains responses, these are short worked examples (~50-150 LOC each).

| Script | What it does |
|---|---|
| [`dg-live-readonly-test.ts`](dg-live-readonly-test.ts) | Hits the read-only `getReservations` endpoint. No state changes. |
| [`dg-step-by-step.ts`](dg-step-by-step.ts) | Walks the make/get/cancel chain step-by-step, logging each response. |
| [`dg-live-book-and-cancel.ts`](dg-live-book-and-cancel.ts) | LIVE: books a real Cooley Museum slot then cancels it within seconds. Requires `imprint login discoverandgo` first. |

These will only run if you have a credential store at `~/.config/imprint/credentials/discoverandgo.json` from a prior `imprint login discoverandgo`.
