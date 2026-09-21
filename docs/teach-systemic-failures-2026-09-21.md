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

Checkpoint `a837d55` corrected the two prompt contradictions. Fresh Flights 2
then ran 79.632 minutes and exited 1: location lookup and the initial date grid
passed recorded/live verification; search had an unavailable recording fixture
and duplicate live rows, leaving booking blocked. The next checkpoint adds early
fixture-availability validation and preserves research history across boundary
changes. A fresh Flights 3 is next; no full audit or repeatability pass is claimed.

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


## Flights 2 observations (in progress)

Fresh Flights 2 started at 06:02:30 UTC on `a837d55`, run
`1fca0e8b-ac9f-4176-b746-6dfdd00f725f`, isolated home under the new campaign.
The master retained recorded location requests 63 and 288. Research tested both
queries through fetch (244 and 205 ms transport), and the focused plan selected
two unchanged recorded/live pairs. This demonstrates the prompt correction at
planning; generated-tool verification and audit are still pending.

Search's first selected request had no response body. Research inspected nearby
completed requests and continued. The first browser-backed test spent 76.047
seconds, including a 45-second wait for an old recorded network endpoint that the
current page did not emit. The page did render results. The researcher changed
the capture strategy to rendered-document evidence; the next call reused its
same-tool browser and took 2.065 seconds. These were different capture strategies,
so the difference is not a controlled setup/warm benchmark. This is evidence of
an outdated capture assumption, not a demonstrated network outage or permission
to remove setup waits. Preserve this distinction when reviewing SF-07.


At 30 minutes, locations and search research were proven; booking had invoked
search for fresh upstream evidence; calendar remained partial. Continue to the
60-minute assessment because retained-agent repairs are making concrete progress.
The 90-minute hard deadline is unchanged. This is not a passed teach.

Search's first parameterized navigation used the wrong trip-mode value. Its
follow-up researcher corrected that value from the recording and captured a fresh
shopping API response with the full continuation data. Thus the earlier missing
endpoint observation alone did not establish that the site removed the endpoint:
a wrong generated request mode was also involved. Track this as an input-mapping
error recovered within the run, not as proof of an infrastructure outage. Booking
then called the corrected producer again for fresh output rather than reusing the
recorded selection. Calendar's successful fixed navigation had ignored advertised
route and range inputs; its partial status correctly exposed those no-op mappings.


SF-09 (confirmed mechanical history loss): after the calendar boundary revision,
`api-research.json` contained only the three new observations, replacing the
previous seven. `researchSelectedOperations` sends no previousProgress when it
refreshes a changed boundary; `researchApiMvpCall` loads saved history only when
previousProgress exists. The retained provider conversation is keyed by public
tool name and stays intact, so this is on-disk evidence loss, not a lost agent
conversation. Prior observations are absent from the run home. Available valid
trace observation payloads were archived privately, with source span IDs; this
does not establish recovery of every complete raw body. Current research files
also have content-addressed private snapshots. Fix after the active run: retain
same-run disk history independently of whether a previous handoff is supplied,
without allowing old-candidate observations to prove a revised request. Add a
regression for a changed boundary and no previousProgress before another teach.


SF-09 recurred for booking: revising the consumer from an opaque token to a
serialized selection object replaced seven saved observations with two new ones.
The pre-revision private content-addressed snapshot preserved all seven this time.

The booking mismatch comparison demonstrated SF-04 concretely: a fresh token for
one flight, combined with a different hardcoded flight in navigation, returned
the hardcoded flight. The coherent same-record context returned the intended
flight. The master revised producer and consumer together to carry route, date,
carrier, flight number and the opaque continuation in one selection value. The
revised consumer was proven in two tests by minute 52. These are retained-agent
repairs, not external changes to the active teach. All four research results were
then proven; no generated-tool or audit success was claimed at that point.


