# Fresh-teach failure ledger

## Current work — September 22 implementation completion

Flights 19 on `fd153b8` ended at its 90-minute deadline with zero published tools
and no audit. The [retrospective](teach-flights-19-retrospective-2026-09-22.md)
records time, accounting and the unresolved producer-context failure. Implementation
is continuing before another fresh teach. The user explicitly superseded the
five-round cap and static-worker fallback: Codex native agents own concurrency.
No cron, MR, push or evidence deletion.

## Historical status — September 21 analysis checkpoint

The user requested continued fresh teaches on September 20 (PDT), superseding the
previous campaign stop. The goal is a working four-operation Flights teach and
strict independent audit, followed by an unchanged-code repeat and Hotels validation.
Keep each teach at a 30-minute target, assess at 60 minutes, and enforce 90 minutes.
Audits retain a 45-minute limit. No recurring automation, MR, push or merge.

Twelve attempts in this September 21 campaign have ended unsuccessfully (five
operator stops, five natural failures and two 90-minute deadlines). Flights 12
on `753e6ab` ended at 69.380 minutes with no published tools. All four researchers
returned proven, including booking from freshly selected current flights. The
master correctly found that the producer value lacked full itinerary context
and booking retained recording literals. Its proposed contract repair then
failed strict output validation twice: first an invalid decision wrapper, then
previously unreported nested follow-ups that omitted instruction and used
suggestedExperiments. The whole teach terminated. No independent audit ran.

No teach is currently running. The latest user request is a research deep dive
and local evidence dashboard. The [research report](teach-research-deepdive-2026-09-21.md)
records measured turn-level costs and the smallest correction candidates.
No runtime or prompt changes were made during that analysis. Twelve attempts
report $211.6927424 in base API equivalent; missing usage remains excluded.

All local evidence remains under
`~/.imprint/experiments/reteach-systemic-2026-09-21/`. The collector is on
127.0.0.1:6443. Latest preflight: AC power, 100% battery, 17 GiB free, original
recordings intact. No disk exhaustion, sleep, or network loss has been established
as the cause of these twelve unsuccessful attempts. No prior generated tools enter teaching.
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
| SF-02 | Evidence formatting consumes the verification budget | Recurred in Flights 4: seven quotations exactly matched original raw strings, but only two of nine matched their extra-escaped JSON wrapper. The reader reached its final turn with grounded facts and was rejected. `d424359` accepts exact citations in either representation; synthetic regression fails before and passes after. | Flights 7 reached completed raw reviews: location/calendar passed, search was rejected for actual parser loss. Literal-citation repairs still occur. Do not widen budgets or waive raw-source citation checks. |
| SF-03 | Verification accepts an unrelated live request | September 20 calendar saved-response check passed parser fidelity despite an unnecessary date change. Explicit comparability assessment now rejects it; unchanged location input passes. | Track recorded/live input relationships at planning and review. Repair the selected pair without inventing new cases. |
| SF-04 | Result membership or component identity is lost between raw data and output | Historical Flights 53 duplicated repeated frames; September 20 Flights 2 omitted other result groups and connecting options. Earlier 52 constructed a consumer selection from only part of a composite record. These are confirmed recurring artifact defects, not one universal parsing rule. | Check whether the compiler sees all selected raw bodies and actionable independent feedback. Repair its existing fixed cases; do not prescribe first-frame selection, concatenation, deduplication or a site-specific mapping in runtime. |
| SF-05 | MVP verification and strict audit require different coverage | First isolated refine repair passed its raw checks and two identical calls, but strict audit could not establish the query parameter. Selecting distinct existing recorded queries made repair and extension pass. September 21 Flights 1 repeated the single-query plan despite a variable query contract. Stopped early to correct contradictory planner guidance and upstream evidence pruning. | If teach repeats this gap, align case-selection guidance with strict audit using the same fixed recorded set. Preserve unverified coverage rather than weakening the audit. |
| SF-06 | Small metadata changes trigger expensive research again | September 20 Flights 2 repeated booking research after a description/path correction. Code hashes the entire candidate; its workflow includes parameter descriptions. Exact proof binding is useful, but can invalidate more than executable request behavior. One concrete observation; general recurrence not yet established. | Record what changed, which proof was invalidated and elapsed rework. Consider separating execution identity from explanatory metadata only if a reproducer shows needless reproof without weakened semantics. |
| SF-07 | Browser interaction waits dominate despite available evidence | September 20 Flights 1 repeatedly waited about 60 seconds on guessed selectors; historical 48 had missing click targets while result markup existed. There are multiple possible causes, not proof that setup can be skipped. | Inspect navigation/capture/action timestamps and selected conditions. Keep bounded cold-start behavior; change only a reproduced mechanical wait or evidence delivery defect. |
| SF-08 | Minimizing execution also prunes verification evidence | September 21 Flights 1 discovery supplied ten location requests, but the master kept only [63,69]. Focused evidence is mechanically filtered to this pool, so the planner could not select contrasting recorded queries. | Clarify that candidate requestSeqs is an evidence pool, while research determines the minimum executed graph. Preserve a small selected set of recorded contrasts and representatives; fresh validation pending. |

| SF-09 | Boundary refresh overwrites same-run research history | Confirmed Flights 2. Fixed in `dce493a`; later runs retain full private observations and forward bounded history. | Watch boundary-changing follow-ups; old observations must never prove a changed candidate. |
| SF-10 | Missing recording fixtures are detected only after compilation | Flights 2 failed here. `dce493a` gives planning body availability and checks fixture references; Flights 3 demonstrated early rejection. | Preserve the guard and let agents choose comparable completed captures. |
| SF-11 | Generated request construction changes nested array structure | Calendar in Flights 3/4 and booking in Flights 3; recurred in Flights 10 and in both search and calendar in Flights 11. Template-preservation prompt guidance did not prevent it. | Reuse the existing bounded body comparator in research diagnostics to expose structural differences after preparation. Implemented with regression and bounds checks; fresh validation pending. |
| SF-12 | Bootstrap cache ignores changed URL context | Flights 3 and Flights 5 retained a homepage jar/HTML after changing bootstrap to search. CDP browser pool does key on URL; disk jar cache does not. | Fixed in `760e3b4`; Flights 6 validated separate snapshots for distinct bootstrap URLs. |
| SF-13 | Master invents comparisons outside the recording | Flights 3 requested another route/date. `5d7b2be` clarified the existing fixed-case policy; Flights 4 master explicitly kept the recorded route/date. | Track actual inputs, not just compliance prose. |
| SF-14 | Inspected evidence and observations disappear at agent handoffs | Flights 3 lost completed search response 245 during follow-up; proven/partial handoffs also omitted observations. Fixed in `5d7b2be`; Flights 4 retained IDs 245/295, selected fixture 245 and repaired a bad capture matcher from history. | Fresh continuation evidence validated; still watch later boundary changes. |
| SF-15 | Invalid focused planning terminates the whole teach | Flights 3 and Flights 8: an unavailable fixture or malformed proposal becomes fatal after one local repair. | Return exact validator diagnostics to the master alongside valid siblings. Preserve retained planner history and reject invalid proof. Regression reproduces the old failure and passes through initial and repair planning; fresh validation pending. |
| SF-16 | One verifier status conflates raw-fact readiness and parser correctness | Flights 4 location supplied complete facts and matched calls, then prematurely marked itself unverified. `d424359` clarifies omission of status for sufficient raw expectations; explicit gaps remain unverified. | Flights 7 readers supplied raw expectations and reached actual parser evaluation; preserve explicit uncertainty. |

| SF-17 | Fixed-case verification turns into fixed-constant tools | Flights 5 removed every search input and restricted calendar to literal recorded windows, although search route/date mappings were grounded and the working calendar method could expose a different input shape. | Clarify coverage versus mapping support; require recorded meaning, actual construction, and independent result evidence together. Preserve ambiguous/no-op failures. Validate fresh, without inventing cases. |
| SF-18 | Consumer cannot inspect retained sibling raw bodies | Flights 6 booking received the producer observation but result inspection only searches its own history. | Track recurrence; a same-run read-only source lookup must remain separate from candidate-proof eligibility. Not implemented. |
| SF-19 | Pre-action readiness confused with post-action completion | Flights 6 booking waited for a URL that its unexecuted clicks would produce, three times. | Fixed in d131a54 with zero-click regression and phase guidance. Flights 7 completed booking research without recurrence. |

## Later systemic findings — current status

| ID | Finding | Current status |
| --- | --- | --- |
| SF-20 | Each live case rereads unrelated recorded fixtures | Explicit pairs now select only their recorded response chain (3a61e14); exercised in Flights 9. |
| SF-21 | Artifact-only repairs unnecessarily replan | Existing direct compiler-recall guidance moved earlier; continue measuring actual revisions. |
| SF-22 | Repeated full handoffs exhaust master context | Changed-handoff delivery in 28f128e exercised in Flights 10; unchanged research omitted, no overflow. Focused inputs still reached 577k characters. |
| SF-23 | Speculative draft completion delays blocked-research review | Flights 9 and 10 measured delays of about 3.5 and 5.5 minutes. Unchanged; later draft reuse must justify the cost. |
| SF-24 | Saved dependent verification cases run before fresh primary producer calls | Observed in Flights 9; age versus browser context was not isolated. Repaired cold capture worked. Unchanged. |
| SF-25 | Focused planning unnecessarily follows execution dependency waves | 5d5a770 overlaps independent planners at two workers; regression retains producer-first compilation. Flights 11 stopped before final planning; live overlap validation remains pending. |
| SF-26 | Master chooses initial parameter contracts without underlying request quotes | Code inspection: retained discovery input gives candidate/advisor summaries and evidence counts, with no cited raw entries. Repeated wrong-mode choices in Flights 9/10 required later research repair. Candidate for better evidence delivery, not yet implemented or isolated as the sole cause. |
| SF-27 | Turn completion at the watchdog boundary causes duplicated work | Flights 11 rollout completed at 297.969 seconds, host watchdog fired at 300 seconds, retained retry took 238.29 seconds. Completion-handling candidate; no confirmed network outage or SDK hang. |
| SF-28 | Tested partial producers cannot be invoked by sibling researchers | Controller exposes only proven handoffs/results through call_producer. Flights 12 search returned live outbound records but lacked return-date proof. Watch whether this prevents downstream research from supplying that proof; no change or deadlock claim yet. |
| SF-29 | A later request failure loses the complete earlier response | Fixed in c4898d5: each response is retained immediately with attempt/backend/request identity. Flights 15 retains failed 400/protocol-error bodies across execution rungs. Synthetic downstream-failure regressions pass. Complete teach reliability remains unproven. |

