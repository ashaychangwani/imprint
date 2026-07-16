# Tracing

Imprint emits [OpenTelemetry](https://opentelemetry.io/) spans in [OpenInference](https://github.com/Arize-ai/openinference) format, designed for the [Phoenix](https://github.com/Arize-ai/phoenix) trace UI. Tracing is opt-in and covers every LLM call, agent turn, tool invocation, and pipeline stage.

## Quick start

```bash
# Terminal 1 — start Phoenix
pip install "arize-phoenix>=11.4" && phoenix serve

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

### Cost ownership

Imprint emits OpenInference model, provider, total-token, and cache-token attributes. Phoenix calculates span, trace, and project costs from those attributes using its model pricing configuration. Update pricing in Phoenix under Settings → Models when a model is new or has custom rates; Imprint does not maintain a duplicate pricing table.

`scripts/analyze-phoenix.ts` requires Phoenix 11.4 or newer, where the GraphQL `costSummary` field was introduced. When Phoenix has no price for a model, the analyzer reports that model as **unpriced**; a trace containing both priced and unpriced models is explicitly labeled **partial** rather than presenting the priced subset as a complete total. Phoenix calculates costs asynchronously, so the analyzer briefly polls a newly completed trace. A null summary is pending during that bounded wait; if it remains unresolved, it is treated as unpriced/unknown for compatibility with Phoenix 11.4–11.7, which did not materialize cost rows for unmatched models.

Previous releases accepted `IMPRINT_TRACE_*_USD_PER_1M` and `IMPRINT_TRACE_COST_*` variables for local pricing. They are no longer applied. Imprint prints a migration warning when one is present; move those rates to Phoenix Settings → Models.

## Trace hierarchy

### `imprint teach`

```
cli.teach (AGENT)                          ← Phoenix rolls up child costs for the trace
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
│   ├─ API-provider path
│   │   └─ llm.message_with_tools (LLM)   ← one instrumented model call
│   └─ CLI-provider path
│       └─ compile.{codex,claude}_cli_agent (AGENT)
│           ├─ agent.turn.1 (CHAIN)
│           ├─ agent.tool.read_session_summary (TOOL)
│           └─ compile.{codex,claude}_cli_usage (LLM) ← aggregate usage carrier
└─ compile.playbook (CHAIN)
    ├─ compile.triage_requests (RETRIEVER)
    └─ llm.analyze (LLM)
```

### `imprint audit`

```
cli.audit (AGENT)                          ← Phoenix rolls up child costs for the trace
└─ audit.session (AGENT)                   ← discovery, tool-driving, grading, persistence
    └─ audit.llm_usage (LLM)               ← aggregate CLI usage carrier, when usage exists
```

## Token and cost tracking

Each LLM span carries `llm.model_name`, `llm.provider`, `llm.token_count.prompt`, `llm.token_count.completion`, and `llm.token_count.total`. When available, cache usage is emitted as `llm.token_count.prompt_details.cache_read` and `.cache_write`. `llm.token_count.prompt` is the total prompt (uncached + cache read + cache write), normalized by `totalPromptTokens()` for providers that report the parts separately.

Codex already includes cached input in its reported `input_tokens`, so Imprint passes that total through and emits `cached_input_tokens` only as a subset. Anthropic reports uncached input separately, so Imprint adds its cache-read and cache-write buckets to form the OpenInference prompt total.

External CLI agent sessions expose only aggregate usage rather than one event per underlying model request. Their surrounding workflow remains an `AGENT` span; Imprint emits a zero-duration child `LLM` span marked `imprint.llm.usage_aggregate=true` solely to carry the model and token attributes Phoenix needs for pricing. This prevents tool-driving latency from being mislabeled as LLM latency. The `audit.session` span can additionally carry `imprint.audit.cost_usd` when the CLI provider reports a cost directly.

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

`scripts/analyze-phoenix.ts` reads Phoenix's calculated `costSummary` from its GraphQL API to produce per-stage and per-trace cost/token summaries:

```bash
# Analyze the last teach trace
bun run scripts/analyze-phoenix.ts --kind teach

# Analyze a specific trace
bun run scripts/analyze-phoenix.ts --trace-id <id>

# Analyze the last 5 audit traces
bun run scripts/analyze-phoenix.ts --kind audit --last 5
```

The script does not recompute pricing. Its trace total comes from Phoenix's trace-level cost summary, so it follows Phoenix's built-in or user-configured model rates. It paginates through every span in the trace, then checks every token-bearing LLM span and reports `unpriced`, `partial`, `cost pending`, or `unknown` instead of converting missing pricing to `$0`.

## Tips

- **Debugging a teach failure**: Open the `cli.teach` trace. The failing stage has a red status — expand it to see the LLM call that errored. `teach.plan_prereqs` timeout, `teach.build_shared_module` with `ok=false`, an empty `teach.plan_tool`, or a `compile.generate` that gave up are the common failure modes.
- **Debugging an audit failure**: The `audit.session` span carries `imprint.audit.verdict` and the per-invocation breakdown. When `imprint.audit.timed_out=true`, the verdict is `timeout` and the auditor's transcript is written next to the report for diagnosis.
- **Cost configuration**: Keep Phoenix current and configure new or custom model prices under Settings → Models.
- **Large traces**: Set `IMPRINT_TRACE_IO_MAX_CHARS=0` to suppress I/O capture entirely (structure-only traces). Set `IMPRINT_TRACE_BATCH=0` for short-lived runs where the process exits before the batch exporter flushes.