At minute 58 the master accepted all four tools in two waves; it reused the
matching location draft and launched search/calendar compilation. Provider
rollout timestamps show the preceding quiet interval included focused planning
and a second master decision, not one continuously stalled research review.
At minute 60 continue to the unchanged hard deadline because compilation is
active. No generated tool has passed yet.

SF-10 (confirmed invalid fixture reference, recovery pending): the accepted
search replay/live pair still names recording request 206, whose response body
is absent in the original session. Research had already noticed this and read
nearby completed request 245 (51,290 bytes). The planner nevertheless reverted
to 206. `recordingFixtures` requires a body and will reject that source. Observe
whether repair reaches planning or merely recompiles the parser. A small generic
fixture-availability check before compilation would be appropriate if the existing
repair path fails; no site-specific reference substitution should be automatic.


## Flights 2 final outcome and next correction

Flights 2 exited 1 naturally at 79.632 minutes (4,777.903 seconds), with locations
and calendar published after independent recorded/live checks. Search's live call
completed, but recording verification failed because request 206 has no body.
The master returned the unchanged plan and no recalls, treating that evidence
failure as ignorable. The unchanged-failure guard correctly stopped the run.
Booking remained dependency-blocked. This is a failed four-tool teach; no external
strict audit or repeatability pass is claimed.

Inspection of the saved search live result found 60 rows containing only 20
unique full rows and 20 unique IDs; every row appeared three times. Its compiler
unit tests passed against a single-frame research response. The independent
reader never reached this live parser defect because the missing recording
fixture blocked review first. This is a new SF-04 recurrence, not evidence of
correct search output despite the master's prose calling all 60 rows credible.

Small correction: focused planning now receives the mechanically derived list
of requests with captured bodies. Its existing schema-repair conversation rejects
unavailable recording sources before compilation. The agent still chooses a
comparable replacement; no runtime substitution is made. Master guidance treats
missing fixtures as a plan gap that cannot be waived. Research also loads and
retains the full same-run history across boundary refreshes; outward handoffs
remain bounded and existing candidate-proof binding is unchanged. Regression
checks cover both repairs, including rejection of old proof for a new request.

Final Flights 2 accounting: 14,827,797 input tokens, including 12,445,696 cache
reads; 205,778 output; zero reported cache writes; $18.6222424 estimated base API
cost. No missing analysis usage was reported. Both campaign attempts together:
$23.9412656 base estimate, with the first attempt's two missing usage spans still
unknown. All failed calls and repair turns count. The teach process group exited;
the task collector remains active for the next fresh run. No cron was started.


Correction validation: 199 focused checks passed; the final full run passed all
1,985 tests, with lint and type checking clean. Two end-to-end mocks needed to
select current candidate proof rather than assume empty history on refresh. A
known process-cleanup test race failed once, then passed its rerun and the final
full suite. Website build and desktop/mobile text rendering passed. These checks
validate mechanics, not fresh-teach reliability. Next command:
`python3 ~/.imprint/experiments/reteach-systemic-2026-09-21/run.py flights-3 google-flights`.


## Flights 3 active validation