## Code-path observations to test, not established failures

- The original all-fixtures-per-case concern became SF-20 and was repaired in
  3a61e14. Continue checking that selected recorded/live pairs actually match;
  filtering fixture delivery does not establish their semantic comparability.
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
| September 21 Flights 6 | 760e3b4 | Operator stop after 44.109 minutes; 0/4 published | Setup-URL isolation and repairable handoffs exercised successfully; SF-01 vague schema diagnostics and SF-19 pre-action waits blocked completion. $11.6595168 reported; one span missing usage. |
| September 21 Flights 7 | d131a54 | Deadline at 90.019 minutes; 1/4 published (calendar) | All research and fresh research chain proven. Location identifier meaning and search result loss rejected; retained repairs completed too late for rechecking. $40.8916328 reported; two spans missing usage. |
| September 21 Flights 8 | 3a61e14 | Natural failure at 46.136 minutes; 0/4 published | All research proven; missing response 206 rejected, then SF-15 killed planning. SF-10 availability was absent from discovery. $14.631096 reported, no missing usage spans. |
| September 21 Flights 9 | fddd4ec | Natural failure at 78.954 minutes; 2/4 published | SF-22 context overflow after SF-04 search parser rejection; repaired cold continuation succeeded. $24.5983104 reported; one failed model span lacks usage. |
| September 21 Flights 10 | 28f128e | Deadline at 90.012 minutes; 0/4 published | Context dedup exercised; wrong capture substring, nested request reconstruction, producer-stage drift and serial/repeated planning consumed the budget. $19.596328 reported; one deadline span lacks usage. |
| September 21 Flights 11 | 5d5a770 | Operator stop at 70.384 minutes; 0/4 published | SF-11 in search, calendar and fresh booking continuation. Calendar direct calls became empty; page-owned initial grid worked. SF-27 watchdog duplicate. $11.7279648 including one recovered provider usage record; one cancelled span still lacks usage. |
| September 21 Flights 12 | 753e6ab | Natural failure at 69.380 minutes; 0/4 published | All four research reports proven, but master found missing itinerary context. Its contract repair used invalid follow-up fields after one repair and terminated the teach. $12.0917576 reported; no missing usage spans. |

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


## Flights 6 in progress on 760e3b4

Started 11:04:23 UTC in `flights-6/home`; 19 GiB available, AC power and
process-bound sleep prevention verified. Target 11:34, assess at 12:04, hard
stop at 12:34 UTC. Exact recording and four-operation guidance are unchanged.
Initial discovery retained all four operations and reusable input fields.
However, the master again chose the 206→218 path while retaining 245/256 as
contrasts. Its compact evidence explicitly has no responseBodyLength for 206
and 51,286 bytes for 245; this initial choice is not caused by missing metadata.
Research/final planning must resolve mode comparability before claiming proof.
Location first research returned New York data and deferred other recorded
queries; inspect final selected verification cases before claiming coverage.
No final tool or live validation pass is established at this checkpoint.

Private `flights-5/model-stage-timing.json` records 58 research model calls and
2,146.13 summed model seconds. Calls overlap, so this is not additive wall time;
compiler and interrupted tail usage may be absent from that role breakdown.
Accounting remains in `accounting.json` with its separate completeness caveats.

At 21 minutes, Flights 6 first-pass research finished: location proven, search
partial for the booking-selection representation, calendar partial for ignored
window bounds, and booking blocked pending fresh producer data. Search kept
reusable route/date fields grounded by construction and returned record attributes;
it did not freeze them merely for missing contrasts. Calendar explicitly detected
that its initial successful capture ignores the four claimed bounds.

The URL cache fix exercised real changed setup context: calendar's homepage
snapshot (345,917 characters) and Flights-page snapshot (2,047,486 characters)
were minted separately under two URL hashes. Search's capture timeout included
the new predicate diagnostics. Its matcher still had a slash/dot mistake, but
it switched to rendered HTML after the observed page showed results without a
captured shopping response; do not claim the diagnostic proved the cause or
that the agent repaired this matcher. Calendar used the correct matcher on its
first capture and returned the raw grid after 33.923 seconds of cold execution.


Flights 6 at 28–31 minutes reproduced malformed advisory handling: search
returned inspect_result fields at the root, omitted binding, and asked for a
12,000-character slice (the contract maximum is 2,000). The repair supplied
binding but omitted resultQuery. The controller returned the validation failure
and actual observations to the master instead of terminating the whole teach.
This exercises the earlier 60392ef protection, without accepting invalid proof.

A separate evidence-access limitation emerged: booking requested read-only
inspection of the successful sibling search observation. The validator searches
only the current researcher's observations, so it reported no retained result
text even though the search body exists on disk and its sibling handoff names
it. Search must currently inspect its own body and forward slices, or become a
callable proven producer first. Track this as SF-18: sibling raw evidence cannot
be independently inspected by the consuming researcher. A possible small
correction is a read-only, same-run source lookup distinct from proof eligibility;
do not merge sibling observations into the consumer's candidate-proof history.
Not implemented. Search's saved successful HTML contains 60 data-gs attributes,
so its claim of a missing representation is not yet an established absence.
The attributes' semantics and complete record pairing still require proof.

At 31 minutes calendar's narrowed route/selected-date contract was re-executed
and reported proven. Location remains proven. No tool has passed final MVP
verification or independent audit in this attempt yet.


At 35 minutes, search independently found the live row's data-gs selection and
paired flight identity in retained HTML. Its proposed retest then failed schema
validation before execution: site was google.com rather than the current site
id, and requestTransformModule was absent despite requestTransformSource. The
repair diagnostic only said “wrong site” and “source and module must be supplied
together”; the repair guessed a URL as the site and still omitted the module.
This is recurring SF-01 protocol drift amplified by underspecified feedback.
A two-message correction is prepared privately as pending-research-diagnostics.patch,
not applied to this active run. It supplies the expected site id and exact module
field/path. A targeted synthetic check fails before and passes after (48 assertions),
and type checking passes. No validation predicate or proof rule is relaxed.

At 40 minutes, booking confirmed cross-navigation token rotation, then changed
the diagnostic to stable complete flight identity. Both initial token-based and
first identity-selector attempts timed out (91.645 seconds cold, 60.229 warm).
Subsequent source inspection corrected this initial diagnosis: these were
pre-action URL readiness waits, so none of the proposed selectors executed. The same failed attempts remain in its research history.


## Flights 6 stop: readiness phase confused with post-action completion

The booking navigation set urlIncludes to the booking page, then declared clicks
that would reach it. The runtime checks page URL/selector/cookie conditions before
executing actions. Therefore all three timeouts happened before any click target
was even evaluated. Changing the selector could not fix them. This is SF-19:
readiness phases are exposed as nearby fields without sufficiently explicit
ordering, and the timeout hides whether actions started. It is not a selector
failure, internet outage, or insufficient cookie wait. The earlier selector
interpretation above is corrected by this execution-order evidence.

The checkpoint keeps runtime ordering and deadlines intact. It adds the factual
pending-action count to this timeout and clarifies pre-action URL/selector/cookie
versus post-action resultSelector in research, planning and compiler guidance.
A synthetic CDP regression reproduces the same final-URL-before-click deadlock;
old diagnostics fail its assertion. The two prepared schema diagnostics now name
the expected site id and exact transform-module field/path. No proof is waived,
no site-specific rule is added, and no browser state is shared across tools.

Stopped cleanly with SIGINT, exit 130, at 44.109 minutes. Process group exited
before code/prompt changes. No published tools or audit. Location and narrowed
calendar were research-proven; search had real results and discovered its live
selection attributes, but schema errors and dependent readiness waits prevented
completion. The prior malformed-handoff protection demonstrably returned actual
history to the master, which identified the error and requested repair.

Flights 6 reported 7,342,468 input (5,554,432 cache reads), 114,280 output,
zero cache writes reported, and $11.6595168 base API equivalent. Root trace closed;
one analyze span lacks usage. The six attempts total $88.1556528 reported, with
five observed missing-usage spans and the earlier interrupted tail still unknown.
Original failed calls, research snapshots and stop reason remain in flights-6.

Checkpoint validation: 172 focused tests passed (987 assertions), including the
pre-action deadlock and exact schema-diagnostic regressions. Type checking, lint,
diff whitespace, website build and 1440/390px visual inspection passed. The
existing website bundle-size warning remains. No live pass is implied.


## Flights 7 in progress on d131a54

Started 11:52:40 UTC with unchanged recording/guidance in flights-7/home.
18 GiB available, AC power, collector and process-bound sleep prevention verified.
Target 12:22, assess at 12:52, hard deadline 13:22 UTC. Code/prompts remain fixed
through the run. Fresh validation must show correct navigation phases and exact
schema repair, then final parser checks, audit and unchanged-code repeat.

