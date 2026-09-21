# Fresh-teach failure ledger

## Current work

The user requested continued fresh teaches on September 20 (PDT), superseding the
previous campaign stop. The goal is a working four-operation Flights teach and
strict independent audit, followed by an unchanged-code repeat and Hotels validation.
Keep each teach at a 30-minute target, assess at 60 minutes, and enforce 90 minutes.
Audits retain a 45-minute limit. No recurring automation, MR, push or merge.

Five attempts in this September 21 campaign have ended unsuccessfully (three
operator stops, two natural failures). Flights 5 was stopped after 48.144 minutes
on `d424359`; it had positive research results but narrowed search to a fixed
route/date and grid to literal windows. No tools were published and no independent
audit ran. The current checkpoint addresses repeated bootstrap/capture problems
and that evidence-policy scope regression. Fresh Flights 6 is next after checks.

`d424359`'s citation correction has unit and retained-byte validation, but Flights 5
did not reach final parser review, so fresh end-to-end confirmation remains due.
No four-tool teach, audit, or repeatability pass is claimed in this campaign.

All local evidence remains under
`~/.imprint/experiments/reteach-systemic-2026-09-21/`. The collector is on
127.0.0.1:6443. Latest preflight: AC power, 100% battery, 19 GiB free, original
recordings intact. No disk exhaustion, sleep, or network loss has been established
as the cause of these five unsuccessful attempts. No prior generated tools enter teaching.
Code and prompts stay fixed within each teach. The detailed observations below
are historical entries; the current state and attempt table take precedence.

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
| SF-02 | Evidence formatting consumes the verification budget | Recurred in Flights 4: seven quotations exactly matched original raw strings, but only two of nine matched their extra-escaped JSON wrapper. The reader reached its final turn with grounded facts and was rejected. `d424359` accepts exact citations in either representation; synthetic regression fails before and passes after. | Validate in fresh Flights 5. Do not widen budgets or waive raw-source citation checks. |
| SF-03 | Verification accepts an unrelated live request | September 20 calendar saved-response check passed parser fidelity despite an unnecessary date change. Explicit comparability assessment now rejects it; unchanged location input passes. | Track recorded/live input relationships at planning and review. Repair the selected pair without inventing new cases. |
| SF-04 | Result membership or component identity is lost between raw data and output | Historical Flights 53 duplicated repeated frames; September 20 Flights 2 omitted other result groups and connecting options. Earlier 52 constructed a consumer selection from only part of a composite record. These are confirmed recurring artifact defects, not one universal parsing rule. | Check whether the compiler sees all selected raw bodies and actionable independent feedback. Repair its existing fixed cases; do not prescribe first-frame selection, concatenation, deduplication or a site-specific mapping in runtime. |
| SF-05 | MVP verification and strict audit require different coverage | First isolated refine repair passed its raw checks and two identical calls, but strict audit could not establish the query parameter. Selecting distinct existing recorded queries made repair and extension pass. September 21 Flights 1 repeated the single-query plan despite a variable query contract. Stopped early to correct contradictory planner guidance and upstream evidence pruning. | If teach repeats this gap, align case-selection guidance with strict audit using the same fixed recorded set. Preserve unverified coverage rather than weakening the audit. |
| SF-06 | Small metadata changes trigger expensive research again | September 20 Flights 2 repeated booking research after a description/path correction. Code hashes the entire candidate; its workflow includes parameter descriptions. Exact proof binding is useful, but can invalidate more than executable request behavior. One concrete observation; general recurrence not yet established. | Record what changed, which proof was invalidated and elapsed rework. Consider separating execution identity from explanatory metadata only if a reproducer shows needless reproof without weakened semantics. |
| SF-07 | Browser interaction waits dominate despite available evidence | September 20 Flights 1 repeatedly waited about 60 seconds on guessed selectors; historical 48 had missing click targets while result markup existed. There are multiple possible causes, not proof that setup can be skipped. | Inspect navigation/capture/action timestamps and selected conditions. Keep bounded cold-start behavior; change only a reproduced mechanical wait or evidence delivery defect. |
| SF-08 | Minimizing execution also prunes verification evidence | September 21 Flights 1 discovery supplied ten location requests, but the master kept only [63,69]. Focused evidence is mechanically filtered to this pool, so the planner could not select contrasting recorded queries. | Clarify that candidate requestSeqs is an evidence pool, while research determines the minimum executed graph. Preserve a small selected set of recorded contrasts and representatives; fresh validation pending. |

