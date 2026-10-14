# Recording-backed teaching validation

Initial implementation: `1073ceb`; planner correction: `f1a0b6a`, on `codex/imprint-master-v066-validation`, descended
from `origin/codex/imprint-master-v066`. No old vnext changes were used. The final implementation checkpoint is `2647f8b`; its fresh teach validation remains outstanding because the campaign limit was reached.

The change selects a fixed set of existing recorded cases and matches live
inputs to them. An independent reader establishes facts from raw responses
before seeing parser output. All selected cases and dependent calls must pass
before publication. Strict audits use the retained case list and cannot hide
broken calls behind an aggregate score. Research can batch calls and reuse
isolated browser sessions; cold-start waits are unchanged. `imprint refine`
stages targeted repairs or extensions and verifies them before replacement.

## Limits and evidence

This campaign permits at most four fresh teaches and stops after two consecutive
failed teaches, including core audit failures. Target order: Flights twice,
then Hotels twice on unchanged code. Teach target 30 minutes, assessment at
60 minutes, hard deadline 90 minutes; independent audits have 45 minutes.
Refinement repair and extension checks have 30 minutes each on isolated copies.
No recurring automation was restarted.

Private evidence is retained under
`~/.imprint/experiments/reliability-2026-09-20/`: per-attempt manifests and logs,
isolated homes, `spans.jsonl`, and the `account.py` accounting helper. The original
Flights and Hotels recordings were verified before launch. About 24 GiB was
available. No recordings, logs or earlier experiment data were deleted.

## Completed checks

- Full suite: 1,975 passed. Later focused checks: 180 passed, then 52 controller
  checks after per-case receipt binding. Lint and type checking passed.
- Website build passed with its existing bundle-size warning. Desktop and mobile
  views were inspected with no horizontal overflow.
- First real-agent raw-evidence smoke: rejected a parser that dropped a result,
  but the repair review was unverified because inspection conversation history
  was lost. Evidence retained. Duration 30.50 seconds.
- After correcting provider reuse, a new smoke rejected the bad parser and
  accepted the repair against the same frozen expectations. Duration 19.62 seconds.
- These smoke checks establish verifier mechanics, not site reliability.

The planner checkpoint passed 1,980 tests. Later verifier corrections passed 1,982 tests, lint and type checking. Final full suite: 1,983 passed; lint and type checking passed. One preceding full run had an intermittent existing hostile-process cleanup assertion failure. That test passed all 15 checks in isolation, no matching child remained, and the next complete suite passed. Both failed and successful logs are retained.

## Live results

Flights attempt 1 started at 2026-09-20 18:02:40 UTC on implementation `1073ceb`,
with the original combined recording and four-operation scope. It was deliberately
stopped at 18:42:35 UTC after 39.916 minutes: the planner's exact output schema
and canonical example contradicted the new instruction to supply `recordedCall`.
Every observed focused plan omitted it, making the new verification gate
unreachable without further repair. This counts as failed attempt 1, not a
completed teach or an infrastructure exclusion. All owned processes exited.

All four research steps had reported success by about 33 minutes, missing the
30-minute target. Location retained 2 observations, search 3, calendar 8 and
booking 14. Booking corrected selection-value and nested-request mistakes, but
direct RPC remained unproven. It ultimately used parameterized CDP navigation
and rendered offers. Guessed readiness selectors caused several 60-second
capture timeouts despite offers being visible in diagnostics. None of these
research claims passed the final parser/chain/publication gates, and no tool
was published. No independent audit was started. The malformed-research-handoff
repair path was not exercised by this attempt.

The follow-up aligns the planner's prose, exact schema and example, and rejects
missing or unpaired response-chain metadata during planning. Older saved plans
remain readable. It also retains full dependency identifiers in audit metadata
and preserves prior plus new refinement cases in strict audits. A fresh run is
required to validate these corrections; the failed run will not be resumed.

Early research timing: a flight-search CDP call took 46.504 seconds including
setup. Its next call logged reuse of the same isolated browser and took 3.142
seconds. These were different research inputs, not a controlled latency benchmark;
the durations do not separately measure navigation, setup and network time.

## Accounting method

`accounting.json` is regenerated from deduplicated trace/span IDs. If both an
aggregate and descendant span carry token usage, only descendant usage is counted.
Input includes cache reads/writes; cached tokens are not added a second time.
Nested phase durations overlap and cannot be summed as elapsed time. Running
traces remain partial; interrupted or unreported usage remains unknown.

