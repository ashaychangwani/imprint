# Plan — dependency-aware tool selection in `imprint teach`

## Problem

The candidate picker in `imprint teach` treats detected tools as a flat list.
That lets a user select a downstream consumer such as `get_details` or
`book_item` without selecting the upstream producer that mints the opaque ID,
token, or lookup result the consumer needs.

The compiler already understands producer→consumer contracts later in the
pipeline (`tokenParams` / `emitsTokens`) and compiles producers before
consumers. The gap is earlier: selection can remove the producer before build
planning derives that contract, at which point the missing edge is no longer
recoverable.

## Goal and invariant

Treat detected candidates as a directed dependency graph, not a flat set.

> Before candidate state is persisted or compilation begins, the selected tool
> set must be transitively closed over all known producer dependencies.

Selecting a downstream tool therefore automatically selects every required
upstream tool. This applies consistently to:

- the interactive multiselect, where all detected tools are selected initially;
- `--no-interactive`, which compiles all detected tools by default;
- `--primary-tool`, which narrows either mode to the primary tool plus its
  dependency closure;
- explicit `--tool` phase resumes; and
- reconstruction from `.teach-state.json`.

Auth remains outside this graph because it is already compiled as the separate
`authenticate_<site>` prerequisite. The new graph covers user-visible data-tool
dependencies only.

## Selection defaults and CLI contract

Make the complete detected tool set the default because it is the most faithful
representation of what the user recorded:

- **Interactive:** every candidate starts checked. The user may deselect
  independent tools, but prerequisites are restored automatically whenever a
  selected downstream tool needs them.
- **Non-interactive:** compile every candidate by default. This becomes the
  behavior previously requested with `--all-tools`, including a non-zero exit
  when any selected tool fails instead of silently shipping a partial set.
- **Primary-only:** add `--primary-tool` to compile only the primary candidate
  and its transitive prerequisites. This replaces the old implicit
  non-interactive primary-only behavior.
- **Explicit resume:** `--tool <name>` continues to target one persisted tool,
  but automatically includes that tool's transitive prerequisites.

Keep `--all-tools` as a backward-compatible explicit spelling of the new
default for existing scripts. Document it as redundant rather than removing it
immediately. Reject `--primary-tool` combined with `--all-tools` or `--tool`
because those flags express conflicting selection modes.

## Dependency evidence

Build the graph from two complementary sources:

1. **Pre-prompt structural edges.** Before replay finishes, map each candidate's
   `dependencySeqs` to the sole candidate whose `requestSeqs` own that request.
   Add `consumer → producer` only when ownership is unambiguous and never add a
   self-edge. This evidence is available in time to improve the picker without
   giving up the current replay/detection parallelism.