| SF-09 | Boundary refresh overwrites same-run research history | Confirmed Flights 2. Fixed in `dce493a`; later runs retain full private observations and forward bounded history. | Watch boundary-changing follow-ups; old observations must never prove a changed candidate. |
| SF-10 | Missing recording fixtures are detected only after compilation | Flights 2 failed here. `dce493a` gives planning body availability and checks fixture references; Flights 3 demonstrated early rejection. | Preserve the guard and let agents choose comparable completed captures. |
| SF-11 | Generated request construction changes nested array structure | Calendar in Flights 3/4 and booking in Flights 3. Extra wrappers caused bad requests before agents corrected them. | A future agent-requested prepare/compare diagnostic could expose structure before spending network/browser time. Not implemented. |
| SF-12 | Bootstrap cache ignores changed URL context | Flights 3 and Flights 5 retained a homepage jar/HTML after changing bootstrap to search. CDP browser pool does key on URL; disk jar cache does not. | Confirmed recurrence. Prepare a URL-context cache regression and the smallest isolation fix if another checkpoint is needed. |
| SF-13 | Master invents comparisons outside the recording | Flights 3 requested another route/date. `5d7b2be` clarified the existing fixed-case policy; Flights 4 master explicitly kept the recorded route/date. | Track actual inputs, not just compliance prose. |
| SF-14 | Inspected evidence and observations disappear at agent handoffs | Flights 3 lost completed search response 245 during follow-up; proven/partial handoffs also omitted observations. Fixed in `5d7b2be`; Flights 4 retained IDs 245/295, selected fixture 245 and repaired a bad capture matcher from history. | Fresh continuation evidence validated; still watch later boundary changes. |
| SF-15 | Focused planner cannot return an evidence-gap advisory | Flights 3 correctly recognized unavailable fixtures after a bad first proposal, but its only output type required a full valid plan; empty cases became a fatal schema error. | First remove upstream evidence loss. If needed, add a bounded advisory path to the master, not fake proof. Not implemented. |
| SF-16 | One verifier status conflates raw-fact readiness and parser correctness | Flights 4 location supplied complete facts and matched calls, then prematurely marked itself unverified. `d424359` clarifies omission of status for sufficient raw expectations; explicit gaps remain unverified. | Validate the prompt correction in Flights 5; do not silently override an agent's uncertainty. |

| SF-17 | Fixed-case verification turns into fixed-constant tools | Flights 5 removed every search input and restricted calendar to literal recorded windows, although search route/date mappings were grounded and the working calendar method could expose a different input shape. | Clarify coverage versus mapping support; require recorded meaning, actual construction, and independent result evidence together. Preserve ambiguous/no-op failures. Validate fresh, without inventing cases. |

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
| September 21 Flights 2 | a837d55 | Natural failure at 79.632 minutes; 2/4 published | SF-09/10; search also duplicated 20 rows into 60 (SF-04). Booking blocked. $18.6222424 reported base equivalent. |
| September 21 Flights 3 | dce493a | Natural failure at 78.914 minutes; 1/4 published | SF-14 lost completed fixture, then SF-15 planner output failure. Missing-body guard worked; search returned 20 distinct rows. $21.0471232. |
| September 21 Flights 4 | 5d7b2be | Operator stopped at 60.108 minutes; calendar published | SF-02/16 blocked parser evaluation; booking waited. Retention and fresh research chaining worked. $17.8705224; one interrupted usage span missing. |
| September 21 Flights 5 | d424359 | Operator stop after 48.144 minutes; 0/4 published | SF-12 reused wrong bootstrap HTML; SF-07 repeated matcher typo; SF-17 froze useful inputs for lack of recorded contrasts. Positive research exists; final parser verification not reached. $13.6372248 reported; unflushed tail unknown. |

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


