# Plan — run specific phases of the `imprint teach` chain

> Design plan for the `--from-step` / `--to-step` / `--only` feature. Implemented
> in this branch; kept here as the design record.

## Goal

Let a developer re-run **only specific phases** of a teach run instead of the
whole chain — e.g. just re-detect candidate tools, or just rebuild shared
modules — reusing the persisted outputs of earlier phases. Running a phase in
isolation is **only allowed when a prior run reached or crossed that point**,
otherwise the run would be missing upstream dependencies.

## The phase chain

Persisted as checkpoints in `~/.imprint/<site>/.teach-state.json`
(`WorkflowState.completedSteps`):

```
record → redact → replay-and-diff → triage → detect-candidates → plan-prereqs → generate → compile-playbook → emit → register
```

Architecture note — this is not a flat linear chain:
- **Shared pipeline (runs once):** record … plan-prereqs.
- **Per-tool (per selected tool):** generate → compile-playbook → emit, driven by each plan's `startFrom`.
- **Final:** register (platform integration).

## UX

Three flags on `imprint teach`, validated against the canonical `TEACH_STEPS`:

- `--from-step <step>` — start at `<step>` (non-interactive; bypasses the resume TUI), run to the end.
- `--to-step <step>` — stop after `<step>`.
- `--only <step>` — sugar for `--from-step X --to-step X` (exactly one phase).

```bash
imprint teach google-flights --only detect-candidates    # just re-detect candidate tools
imprint teach google-flights --only plan-prereqs          # just rebuild shared modules (multi-tool)
imprint teach google-flights --to-step triage             # process up to triage, then stop
imprint teach google-flights --from-step generate          # recompile the tools from the persisted plan
```

## The dependency guard (the core requirement)

`--from-step <step>` (anything past `record`) is rejected unless the target
workflow's persisted `completedSteps` includes **every** step before `<step>`.
Error reports the furthest step the prior run actually reached and where to
restart. `record` is always allowed (it produces everything fresh).

`--from-step` is a *resume* of a prior run, so it is **not combinable with
`--from-session`** (a separate fresh-input entry mode); pair `--to-step` with
`--from-session` to cap phases on a fresh recording. `--to-step` alone (no
`--from-step`) works in any mode — it just bounds the upper end.

## Mechanism

- `startIdx = idx(fromStep)`, `stopIdx = idx(toStep)` (default = last step). A
  phase runs iff `startIdx ≤ idx(phase) ≤ stopIdx` (`inWindow`).
- Every phase gate (shared pipeline + register) is windowed; clean early-exits
  with a summary at each phase-group boundary (`finishEarly`) so the
  full-compile tail never runs on a partial.
- A non-interactive `--from-step` branch in the resume decision uses
  `resolveStepStartTarget` (picks the most-recently-updated workflow) +
  `assertResumableAt` (the guard).
- A `--from-step` resume into `plan-prereqs`/`generate` reconstructs **every**
  selected tool from persisted state (shared-module planning needs ≥2 tools);
  confined to `--from-step` so interactive resume keeps its single-tool behavior.

## Granularity (honest constraints, documented)

- The **`replay-and-diff → triage → detect-candidates`** analysis runs as one
  atomic block (its sub-steps share a parallel run + the triaged session), so
  stopping at any of them completes through `detect-candidates`.
- The **per-tool `generate → compile-playbook → emit`** compile is atomic per
  tool. A `--to-step` (or `--only`) landing inside it runs the **whole** compile
  unit and stops before `register` rather than mid-tool — stopping mid-compile
  would leave artifact gaps the result tail assumes exist, so its early-exit
  summary reports `→ emit`. `--from-step`, by contrast, **can** resume mid-compile:
  each phase's `else` branch loads the prior phase's artifact (`workflow.json` /
  `playbook.yaml`) from disk, so `--from-step compile-playbook` is valid.

## Files

- `src/imprint/teach-state.ts` — `resolveStepStartTarget` + `assertResumableAt` (guard).
- `src/cli.ts` — the three flags + validation (step names, ordering, mutual exclusion).
- `src/imprint/teach.ts` — options, non-interactive `--from-step` branch, `stopIdx`
  window gates, `finishEarly` early-exits, multi-tool reconstruction.
- `docs/troubleshooting.md` — user-facing "Re-running only specific phases" section.
- `test/teach-phase-window.test.ts` — synthetic tests for the guard + workflow selection.

## Generality

No site/channel/host literals. Everything is keyed on the canonical step list and
the persisted `completedSteps`.