Private Flights 6 timing records 39 research model calls (1,607.98 summed seconds),
three master calls (386.71 seconds), and one planner call (82.11 seconds). These
overlap and exclude compiler time, so they are not additive wall-clock phases.
SF-01 architecture watch: repeated full request-object reconstruction across
retained turns invites site/module/schema drift even when only a selector changes.
Exact diagnostics are the small current fix. Referencing a stored tested candidate
could reduce copy errors later, but any such protocol change must preserve exact
proof binding and is not implemented in this checkpoint.


Flights 7 observations through 30 minutes: the master selected staged round-trip
search, booking by a selected tfs/tfu query, four-input calendar, and location
lookup. Search inspected completed round-trip request 194 (68,045 recorded body
characters), then captured about 119,600 live API response characters. It kept
non-empty selected_flights unproven because the initial transform rejects it;
the master explicitly requested fresh outbound selection, return-stage execution,
and the exact completed selection query required by booking. The fresh capture
was repeated successfully before attempting continuation.

Location initially put testCases inside candidate and omitted parameterValues.
The repair corrected that structural error, then the next validation stage found
the absent transform module. This illustrates sequentially exposed schema errors,
not an API failure. The master used the new exact module diagnostic; its retained
researcher repaired the candidate and executed a successful two-request New York
lookup in 445ms, grounding entity metadata from the first response's identifier.

Calendar repaired another slash/dot matcher mismatch and captured a populated
API grid in 2.393 seconds warm. Booking first encoded an entire selected query
as one URL key (a 76.308-second cold failure), then used a transform to preserve
query-field boundaries. It returned positive one-way and round-trip booking data
in 1.703 and 1.411 seconds warm. Those used recording-backed selections, so they
do not replace the still-required fresh generated producer/consumer chain.
The earlier pre-action URL/click deadlock has not recurred so far; this is not
yet a completed teach or independent audit pass.


By 34 minutes Flights 7 had four research-proven operations. Search's final
shared candidate passed empty and non-empty selected_flights branches; the latter
used a same-record option token, serialized identity and segment tuple from the
immediately preceding fresh response, then returned the correct return-stage
options. The repeated empty branch completed in 2.195 seconds warm, continuation
in 3.554 seconds. Research retained inspected request 194 across follow-up.
The final compiler and fresh generated-tool chain still need to prove the emitted
continuation and booking scalars; research success is not publication or audit.
One capacity_or_overload interruption during master review was retried inside
the existing run deadline, preserving the run and all evidence.


At 49 minutes the master accepted all four plans and explicitly repaired the
fresh chain. Search's focused proposal had generic options while booking expected
return_options[0].booking_selection; the master requested outbound_options,
return_options and route/date outputs, five bindings into a named return_search
invocation of search_flights, then booking bound to that invocation. Finite repeated
tool invocations are already supported; no runtime self-call limitation is claimed.

Removing unused location dependency evidence caused a search research refresh.
The researcher reused five saved observations without another network call. This
is not the old description-only invalidation: apiResearchInputsSha256 excludes
descriptions, while its fallback coverage also checks request-provenance membership.
Booking's refresh, by contrast, addresses a newly explicit incoming fresh-value
obligation and is legitimate additional proof. At 51 minutes it called the proven
search producer for an initial result (36.493 seconds cold), then continued it
with fresh selection data (2.638 seconds warm), using isolated producer state.
Final generated-tool verification remains outstanding.

SF-01 follow-up option: the installed Codex SDK exposes outputSchema, while these
advisory roles currently return unconstrained JSON and undergo post-hoc parsing.
Schema-constrained output could remove structural drift without weakening the
existing semantic/proof validators. This is recorded for a bounded investigation,
not implemented or assumed compatible with every current refined schema.

At 56 minutes the fresh research chain completed: initial search, return-stage
search and booking all used newly returned values. Booking completed in 3.128
seconds warm. At 58 minutes the master accepted that complete chain and requested
no further research. Final focused planning and compilation continue under the
original 90-minute deadline. No published-tool or audit pass is implied.

Flights 7 reached final compilation at 62 minutes. Location completed in about
four minutes; search repaired a generated syntax error within its retained
compiler conversation and completed in about seven minutes. Calendar reused
its same-run draft and completed in about three minutes. The compiler already
has compare_rendered_requests and search used it; SF-11’s proposed earlier
request-construction diagnostic concerns research, not absence of this compiler
tool. At 70 minutes all first-wave artifacts reached final live verification.

At 75 minutes the location raw-response review passed after correcting one
nonliteral citation. The subsequent semantic review correctly rejected the
artifact: JFK/LGA related-airport rows expose the same New York locality id as
if it were an airport entity id. Recorded/live parser agreement establishes
extraction fidelity, not the semantic meaning of an unlabeled identifier. This
is a generated-output meaning error, not connectivity or citation infrastructure.
The narrow repair is to omit or correctly label the unproven member; the current
master should choose that repair from its actual review feedback. Search live
execution then completed in 34.258 seconds cold before its raw-response review.

At 80 minutes search verification rejected concrete result loss: initial output
contained 5 of 18 eligible options; recorded continuation contained 1 of 5, and
live continuation 2 of 5. The parser selects one collection and filters the
first segment’s destination against the final destination, dropping connections.
This recurs despite existing completeness guidance. Do not add another generic
prompt reminder. Preserve missed raw records, frozen expectations and parser
output in the retained repair conversation. The raw reader also spent two
inspection calls on the initial replay fixture during a continuation live review;
all replay fixtures are currently supplied for every live case. A mechanically
matched fixture set could remove duplicated work without reducing fixed coverage.

At 82 minutes calendar passed both reviews and published: exactly 49 unique
date pairs, prices/currency/flags and same-record selections verified. Location
and search remain rejected, booking is blocked behind search, and the master
is revising from those factual failures. This is not a four-tool teach pass.


Flights 7 ended at its 90-minute deadline (90.019 minutes, exit 1). One of four
tools published; no audit ran. Location finished its retained compiler repair in
2:22; search reached its deterministic handoff in 3:10, but the run deadline
interrupted its final completion message before live rechecking. The master spent
113.5 seconds producing the repair decision, planners spent 56.9/96.1 seconds in
parallel, and the following master acceptance delayed compiler restart until
13:19:28 UTC. API research did not repeat for these parser-only failures.

SF-20: every live-case review included every replay fixture. Search's continuation
review spent two inspection turns on the unrelated initial-search recording.
The small correction filters fixtures by the explicitly selected case's exact
ordered response sequence. Each selected live case still runs; unmatched evidence
still fails, and unbound chain calls retain the full set. A synthetic regression
fails before the correction and passes after, including order and missing-body
handling. No source semantics or result-membership rules enter the runtime.

SF-21: artifact repair unnecessarily revisits focused planning. Search's accepted
contract already required complete collections, but the master restated that
requirement in a changed plan instead of recalling its retained compiler directly.
The prompt already explains recall versus contract changes, near line 525. Move
that existing instruction near the front rather than adding another rule. Agents
still decide whether the contract actually needs revision. Location's optional
identifier claim may legitimately need a contract correction.

Flights 7 reported 21,671,276 input tokens (14,084,992 cache reads), 245,625 output,
zero reported cache writes and $40.8916328 base API equivalent. Two analyze spans
lack usage; the root closed. Seven attempts total $129.0472856 reported, with
seven observed missing-usage spans and the earlier interrupted tail still unknown.
The evidence remains private under flights-7. Disk remains at 18 GiB free.


Retained-byte inspection after the run confirms the final repair artifacts now
return 18 outbound, five recorded-return and five retained-live-return records;
location emits locality_entity_id for related airports. This is an offline count
and label check, not a fresh live or independent audit pass. Private helper:
check-flights7-repair.ts. No generated artifact enters the next fresh teach.

Checkpoint checks: 234 focused tests passed with 1,446 assertions; type checking,
lint and diff whitespace passed. Website build and 1440/390px visual inspection
passed (existing bundle-size warning only). Fixture-selection regression failed
on old code and passes after the small change. Next: fresh flights-8 with the
same original recording, four-operation scope and 90-minute hard deadline.


## Flights 8 in progress on 3a61e14

Started 13:28:44 UTC in a new flights-8/home, original recording and four-operation
scope. Target 13:58, assess 14:28, hard deadline 14:58 UTC. AC/100%, 18 GiB free;
collector and process-bound sleep prevention remain active. Code/prompts stay fixed.

Flights 7 timing deep dive is retained in model-stage-timing.json. Research:
35 calls, 2,182.48 summed model seconds; master: 10 calls, 1,240.13 seconds;
focused planning: nine calls, 751.10 seconds; raw evidence review: 15 calls,
555.61 seconds. These overlap and exclude compiler time; they are not additive
wall-time phases. Two raw-inspection turns addressed the initial fixture during
continuation review, supporting the paired-fixture correction.

SF-22 watch: oversized repeated evidence handoffs. Measured later master prompts
were 305k–414k characters. The final four research histories occupy roughly 248k
JSON characters, dominated by successful raw previews (about 154k characters)
and response observations (about 55k), before candidates/current observations
and the accepted plan are added. Most later master calls reported only 0–12k
cached tokens despite hundreds of thousands of input tokens; cache behavior or
compaction causality has not been established. The SDK's 80k compaction setting
is a hypothesis to investigate, not a proven fault. Trace prompt contents are
capped at 50k; pre-truncation lengths and provider token totals remain available.
A possible bounded follow-up is to send only changed handoffs to the retained
master while preserving the full stored history and full validation input.
Do not erase failed observations or assume a short preview proves semantics.
No handoff compression/protocol change is implemented during Flights 8.


Flights 8 at 12 minutes: location has a useful autocomplete call for recorded
query san, but correctly marks coordinates unproven and offers narrowing or a
fresh derived detail request. Search repaired a 61.160-second capture timeout:
the loaded page contained 20 results, while its endpoint matcher used a slash
where the observed URL uses a dot. Corrected capture completed in 2.579 seconds
warm. This is SF-07 recurrence, not demonstrated connectivity loss.