## Flights 4 active validation

Fresh Flights 4 started 2026-09-21 09:01:00 UTC on `5d7b2be`, PID/PGID 13399.
Foreground driver session 47230 uses the original recording, unchanged
four-operation guidance, and a new home under the campaign's `flights-4/`.
Target 09:31, assessment 10:01, hard deadline 10:31 UTC. Available disk is
19 GiB; the task collector remains reachable on 6443. No prior generated
artifacts are supplied. Source code and prompts stay unchanged during this run.


Post-run offline inspection of Flights 3's retained live search output found
20 rows and 20 distinct complete rows. The Flights 2 triplication failure did
not recur in this result. This count check is not a full semantic audit: the
independent reader stopped on the incomparable fixture before checking search
output meaning and completeness.


Flights 3 model-stage timing is saved privately in
`flights-3/model-stage-timing.json`. Structured-output classification found seven
master decisions totaling 888.94 seconds and ten focused-planning calls totaling
893.49 seconds; the latter include concurrent calls. They emitted 39,211 and
38,134 output tokens respectively. Research used 39 decisions totaling 2,119.38
seconds. These are overlapping model-call durations, not additive wall-clock
stages. Complete-plan regeneration and repeated approval/planning account for
substantial latency; browser startup alone does not explain the 79-minute run.
A later architectural option is references to unchanged plan portions plus
explicit agent-authored edits, while keeping binding validation mechanical.
Do not implement that larger protocol change in this unblocker checkpoint.


Flights 4 search at 12 minutes showed another SF-07 mechanism: the page really
issued a successful in-scope POST/XHR to its shopping endpoint, but the authored
URL substring matcher began with a slash where the actual endpoint has a dot.
The trace reports matchingRequestCount 0 and includes the actual endpoint. The
researcher switched to rendered HTML rather than repairing that literal mismatch.
The next same-browser call completed in 1.967 seconds. This is a candidate matcher
error, not loss of network or an absent API response. The new observation handoff
should let the master see it; watch that before adding more guidance. A possible
future mechanical aid is per-predicate match facts in timeout diagnostics, not a
site-specific matcher rewrite or automatic semantic selection.


Flights 4 at 15 minutes: location research is proven; search is partial and
its saved history now includes inspected recording IDs 245 and 295. Booking
returned a valid dependency block after one token-only diagnostic: error 13
cannot distinguish a stale token from omitted coupled context, so the master
must supply fresh search evidence or revise the contract. Calendar research
started next. This is not an invalid research handoff or evidence that booking
API execution is impossible. The new inspection persistence has been exercised;
retention across the upcoming follow-up is still to be verified.


SF-11 recurred in Flights 4 calendar: four locations each had one extra array
wrapper, producing the same 24-byte body surplus seen in Flights 3. All four
transport rungs returned BAD_RESPONSE before the researcher corrected the body
to 683 bytes. Fetch then accepted it but returned protocol marker 13 with no
grid data, so that transport completion is not semantic proof. The agent is now
testing recorded request context. A generic prepare-and-compare diagnostic before
network execution remains a plausible efficiency fix; the runtime must report
structure differences rather than decide which fields are semantically needed.


Flights 4 first master review (about 26 minutes) used the forwarded observations
to identify the bad shopping-response matcher and directed the retained search
researcher to repair it on the same recorded route/date. It explicitly forbade
new challenge routes/dates, retained the public inputs pending structural and
effective-state proof, and named completed request 245 as supporting evidence.
Calendar should tie rendered route state to its grid from the same navigation.
Booking follows those repairs and must call the updated search producer for
a fresh coherent selection. This is a positive coordination result from the
new handoff path, not yet a successful teach or independent audit.


