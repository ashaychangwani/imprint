# Fresh-teach failure ledger

## Current work

The user requested continued fresh teaches on September 20 (PDT), superseding the
previous campaign stop. The goal is a working four-operation Flights teach and
strict independent audit, followed by an unchanged-code repeat and Hotels validation.
Keep each teach at a 30-minute target, assess at 60 minutes, and enforce 90 minutes.
Audits retain a 45-minute limit. No recurring automation, MR, push or merge.

Flights 1 used implementation `2647f8b` (launch `b6b8cff`). It was stopped by
this operator after 14.834 minutes when inspection found a deterministic coverage
problem, before a full teach result. All 27 owned processes exited. No tools were
published or audited. Evidence remains in
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-1`.

The next checkpoint corrects two prompt contradictions, with no runtime changes:
the planner incorrectly said only the first live case executes, and the master
pruned away recorded contrasts while minimizing the executable path. The planner
example now demonstrates two existing recorded/live pairs. A fresh Flights 2 will
validate behavior; passing prompt tests alone is not a reliability result.

The new collector uses 127.0.0.1:6443 and the campaign's spans.jsonl. Its protobuf
export/decode/append path was tested. Preflight: AC power, 90% battery, about 20 GiB
free, original recordings intact, prior task-owned live work stopped. No prior
generated tools enter teaching. Code and prompts stay fixed within each teach.

## How fixes will be selected

Record each failure with its stage, exact private evidence path, artifact/version,
and whether it recurs. Separate a bad generated artifact, bad verification evidence,
orchestration error and external interruption. Reproduce from retained bytes when
possible, apply the smallest general correction, run focused checks, then start a
fresh teach after any implementation/prompt change. Preserve unsuccessful evidence.
An unchanged deterministic failure is not a reason to reroll the whole teach.

The ledger tracks architecture candidates; it is not permission to implement them
all. A suspected issue needs an observed recurrence or a deterministic reproducer
before changing behavior. Agents retain semantic and strategic decisions. Runtime
changes remain mechanical. Existing setup waits, isolation and rate limits stay.

## Recurring failures and current evidence

| ID | Failure | Evidence and status | Smallest next action / trigger |
| --- | --- | --- | --- |
| SF-01 | Prompt examples and machine contracts disagree | September 20 Flights 1: all focused plans omitted required recorded-call metadata. Fixed in f1a0b6a; fresh Flights 2 passed that planning boundary. | Recurrence: September 21 Flights 1 exposed an obsolete first-live-case-only instruction, also asserted by a test. Corrected guidance/example/tests to match the existing all-case runner; fresh validation pending. |
| SF-02 | Evidence formatting consumes the verification budget | September 20 Flights 2: escaped citations blocked locations/calendar; hand-built frame decoding exhausted search inspection. Generic decoding, bounded citation repair and a final decision turn were added in 2647f8b. Saved-response and refine checks passed; full teach not yet validated. | Confirm the existing fixes in this fresh run. If repeated, inspect raw decisions before changing budgets. |
| SF-03 | Verification accepts an unrelated live request | September 20 calendar saved-response check passed parser fidelity despite an unnecessary date change. Explicit comparability assessment now rejects it; unchanged location input passes. | Track recorded/live input relationships at planning and review. Repair the selected pair without inventing new cases. |
| SF-04 | Result membership or component identity is lost between raw data and output | Historical Flights 53 duplicated repeated frames; September 20 Flights 2 omitted other result groups and connecting options. Earlier 52 constructed a consumer selection from only part of a composite record. These are confirmed recurring artifact defects, not one universal parsing rule. | Check whether the compiler sees all selected raw bodies and actionable independent feedback. Repair its existing fixed cases; do not prescribe first-frame selection, concatenation, deduplication or a site-specific mapping in runtime. |
| SF-05 | MVP verification and strict audit require different coverage | First isolated refine repair passed its raw checks and two identical calls, but strict audit could not establish the query parameter. Selecting distinct existing recorded queries made repair and extension pass. September 21 Flights 1 repeated the single-query plan despite a variable query contract. Stopped early to correct contradictory planner guidance and upstream evidence pruning. | If teach repeats this gap, align case-selection guidance with strict audit using the same fixed recorded set. Preserve unverified coverage rather than weakening the audit. |
| SF-06 | Small metadata changes trigger expensive research again | September 20 Flights 2 repeated booking research after a description/path correction. Code hashes the entire candidate; its workflow includes parameter descriptions. Exact proof binding is useful, but can invalidate more than executable request behavior. One concrete observation; general recurrence not yet established. | Record what changed, which proof was invalidated and elapsed rework. Consider separating execution identity from explanatory metadata only if a reproducer shows needless reproof without weakened semantics. |
| SF-07 | Browser interaction waits dominate despite available evidence | September 20 Flights 1 repeatedly waited about 60 seconds on guessed selectors; historical 48 had missing click targets while result markup existed. There are multiple possible causes, not proof that setup can be skipped. | Inspect navigation/capture/action timestamps and selected conditions. Keep bounded cold-start behavior; change only a reproduced mechanical wait or evidence delivery defect. |
| SF-08 | Minimizing execution also prunes verification evidence | September 21 Flights 1 discovery supplied ten location requests, but the master kept only [63,69]. Focused evidence is mechanically filtered to this pool, so the planner could not select contrasting recorded queries. | Clarify that candidate requestSeqs is an evidence pool, while research determines the minimum executed graph. Preserve a small selected set of recorded contrasts and representatives; fresh validation pending. |

## Code-path observations to test, not established failures

- `verifyRecordingMvp` currently builds every replay fixture for each individual
  live result. A tool with several cases can therefore re-read unrelated fixtures
  and show the reader an asymmetric set of recorded/live sources. Watch for
  unmatched-case rejection or repeated inspection work. A paired-fixture filter
  would be smaller than redesigning verification, but is not implemented without
  evidence that this is blocking the run.
- Recording evidence failures become `revision_required` along the same route as
  bad artifacts. Inspect whether the master repairs the correct component or
  unnecessarily recompiles a correct parser after a proof-only failure. Existing
  citation repair already handles one concrete instance inside the reader.
- The controller copies `.recording-verification` and `.live-checks` into same-run
  repair drafts and resumes the compiler conversation. Confirm the next compiler
  actually reads this evidence; another generic reminder is not automatically a fix.

## Timing baseline

September 20 Flights 2 spent about 39 minutes before all research claims became
proven, 45 minutes before an accepted plan, and 52 before the first compile wave.
It stopped at 64.243 minutes. The critical path includes repeated research and
planning before generated parser checks, not just code generation. Recorded
`compile.generate` spans totaled 555 seconds versus 3,854 seconds elapsed; those
spans overlap other work and cannot be subtracted to attribute the remainder.
`llm.analyze` also includes several agent roles and overlaps, so its total is not
an independent wall-time phase. Warm search reuse was observed previously, but
with different inputs and therefore not a controlled cold/warm benchmark.

The new campaign retains per-role spans, conversation turns, raw failures,
request setup/pacing/call times where emitted, and input/output/cache usage.
Missing measurements are reported as unknown. See the
[previous validation report](teach-reliability-validation-2026-09-20.md) for the
failed baseline, successful isolated refinement and accounting caveats.

## Additional baseline inspection

The prior flight-search compiler made 25 file reads, 10 shell inspections, four
unit-test calls and one final submission. Its parser tests asserted a positive
result count and spot-checked selected members, rather than asserting the full
source membership later found missing. This supports SF-04's diagnosis: passing
self-authored tests did not establish completeness. The raw data was available;
another generic framing reminder is not, by itself, a justified repair.

Prior Codex compile logs contain event ordering but no per-event timestamps.
The existing compile-log analyzer targets older Claude message shapes, so its
turn timing is not a trustworthy breakdown for these logs. Use trace spans for
measured times and report unavailable per-turn timings. A private aggregation
of prior `llm.analyze` traces is retained as `prior-role-breakdown.json`; resumed
turns lack explicit role labels, so unclassified continuation time is not assigned
arbitrarily to research or planning. This observability limitation is recorded,
not used to justify a production refactor during an active run.

## Attempt log

| Attempt | Implementation | Outcome | Failure IDs / evidence |
| --- | --- | --- | --- |
| September 21 Flights 1 | 2647f8b (launch b6b8cff) | Operator stopped at 14.834 minutes; no published tools | SF-01, SF-05, SF-08. Location draft compiled; search research had short error responses and one 120.827-second CDP timeout, followed by a 1.952-second warm transport call. Neither transport success nor the draft establishes a passing tool. |

Flights 1 accounting: 2,546,811 input tokens, including 1,609,728 cache reads;
46,340 output tokens; zero reported cache writes; $5.3190232 estimated base API
cost. Two interrupted analysis spans lack usage. This is an estimate, not an
invoice. The run lasted 890.039 seconds; interrupted work and failed calls count.
No disk exhaustion, sleep or network disconnection was established as its cause.