SF-03/SF-10 watch: the initial master chose a one-way search from requests 206/245.
Original event 204 says One way; event 243 says Multi-city. Request 206 lacks a
response body; 245 has 51,286 body characters and a different mode value (2 vs 3)
while both have one leg. The researcher proved the 206 one-way construction, so
it still needs a genuinely comparable recorded fixture. The master’s initial
retained-conversation projection includes candidate summaries and evidence counts,
but not the body-availability list supplied later to focused planners. Inspect
whether that missing early factual context causes late mode repair; do not assume
an agent can obey an early body-selection instruction without those facts.
No code change is made during this run, and it has not yet failed on this issue.


Flights 8 at 31 minutes: the master removed optional coordinates and relative-price
classification. Location was reclassified proven from the exact saved successful
candidate without another network call. Calendar tried a two-navigation diagnostic
(document context, then API capture); its second navigation failed after 93.841
seconds total, with no matching grid request. The failure’s page diagnostic showed
San Jose SJC, San Diego and the exact route/date tracking label. Research retained
the previously successful single-navigation candidate and cited that diagnostic
as contextual route evidence. This does not validate the failed two-navigation
method or establish warm repeatability. Final fresh tool checks remain necessary.

Booking’s first fresh-token POST and direct booking URL attempts failed; a
same-session first-result click then captured actual fare data in 9.012 seconds.
It correctly remained partial because selection_token did not drive that click.
The master requested a current non-first producer record and a construction that
actually consumes its identity. Browser sessions remain isolated by tool; sharing
a producer session is not accepted as the repair. A fresh producer call completed
in 41.456 seconds cold during this retained follow-up.


At 36 minutes booking proved selection of the second, fresh WN4341 itinerary,
then correctly remained partial because its search scope was hardcoded. The
master added origin, destination and departure_date alongside selection_token,
without inventing another route/date case. The retained researcher rebuilt both
navigations from those inputs and retested in 36.290 seconds cold. At 40 minutes
all four research operations were proven, with eight retained booking observations.
This is request-level proof; comparable recorded search fixtures and final generated
tool verification remain unresolved. No publication or independent audit yet.


At 43 minutes focused search planning chose recordedCall [245] for both replay
and live verification while retaining the proven one-way construction from 206.
Its freshnessChanges mentions route/date preservation and refreshed browser state,
prices, ranking and tokens, but does not address the different recorded mode.
The selected recording also has request 235 in one-way mode, with no response body;
there is no completed one-way GetShoppingResults response in this recording.
Whether the single-leg multi-city response is semantically comparable must be
established, not assumed merely because the route/date coincide. The independent
review is still pending. Initial master evidence should expose body availability
early enough for agents to select a verifiable mode before research.


## Flights 8 terminal findings and next correction

Natural failure at 46.135509 minutes, exit 1. Exact planner diagnostics are in
`flights-8/run.log`; all retained research and trace evidence remains private.
All four operations reached proven research status. Booking used fresh search
output and correctly selected a non-first matching flight; this does not prove
that generated tools work. No tool was published and no audit ran.

The recording's selected one-way shopping requests have missing bodies. A later
completed single-leg multi-city response was chosen as search's fixture without
explaining the trip-mode difference. Booking instead referenced the missing
one-way body in its parser response chain. Comparable route/date alone does not
establish comparable modes. Keep SF-03 open. SF-10 must expose captured-body
availability before discovery chooses the MVP, not only at focused planning.
SF-15 recurred: exact rejected-output diagnostics should reach the master, which
can revise the mode/evidence choice; runtime must not invent that strategy.

Reported usage: 6,231,776 input tokens, including 3,572,480 cache-read tokens;
128,246 output tokens; zero reported cache-write tokens; no missing analysis
usage spans. Base API equivalent $14.631096, using the accounting assumptions
above. Eight completed attempts total $143.6783816 reported base equivalent;
seven earlier spans lack usage and Flights 5 has an unknown unflushed tail.
This is not a subscription invoice. No infrastructure interruption caused the
recorded terminal failure. The next fresh run is Flights 9 after validation and
checkpointing the two general corrections.


Flights 9 started at 14:27 UTC on `fddd4ec`, from the original recording in a new
isolated home. Code/prompts are fixed for the run. The input still requests all
four operations, with no previous generated artifacts supplied.

Flights 8 timing deep dive: 43 reported model calls total 3,090.519 seconds of
model time; stages overlap and this is not additive wall time. Prompt-derived
role classification identifies 26 researcher calls (1,840.46 seconds), six
focused-planner calls (524.54 seconds), four master calls (336.24 seconds), plus
discovery/repair calls. Its 18 recorded backend attempts total 481.127 seconds,
including producer invocations retained in booking history. HTTP success includes
application-level error payloads and does not mean semantic success. These totals
show that browser setup alone cannot explain the 46-minute failed run. Private
summaries: `flights-8/model-stage-timing.json` and
`flights-8/backend-attempt-timing.json`. SF-22 remains a measured payload-size
candidate, not a proven cache/compaction cause or an implemented optimization.


Flights 9, first nine minutes: the advisor received the new captured-body list and
explicitly flagged missing search responses before selection. The master chose
completed requests 295/308/317 but mislabeled their multi-city itinerary as round
trip. The researcher read the actual request legs and narration, rejected that
boundary before testing, and returned the factual mismatch for master review.
This is SF-03 caught during research, not an infrastructure failure or proof the
API is impossible. Location autocomplete was proven through direct fetch in
251 ms; no browser bootstrap was required for that first evidence-backed call.


Flights 9, 11 minutes: SF-11 recurred in calendar research. The generated form body
was 695 bytes versus 683 recorded; two unnecessary array wrappers accounted for
the 12-byte difference. Existing post-execution request comparisons let the agent
repair exactly that shape without changing route/dates. The corrected fetch
completed in 272 ms, but HTTP completion alone is not semantic proof. The bad
shape had already spent time across all four backend rungs. A pre-execution
research comparison remains a possible small mechanical diagnostic; it is not
implemented during this fixed-code run.


Flights 9, 15 minutes: calendar research captured the same selected date-grid API
case twice through its retained per-tool CDP session (2.748 and 2.455 seconds,
excluding earlier setup and pacing). Both produced dated fare rows; fresh opaque
values changed. The research is proven, but generated parser semantics and broad
input coverage remain unverified. Booking performed one exact stale diagnostic,
then correctly requested matching fresh final-selection state from the blocked
search producer. The master review must repair that dependency; recording values
have not been accepted as a fresh-chain substitute.


SF-23 (scheduling candidate), Flights 9: all first research passes had returned by
15.04 minutes (location/calendar proven, search/booking blocked). Calendar's
speculative focused plan finished at 16.36 minutes and its compiler then ran,
while the master had not yet received the blocked search boundary. The controller
awaits `onProven` draft work inside the research worker before the all-operation
review. That can delay a necessary master correction behind unrelated speculative
compilation. Preserve the two-worker cap and measure the actual delay before
changing scheduling. This is separate from provider capacity or network setup;
no scheduling change is made during Flights 9.


Flights 9, 20.27 minutes: the retained master repaired the itinerary mismatch by
revising search to a complete encoded leg-list input, preserving the recorded
multi-city operation rather than pretending it was round trip. Location and
calendar boundaries remained unchanged. Booking's follow-up explicitly waits for
fresh matching final-selection output. The master review itself took 99.32 seconds
with a 98,871-character payload. Independent drafts were ready at roughly 18.6
minutes, so the earlier scheduling delay was about 3.5 minutes, with possible
later savings if both drafts are reused.


Flights 9, 23.14 minutes: SF-11 also recurred in search. Four extra location-array
wrappers made the generated body 24 bytes longer than the 581-byte recording.
The first malformed call exhausted four execution rungs, including two roughly
31-second browser setups. The retained researcher used the existing exact
comparison to remove those wrappers; direct fetch then completed in 219 ms but
returned application error 13. It correctly kept semantic proof open and next
compared fresh page/session state with the same request construction. A smaller
possible correction than a new runtime action is to bring the compiler's existing
recorded-template construction guidance into research; assess only after this
fixed-code run, and do not confuse shape repair with a proven API.


Flights 9, 30-minute assessment: not complete, continue because evidence is
improving. Search's parameterized multi-city navigation returned coherent first-leg
choices after 34.458 seconds cold. The same candidate's continuation used a fresh
same-record token and matching first-leg tuple, returning second-leg choices in
3.888 seconds warm. An identical initial-case repeat completed in 1.560 seconds.
Booking and final generated parser checks remain unproven. Disk is about 17 GiB;
no machine interruption or outage is established. Next formal assessment at 60
minutes; retain 90-minute deadline.


Flights 9, 39 minutes: booking switched from semantically empty direct POSTs to
page-owned GetBookingResults capture with a fresh producer token and complete
selected itinerary. It returned both selected flights, fare/provider data and an
airline redirect in 2.160 seconds warm, then repeated the same case in 1.522
seconds. A second fresh selection from the same upstream route/date response
completed in 1.561 seconds; its returned identity is still under researcher review.
This is positive research evidence, not publication, strict audit or repeatability.


Flights 9, 44.82 minutes: search planning selected two explicit matched pairs,
recorded responses 295 and 308, both with captured bodies. Calendar was replanned
at 43.49 minutes after the master added navigation request 618 to its supporting
evidence and rewrote compile context. The early calendar plan already described
that navigation, but its candidate support list was empty, and the exact boundary
reuse check rejected it. This is real extra planning; whether final compilation
can reuse its early artifact remains to be checked. Do not loosen semantic or
provenance binding merely to obtain a cache hit.