Flights 4 at 29.5 minutes: the repaired shopping-response capture completed in
41.929 seconds including fresh CDP setup, then search returned a proven handoff.
Its history grew from four to five observations and inspected IDs 245/295
survived the actual follow-up. This validates the new retention path in the fresh
run; it does not yet establish final planner fixture selection or parser quality.
Calendar route verification and fresh booking consumption follow next.


Flights 4 at 34 minutes: calendar research is proven after route-state
corroboration; all seven observations are retained. Booking has explicitly
invoked `call_producer` for fresh search output, instead of testing the recorded
token again. Its consumer request and final executable chain still need proof.


Flights 4 at 41.8 minutes: all four research handoffs are proven. Booking used
a fresh producer response, then a coherent serialized selection carrying its
token and route/date/carrier/flight identity. Direct fetch returned only marker
13; page-owned booking capture completed in 32.474 seconds including cold setup
and returned positive booking data. Its four observations are preserved.
This research milestone is roughly eight minutes earlier than Flights 3, but
final planning, parsers, compiled chain checks, and independent audit remain.


Flights 4 at 48 minutes: focused planning now selects completed shopping
response 245 for recorded replay; SF-14's downstream fixture-loss symptom has
not recurred. Calendar has one request definition matching its proven workflow.
The booking focused planner proposed `itineraries[1].selected_flights`, but
search's output plan names `items`; the master explicitly corrected the edge
to `items[1].selected_flights` before compilation. This is successful agent-led
coordination, not a runtime defect. Location planning nevertheless selected only
the recorded New York query despite proven SJC evidence; SF-08 coverage pruning
remains under observation. Do not count one query as recorded contrast coverage.


Flights 4 at 52 minutes exposed SF-16, a verifier phase-contract ambiguity.
Location's raw-only reader returned complete expectations for both sources and
comparability `matched`, explaining that all five city groups, identities,
ownership, distances, and scores were established. It also set top-level
`status: unverified`. The runtime consequently terminated before showing parser
output. This is an incomplete/inconsistent verifier report, not evidence that
the location parser failed. The same response schema describes raw expectation
readiness and final parser correctness; clarify the phase contract without
ignoring an explicit unverified finding or accepting unreviewed output. Let the
current run expose subsequent outcomes before choosing the smallest correction.


Flights 4 at 57 minutes: SF-02 recurred with a concrete mechanical cause. Search
reader used all six inspections, then supplied complete facts and matched
comparability. Its escaped array quotations are literal substrings of the
original response string, but not of `JSON.stringify(responses)`, which adds
another escaping layer. The validator checks only that serialized array. Seven
valid raw quotations were rejected on the final turn, yielding the misleading
inspection-budget result before parser evaluation. A minimal general correction
is to validate quotes against both the shown serialized source and each original
raw response string, retaining exact substring checks and rejecting invented
citations. No semantic inference, increased inspection budget, or new live case
is needed. Preserve the source-level distinction in regression coverage.


Flights 4 was operator-stopped at the 60-minute assessment, not a natural teach
completion: exit 130 after 60.108 minutes. Calendar passed its 49-item recording/
live check and MVP review and published. Search and location never reached parser
evaluation because of the verifier issues above; booking waited on search.
No independent audit or repeatability pass is claimed. Its process group exited
fully before source files changed. Preserved local `operator-stop.json` records
the decision. Reported usage: 10,352,473 input including 7,431,936 cache reads,
160,780 output, zero cache writes reported, $17.8705224 base API equivalent; one
interrupted model span lacks usage. Four attempts total $62.8589112, excluding
unreported usage and pricing surcharges.

The next minimal correction accepts quotations in original response strings
without removing exact-source citation checks. A synthetic regression reproduces
the extra-escaping rejection on old code and passes after the fix. The reader
prompt also distinguishes raw-fact readiness from a final parser verdict; an
explicit raw-evidence gap still terminates unverified, covered by regression.
This does not increase inspection limits or alter selected cases, request
construction, browser readiness, or site behavior.