Fresh Flights 3 started 2026-09-21 07:38:45 UTC on `dce493a`, PID/PGID 79138,
using the original recording and four-operation guidance. Home is
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-3/home`. Target 08:08:45,
assessment 08:38:45, hard deadline 09:08:45 UTC. AC power, fully charged battery,
about 20 GiB available. No implementation changes during this run; no prior
artifacts supplied to its teaching agents. The task collector remains on 6443;
there is no recurring automation.

Approximate Flights 2 wall-clock stages from progress/rollout timestamps:
0–8 minutes selection; 8–24 first-pass research plus an overlapping location draft;
24–52 research follow-ups and contract revisions; 52–58 focused planning/master
acceptance; 58–66 search/calendar compilation; 66–78 generated-tool verification;
78–79.6 final unchanged-plan failure. Nested trace totals overlap and must not be
summed as wall time. The largest delay was research/contract coordination, not
disk exhaustion or loss of power/network. Browser capture waits caused some
local delays, including wrong generated page-state encodings; warm requests were
usually much faster after the corresponding repair.


SF-11 (recurring generated request-structure errors): Flights 3 booking added an
unsupported location array layer, making its prepared body 12 bytes longer than
the recording. Calendar repeated the same kind of error across four locations,
making its body 24 bytes longer. Each malformed construction traversed transport
rungs before the agent used prepared-request comparisons to correct nesting.
Both errors were generated-artifact mistakes; changing network transport could
not repair them. The existing comparisons enabled repair, but arrive after live
execution. Track whether a small agent-requested render/compare step before
execution would remove these repeated sweeps. This is a candidate for future work,
not an automatic runtime rule equating every structural difference with failure.
Do not add site-specific body mappings or skip legitimate browser state.


SF-12 (observed stale setup context): Flights 3 calendar changed its bootstrap
page from the home page to a search page, but fetch-bootstrap reused a 199-second
old jar containing 339,370 bytes of home-page HTML. Required captures were absent,
and execution escalated to a fresh CDP context. `getOrMintCdpJar` scopes its disk
cache by tool/rung and age but does not bind it to bootstrap URL; `MintedJar` does
not record that URL. The live CDP pool does key on bootstrap URL. A narrowly scoped
cache-context fix is a candidate if this causes repeated setup failure; no change
is made during the active run, and this does not justify sharing state across
rungs or removing readiness requirements.


Flights 3 checkpoint at 44.7 minutes: location and booking research are proven;
calendar follow-up is now proven; search remains partial pending a narrower
contract. Calendar retained all eleven observations (seven initial plus four
follow-up), confirming same-run history retention at this boundary. Its shifted
window initially clicked a stale positional selector and moved the return edge
the wrong way; using the recording's semantic Scroll down selector repaired the
seven-record response. A supplemental route-label check then timed out because
the agent expected Las Vegas for a San Diego identifier; the retained failed
response identified San Diego and supported correction without another request.
This was an agent interpretation/readiness-selector error, not evidence of an
internet outage. The resulting candidate supports two recorded window shapes;
general arbitrary window support is not established. No strict audit yet.


SF-13 (recording-only policy drift): at 47 minutes in Flights 3, the master
requested a new airport-code route/date after the retained researcher correctly
reported that no selected one-way recording changed the origin. The researcher
then tested SFO-to-LAX on 2026-10-20, absent from the selected recorded call.
This violates the requested fixed recording-backed case policy; a successful
result cannot be counted as a matched recorded/live verification case. The
master prompt contains a short prohibition on extra exploratory challenges,
but later unconstrained instructions request a distinguishing comparison. Other
verification agent prompts carry an explicit recording-backed policy override.
Review this prompt inconsistency after the active run; keep its observations
and accounting, and do not silently present it as a compliant paired example.


SF-14 (research evidence lost between follow-ups and planning): Flights 3
search inspected completed request 245 during its first pass, but a later
follow-up rebuilt the focused evidence from the selected scope plus only that
follow-up's additional sequences. `mergeResearch` replaces the old evidence
projection. `researchApiMvpCall` keeps inspected sequence IDs only in memory and
saves observations without those IDs, so later boundary/follow-up passes do
not reconstruct the earlier inspection evidence for downstream planners. The
search planner then chose document request 1 as its replay result: that body
is the generic landing page and contains neither flight cards nor data-gs
selection attributes. Its body exists, so the new availability guard correctly
does not catch this semantic mismatch. A minimal repair is to preserve the
agent-selected inspection IDs alongside same-run history and reconstruct their
evidence on follow-up; agents still decide which request is comparable.

The same controller also drops `outcome.observations` while constructing proven
and partial handoffs, despite the researcher returning that bounded history.
Only blocked handoffs carry the complete returned list. Forward the existing
field so the master and planner can inspect successful contrasts and failures
without relying exclusively on the final summary. These defects are distinct
from the already-fixed local observation-file overwrite. No source edit has
been applied while Flights 3 is active.


Flights 3 sixty-minute assessment (08:38:45 UTC): all four research handoffs
are proven, a four-tool/two-wave plan exists, and final booking-plan/chain
review is underway before compilation. Continue
within the original 09:08:45 hard deadline because this is real phase progress.
The search replay proposal still names landing-page request 1; verification
must reject unsupported extraction rather than waive the missing search fixture.
Master corrected the booking chain paths from itineraries to the producer's
accepted items result shape. No publication or independent audit has completed.


Flights 3 checkpoint at 74 minutes: search compiled and its live call completed
in 33.495 seconds including cold CDP setup. The independent reader then rejected
request 1 as incomparable with the claimed SJC-to-SAN search; this was an honest
unverified result, not a successful teach. Location lookup published after both
New York and SJC pairs passed, including complete result groups and associated
airports. Each pair reread both selected recorded fixtures; this repeated work
is a measured efficiency issue, separate from semantic failures. The master is
now revising from search's fixture failure; calendar and booking remain unchecked.

A minimal candidate correction was prepared outside the active checkout in
`~/.imprint/experiments/reteach-systemic-2026-09-21/scratch-history-fix`, with
`pending-history-fix.patch` and its manifest in that campaign root. It saves
and restores inspected recording IDs, forwards existing observation history
in proven/partial handoffs, and explicitly keeps master-directed comparisons
within recording-backed cases. It has not yet been applied to the running teach.
Two targeted regressions fail against the old code and pass with the repair;
201 focused tests and all 1,985 full-suite tests pass (6,434 assertions, 110.53s).
Lint, types, website build, and 1440/390px visual checks pass; the existing large
JavaScript chunk warning remains. The scratch preview/browser are stopped.


At 77.5 minutes, the master requested focused replanning of search and calendar.
It correctly identified the incomparable landing-page fixture but incorrectly
asserted that request 206 has a captured core response. The new planner body
availability guard must reject that source. Calendar did not reach compilation: its
focused plan had two request definitions while the exact proven candidate had
three (route-label navigation plus mutually exclusive initial/shifted branches).
The master requested preservation of the proven definitions; this is a planning
mismatch, not a demonstrated calendar live failure. Booking remains waiting on
a verified producer.


Flights 3 final result: exited 1 at 08:57:40 UTC after 78.914 minutes, with
1 of 4 tools ready (location lookup). Search remained recording-unverified;
calendar had a plan/request-definition mismatch; booking never reached a
verified producer chain. All owned processes exited, and no strict audit was
started for this incomplete four-operation teach. The availability guard did
reject request 206 in the retained planner repair turn. The planner then returned
an empty recordedCall request list because its supplied evidence lacked a
comparable response; the schema correctly rejected it.

SF-15 (unrepresentable planning gap terminates the stage): a focused planner can
recognize that its evidence cannot produce a valid verification plan, but its
output contract still requires a complete plan. After one invalid-output repair,
that failure terminates the whole planning fanout instead of returning a factual
advisory gap to the master, unlike malformed research handoffs. This occurred
once here and remains a tracked architectural limitation; no new fallback or
weakened fixture validation was added. First fix the demonstrated upstream
evidence loss and check a fresh run before expanding planner orchestration.

Flights 3 accounting: 12,293,979 input tokens including 8,939,648 cache reads;
202,697 output; zero reported cache writes; $21.0471232 estimated base API cost.
No missing usage spans. All three campaign attempts total $44.9883888,
29,668,587 input tokens (22,995,072 cached), 454,815 output, zero reported writes,
and two missing usage spans from the interrupted first attempt. These are base
API equivalents, not subscription charges; prior pricing caveats still apply.

The tested pending patch was applied only after Flights 3 and its process group
exited. In-checkout regression checks, lint, and type checking passed. The full
suite and website checks above used identical patched files in the isolated
scratch copy. Next: commit this checkpoint and start a new `flights-4` teach from
the original recording. Do not resume Flights 3 or seed its generated artifacts.