2. **Post-replay token edges.** After replay finishes, run
   `deriveTokenContractHints` against **all detected candidates**, not only the
   user's preliminary selection. Merge every grounded `consumerTool →
   producerTool` edge into the graph. This is the correctness backstop for
   opaque producer values that candidate detection did not express through
   `dependencySeqs`.

Persist the merged direct dependency names on each `ToolCandidate` as
`dependsOnTools: string[]` (default `[]` for backward compatibility). Keep
`dependencySeqs` as recording evidence; `dependsOnTools` is the durable
candidate-level relationship used by selection and resume logic.

Shared or ambiguous sequence ownership must not guess an edge. Cycles are
handled safely by a visited set: selecting any member selects the whole cycle
and emits a diagnostic warning so bad detector output is visible without an
infinite traversal.

## Implementation

### 1. Add pure graph and closure helpers

In `src/imprint/tool-candidates.ts`:

- Extend `ToolCandidateSchema` with `dependsOnTools`, defaulting to an empty
  array so old state and detector responses remain valid.
- Add a pure helper that derives direct structural dependencies from
  `dependencySeqs` and sole ownership of `requestSeqs`.
- Add a pure merge helper for replay-derived producer edges.
- Add a cycle-safe transitive-closure helper that returns candidates in original
  detection order plus metadata describing which tools were auto-added and why.
- Normalize duplicates, unknown names, and self-references at this boundary.

Keep these helpers site-agnostic and based only on candidate names and recorded
sequence provenance.

### 2. Make the interactive and non-interactive picker dependency-aware

Refactor `selectTeachCandidates` in `src/imprint/teach.ts` so the selection rule
is testable without terminal I/O.

- Before the prompt, attach the structural dependencies to every candidate.
- Show direct prerequisites in option hints, for example
  `get_details — requires search_items`.
- Set `initialValues` to every detected candidate.
- After submission, expand the answer to its dependency closure. If the user
  omitted prerequisites, show one concise note listing the tools Imprint added.
- For `--no-interactive`, select every candidate and retain the existing strict
  `--all-tools` partial-failure behavior by default.
- Add `--primary-tool` as the only fresh-teach narrowing flag: select the
  primary candidate, then expand it to dependency closure.
- Keep explicit `--all-tools` behavior as a compatibility no-op that still
  communicates intent in scripts.

In `src/cli.ts`, add the flag and validation, update help text so the defaults
are unambiguous, and update telemetry attributes so a run records whether the
user chose primary-only mode instead of implying that all-tools is exceptional.
Thread the new option through `TeachOptions` and ensure the default full-set
mode is what controls partial-failure handling in `compileCandidatePlans`.

Do not add an override that permits an invalid downstream-only set. If a tool is
usable without its apparent producer, that relationship should not be declared
as a dependency in the first place.

### 3. Reconcile authoritative replay edges before checkpointing

Restructure the analysis join in `src/imprint/teach.ts` so candidate detection
can still run in parallel with replay, but candidate plans are not finalized too
early.

- Let the candidate branch return the detection result, preliminary selection,
  triage artifact, and credential decision instead of immediately checkpointing
  selected candidates.
- Once replay and detection have both completed, derive token edges across the
  full detected candidate set and merge them with the structural graph.
- Re-run dependency closure on the preliminary selection. If replay discovered
  new prerequisites, notify the user that they were added based on recorded
  producer-token evidence.
- Only then build shared context, create `CandidateCompilePlan[]`, write
  per-candidate checkpoints, remove the pending key, and continue to
  `plan-prereqs`.

This ordering preserves the existing parallel work while ensuring selection
cannot erase evidence before `build-plan.ts` sees it. The final closed candidate
set should be passed unchanged into build planning so the existing
`tokenParams` / `emitsTokens`, topological compile ordering, and chained
verification gates continue to work.

### 4. Enforce the same invariant on resume

Update `selectMultiToolResumePlans` in `src/imprint/teach-state.ts`:

- Explicit `--tool <downstream>` returns that tool plus its transitive persisted
  prerequisites.
- Default non-interactive and interactive reconstruction returns the complete
  eligible set.
- `--primary-tool` returns the primary closure.
- If a selected tool requires a prerequisite that is from another recording,
  absent from the persisted build plan, or not resumable at the requested step,
  fail with an actionable message instead of silently resuming an unusable
  consumer. The message should name the downstream tool, missing prerequisite,
  and earliest safe step to rerun.

Old `.teach-state.json` files without `dependsOnTools` retain their current
behavior. Re-running candidate detection upgrades them with the graph.

### 5. Update user-facing documentation

Because this changes interactive and non-interactive CLI behavior, update all
matching surfaces in the same change:

- `README.md`: explain that choosing a downstream candidate automatically adds
  its producer tools, that all candidates are selected/compiled by default, and
  that `--primary-tool` is the narrowing option.
- `docs/architecture.md`: change the teach pipeline description from flat
  `detect → select` to dependency-aware selection plus post-replay closure, and
  document that token hints are derived before candidate filtering.
- `docs/getting-started.md` or `docs/troubleshooting.md`: document the
  auto-added-prerequisite note, the new defaults, `--primary-tool`, and resume
  failure recovery.
- `web/src/App.jsx`: update the multi-tool producer-chain copy so the public
  surface reflects dependency-aware compilation; rebuild and visually inspect
  desktop and mobile layouts as required by the project workflow.

## Tests

Add focused synthetic coverage with no real recordings or credentials:

### `test/tool-candidates.test.ts`

- derives a direct dependency from `consumer.dependencySeqs` intersecting a
  sole producer's `requestSeqs`;
- ignores auth/non-candidate dependency seqs, self-edges, and ambiguously owned
  seqs;
- computes direct and transitive closure in detection order;
- terminates on cycles and includes the whole cycle once;
- merges replay-derived token edges without duplicates;
- parses legacy candidates with `dependsOnTools: []`.

### `test/teach.test.ts`

- interactive selection initially checks every candidate;
- non-interactive selection compiles every candidate by default;
- `--primary-tool` selects the primary candidate and all upstream tools;
- an interactive downstream-only answer is normalized to the same closure;
- independent candidates are not added;
- auto-added tool reporting distinguishes structural and replay-derived reasons;
- explicit `--all-tools` remains accepted and matches the new default;
- default non-interactive full-set compilation fails non-zero on a partial tool
  failure, matching the prior explicit `--all-tools` contract;
- conflicting `--primary-tool` + `--all-tools` / `--tool` combinations are
  rejected with actionable CLI errors.

### `test/cli-help.test.ts`

- teach help lists `--primary-tool` and describes all-tools as the default;
- the usage string and flag descriptions no longer describe primary-only as the
  non-interactive default;
- legacy `--all-tools` remains documented as an accepted compatibility flag.

### `test/teach-phase-window.test.ts`

- explicit `--tool` resume includes upstream prerequisites;
- default non-interactive resume includes every eligible candidate;
- `--primary-tool` resume includes the primary closure;
- a missing or non-resumable prerequisite produces an actionable failure;
- legacy persisted candidates without dependency metadata remain resumable.

### `test/build-plan.test.ts`

- token-contract hints are derived against all detected candidates before the
  preliminary selected set is closed;
- the final candidates passed to build planning contain both producer and
  consumer, allowing the existing contract reconciliation to fire.

## Verification

Run, in order:

```bash
bun test test/tool-candidates.test.ts test/teach.test.ts test/teach-phase-window.test.ts test/build-plan.test.ts test/cli-help.test.ts
bun run typecheck
bun run lint
bun test
```

For the user-facing flow, exercise a synthetic three-tool graph
`lookup → search → details` and verify:

1. the picker labels each downstream prerequisite;
2. the picker initially checks `lookup`, `search`, and `details`;
3. choosing only `details` produces `lookup, search, details` exactly once;
4. a replay-only `search → details` token edge adds `search` before checkpoints
   and build planning;
5. `--no-interactive` compiles all three tools, while `--primary-tool` compiles
   only the primary closure;
6. `--tool details --from-step generate` produces the `details` closure; and
7. the generated build plan still compiles producer levels before consumer
   levels.

If `web/src/App.jsx` changes, run `bun run build` from `web/` and inspect at one
mobile and one desktop width.

### Recorded-site verification

Run fresh production candidate detection against five existing local recordings,
with one isolated subagent per site and no writes to the recording store:

- Google Flights
- Google Hotels
- CarRental
- Costco Car Rental
- Luma

For each result, apply the production structural merge, replay-token merge, and
selection closure. Verify that the default selects every freshly detected tool,
`--primary-tool` includes the primary plus its full prerequisite closure, and a
representative downstream tool cannot be selected without its prerequisites.
Also exercise ambiguous ownership and cycle behavior where the recording
provides those cases. Report detector segmentation/name drift separately from a
dependency-closure failure; fresh LLM detection is not expected to reproduce
historical candidate names exactly.

This verification exposed a classification-shape boundary worth retaining as a
regression case: cached replay classifications store the recorded value as
`value1`, while `deriveTokenContractHints` accepts a value-only projection.
Adapt `value1` to `value` before deriving early replay edges so persisted
classifications participate in dependency closure.

## Acceptance criteria

- No path into fresh teach or resume can compile a known downstream candidate
  without every known upstream candidate.
- Interactive and non-interactive teach select all detected candidates by
  default.
- `--primary-tool` is the explicit way to compile only the primary candidate
  and its prerequisites; `--all-tools` remains a compatible explicit spelling
  of the default.
- Default non-interactive full-set runs preserve strict partial-failure
  reporting.
- Dependency closure is transitive, deterministic, order-stable, and cycle-safe.
- Replay-derived producer edges are computed before the user's preliminary
  selection can discard their producer candidates.
- The picker makes auto-selected prerequisites visible to the user.
- Legacy state remains readable, while newly written state persists the merged
  dependency graph.
- Existing auth handling, independent single-tool behavior, shared-module
  planning, and producer-before-consumer compilation remain unchanged.
- Targeted tests, typecheck, lint, full tests, and the website build (when
  touched) all pass.