Checkpoint validation: 1,987 tests passed across 100 files (6,445 assertions,
109.49 seconds); lint and type checking passed. Website build and desktop/mobile
inspection passed without horizontal overflow. The original failed search
review's nine quotations were checked offline: old validation accepts two, the
corrected exact-source validation accepts all nine. No parser pass is inferred
from citation acceptance. Fresh validation starts from this committed checkpoint.


## Flights 5 active validation

Started fresh at 2026-09-21 10:04:53 UTC on d424359, PID/PGID 44525, driver
session 49146, new campaign home `flights-5/home`. Original recording and exact
four-operation guidance are unchanged. Target 10:34:53, assessment 11:04:53,
hard deadline 11:34:53 UTC. Disk remains 19 GiB free, AC power is connected, and
collector 6443 is active. No prior generated tool is supplied and code/prompts
stay unchanged during validation.


Flights 5 at eight minutes: location research proves both recorded queries.
Search inspected completed request 245 immediately, then identified its first
400 response as an extra origin-array wrapper: prepared body was six bytes too
long and first diverged inside that structure. It corrected the shape using
existing request-comparison facts. SF-11 now appears across search, calendar and
booking construction; it is a general nested-wire reconstruction error. The
first test spent browser setup on four rungs before returning those diagnostics.
An optional prepare/compare step could save that cost, but the agent already has
enough facts to repair after the test; do not equate this with network failure or
add a semantic transport classifier during this run.


SF-12 recurred in Flights 5. At about 9–12 minutes, search changed bootstrap.url
to `https://www.google.com/travel/flights`, but fetch-bootstrap reused the prior
337,606-byte homepage snapshot (ages 131 and 253 seconds) and failed required
state capture. A separate CDP document request loaded current Flights HTML, yet
the next fetch-bootstrap retry again used the old snapshot. The cache path is
scoped by tool/rung but `getOrMintCdpJar` checks age/recording freshness without
binding the snapshot to the requested bootstrap URL. This can mislead researchers
into debugging a correct capture pattern against the wrong page. The CDP pool
already includes the rendered bootstrap URL in its key. A minimal future fix is
URL-context scoping for the fetch-bootstrap snapshot, with tests for same-URL
reuse and changed-URL isolation. Do not change the active run under observation.


Flights 5 around 18 minutes repeated SF-07 in calendar: its response matcher uses
`/FlightsFrontendService/GetCalendarGrid`, while the recorded endpoint contains
`.FlightsFrontendService/GetCalendarGrid`. This is the same literal slash/dot
error as Flights 4 search, now in another operation. Search's current full matcher
is correct. Confirm the ensuing observed-network facts and whether the researcher
or master repairs the mismatch; it is not evidence that a setup sleep is needed.
A generic per-predicate capture diagnostic remains a candidate, without requiring
live endpoints to equal old recorded URLs or automatically rewriting matchers.

A private pending SF-12 patch and synthetic regression are saved as
`pending-bootstrap-context-fix.patch` / `.json` in the campaign root. It hashes
the rendered bootstrap URL into the existing per-tool/per-rung cache directory.
The synthetic A→A→B→A test fails on old cache identity and passes after the change;
115 backend/cache tests and type checking passed in the isolated scratch copy.
It is NOT applied to the active checkout or Flights 5. A later checkpoint still
requires integration checks, collateral updates, a commit, and a fresh teach.


Flights 5 calendar repaired SF-07 itself at about 25 minutes: after four capture
timeouts (~90.8, 60.3, 60.3 and 60.3 seconds including first setup), it recognized
the literal slash/dot mismatch and changed only the matcher. The next warm call
returned the raw grid in 2.410 seconds. Earlier revisions had changed capture
timing and removed explicit occurrence 1 (which equals the default), neither
addressing the mismatch. This is concrete evidence for showing per-predicate
matcher facts; it does not justify automatically choosing another endpoint or
relaxing the deadline. A private diagnostic-only patch is being tested alongside
the pending cache fix, not applied to this run.


