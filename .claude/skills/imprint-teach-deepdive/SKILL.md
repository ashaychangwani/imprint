---
name: imprint-teach-deepdive
version: 1.0.0
description: Analyze where an `imprint teach` run spent its time — macro phase breakdown from the Phoenix trace plus turn-by-turn per-tool compile timing — and identify the fixable time sinks.
triggers:
  - analyze teach performance
  - where did teach time go
  - why is teach slow
  - compile timing
  - teach deep dive
  - phoenix trace teach
allowed-tools:
  - Bash
  - Read
---

# imprint teach deep-dive

Use this to answer "where did the ~N-minute teach go, turn by turn, and what's fixable."

## Two data sources

1. **Macro (phase/span timing + cost)** — Phoenix. Requires `IMPRINT_TRACE=1` + a running Phoenix collector (the teach must have been run with tracing on; `scripts/teach-from-scratch.sh` sets this). Project name `imprint`, root span `cli.teach`.
2. **Micro (turn-by-turn per tool)** — the per-tool compile log at `~/.imprint/<site>/<tool>/.compile-log.json` (a claude-cli **stream-json** event array: `{type:'assistant'|'user'|..., message.content[], timestamp}`).

## Procedure

```bash
# 1. Macro: list recent teach traces, pick the site/run, get the span tree
bun run scripts/analyze-phoenix.ts --kind teach --last 8
#    Span tree under cli.teach: teach.detect_tool_candidates, teach.plan_prereqs
#    (build-plan), build_shared_module[_shared/*], plan_tool[*],
#    compile.generate[*] (the dominant phase), compile.playbook[*].
#    Cost is on llm.cost.* attrs; sum is the trace total.

# 2. Micro: turn-by-turn for one tool (or sweep the whole site)
bun run scripts/analyze-compile-log.ts ~/.imprint/<site>/<tool>/.compile-log.json --full
bun run scripts/analyze-compile-log.ts --site <site>          # all tools
```

`analyze-compile-log.ts` prints: tool-call breakdown, exploration %, done attempts (and how many were **rejected**), live-integration/pacing time, **top time sinks**, and the full per-turn timeline with wall durations (delta between consecutive `tool_result` timestamps).

## What the numbers usually show (and the general levers)

- **`compile.generate` of heavy RPC tools dominates** (e.g. Google batchexecute search/booking ≈ 20–25m each). Most of that is **per-tool field-index discovery** on a schema-less positional array — the tool walks the *decoded* payload to find where its fields live. This is **inherent**, NOT a missing helper: the generic decode/round-trip already exists as a `_shared/` module and is imported (verify with `grep -n "_shared" ~/.imprint/<site>/<tool>/parser.ts`). Do **not** "recommend adding a decode helper" — that double-counts the shared-modules phase.
- **25s live-request pacing** on every integration/chain run, serialized inside each compile (anti-flag throttle to the real site). Large, but only partly controllable — a shared token-bucket across lanes can overlap the waits without raising the aggregate request rate.
- **`done` rejections each cost a full verify cycle.** Two recurring causes: (a) missing `param:<name>` coverage tests, (b) `noUncheckedIndexedAccess` TS errors that the agent's own `run_tests` never surfaces (it runs unit tests, not `tsc`). General fixes: run `tsc` inside `run_tests`; add a pre-`done` per-param lint.
- **Concurrency is capped at 2.** The critical path = sequential prefix (triage + build-plan + the shared-module build, gated by the slowest module) + the **single slowest tool chain**. More lanes can't beat that floor.
- A `/tmp/dbg.ts` scratch script can't `import '../_shared/...'` (relative path doesn't resolve from /tmp) → a wasted iteration. Scratch scripts belong in the tool dir.

## Gotchas

- `analyze-compile-log.ts` handles both the current stream-json shape (`type` + `message.content`) and the legacy `role`/`content` shape. Tool names are MCP-prefixed (`mcp__imprint-compile__run_bash` → `run_bash`).
- Per-turn durations come from the `user`-entry `timestamp`s; assistant entries have no timestamp, so a turn's duration is the time from the previous result to this one (think + tool exec).
- Phoenix `compute sum > wall` is normal — shared modules build in parallel and plan/playbook overlap adjacent compiles under concurrency-2.
