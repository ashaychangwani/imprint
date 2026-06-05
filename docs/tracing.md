# Tracing

Imprint emits [OpenTelemetry](https://opentelemetry.io/) spans in [OpenInference](https://github.com/Arize-ai/openinference) format, designed for the [Phoenix](https://github.com/Arize-ai/phoenix) trace UI. Tracing is opt-in and covers every LLM call, agent turn, tool invocation, and pipeline stage.

## Quick start

```bash
# Terminal 1 — start Phoenix
pip install arize-phoenix && phoenix serve

# Terminal 2 — run imprint with tracing
IMPRINT_TRACE=1 imprint teach southwest --url https://www.southwest.com
```

Open `http://localhost:6006` → project "imprint" → traces.

## Environment variables

### Activation

| Variable | Effect |
|---|---|
| `IMPRINT_TRACE=1` | Enable tracing |
| `IMPRINT_TRACING=1` | Alias for `IMPRINT_TRACE` |
| `OPENINFERENCE_TRACE=1` | Alias for `IMPRINT_TRACE` |
| `PHOENIX_COLLECTOR_ENDPOINT` | Phoenix endpoint URL (auto-enables tracing) |
| `PHOENIX_HOST` | Alias for `PHOENIX_COLLECTOR_ENDPOINT` |
| `PHOENIX_API_KEY` | Auth key for hosted Phoenix |
| `IMPRINT_TRACE_PROJECT` | Phoenix project name (default: `imprint`) |
| `IMPRINT_TRACE_BATCH` | Batch span export (default: `true`; set `0` to flush each span immediately — useful for debugging short-lived runs) |

### Verbosity

| Variable | Effect |
|---|---|
| `IMPRINT_TRACE_LLM_IO=1` | Include prompt text and LLM responses in spans |
| `IMPRINT_TRACE_TOOL_IO=1` | Include tool arguments and results in spans |
| `IMPRINT_TRACE_IO=1` | Shorthand — enables both LLM and tool I/O |
| `IMPRINT_TRACE_FULL=1` | Alias for `IMPRINT_TRACE_IO=1` |
| `IMPRINT_TRACE_IO_MAX_CHARS` | Truncation cap for captured I/O text (default: `50000`) |

When tracing is enabled, `IMPRINT_TRACE_LLM_IO` and `IMPRINT_TRACE_TOOL_IO` default to on. Set them to `0` to capture structure without payloads.

### Cost rate overrides

Cost is computed from a built-in rate table (`DEFAULT_MODEL_RATES` in `tracing.ts`) covering current Claude models. Override with env vars when using models not in the table or when rates change:

| Variable | Example |
|---|---|
| `IMPRINT_TRACE_INPUT_USD_PER_1M` | `3` — global input rate fallback |
| `IMPRINT_TRACE_OUTPUT_USD_PER_1M` | `15` — global output rate fallback |
| `IMPRINT_TRACE_COST_<MODEL>_INPUT_USD_PER_1M` | `5` — model-specific override |
| `IMPRINT_TRACE_COST_<PROVIDER>_<MODEL>_INPUT_USD_PER_1M` | `5` — provider+model-specific override |

Model and provider names are uppercased with non-alphanumeric characters replaced by `_` (e.g. `claude-sonnet-4-5` → `CLAUDE_SONNET_4_5`). The resolution order is: provider+model-specific → model-specific → provider-specific → global fallback → built-in rate table.

## Trace hierarchy

### `imprint teach`

```
cli.teach (AGENT)                          ← cost rollup: total tokens + cost from all children
├─ teach.combine_sessions (CHAIN)          ← merge sibling recordings
├─ teach.record (CHAIN)                    ← live capture
├─ teach.redact (CHAIN)                    ← credential/PII scrub
├─ compile.triage_requests (RETRIEVER)
│   └─ llm.analyze (LLM)
├─ teach.detect_tool_candidates (AGENT)
│   └─ llm.analyze (LLM)
├─ llm.analyze (LLM)                       ← multi-tool: build plan (planner)
├─ teach.build_shared_module (AGENT)       ← shared modules (concurrent per level)
│   └─ llm.analyze (LLM)
├─ teach.plan_tool (AGENT)                 ← per-tool implementation plan
│   └─ llm.analyze (LLM)
├─ compile.generate (AGENT)
│   ├─ agent.turn.1 (CHAIN)               ← per-turn tokens
│   │   ├─ llm.message_with_tools (LLM)   ← model, tokens, cost, stop reason
│   │   ├─ agent.tool.read_session_summary (TOOL)
│   │   └─ agent.tool.write_file (TOOL)
│   └─ ...
└─ compile.playbook (CHAIN)
    ├─ compile.triage_requests (RETRIEVER)
    └─ llm.analyze (LLM)
```

### `imprint audit`

```
cli.audit (AGENT)                          ← cost rollup
└─ audit.session (AGENT)
    └─ (headless claude drives the site's real MCP tools)
```

## Cost rollup

Root spans (`cli.teach`, `cli.audit`) use `tracedWithCostRollup` to accumulate `llm.cost.*` and `llm.token_count.*` from every descendant LLM span. This means:

- **Child spans** (each `llm.message_with_tools`) carry their own per-call cost.
- **Root spans** carry the **total** — the sum across all child LLM calls in the entire pipeline.

The rollup uses an `AsyncLocalStorage`-based accumulator. Every `llmCostAttributes` call checks for an active accumulator and adds its tokens and cost to the running total. When the root span completes, the accumulated totals are set as span attributes.

### Cache-aware cost breakdown

Prompt costs reflect the Anthropic cache split:

| Token type | Rate multiplier | Attribute |
|---|---|---|
| Uncached input | 1.0× (full rate) | `llm.cost.input` |
| Cache read | 0.1× | `llm.cost.prompt_details.cache_read` |
| Cache write | 1.25× | `llm.cost.prompt_details.cache_write` |
| Completion | 1.0× (output rate) | `llm.cost.completion` |

`llm.cost.prompt` = uncached + cache read + cache write. `llm.cost.total` = prompt + completion.

Token count attributes follow the same structure: `llm.token_count.prompt` is the **total** prompt tokens (uncached + cache read + cache write), not just the uncached portion. This normalization happens in `totalPromptTokens()` — Anthropic's API reports `input_tokens` as uncached only, with cache counts in separate fields.

### Cost attributes on root vs child spans

| Attribute | Child (`llm.message_with_tools`) | Root (`cli.teach`) |
|---|---|---|
| `llm.token_count.prompt` | This call's tokens | Sum of all calls |
| `llm.token_count.completion` | This call's tokens | Sum of all calls |
| `llm.cost.total` | This call's cost | Sum of all calls |
| `llm.cost.prompt_details.cache_read` | This call's cache reads | Sum of all calls |
| `imprint.llm.cost_estimated` | `true` | `true` |

The `audit.session` span also carries `imprint.audit.cost_usd` — the auditor's CLI-reported cost figure (parsed from headless claude output). `llm.cost.*` on that span is the token-based estimate. The two may differ slightly (CLI reports its own accounting).

## Stage attributes

Each pipeline stage carries end-attributes for fast triage without expanding child spans:

| Span | Key attributes |
|---|---|
| `teach.record` | `imprint.record.event_count` |
| `teach.redact` | `imprint.redact.*` counts |
| `teach.combine_sessions` | `imprint.combine.{session,request,narration}_count` |
| `teach.plan_tool` | `imprint.tool_plan.chars`, `.skipped` |
| `teach.build_shared_module` | `imprint.shared_module.ok`, `.cycles`, `.planned` |
| `compile.generate` | agent turn count, final verdict |
| `audit.session` | `imprint.audit.{score, correct, broken, infra, bad_params, graded, params_working, params_no_op, params_broken, params_untestable, verdict, timed_out, turns, cost_usd}` |

## Analyzing traces

`scripts/analyze-phoenix.ts` reads `llm.cost.*` attributes from Phoenix's GraphQL API to produce per-stage and per-trace cost/token summaries:

```bash
# Analyze the last teach trace
bun run scripts/analyze-phoenix.ts --kind teach

# Analyze a specific trace
bun run scripts/analyze-phoenix.ts --trace-id <id>

# Analyze the last 5 audit traces
bun run scripts/analyze-phoenix.ts --kind audit --last 5
```

The script reads the emitted `llm.cost.*` attributes directly — it does not recompute from a private rate table, so its numbers always match the app's pricing. It reads from non-root leaf spans to avoid double-counting against the rolled-up root totals.

## Tips

- **Debugging a teach failure**: Open the `cli.teach` trace. The failing stage has a red status — expand it to see the LLM call that errored. `teach.plan_prereqs` timeout, `teach.build_shared_module` with `ok=false`, an empty `teach.plan_tool`, or a `compile.generate` that gave up are the common failure modes.
- **Debugging an audit failure**: The `audit.session` span carries `imprint.audit.verdict` and the per-invocation breakdown. When `imprint.audit.timed_out=true`, the verdict is `timeout` and the auditor's transcript is written next to the report for diagnosis.
- **Cost estimation**: The built-in rate table covers Claude Opus 4.1 and 4.5–4.8, Sonnet 4.5–4.6, and Haiku 4.5. For other models, set the `IMPRINT_TRACE_COST_*` env vars.
- **Large traces**: Set `IMPRINT_TRACE_IO_MAX_CHARS=0` to suppress I/O capture entirely (structure-only traces). Set `IMPRINT_TRACE_BATCH=0` for short-lived runs where the process exits before the batch exporter flushes.