At 30–33 minutes, Flights 5 search recovered the per-card booking selection
from its retained successful HTML (`data-gs`) and coherent flight identity. Its
remaining partial finding is lack of a distinct recorded one-way input case,
not continued absence of the selection. Root offline inspection confirms one
important comparability detail for SF-03: decoded requests 206 and 245 differ at
inner path /1/2 (2 versus 3), and the researcher identifies this as trip mode.
Do not describe 245 as an exact one-way replacement without resolving that
difference; earlier Flights 4 reader reasoning only named route/date equality.
This is an audit concern, not yet a demonstrated parser failure. The master
retains authority to narrow the scope or justify a comparable recorded operation.
Calendar follow-up is now executing three existing recorded windows; no new
route or date challenge is supplied by the operator.


Flights 5 booking at 41 minutes confirmed another SF-04 dependency hazard. It
used the current run's coherent search card, but a new consumer navigation minted
a different opaque data-gs value; an exact DOM token match timed out after 91.829
seconds. A deliberately fixed first-card diagnostic then returned positive
booking data in 6.222 seconds. The agent correctly treats this as diagnostic, not
proof that selected_flights controls selection. It is testing a same-record
stable flight identity derived from the token, while acknowledging the remaining
hard-coded route/date context. Do not share browsers across tools to hide this
contract gap. The final compiled producer/consumer chain must prove its public
selection representation using fresh output.


## Flights 5 stop and next checkpoint

Flights 5 stopped after the master accepted zero-parameter flight search for
SJC–SAN on 2026-10-15 and four literal grid window combinations. This would not
establish the intended reusable MVP. The research instruction mixed a fixed
recorded-case policy with a broad contrast requirement; lack of another example
was treated as a reason to freeze otherwise grounded fields. The next prompt
correction requires recorded field meaning, actual parameter use through coupled
request state, and returned record attributes or independent effective settings
together. Missing contrast alone is a coverage limit. Ambiguous field meanings,
echo-only proof, ignored inputs, stale coupled state, and unsupported bounds
still require repair. The master can reshape inputs around the working method;
it must also choose a mode with comparable captured response bodies up front.
No new test cases or site-specific decision rule are introduced.

The prepared URL-context cache fix and per-predicate capture diagnostics were
applied only after all Flights 5 owned processes exited. Existing exact matcher
selection is unchanged, and original cache data is not deleted. The cache
regression reproduced A→A→B incorrectly returning A, then passed A→A→B→A with
two mints after isolation. Diagnostic regressions distinguish URL, method, and
resource-type mismatches without selecting another response; redaction bounds
still pass. An earlier scratch browser-form test timed out while the teach was
active; its failed result is retained and the complete suite is now rerun with
no active teach.

Operator-stop evidence is in `flights-5/operator-stop.json`. SIGINT stopped the
children, but the remaining Bun parent needed SIGTERM; exit -15 at 48.144 minutes.
Cookie/CDP errors after cancellation are operator-induced, not an ambient outage.
The root trace did not close, so unflushed tail usage is unknown. Reported usage:
11,894,681 input (10,102,272 cache reads), 121,334 output, zero writes reported,
$13.6372248 estimated base API cost, and one observed span without usage. Five
attempts total 51,915,741 input (40,529,280 cached), 736,929 output and $76.496136
reported base API equivalent, excluding unreported usage and surcharges.

Checkpoint checks: the complete suite passed 1,988 tests and found one stale
prompt-wording assertion. After updating that assertion, all seven tests in its
file passed; the 139 focused prompt/evidence tests also passed. Both new runtime
regressions passed in the complete suite, including the browser-form test that
had timed out during the scratch run. Lint, type checking, diff whitespace,
website build and 1440/390px visual inspection passed. The existing bundle-size
warning remains. No fresh live result is implied by these checks.