Flights 9, 48.73 minutes: final master approval retained four tools in two waves.
Booking's focused proposal guessed `items[0]` producer paths and skipped the
required staged continuation. The master corrected both from the accepted search
contract: `choices[0]` feeds a fresh self-continuation invocation, whose completed
choice then feeds booking. This mismatch was repaired before execution, with no
runtime semantic rule. Location's exact early draft was reused. Calendar's revised
boundary resumed its retained compiler instead of reusing the early artifact;
search began its first compiler. The missing-body fatal failure from Flights 8
did not recur. The new invalid-planner advisory path was not needed in this run's
initial planning; its synthetic regression remains the direct validation so far.


Flights 9, 55.7 minutes: location passed independent raw and semantic checks and
was published (five complete result groups). Search's non-primary continuation
case then received a null shopping payload with wrb.fr error marker 13; the
trailing frame value 131 is not independently established as an error code.
The raw reader correctly marked the case unverified. Offline comparison
(`compare-flights9-continuation.ts`, private) confirms identical parameters,
token and rendered 817-byte body between this failed generated call and successful
research observation 0894600b-70f9-41fd-b6e4-49f6bdee374c. Method, URL, headers and
body template match; only declared request-effect metadata differs. The successful
research call ran at 28 minutes, about 27 minutes before the failed check. Age or
browser context remains unresolved, not proved token expiry.

SF-24 (verification dependency ordering): the controller executes non-primary
live cases before the primary case, using saved literal parameter values. Thus
the continuation failed before this generated tool could make a fresh initial
search, and its explicit self-chain could not establish the fresh dependency.
Investigate whether agent-authored fresh bindings should feed selected dependent
cases rather than replaying research-time opaque values. Preserve both required
case coverage and fresh upstream outputs; do not waive the failing case or simply
retry the same saved token. No run-time code changes during Flights 9.


Flights 9, 58.4 minutes: calendar passed raw-source and semantic review with 49
complete date-pair rows and was published. Two of four tools are now published.
The master is reviewing the failed saved-token search continuation and consequent
booking dependency block. The fix to pair each explicit live case with only its
matching recording chain was exercised: the failed continuation review received
recording 308 alone, and honestly rejected missing live data rather than judging
an unrelated initial-search fixture. Continue to the unchanged 90-minute deadline
because two MVPs passed and a retained master repair is active.


Flights 9, 65.88 minutes: retained research repaired search by changing continuation
from a reconstructed direct POST to page-owned selected-search navigation and
captured request 308. A fresh initial capture took 34.990 seconds cold; the new
continuation returned results in 2.958 seconds and repeated in 1.874 seconds.
All nine research observations are retained. The researcher explicitly limited
its proof to a retained same-tool CDP session; independent-profile continuation
was not tested. This positive repair does not by itself resolve SF-24's saved
verification input lifecycle or isolate token age versus ambient browser state.
Final generated checks are still pending.


Flights 9, 75 minutes: the revised generated search continuation returned 28
choices from a 164,588-character raw response after 34.152 seconds in a cold
browser. The prior generated check had returned zero choices from a 131-character
error response. Its independent raw review is active. This supports the agent's
page-owned transport repair; it does not prove token expiry or show that runtime
case-order changes are needed to make this repaired artifact work. SF-24 remains
an ordering/lifecycle design mismatch to investigate, not a confirmed cause of
this second candidate failing. The run still has only location/calendar published.


## Flights 9 terminal findings and changed-handoff correction

Run f7561b50-265d-42a7-b8b2-ce1b29a35c76 ended naturally with provider context
exhaustion at 78.954 minutes. Location and calendar passed; search and booking did
not. The final search reader correctly found remaining_leg_count zero instead of
one and null aircraft values despite raw labels. These are SF-04 artifact defects.
The repaired continuation transport returned 28 choices after 34.152 seconds cold;
there is no basis to blame this candidate's failure on token age or browser setup.

SF-22 is now a confirmed fatal orchestration problem. The last master payload was
426,590 characters in the trace. Retained turns repeatedly included all unchanged
research handoffs. Exact-content delivery fingerprints now omit only unchanged
handoffs within the same analyzer/run. New and changed handoffs remain complete;
failed delivery does not advance the fingerprints, and self-contained calls keep
full evidence. Current plans, diagnostics and full host validation are unchanged.
No history reset, summary replacement, provider setting or site-specific rule.

Private replay of the full saved master inputs reduced the last input JSON from
427,656 to 76,440 characters (serialization differs from the trace envelope), and
removed 1,556,806 characters across later turns. This measures avoided repetition,
not a live success claim. Evidence: flights-9/master-delta-replay.json and retained
provider rollout, alongside run.log, model-progress.json and raw verification files.

Usage: 16,411,741 input tokens including 12,600,576 cache reads, 215,671 output,
zero reported cache writes, $24.5983104 base API equivalent. One failed context
span has no usage. Nine completed attempts total $168.2766920, with eight observed
missing-usage spans and the earlier Flights 5 unflushed tail excluded. Rates remain
$4/M uncached input, $0.40/M reads, $5/M writes and $20/M output; not invoice totals.

Validation: 331 focused tests and 1,940 assertions passed, including unchanged,
changed, failed-delivery, self-contained and different-conversation/run cases.
Blocked research is still rejected against full input after delivery is omitted.
Type checking, lint, website build and desktop/mobile inspection passed. Existing
bundle-size warning unchanged. Fresh Flights 10 must validate the checkpoint.


## Flights 10 started on 28f128e

Started 15:57:40 UTC with a new isolated flights-10/home, original recording,
unchanged four-operation guidance and 90-minute deadline. About 17 GiB free;
collector confirmed listening. No prior generated artifacts supplied.

Read-only Flights 9 payload analysis also found focused planners receive all
completed sibling research. Calendar's final planner input was 468,538 JSON
characters: its own research was 64,307, unrelated research 226,583 and focused
recording evidence 162,401. Search repair planning reached 500,972 characters.
This is a measured SF-22 extension and potential efficiency correction, not a
proven planner context failure. Private evidence: flights-9/planner-payload-profile.json.
Keep Flights 10 code fixed; agent-selected dependencies and contracts must stay
available if focused delivery is improved later.


Flights 10, early findings: master chose five tools, splitting selection from
search, but again called the 295/308/317 multi-city sequence a round trip. Research
caught this before execution and inspected recorded round-trip search 730.
Location proved both recorded queries and planned explicit 79/707 paired checks;
this is better selected-case coverage than Flights 9's single query.

SF-11 recurred in both search and calendar: each initial handwritten transform
added four endpoint array wrappers (24 encoded bytes). Both exhausted the ladder
before repairing the shape from existing comparisons. Search then hit three
60-second navigation/action waits: pre-search form with no shopping response,
a simplified pre-action selector that did not match, then an exact recorded
selector attempt still pending diagnosis. These are separate request-shape and
browser execution failures, not established disk/network outages. No code changes
within the run. Current public contracts and fresh producer dependencies still
need proof before any publication claim.


Flights 10, 30-minute assessment: continue within the 90-minute limit. Location
has two proven recorded contrasts; calendar has two successful page-owned captures
(3.805s and 2.255s warm) with 49 cells. Search exposes rendered results but not
required reusable selection state and returned partial. Selection and booking
returned blocked, refusing wrong-stage calendar tokens or stale-token proof.
17 GiB free, AC power at 100%; no established host interruption.

SF-23 recurred: all first-pass research returned by minute 28, but master review
waited until calendar's draft finished at 33.53. Its planner took 139.58s and
compiler 236.18s. Location draft finished earlier at 11.77 (105.81s compile).
The delayed review starts with both successful independent drafts available;
track eventual reuse before concluding that disabling drafts would be faster.
Search's actual third timeout followed a successful click and 19 rendered results
but no matching shopping XHR. Calendar's class-only click opened the wrong picker;
inspection of retained HTML found the correct Date grid control. These distinguish
SF-07 response/control selection failures from network loss.


Flights 10, 60-minute assessment: continue to 90 minutes because selection has
isolated a concrete producer-stage mismatch and returned an honest blocker.
Nothing published yet. Search's revised workflow automatically selected the
first outbound and captured second-stage return choices. It was marked proven
at 48.71 despite the downstream contract requiring an outbound token. Selection
used a fresh producer call (34.152s cold), first failed local extraction, then
repaired a malformed request and got null marker [3] with a final-leg token.
At 60.36 it explicitly identified the wrong stage and requested a boundary repair.
This is SF-03/04 contract-stage drift, not evidence that fresh tokens generally fail.
SF-18 also recurred: selection could not inspect an older sibling pre-selection
HTML observation through its own result lookup; retained bytes are not evidence
of accessible inspection. Track this independently from valid proof eligibility.

SF-07 capture diagnosis: wrong literal endpoint substring used a slash where the
observed endpoint had a dot. Latest diagnostic exposed a matching-method/type HTTP
200 response with urlIncludes=false. The agent corrected that substring and got
responses in 3.308s and 3.106s. Earlier failures reported 40/45 total responses but
only their last 12, dominated by repeated log endpoints; 28/33 were omitted.
We cannot establish which responses were omitted from those saved summaries.
A smallest general candidate is deduplicating identical factual endpoint summaries
before taking the bounded tail, preserving counts and exact matcher behavior.
Private evidence: flights-10/search-capture-failures.json and retained provider inputs.
No runtime change during the experiment.


Flights 10, 71.44 minutes: master removed the redundant selection tool and folded
its recorded operation into the tested search workflow. Booking research had
succeeded with a fresh final-choice pair in 2.127s direct fetch, identifying both
flights plus airline link, USD fare and baggage details. No published tools yet.
The changed-handoff correction was exercised: the next master input included
search, selection and booking only, omitting unchanged location/calendar. Saved
input JSON was 284,266 characters; trace envelope 283,324. No context overflow.

At 75.69 the search planner paired round-trip live inputs with recording 308 and
claimed route/dates unchanged. That recording belongs to the multi-city sequence,
so this is an incorrect comparability claim (SF-03), still awaiting master/raw
review. Booking planned record 317 with producer-derived live values. Do not
silently count either claim as a verified matching pair.