The reported model is `gpt-5.6-sol`. Base API-equivalent rates per million tokens:
$4 uncached input, $0.40 cache reads, $5 cache writes, $20 output. These rates were
verified on the [official model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
on September 20. This is an estimate, not a subscription invoice. Long-context
surcharges, service tiers and tool fees are excluded; CLI aggregate usage does not
reliably establish the per-request long-context surcharge. Zero emitted cache
writes means zero reported, not necessarily zero backend writes.



## Second attempt and campaign stop

Flights attempt 2 ran from 18:50:54 to about 19:55:08 UTC on `f1a0b6a`, in a
fresh isolated home with the same recording and four-operation scope. It was
assessed at 60 minutes and deliberately stopped at 64.243 minutes. Three first-wave
verification reviews were unverified: the location and calendar readers supplied
incorrectly escaped raw citations; the search reader exhausted its inspections
while implementing a frame decoder, without a final decision turn. Compilation
could not fix these verifier mechanics. This counts as failed attempt 2.

The campaign is closed under its two-consecutive-failure limit. Neither attempt
published tools or reached the independent site audit. No Hotels teach or successful
repeat was run. Reliability and the 30-minute teach target are not demonstrated.
All owned teach processes exited; no failed teach was resumed and the old cron
remains stopped. Disk availability and connectivity did not cause either stop.

Research initially returned partial or blocked results for search, calendar and
booking. The master continued with retained history, repaired request dependencies,
and narrowed the calendar to a supported initial grid. Booking research consumed
fresh search output and captured a new provider response. All four researchers
reported success by about 39 minutes, but these claims did not pass publication.
A later booking research cycle followed a parameter-description/path correction;
this added orchestration overhead even though its request and transform stayed
unchanged. All earlier observations remain in traces, not just the last handoff.
The malformed-proof-to-master path remains unvalidated by a fresh teach.

Planning finished around 45 minutes; the first compile wave began around 52.
Calendar and search compilation took roughly 2:53 and 4:34 respectively. First
live checks took 0.213 seconds for locations, 52.180 seconds for search and
33.237 seconds for calendar. These include different setup paths; they are not
comparable warm-call benchmarks. Cold-start waits were not changed.

## Corrections and retained-response checks

The follow-up keeps invalid proof rejected but lets the same reader correct raw
citations before it sees parser output. It exposes the existing generic wire
decoder for bounded projections, including byte-counted frames, and reserves a
final decision turn after six inspections/repairs. Original recorded request
inputs accompany responses. New focused plans reject response chains longer
than the artifact request list: a captured API response replaces its navigation
document, rather than appending both as parser inputs.

Separate saved-response probes used real bodies from attempt 2, without new live
searches or teaching agents. Originals remain untouched. An observer fixture
initially removed extra navigation documents but accidentally retained the old
recorded parser output. The corrected probe reran the parser on the corrected
chain. Both probe versions and the setup error are retained; the earlier parser
error does not establish failure on the corrected chain.

- Locations: accepted the complete recorded/live outputs, then rejected a copy
  with the final location removed against the same frozen facts.
- Search: after reparsing, rejected omitted return options in both recorded and
  live output. Inspection confirms the generated parser reads only one result
  group and assumes a single segment. The reader also alleged incorrect prices;
  that semantic claim is not independently established and is not needed for the
  omission diagnosis.
- Calendar: preserved all 49 cells in each source and received a parser pass.
  Observer review found that its live request changed a still-valid recorded
  date unnecessarily. This is not accepted as a comparable recording/live pass.

The last finding adds an explicit agent assessment of every recording/live pair
before expectations can be frozen. The reader receives the current date and must
justify input changes rather than accepting a freshness description at face
value. The runtime validates that the assessment exists; agents still determine
semantic equivalence. No site-specific rules or extra challenge calls were added.
Cached reviews from the older verification contract are not reused. A new saved-response check rejected the mismatched calendar pair in 17.186 seconds; a positive check accepted the unchanged location query.

These probes test verification mechanics and expose parser defects. They do not
substitute for a fresh teach or independent site audit. Further fresh teaches
require a new campaign budget; do not resume either failed attempt.

## Refinement validation

An isolated copy of the generated location tool was given a deliberate defect:
drop the last result and adjust the count. Its configured parser tests fail in
two cases before repair. The first bare test command lacked the required session
environment variable; both logs are retained. The first live `imprint refine` repair check took 5.993 minutes. Compilation,
recording/live evidence review and both audited invocations passed. Strict audit
stayed inconclusive because the two selected cases repeated the same query,
leaving its differential effect unverified. No replacement occurred; originals
were preserved. The planner now chooses a small contrasting case already in the
recording when needed for an advertised parameter, within the existing three-case
limit. It does not invent searches or grow the case set after selection.

Fresh isolated checks on the implementation equivalent to `2647f8b` both passed:

- Repair: 8.330 minutes; three recorded/live pairs passed independent raw-evidence
  review. Strict audit passed all four retained case invocations and the query
  parameter (five total graded checks), with no broken or missing cases.
- Extension: 8.271 minutes; optional `max_results` defaults to 0 (unlimited), with
  positive values limiting ordered result groups locally. Three recorded/live
  pairs passed independent review. Strict audit passed five case invocations and
  both parameters (seven graded checks), with no broken or missing cases.

The repair used three distinct queries already in the recording. The extension
used the recorded query for unlimited/limited output and a contrasting recorded
query. Cases were fixed before compilation; no invented live searches were added.
Both were promoted only inside their isolated test homes, with backup directories
retained. All eight original parser regression tests passed against the promoted
artifacts. The first failed refinement's original parser also matched its expected
pre-run contents exactly. Default installed tools were not modified.

Repair live transport times were 426, 187 and 193 milliseconds. Existing 25-second
pacing remained between calls; these figures exclude pacing and model time. These
were fetch calls and do not benchmark browser cold-start behavior. The extension
also used fetch. Neither refinement proves a successful four-tool teach.

A local setup copy initially followed dependency symlinks and was interrupted.
The partial copy remains under `refine-repair-setup-interrupted`; no evidence was
deleted. Setup was repeated using only the necessary artifact files. This consumed
about 4.5 GiB of additional disk space; it was not a teach failure.


## Final reported accounting

| Attempt/check | Minutes | Input including cache | Cache reads | Output | Base API equivalent |
| --- | ---: | ---: | ---: | ---: | ---: |
| evidence-smoke-1 | 0.508 | 67,225 | 29,184 | 587 | $0.1756 |
| evidence-smoke-2 | 0.327 | 50,819 | 33,920 | 253 | $0.0862 |
| flights-1 | 39.916 | 9,224,402 | 7,595,520 | 135,423 | $12.2622 |
| flights-2 | 64.243 | 14,610,145 | 11,684,480 | 195,989 | $20.2962 |
| real-evidence-search_locations | 1.613 | 59,215 | 37,760 | 4,016 | $0.1812 |
| real-evidence-search_flights | 3.823 | 516,270 | 421,632 | 9,942 | $0.7460 |
| real-evidence-get_date_grid | 2.720 | 267,848 | 213,248 | 6,884 | $0.4414 |
| real-evidence-search_flights-reparsed | 0.173 | 22,021 | 7,552 | 308 | $0.0671 |
| refine-repair | 5.993 | 1,813,511 | 996,480 | 9,804 | $3.8628 |
| real-evidence-get_date_grid-reparsed | 0.000 | 0 | 0 | 0 | $0.0000 |
| real-evidence-calendar-comparability | 0.286 | 30,190 | 7,552 | 359 | $0.1008 |
| real-evidence-locations-comparability | 1.075 | 38,459 | 28,928 | 2,900 | $0.1077 |
| refine-repair-2 | 8.330 | 1,785,149 | 962,816 | 11,438 | $3.9032 |
| refine-extension | 8.271 | 1,874,730 | 1,024,768 | 10,063 | $4.0110 |

Total reported: **30,359,984 input tokens**, including
**23,043,840 cache reads**, **387,966 output tokens**,
and **zero emitted cache-write tokens**: **$46.24** base API equivalent.
Three analysis spans lack usage, so this is incomplete accounting rather than an
exact bill. Failed teaches, failed refinement, and superseded evidence probes are
included. The cached calendar reparse made no model call; its zero is intentional.
An observer script failed before model startup and is retained in its error log.
Concurrent refinements are attributed using their isolated home paths in trace
attributes, not ambiguous launch timestamps. Their elapsed times overlap.

Complete raw traces and per-phase durations remain in local `accounting.json`.
Provider-internal retries and setup/model/parser sub-times are not consistently
separable from CLI totals; no missing breakdown is represented as zero. No provider
capacity failure was identified as the reason for either teach stop.

All task-owned teaches, refinement workers, probes and the trace collector are
stopped. The old recurring monitor remains off. About 18 GiB remained at the final
check; the laptop was still on battery. No recordings or logs were deleted. No
push, MR or merge was made.

## Remaining validation

A successful fresh teach and independent audit on `2647f8b`, followed by unchanged-code
Flights and Hotels repeats, remain outstanding. A new campaign budget is required;
do not restart the old monitor or resume a failed teach. Use the original recording
paths and exact four-operation command in `docs/teach-handoff-2026-09-07.md`, with a
new isolated evidence home. The malformed research-handoff recovery path, end-to-end
booking output and Hotels guest-count support remain unproven by this campaign.
