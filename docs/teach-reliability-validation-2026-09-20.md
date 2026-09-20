# Recording-backed teaching validation

Initial implementation: `1073ceb`; planner correction: `f1a0b6a`, on `codex/imprint-master-v066-validation`, descended
from `origin/codex/imprint-master-v066`. No old vnext changes were used.

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

The two completed smoke attempts together used 118,044 input tokens (including
63,104 cache reads), 840 output tokens and zero emitted cache writes. Their base
API equivalent is $0.2618016. Failed attempts remain in campaign totals.

Flights attempt 1 reported 9,224,402 input tokens including 7,595,520 cache reads,
135,423 output tokens and zero emitted cache writes: $12.262196 base API
equivalent. Two analysis spans lack usage, including interrupted work. Including
both smoke attempts, the completed reported estimate is $12.5239976. This excludes
any later active attempts and retains the failures.


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

A fresh isolated repair and an additive-extension check are running with the
corrected planner. The extension requests an optional local result limit with an
unlimited default; it uses recorded queries and preserves existing behavior.
Neither modifies the user's default installed tools. Results remain pending.

A local setup copy initially followed dependency symlinks and was interrupted.
The partial copy remains under `refine-repair-setup-interrupted`; no evidence was
deleted. Setup was repeated using only the necessary artifact files. This consumed
about 4.5 GiB of additional disk space; it was not a teach failure.