SF-25 (planner scheduling): focused planners use execution build waves, although
requestFocusedPlannerBundles creates their inputs from the same initial plan and
does not feed one planner's result into the next. Search took 255.31s (71.44–75.69),
then booking 261.83s (75.69–80.06). Independent planning at the existing two-worker
limit could overlap these calls while retaining actual compile/execution ordering.
This is a concrete mechanical efficiency candidate, not implemented in Flights 10.


## Flights 10 terminal and next bounded corrections

Run 5a792f3c-e0c4-494d-b302-8a8ca07a4234 ended at its 90-minute deadline,
exit 1, while the master reviewed repaired booking planning. This was deadline
exhaustion, not a provider capacity outage. Both early drafts remained unpublished.
The final master at 84.16 rejected booking's added RPC array layer and incompatible
itinerary shape; replanning finished at 86.94. Master input at 84.16 was 52,357
characters with unchanged research omitted, validating the delivery change but
not the overall teach. No independent audit or repeatability pass.

Small next corrections, all general:
- Group identical displayed capture response facts before selecting the bounded
  twelve-entry diagnostic tail. Keep counts, matcher differences and scope facts;
  do not alter response selection, readiness, setup or timeouts.
- Overlap independent focused planner calls at the existing two-worker limit.
  Keep actual compile/execution dependency order. No new concurrency pool.
- Research preserves decoded recorded body templates; planning carries tested
  wire structures and upstream representations through unchanged. Literal URL
  matching guidance names exact observed substrings and false predicate checks.

The two synthetic regressions fail on old code and pass after the fixes. The
planning regression also proves producer-first compilation remains intact.
Comparability/stage drift, sibling inspection access and speculative-draft gating
remain separate known issues; this checkpoint does not claim to repair them.

Flights 10 usage: 11,803,755 input including 8,625,920 cache-read tokens, 171,731
output, zero reported cache writes. $19.596328 base API equivalent, one missing
model-usage span. Ten completed attempts total $187.8730200; nine observed missing
spans and the Flights 5 unknown unflushed tail remain excluded. Rates and invoice
caveats above still apply. Private run.log, model-progress.json, master delivery
profile, capture failures and accounting.json preserve the failed evidence.


Checkpoint validation: 369 focused tests (2,153 assertions), type checking, lint,
website build and desktop/mobile visual inspection passed. Existing bundle-size
warning remains. Preflight for Flights 11: 17 GiB free; original recordings and
all failed evidence preserved. Start with a new home and unchanged recording/scope.


Fresh Flights 11 is active on 5d5a770 in flights-11/home. Original recording,
unchanged four-operation guidance, two workers and 90-minute deadline. New code
and prompts stay fixed. No generated tools or examples from earlier runs supplied.


Flights 11 early findings: the master selected four operations and includes a
coherent round-trip pair, request 139 and booking 154 (both captured, October
15–24), alongside the multi-city evidence. Initial concern about round-trip scope
must not be generalized to this whole selection. Location again proved two
recorded contrasts (airport query and city query).

SF-11 recurred despite template-preservation guidance. Search's handwritten
location helper produced five array levels where request 139 has three. Its
first two candidates exhausted the ladder, adding current bootstrap state without
repairing those extra layers. At 17.58 the researcher isolated the reconstructed
body as the likely problem and switched to page-owned capture. This shows the
prompt change has not solved structural reconstruction. Investigate bounded decoded
structural differences when first-byte differences reflect intentional token/state
removal; do not add site-specific nesting rules. Current run remains unchanged.


Flights 11, 30-minute assessment: continue within 90 minutes. Location and search
research are proven; booking is partial and calendar completed its first pass at
31.28. The corrected calendar body returned three recorded window cases by direct
fetch in 181/209/219 ms, with 49/7/7 date pairs. Route/anchor assumptions remain
explicit gaps. Search matched the exact endpoint on its first capture attempt,
but its selected body missed the 45-second completion budget; unchanged retry
returned the raw response in 18.925s warm. No mismatch substring recurrence there.
17 GiB free, no established outage. No tools published or independently audited.

Read-only synthetic diagnostic check: the existing decodeBodyStructure and
compareBodyStructures helpers report nested array-length and string-versus-array
path differences even when an earlier token is intentionally replaced by null.
Research preparedRequestComparison currently supplies only byte counts and the
first differing byte for bodies. Reusing the existing bounded comparator is a
small factual-evidence candidate if the structural errors keep blocking fresh runs;
it would not choose which differences are intentional or change execution.

Flights 11, minutes 40–49: narrowing search to its proven departing stage reused
the existing observation without another live call. Calendar promoted two hidden
anchor dates to explicit inputs. A local execution of both retained transform
snapshots produces identical 683-byte bodies for the primary case; the workflow
request definition is unchanged. Earlier direct fetch returned 49 date pairs,
but the retest returned HTTP 200 with a null API result and marker [13]. CDP
replay also returned that empty result. This is a semantic live-response failure,
not evidence of disconnected networking; its service/session cause is not yet
isolated. Preserve the distinction from the earlier malformed-array HTTP 400s.

A separate master watchdog boundary issue occurred: the first research-review
answer completed in the Codex rollout after 297.969 seconds (19,888 output
characters), but the host hit its 300-second watchdog. The retry delivered a
202,243-character user payload to the retained session and completed after
another 238.29 seconds. The full answer and task_complete event precede the retry.
This proves duplicated work at the completion boundary, not a network outage or
a confirmed SDK hang. Saved safe event metadata: flights-11/watchdog-session-events.json.
Investigate completion handling before changing global deadlines.

Follow-up scheduling is intentionally serial to expose each repaired producer
to its consumer. Calendar is ahead of booking in the master's ordered follow-up
list, despite no observed calendar-to-booking dependency. That may add delay, but
a correction must preserve causal producer/consumer ordering and the two-worker
limit; the focused-planner overlap fix is a different path.

Flights 11, 60-minute assessment: continue within the unchanged 90-minute
deadline. Current-state query fields and route-specific bootstrapping did not
restore calendar core results. Page-owned API capture then failed after 151.391
seconds because button[aria-label="Date grid"] matched no element within the
agent-selected 120-second action timeout. The page diagnostic showed 19 real
flight results. The generic NETWORK error label must not be read as evidence of
internet disconnection. The selector/capture route provides a concrete next
repair hypothesis; booking's causal proof remains pending. No tools published,
no independent audit, 17 GiB free. Partial accounting at minute 58: $9.0317712
base equivalent, one missing watchdog usage span; this is not final run usage.

A budget-visibility check found that the shared analyzer already supplies fresh
runTiming.observedAt, deadlineAt and remainingMs on every model call, including
retained turns. Do not propose adding a duplicate deadline field to fix research
strategy. Calendar's long investigation is not explained by hidden remaining time.

Flights 11, minutes 60–63: retained HTML inspection identified the actual Date
grid selector. The corrected warm capture completed in 2.271 seconds and retained
an 8,627-character API response with 49 date pairs. The agent then tested a
two-request candidate: page-owned grid capture followed by the parameterized
direct request in the same CDP session. Only the second response can prove the
four separate window inputs. Do not accept the first successful grid as evidence
that those windows affect the second request's result. The page-owned success
narrows the direct-call issue to construction/session differences without
identifying a specific missing field.

Prepared a private synthetic regression for SF-11 without altering the active
run's code: nested-body-regression.test.ts. It fails on 5d5a770 because the
research observation lacks decoded structural facts. The fixture combines an
intentional early token-to-null change with accidental extra nested array levels,
showing why the first differing byte alone is insufficient. No recording bytes
or real opaque values were used.

Flights 11 final: operator-stopped at 70.3840498 minutes, exit 130. A local
execution of the booking transform against its fresh selected-flight input
produced 835 bytes versus request 139's 811. The generic comparator identifies
extra nested endpoint arrays after an intentional changed token. This was the
third separate researcher to construct this error in the run, despite guidance
to preserve the template. All four execution rungs rejected it with HTTP 400.
The retained candidate and operator-stop process snapshot remain private.

The next correction adds optional bounded bodyStructureComparison facts to
research observations, reusing existing decoding and comparison helpers. No
new matching classifier, request rewrite or execution policy. The synthetic
regression fails before and passes after the change; unsupported, oversized and
incompletely decoded bodies preserve existing diagnostics without claiming an
empty comparison. Active source was changed only after Flights 11 exited.

Final reported Flights 11 usage: 8,380,689 input tokens including 6,737,024 cache
reads, 92,078 output, zero reported cache writes. $11.1110296 base API equivalent,
two missing usage spans (watchdog and operator cancellation). Eleven completed
attempts total $198.9840496; eleven observed missing spans plus the Flights 5
unknown unflushed tail remain excluded. No completed independent audit in this
campaign. All recordings, logs, conversations and failed artifacts remain local.

Checkpoint checks: 276 focused tests, 1,721 assertions, type checking and lint
passed. Website build and 1440/390-width inspection passed (existing bundle-size
warning only). All Flights 11 owned processes exited. The trace collector remains
active for the next fresh run. Original recordings and 17 GiB available space
were verified. No source/prompt changes will be made during Flights 12.

Flights 12 launched at 18:50:04 UTC on 753e6ab. New isolated home, original
recording and unchanged four-operation guidance. Target 19:20, assess 19:50,
hard deadline 20:20 UTC. Driver process 46128; collector retained on port 6443.
Disk 16.55 GiB free. Watch whether structural comparisons reach the actual
researcher and shorten repairs, then complete strict independent audit before
any pass claim. No earlier generated tools or examples supplied.

Flights 11 critical-path accounting (elapsed boundaries, not summed parallel
worker durations): discovery/initial master ended at 9.77 minutes; first research
passes finished at 31.28; master plus watchdog retry finished at 40.27; search
boundary refresh finished at 41.22; calendar follow-up returned partial at 65.45;
booking continued until the operator stop at 70.384. Calendar's follow-up alone
occupied about 24.2 minutes of the serial follow-up path. New structural evidence
addresses construction repair latency; it does not claim to solve that scheduling
choice or the downstream itinerary-stage mismatch.

Accounting recovery after Flights 12 launch: the Flights 11 master rollout
contains the completed watchdog turn's last_token_usage. Both adjacent successful
turns exactly match their OTLP input/output/cache counts, validating the source.
Recovered 119,499 input, 6,528 cache reads, 8,122 output and zero reported writes,
adding $0.6169352. The private accounting helper supplements only that missing
trace/span pair; it never overwrites emitted usage or double counts ancestors.
Flights 11 revised total: 8,500,188 input, 6,743,552 cache reads, 100,200 output,
zero reported writes, $11.7279648, one remaining missing cancelled span. Eleven
completed attempts now total $199.6009848; ten observed missing spans and the
Flights 5 unflushed tail remain excluded. Flights 12 active usage is separate.

Flights 12 discovery ended at minute 12.11: triage 48.04 seconds, detector
225.80, advisor 251.23, initial master 200.53. Four tools selected. Date grid
starts with route and departure/return anchors, avoiding the previous eight-input
window contract. SF-26 recurs as a scope risk: search selects [295,730] and
round-trip inputs, while booking selects the multi-city [308,317]. The advisor
had also listed the coherent round-trip [139,154] among available selection/
booking evidence. Research must resolve the chosen cross-mode scope before
claiming a fresh chain. This is not yet a failed tool or parser verdict.

Additional SF-26 source check: discoveryEvidenceDocuments explicitly removes
request headers, bodies and response previews, retaining indices/digests. The
retained master's discovery projection further supplies evidence counts with
no cited entries. Thus merely forwarding the current discovery evidence would
not supply the missing wire facts. A future bounded, agent-selected request
inspection before committing parameters may address this; no implementation
change is made during Flights 12. Avoid adding a site-mode classifier.

Flights 12 at minute 19: location has made no API call. Its first batch omitted
candidate.parameterValues; the repair supplied them but both versions omitted
workflow.requestTransformModule while supplying transform source. The base schema
error therefore hid a later cross-field error until the single repair was spent.
The controller retained a blocked advisory handoff and continued other research.
This exercises the earlier invalid-report recovery path; master repair is pending.
The batch prompt says testCases replaces the single input, while the schema also
requires a redundant candidate.parameterValues. If this keeps recurring, normalize
the primary batch input mechanically or clarify the contract; do not accept
missing transform linkage or invalidate historical proof.

Search's first candidate preserved request 730 structure, returned real outbound
results through CDP after a fetch-bootstrap failure, and correctly excluded
request 295's multi-city route. It returned partial at 17.59 because the complete
raw response lacked the requested return date. Booking is testing the separately
recorded multi-city selection/booking flow as a diagnostic, with its second token
derived from the preceding live response. That does not prove the declared fresh
round-trip producer chain. Controller inspection confirms partial producer
candidates are unavailable to call_producer; record as SF-28 until its actual
effect on this repair is known.

Flights 12, minutes 21–25: bodyStructureComparison is present in actual model
inputs. Booking used it to confirm request 308's structure matched the recording,
and repaired its local base64/escaped-padding extraction instead of changing the
wire body. Later it claimed the recorded second-flight token was absent, then
corrected that claim during blocker review: only a truncated response preview
was available. The exact full response cannot be inspected. Code inspection
confirms runtime invokes onRawResponses only after all requests finish, while
research retains result text only on success. The failed booking directory has
only workflow.json and request-transform.ts, no live-results files. Record SF-29
as actual lost intermediate evidence, distinct from SF-18 inaccessible sibling
evidence. Any correction must retain attempt/request identity and never treat a
partial failed chain as a successful result or overwrite earlier useful captures
with the final failed rung.

Booking's historical exact-flight requirement is also a comparability risk:
recorded user query constraints must remain comparable, but a current producer
can return different result-derived selection fields. The blocker review correctly
withdraws absence claims based on a truncated preview. Investigate whether
freshness guidance is being interpreted as replacing only an opaque token while
pinning all historical response-derived identity fields. No new case or prompt
change has been supplied during this run.

Flights 12, 30-minute checkpoint: calendar research proven at 28.55 after a
34.466-second cold page-owned API call and a 2.191-second warm repeat. Its four
route/anchor parameters avoid the prior eight-input window contract. Search is
partial, location is blocked on report format, booking is blocked on fresh
upstream state and inaccessible intermediate evidence. No published tools or
independent audit. Continue within the existing deadline; the master has concrete
repairable handoffs. Structural diagnostics are reaching live model calls and
were used to rule out a body mismatch, but a full reliability gain is unproven.

SF-23 recurred in Flights 12: all initial research returned by 28.55, but the
last independent calendar handoff started a speculative focused planner, which
finished at 31.08 (151.70 seconds), before its draft compile. The master still
awaited this work while three other handoffs needed repair. A smaller scheduling
correction than a global concurrency rewrite may be to skip speculative drafting
when no other initial research remains to overlap; test preservation of early
drafting when genuine overlap exists. No source change during the run.

Flights 12 master research review began around minute 36 after the calendar
draft completed, roughly 7.5 minutes after all research had returned. The early
draft used 26 completed MCP calls: read_session_summary 1, read_request 2,
read_event 1, read_response_body 1, read_file 8, write_file 7, run_tests 3,
run_bash 2, done 1. This was active compilation, not a stalled process. The
existing analyze-compile-log.ts reported zero calls because these logs contain
Codex item.completed/mcp_tool_call events; do not use that zero as timing or
activity evidence. Native events lack timestamps here, so macro trace timings
remain the reliable elapsed boundaries.

Flights 12 master at 40.38 resolved the cross-mode contract: search now accepts
a scalar legs JSON string for recorded request 295; booking explicitly returns
next-leg choices for an incomplete ordered selection and offers for a completed
selection. It directs booking to choose a second-leg option actually present in
the fresh response, rather than require historical B61190. This corrects the
freshness interpretation without a source/prompt change. It also correctly
returns the location formatting error to the retained researcher. Location
subsequently passed both recorded queries via fetch in 291/201 ms and returned
proven at 42.37. The invalid-handoff recovery path is now exercised through an
actual successful repair. Search research continues before the causal booking
follow-up. No publication or independent audit yet.

Flights 12 at 51.27 minutes: revised request-295 multi-city search returned
protocol error [13] through fetch-bootstrap and CDP request replay despite a
matching 581-byte body and decoded 80-node structure. The researcher then
parameterized the recorded page navigation and captured its generated API
response: both ordered legs were present, with first-leg records and fresh
selection values. It is repeating the unchanged recorded input to check reuse.
This is current transport-context sensitivity, not established malformed body,
network loss, or a completed search tool. Location repair remains proven; booking
and final parser verification remain pending. At this checkpoint 16 GiB is free.

Measured timing for all eleven completed attempts is now recorded in [the stage report](teach-stage-timing-2026-09-21.md): 701.2 run minutes, 72.7% exclusively discovery/research/planning, 96.7 minutes of completed live backend durations with overlap kept separate, and no final independent audit. Do not treat uncovered intervals as idle or infer a precise setup/network split.

Flights 12 final: search succeeded by page-owned API capture with a warm repeat.
Booking called that producer freshly, selected a currently present second flight,
and obtained offers via ordinary fetch. Research proof did not settle the reusable
contract: the master found that selected_flights omitted full ordered query legs,
so the booking transform hardcoded route/date context. Both final master outputs
failed the follow-up schema; the repair still used suggestedExperiments rather
than instruction, despite the master prompt documenting instruction. This is a
coordinator-output failure after a valid semantic concern, not a site outage.
All evidence is retained. No 4/4 publication or audit. Timing and cost are included
in the twelve-attempt local dashboard.

SF-30 candidate: research repeatedly serializes full candidate definitions. Across
12 attempts, 112 research turns returned a definition previously seen in the same
run/tool after excluding only parameters and backend. They took 111.7 worker-minutes;
this is affected work, not an estimate of removable time. Exact candidate references
could preserve proof while reducing output and accidental source reconstruction.
Synthetic binding tests and a fresh teach must validate any implementation.

Independent Astra review corrected the precise Flights 12 repair sequence. First
output put decision fields under an invalid decision wrapper. Its six parseErrors
covered outer missing/unrecognized fields only. The repair flattened those fields,
then validation discovered the nested follow-up errors not previously reported.
This is layered validation feedback exhausting a single repair allowance, not
proof that the agent ignored the same reported error twice. Parent verified both
retained evidence records (544fac27a2eec094 and 96e5406560dd9490) independently.


## Flights 13 — coordinator repair validation (in progress)

Fresh run started September 22 at 05:48:40 UTC on 620129d, with the original
recording and four-operation scope. User explicitly authorized proceeding on
battery. Private evidence: `reteach-systemic-2026-09-21/flights-13/`.

Observed through minute 28 (not a completion or audit result):

- Initial discovery/master selection took 8.94 minutes. Four scoped operations
  were accepted. Location and search later reached proven research handoffs.
- Search and calendar independently constructed extra nested array layers. The
  factual request-body comparisons let each researcher correct those errors.
  Both first exhausted four execution rungs, so malformed request construction
  also consumed browser setup time; browser escalation did not repair the shape.
  This is recurrent agent request-construction failure, not evidence of an outage.
- The calendar report omitted baseline candidate values for a batch. New
  schema-derived field feedback was delivered at minute 22.62; the same retained
  researcher corrected the report by minute 24.01. No invalid report executed.
  Multi-layer coordinator recovery has not yet been exercised by this live run.
- Search research explicitly distinguished recorded trip modes, but focused
  planning selected a fixture from the different mode. This is a comparability
  concern to check in independent verification, not yet a demonstrated parser bug.
- Booking invoked the current search producer and inspected its fresh response.
  Its initial direct calls returned an error envelope, not booking offers. No
  dependent-tool success is claimed. Selection/context completeness remains open.
- Location/search early planning and compilation held research slots until
  calendar/booking started around minute 20, illustrating the existing scheduling
  concern. Some draft work may be reused; do not count all overlap delay as waste.

An offline synthetic reproduction, `failed-chain-before.ts` and `.log` in the
private campaign root, confirms that later HTTP failure, required-capture failure,
and cancellation after reading a body leave no complete-chain response evidence.
Read failure also leaves no explicit retained body-availability record. It makes
no external calls and does not modify the live runtime. The planned per-request
retention checkpoint will be verified against these cases after this run ends.


Flights 13 finished at the 90-minute deadline, exit 1: two ready, two unfinished.
Location lookup and the date grid published after independent raw-first evidence
checks: five location records and 49 date pairs respectively. Search and booking
remain unpublished. A separate strict audit of the two published tools has begun;
it cannot establish the required four-operation pass.

Later findings:
- The master correctly narrowed calendar to route plus anchor dates and repaired
  booking to require six same-record producer values. Fresh booking research
  succeeded. All four research handoffs were accepted around minute 49.
- Search compilation was rejected because the planner changed its captured-response
  provenance from a bodyless source to a populated fixture. Resolving the distinction
  required another research, planning and master cycle; compilation began only at
  minute 76. The populated fixture has a different recorded request mode. Agents
  explicitly justified structural parser comparability without claiming identical
  modes. That distinction still requires independent verification.
- The search compiler selected the wrong of two distinct values in the same record.
  The consumer needed a price-adjacent token, but the parser emitted a serialized
  selection object. Master inspection caught this at minute 85 and requested a
  parser-only correction. The corrected live call completed, but independent
  evidence review did not finish before the deadline. The generated booking chain
  was never tested. Same field names and string types do not establish a correct
  producer/consumer representation; exact tested consumer evidence must reach the
  producer compiler and reviewer.
- One evidence-reader call received a deterministic provider prompt-policy rejection.
  Preserve it separately from API/parser failures; it was not treated as successful
  verification or a transient capacity outage. No bypass or model switch was used.
- Coordinator format repair did not terminate this run. The new schema-derived
  feedback successfully repaired a research report; the live run did not exercise
  more than one repair for the same coordinator decision. Unit regressions remain
  the evidence for the layered-repair case. Fresh-teach reliability is not proven.

Reported teach usage: 14,980,857 input tokens including 11,431,552 cache reads,
200,868 output, zero reported cache writes, $22.7872008 base API equivalent using
this campaign's existing rates. Two analysis calls lack usage; interrupted or
rejected-call usage remains unknown. Elapsed 90.0126 minutes. Source, failed
attempts, drafts, transcripts and evidence are retained in flights-13. No power
shutdown or network disconnect terminated the run; disk still has 11 GiB.


Strict partial audit finished in 1.7413 minutes, exit 2 / inconclusive. Two actual
invocations were correct; three of five public parameters were graded working,
while calendar origin and destination were untestable. No broken calls, no-op
parameters, infrastructure exclusions or bad inputs. The displayed 100% covers
five graded units only and is not a strict pass. The complete four-tool scope is
also absent. Fixed recording-backed cases are preserved; do not invent contrast
calls or weaken strictness to erase this gap. Agents must either provide relevant
recording-grounded evidence for advertised inputs or narrow the public contract.
Audit usage: 126,198 input including 108,672 cache reads, 1,646 output, zero
reported writes; $0.1464928 base estimate. Teach plus audit: $22.9336936 reported
base estimate, with the teach's two missing-usage calls still unknown.

## Native validation findings — September 22

| ID | Finding | Correction / status |
| --- | --- | --- |
| SF-31 | Native task instructions blur semantic actions and direct MCP execution | Flights 15 round-trip follow-up cited absent direct tools as a blocker. Task metadata/instructions now distinguish JSON host actions from compiler tools; real-provider action/retained-proof smoke passes. Fresh validation pending. |
| SF-32 | Research repair imposes serial order on independent tools | Flights 15 requested six repairs but round-trip delayed all siblings. Reuse accepted plan waves; an independent-overlap regression failed before and passes after, with producer freshness preserved. Fresh validation pending. |
| SF-33 | Native task delivery repeats large immutable packets | Flights 15 made 887 reads for 297 pages of unique packets. Cache guidance and removal of redundant dispatch waiting are measured correction candidates; no speed improvement claimed yet. |
| SF-34 | Shared findings interface is unused | No findings published in Flights 15. Flights 16 has five immutable findings by minute 43; publication is demonstrated, but useful reuse and latency benefit remain unproven. Agents choose applicability. |


## Flights 16 terminal findings — September 22

Flights 16 ended at the ninety-minute deadline: one published tool, two not ready,
booking excluded by the master. The independent strict lookup audit passed one
actual invocation and its one parameter. This is not four-operation acceptance.
See [the measured retrospective](teach-flights-16-retrospective-2026-09-22.md).

| ID | Systemic defect | Evidence and correction |
| --- | --- | --- |
| SF-35 | Native compiler identity follows revision directories instead of the tool | A successful 8.55-minute revised search compile was rejected because its child identity changed. Key the retained compiler by public tool within the run. The regression fails before and passes after, and isolates different tools. |
| SF-36 | Verification waits for all sibling compilations and then runs serially | The ready lookup draft waited about twelve minutes after final plan acceptance before checks began. Run checks through the existing per-tool completion callback, preserving dependency waves. Independent and dependent regressions pass. |

Neither correction adds a worker pool or scheduler. Full fresh validation remains
outstanding. The upstream search/booking contract mismatch and unattempted recorded
variants remain unresolved; native delegation alone does not solve them.


## Flights 17 observed delays — September 22

All first-pass research had returned at 14:53:42 UTC, but master review waited
until 15:09:13 for the one-way speculative compiler. This repeats SF-23: about
15.52 minutes of avoidable review delay. The compiler was actively building and
testing a parser, not stuck after an SDK terminal event. A preparation checkpoint
moves draft settlement after master review while retaining owned cleanup and exact
reuse. The old-code regression fails; normal and review-error paths pass afterward.

| ID | Systemic defect | Evidence and correction |
| --- | --- | --- |
| SF-37 | Bounded excerpts force many turns to query a large retained response | A fresh consumer received a 3,041,549-character document and repeatedly searched 2000-character slices. Reuse the existing verifier's bounded offline projection for research inspection, preserving observation identity and failed status. Regression tests pass; fresh teach benefit remains unproven. |

Native concurrency reached nine active child turns, including tool waits; no
capacity failure was recorded. The master split recorded user purposes into nine
tools and shared findings were published. These mechanics do not prove full
coverage, cross-tool reuse or a net reduction in runtime code. First-pass research
still left fresh booking contracts incomplete. See the Flights 17 retrospective
for the eventual terminal result and cost accounting.


| ID | Systemic defect | Evidence and status |
| --- | --- | --- |
| SF-38 | Agent tool-purpose labels can disagree with the selected recording fixture | Flights 17 treated request 245 as one-way even though it belongs with the multi-city requests. Flights 18 independently identified the actual one-way requests 206/235 and their missing response bodies. Direct source inspection confirms that distinction. No one-way coverage was published or audited. Preserve explicit purpose/fixture comparability and report the coverage correction; no site-specific runtime classifier is added. |


## Flights 18 terminal lock failure — September 22

SF-39: The research executor's shared file lock starved date-grid research for ten
minutes. Its generic timeout aborted the first research phase; unrelated planners
then settled before failure became visible. No calendar request executed. Independent
synthetic reproduction confirms later arrivals can overtake an earlier waiter.
Remove the research-only lock and reserve existing origin-pacing starts before
waiting, retaining per-tool/rung state isolation and other lock users. This is the
fifth bounded native-path correction, not a new scheduler. Fresh validation pending.

The time-window researcher also invented an unrecorded contrast despite explicit
fixed-case guidance, and based its proven handoff on it. This remains a coverage
and instruction-following defect; no tool was published. Booking still lacked
complete fresh producer selections. See the Flights 18 retrospective for scope,
timings, failed response evidence and usage. Native delegation alone is not full
MVP acceptance or a claim of whole-runtime simplification.


## September 22 purpose and native lifecycle follow-up

- SF-40: Purpose splitting was installed as prompt text but not reliably achieved.
  Flights 18 split ten tools; Flights 19 selected four and deferred other modes.
  The boundary advisor did not receive human scope, and older MVP instructions
  contradicted distinct-purpose coverage. Correct scope delivery and align advisor,
  master, planner, researcher and completion-review guidance. Judge actual plans;
  synthetic tests cannot establish website coverage.
- SF-41: Native completion journaling could leave an accepted-looking assignment
  unresolved after a write error. Independently reproduced with synthetic data.
  Creation now logs before enqueue, failed completion rejects/removes the task,
  and cleanup journaling cannot hide the primary result. Composed cancellation
  covers family-owned work even with a separate caller signal.
- SF-42: Semantic schema repairs and shared-memory queries still required repeated
  root routing despite persistent research. Reuse the same generic agent-pass
  channel for all semantic roles, retaining one child and the existing validators.
  Native waves submit directly; there is no additional native worker pool.

- SF-43: Planning and callable producer lookup used different compatibility checks.
  Flights 19 kept narrowed search research but hid it from booking. A synthetic
  metadata-only boundary change reproduces the missing producer. Both now reuse
  the existing boundary coverage check, with exact candidate/observation matching
  against the retained result. Invalidated producer evidence remains unavailable.
