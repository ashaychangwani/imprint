# Teach validation accounting — September 7, 2026

These are twenty teaches and fourteen independent audits, including the failed fresh validation of implementation `60392ef` (Flights attempt 5). Failed and cancelled attempts remain in the totals. Raw recordings, transcripts, and traces stay outside the repository.

## Recorded results and usage

Elapsed time normally comes from each completed `cli.teach` or `cli.audit` root span. Audit 17 is the exception: host sleep interrupted its monotonic trace clock, so its 52.37 minutes use launch time to final report modification time; the trace reports only 0.54 minutes. Input includes cache reads and writes; do not add the cache columns again. All 1,217 usage spans identify `gpt-5.6-sol`.

| Attempt | Result | Minutes | Total input | Cache read | Cache write | Output | Base API estimate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flights teach 1 | Cancelled | 11.50 | 1,692,092 | 998,528 | 0 | 31,780 | $3.81 |
| Flights teach 2 | Cancelled | 73.41 | 17,836,093 | 14,580,352 | 0 | 212,548 | $23.11 |
| Flights teach 3 | 4 ready; audit passed | 69.40 | 13,643,094 | 10,374,272 | 0 | 172,358 | $20.67 |
| Flights audit 3 | 22/22 correct | 7.24 | 679,038 | 645,376 | 0 | 4,201 | $0.48 |
| Hotels teach 1 | 1 ready; audit failed | 17.37 | 3,212,993 | 2,703,872 | 0 | 27,803 | $3.67 |
| Hotels audit 1 | 3/9 correct; 1 excluded bad input | 1.90 | 200,610 | 177,280 | 0 | 1,853 | $0.20 |
| Hotels teach 2 | 1 ready; audit passed | 28.46 | 5,770,208 | 5,150,592 | 0 | 36,521 | $5.27 |
| Hotels audit 2 | 7/7 correct | 2.60 | 177,730 | 151,040 | 0 | 1,430 | $0.20 |
| Flights teach 4 | Failed before planning | 52.40 | 7,896,713 | 6,792,192 | 0 | 98,403 | $9.10 |
| Flights teach 5 | Deadline failure; 0 ready, 4 not ready | 90.00 | 12,621,233 | 10,945,024 | 0 | 143,282 | $13.95 |
| Flights teach 6 | Deadline; 3 ready, grid failed, booking unfinished | 90.00 | 14,432,957 | 11,569,024 | 0 | 175,407 | $19.59 |
| Flights audit 6 | 16/16 correct; 3 published tools only | 7.60 | 548,944 | 502,784 | 0 | 3,867 | $0.46 |
| Flights teach 7 | Deadline before planning; 0 ready | 90.00 | 15,580,269 | 12,171,520 | 0 | 150,435 | $21.51 |
| Flights teach 8 | 4 ready; independent audit passed | 82.29 | 12,453,189 | 9,761,024 | 0 | 164,877 | $17.97 |
| Flights audit 8 | 24/24 correct; 1 excluded bad input | 9.39 | 705,235 | 665,088 | 0 | 6,334 | $0.55 |
| Hotels teach 3 | Cancelled: reproduced local module loader defect | 8.86 | 1,133,457 | 852,864 | 0 | 14,276 | $1.75 |
| Flights teach 9 | Deadline: 2 ready; search failed, booking dropped | 90.00 | 13,509,129 | 11,733,504 | 0 | 164,139 | $15.08 |
| Flights audit 9 | 12/13 correct; only two published tools | 4.88 | 360,143 | 326,400 | 0 | 3,060 | $0.33 |
| Flights teach 10 | Deadline: 4 ready, both chain checks failed | 90.00 | 16,435,849 | 13,469,056 | 0 | 164,056 | $20.54 |
| Flights audit 10 | 8/15 correct; booking untestable | 12.53 | 958,099 | 922,496 | 0 | 4,651 | $0.60 |
| Flights teach 11 | Deadline: 3 ready; booking MVP and chain failed | 90.00 | 11,978,209 | 9,372,416 | 0 | 159,771 | $17.37 |
| Flights audit 11 | 19/19 correct; 3 tools, one navigation failure excluded | 7.46 | 829,193 | 727,296 | 0 | 4,284 | $0.78 |
| Flights teach 12 | Deadline: 0 ready; final validation unfinished | 90.21 | 22,877,668 | 19,092,864 | 0 | 170,195 | $26.18 |
| Flights teach 13 | Deadline: 1 ready; search MVP failed | 90.25 | 12,421,027 | 10,225,536 | 0 | 163,657 | $16.15 |
| Flights audit 13 | 3/3 correct; location tool only | 0.83 | 83,531 | 62,976 | 0 | 947 | $0.13 |
| Flights teach 14 | Deadline: 2 ready; search date proof failed | 90.00 | 13,189,021 | 11,104,896 | 0 | 147,378 | $15.73 |
| Flights audit 14 | 13/14 correct; location lookup failed | 3.78 | 390,228 | 322,688 | 0 | 3,087 | $0.46 |
| Flights teach 15 | Early capacity failure: 1 ready, 3 not ready | 67.51 | 11,341,302 | 8,334,336 | 0 | 128,762 | $17.94 |
| Flights audit 15 | 3/3 correct; location tool only | 0.62 | 80,234 | 69,120 | 0 | 549 | $0.08 |
| Flights teach 16 | Deadline: 3 ready; grid route proof failed, chain review unfinished | 90.00 | 13,147,148 | 10,827,008 | 0 | 165,778 | $16.93 |
| Flights audit 16 | 14/14 correct; 3 tools, booking inputs varied jointly | 5.51 | 786,639 | 679,552 | 0 | 2,992 | $0.76 |
| Flights teach 17 | 4 ready; generated chain and independent audit passed | 88.17 | 14,110,343 | 11,640,192 | 0 | 171,275 | $17.96 |
| Flights audit 17 | Sleep-interrupted timeout; no graded calls or reported usage | 52.37 | — | — | — | — | — |
| Flights audit 17b | Full pass: 22/22 correct, no exclusions | 8.67 | 1,054,089 | 985,856 | 0 | 5,456 | $0.78 |
| **Total** | **Includes failures/cancellations** | **1,525.25** | **242,135,707** | **197,937,024** | **0** | **2,705,412** | **$310.08** |

## Cost assumptions and completeness

The base API estimate uses $4/M uncached input, $0.40/M cached input, $5/M cache writes, and $20/M output from the [official GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol), checked September 7, 2026. Formula: `(4 × uncached + 0.4 × cache_read + 5 × cache_write + 20 × output) / 1,000,000`.

This is an API-equivalent estimate, not an invoice or measured Codex subscription charge. The official page specifies higher rates for requests over 272K input tokens. CLI turn/session aggregates do not establish individual request lengths, so the base estimate does not apply that surcharge. Service-tier adjustments, external tool charges, and account-specific pricing are also not established by these traces. No dollar-cost attributes were recorded.

Each span is counted once by trace/span ID. The trace file has no duplicate span IDs within a trace and no token-bearing ancestor of a counted usage span. Compiler and audit CLI usage carriers have no token-bearing children. Workflow spans are excluded. No counted usage is marked estimated.

Thirteen failed or interrupted `llm.analyze` spans have no reported usage: three in cancelled Flights attempts, two optional Hotels refinement passes stopped after MVP promotion, the final deadline-interrupted booking call in Flights attempt 5, the search-contract follow-up in attempt 7, the cancelled Hotels attempt-3 research follow-up, the final master decision in Flights attempt 10, an optional location-parameter advisory call in Flights attempt 13, the final master revision in Flights attempt 14, the capacity-failed grid MVP review in Flights attempt 15, and the final deadline-interrupted booking chain review in attempt 16. Cancelled or interrupted provider work may have consumed unreported tokens; the recorded total is therefore incomplete for such work. Flights attempt 6 also terminated its newly started booking compiler at the deadline; its interrupted CLI work may have usage not captured in the reported session totals. Flights attempt 9 also interrupted its search compiler repair, so its CLI usage may be incomplete. Cache writes are zero as emitted by Imprint, which can normalize an absent provider field to zero; this does not independently prove that no cache was written.

The earlier successful Flights teach took 69.40 minutes; attempt 8 took 82.29 minutes. Both exceed the 30-minute target. The successful narrow Hotels teach took 28.46 minutes. Earlier approximate timeline times include observation delay and are superseded here for process duration. Flights teach 4 failed after 52.40 minutes. These different revisions do not demonstrate repeatability.

## Evidence and remaining work

Sources: `/tmp/imprint-fresh-inputs-VYbJm1/spans.jsonl` and the completed Flights attempt-5 through attempt-17 and Hotels attempt-3 traces in `spans-validation.jsonl`; extracted local aggregates: `historical-accounting.json` plus `flights-teach-5-accounting.json` and `flights-teach-6-accounting.json`, plus `flights-audit-6-accounting.json` and `flights-teach-7-accounting.json`, plus `flights-teach-8-accounting.json` and `flights-audit-8-accounting.json`, plus `hotels-teach-3-accounting.json` and `flights-teach-9-accounting.json`, plus `flights-audit-9-accounting.json` and `flights-teach-10-accounting.json` and `flights-audit-10-accounting.json` and `flights-teach-11-accounting.json` and `flights-audit-11-accounting.json` and `flights-teach-12-accounting.json`, `flights-teach-13-accounting.json`, `flights-audit-13-accounting.json`, `flights-teach-14-accounting.json`, `flights-audit-14-accounting.json`, `flights-teach-15-accounting.json`, `flights-audit-15-accounting.json`, `flights-teach-16-accounting.json`, `flights-audit-16-accounting.json`, `flights-teach-17-accounting.json`, `flights-audit-17-accounting.json`, and `flights-audit-17b-accounting.json` in the same directory. Teach/audit outcomes are detailed in [the handoff](teach-handoff-2026-09-07.md). The thirty-four accounted traces contain 3,341 spans and thirty-four completed root spans. Later attempts appended to the validation trace file are excluded until accounted separately.

Attempt 6 ran on `cdf57eb`. All five selected operations had research proof, but final grid verification returned zero items and booking compilation began only shortly before the deadline. The CLI reported `provider_unavailable`; the observed cause was exhaustion of the run deadline, not a recorded provider-capacity failure. The independent audit of its three published tools passed all ten invocations and six advertised parameters (16/16 units). It cannot establish success of the missing grid and booking tools.

Warm API execution and browser setup cannot be recovered reliably from root timing or compiler-agent timing alone. Measure them separately in new live audits, preserving tool/rung state isolation. Record new attempts, fresh producer-consumer results, and independent audit counts before claiming repeatability.


The attempt-6 grid diagnostic measured 33.212 seconds for a cold call including
setup (49 date pairs), followed by a 60.243-second timeout on the same tool and
CDP rung. Raw captures and timing records are local `grid-6-v3-*` files. This
used the unchanged transform/parser in a host diagnostic harness, not a
published tool audit. Earlier harness module-loading failures remain preserved
and are not counted as usable warm calls. No provider calls were made by these
diagnostic scripts.


Attempt 7 on `6ca89ba` ended before planning at 90.0002 minutes with no published
tools. The terminal reported four non-ready tools although five operations had
been researched after a boundary revision; retain that reporting discrepancy.
Time facts reached agents but did not establish timely completion. The master
coordinated the consumer contexts late and requested the producer mapping at
the deadline. There was no published output to audit and no Hotels repeat.


Attempt 8 on `1677b16` completed all four selected tools and the fresh
search-to-booking chain in 82.2922 minutes. Location lookup uses fetch; search,
seven-day date grids, and booking capture API responses through CDP navigation.
Booking research consumed a current producer selection across separate browser
sessions and returned provider fares and outbound links. All 64 usage spans
reported usage, with no interrupted semantic call in this trace. Independent
audit 8 passed all 13 valid invocations and 11 parameter checks (24/24). Its
fourth grid invocation deliberately broke the seven-day invariant and was
excluded as bad input. The audit covered airport codes; the teach MVP review
also exercised a Tokyo city identifier in the grid. Broader identifier coverage
and measured warm-call timing remain follow-ups. This success does not establish
fresh-run repeatability on the current revision.


Hotels attempt 3 was cancelled after 8.8645 minutes when repeated local module
loads failed before transport. The defect was reproduced with synthetic files:
Bun resolved the first fresh import through a directory symlink but failed on
later sibling copies. Resolving the physical module path fixed the reproduction.
The initial fetch returned hotel listings, but adult-count semantics were still
unproven; no tools were published and no audit was possible. One cancelled
semantic call has no usage. All raw failed observations remain preserved.


Flights attempt 9 on `9d50dc4` reached the deadline at 90.0024 minutes with
location lookup and date grid published. Search verification rejected records
whose displayed flight fields and continuation values belonged to different
itineraries; repair was interrupted. The master removed booking because its
context source remained unproven. This is a failed four-operation validation.
The partial audit of two published tools failed at 12/13 units: seven correct
invocations, one failed invocation, and five working parameter checks. A SEA–LAX
grid probe returned only backend metadata; an identical paced retry succeeded.
Both are counted. Its underlying intermittent cause remains unresolved; the
auditor report does not retain a lower-level transport error for that call.


Flights attempt 10 on `de8e789` published all four tools but failed at the
90.0003-minute deadline. Both final search-to-booking chain probes timed out
waiting for the booking API response: 89.985 and 150.609 seconds including
setup, with navigation waits of 60 and 120 seconds. Its final master decision
was interrupted and has no reported usage. Individual MVP passes do not
establish an end-to-end pass. Independent audit 10 failed, as detailed below.


Audit 10 failed at 8/15 units: five correct and five broken invocations, three
working and two broken parameters. One search timeout was classified `infra`
and excluded, two bad inputs were excluded, and four parameters were
untestable. Booking had no valid producer selection; its empty-input probe was
excluded and establishes no booking success. The grid's changed return date
returned one non-requested pair; search never succeeded in this audit.

The auditor called the repeated final navigation error a routing failure.
A subsequent diagnostic on the unchanged artifacts established that CDP did
run: it timed out waiting for the selected search API response before a later
fallback returned its inability to navigate. The MCP reply had omitted this
preceding attempt history. Two diagnostic calls took 91.698 / 60.785 seconds
overall; their CDP rungs took 91.182 seconds cold including setup and 60.292
seconds with the same tool's browser retained. Both failed. Rung states were
separate, and browser contexts were closed afterward. These are host diagnostic
calls with no LLM usage, not a replacement audit or measured warm success.
Evidence: `diagnose-flights-10.ts`, `flights-10-diagnostic-{1,2}.json`, log and
`flights-10-diagnostic-timings.json` in the private experiment directory.


Flights 11 on `43ab0c7` failed at 90.0027 minutes with three published tools.
Booking's MVP parser combined separate fare bundles into a contradictory
record; its final chain timed out after 150.611 seconds including setup. Search
again serialized a display airline name where the proven consumer used its
machine code. The late booking compiler repair was interrupted, so its CLI
usage may be incomplete despite no missing semantic `llm.analyze` usage spans.
Partial audit 11 passed its graded checks, with the exclusions below.

Final compilation began around minute 69, after research and plan revisions.
The three earlier drafts took 3.04 / 5.35 / 2.53 minutes of worker time; the
final location, search, grid, and booking compilers took 1.92 / 2.91 / 2.11 /
4.54 minutes, with a 2.29-minute interrupted booking repair. Parallel durations
must not be added as elapsed time. The older compile-log analysis script
reported zero calls because it did not parse this Codex event shape; those
outputs are not valid timing totals. Completed trace spans provide these times.


Partial audit 11 passed 19/19 graded units: eleven correct calls and eight
working parameters across location, search, and grid. A cold grid navigation
failure was classified `infra` and excluded, and one invalid date-order call
was excluded as bad input. The failure remains in the raw evidence and does
not establish reliable cold execution. Booking was not published or audited;
this is not a full Flights pass or fresh-run repeatability.


Flights 12 on `f022180` failed after 90.2061 minutes, zero published tools.
Research proved all four operations, including a fresh one-way search-to-booking
API call after the master rejected the earlier round-trip/one-way mismatch.
Root inspection matched both opaque values inside one 1,052-byte JSON record
in the fresh 3,666,964-byte producer result; the consumer returned booking fares.
This does not substitute for a generated-tool chain or independent audit.

Research and repeated focused/master planning left final compilation until about
minute 86. Earlier location/search/grid drafts took 2.77 / 4.53 / 3.76 minutes;
final search compilation took 3.59 minutes and received `consumerResearch` in
its recorded compiler input. The master and focused planners consumed 28.98
worker-minutes across the run; overlap means this is not elapsed time. Booking
was not compiled. Location verification fetched successfully in 206 ms, and
search navigation completed in 33.039 seconds, but deadline prevented completed
MVP review/publication. The in-flight browser call ran past the deadline before
the next provider call rejected it; the process ended by itself, with no external
signal sent. No missing semantic usage spans were recorded in this trace.

No tools were published, so no independent audit was possible. The original
malformed-handoff catch and complete consumer-context correction remain
unproven by an end-to-end pass. No symlink or closed-CDP failure recurred, while
ordinary navigation/selector failures remained. All failed calls are retained.
Local `flights-12-chain-research-check.json` and `flights-12-decision-timing.json`
retain bounded provenance and decision timing without altering generated tools.


Flights 13, unchanged `f022180`, failed at 90.2479 minutes: one published
location tool, three not ready. Search MVP review rejected stop counts that
contradicted its own segment records. Calendar compilation completed, but its
36.434-second live transport check finished after the deadline and no semantic
review followed. Booking was not compiled. Research had proven all four tools,
including actual seven-date GetCalendarGrid API capture and a fresh rendered
SFO–BOS DL977 booking invocation. Root matched the latter's literal token and
route/carrier/flight fields in one 1,108-byte fresh producer record.

The earlier booking research changed only base64 padding on its selection;
root confirmed identical decoded bytes, while the master requested a second
fresh call. The later follow-up used the literal producer token. Keep both
facts: the earlier string differed but was not a different decoded selection.
Search's earlier research calls measured 34.128 seconds cold and 10.532 seconds
with its own pooled CDP session; these are research timings, not an independent
warm audit or evidence of reliable cold execution.

Partial audit 13 passed 3/3 units: two location invocations (San Francisco and
Tokyo) and the one query parameter. No excluded calls. Other operations were
unpublished and unaudited. This is the second failed fresh teach on `f022180`,
not repeatability. Its optional location-parameter advisory was interrupted with
no usage; the other completed usage totals remain reported above.


Flights 14 on `d2e0f33` failed at 89.9993 minutes with location and date-grid
published, search rejected, and booking not compiled. The search parser copied
the caller's date while discarding the dates captured from returned flight
labels; MVP review could not establish the requested date. Final master repair
was interrupted without usage. No malformed-research-handoff catch was exercised.

Research first failed to capture the shopping API despite several 75–92-second
navigation waits. The master narrowed search to rendered fields and replaced
booking's unproven opaque input with route, date, and displayed result index.
Separate index 0 and index 1 research calls captured fresh booking API responses
for Delta 1696 and American 2218, respectively. These are research successes,
not a generated chain or stable identity across independent search calls.
Final compilation started near minute 82, leaving insufficient repair time.
Partial audit 14 completed afterward and is included in these totals.


Partial audit 14 failed 13/14 units in 3.7822 minutes: six correct calls, one
broken call, and seven working parameters. San Francisco location lookup
returned zero records; London lookup and five grid calls passed. No excluded
calls or untestable parameters. A subsequent direct fetch diagnostic using the
unchanged generated transform/parser returned HTTP 200 and 2,032 bytes in
168.478 ms, with five real location records but zero parsed results. One row
omitted its optional child list; the parser's whole-list predicate consequently
rejected all rows. A manually constructed two-record fixture reproduced the
same loss when one child list was absent. Diagnostics made no LLM calls and
are not audit reruns or a replacement pass. Private evidence is
`flights-14-location-diagnostic*` and `parser-14-synthetic-diagnostic*`.


Flights 15 on `671ae38` stopped after 67.5145 minutes on an actual Codex model
capacity failure during grid MVP review. One location tool was published and
three tools were not ready. This was not deadline exhaustion: about 22.5 minutes
remained. The SDK's `Thread.run()` converted its typed `turn.failed.error` into
a plain `Error(message)`, so the provider-only retry policy could not classify
it. The failed review has no usage; all other reported usage is counted. Search
compilation independently emitted the same capacity response and stopped with
no completed turn usage, so its interrupted CLI usage may also be incomplete.

Partial audit 15 passed 3/3 units in 0.6178 minutes: San Francisco and Tokyo
lookup calls plus the query parameter. No exclusions. San Francisco returned
five locations, covering the optional-child variant that failed in attempt 14.
Other tools and the generated chain remain unproven. A subsequent SDK adapter
correction preserves terminal error origin for existing capacity retries; this
failed teach is retained and will not be resumed after the change.


Flights 16 on `c61dd1e` failed at 90.0001 minutes with location, search and
booking published; the grid was rejected. Final planning completed around minute
70. The first grid live call timed out after 121.456 seconds. Its repaired call
returned 43 fare cells in 34.724 seconds, but the result only identified SEA–DEN
through caller parameters, so the reviewer correctly rejected unsupported route
provenance. Search was recompiled to expose the promised selection path; its
second live check passed in 43.671 seconds after the first chain binding failed
before invoking booking. The repaired chain reached booking in 33.010 seconds,
but the final semantic review was interrupted at the deadline without usage.

Individual booking MVP returned three American 6316 SFO–LAX November 12 fare
options in 33.009 seconds. Neither that pass nor the repaired chain's transport
completion establishes an end-to-end pass. The research contrast had also shown
selection_token to be unnecessary when selected_flights stayed fixed; the master
retained both public parameters because both were encoded. This contract remains
an audit obligation. No actual capacity retry or malformed-research-handoff catch
was observed in this run. All 66 reported usage spans are counted once with no
nested token-bearing ancestor. Partial audit 16 ran after the teach exited and is included above.


Partial audit 16 passed 14/14 reported units: eight correct invocations and six
working parameter grades, with no exclusions or untestable labels. Location
queries SFO and Tokyo passed. Search varied origin, destination, and departure
date separately and returned matching records. Two fresh producer-selected
booking calls returned Frontier 3308 (21 options) and Southwest 4319 (3 options)
for SFO–LAX October 15. Thus the published producer-consumer pair worked twice
in this audit, although the teach's final chain review did not finish.

The auditor changed both booking inputs together and marked both parameters
working. This establishes joint selection behavior, not each input's independent
effect or necessity, and does not settle the research observation that an
unrelated token left the selected flight unchanged. Preserve the original
14/14 report with this qualification; do not reinterpret it as complete
parameter proof or full Flights success. Grid was unpublished and unaudited.
Cold/setup and warm backend timings remain separate outstanding measurements.


Flights 17 on `fa7a627` completed all four tools and the generated chain in
88.1734 minutes, at 09:44:02 UTC September 8, before the 09:45:51 deadline.
Research returned the booking fixed-first-selection gap to the master, then
proved a non-first Delta selection using fresh producer output. All 73 usage
spans reported totals with no token-bearing ancestors; no semantic call lacked
usage. Optional advice remained deferred. The original malformed-handoff catch
and actual capacity retry were not exercised in this successful teach.

Location uses fetch; search and grid capture page-owned API responses. Booking
performs a parameter-derived DOM selection then captures GetBookingResults.
Its individual MVP returned five Delta DL1926 LAX–LAS October 22 fare options
in 33.926 seconds. The generated chain used the fresh second search itinerary
for Southwest WN4319 SFO–LAX October 29 and returned three matching booking
offers in 42.731 seconds. DOM index ordering across distinct queries still
requires independent audit. Research's two opaque values came from one fresh
1,095-byte record but had added base64 padding; they do not drive the DOM click.

Audit 17 started 11:10:05 UTC and wrote its timeout report at 12:02:27 UTC.
macOS power logs show clamshell sleep beginning 09:44:07 UTC, followed by brief
dark wakes and immediate returns to sleep. The auditor emitted only its opening
statement, with no tool calls or grades. Its 45-minute deadline was handled
after 52.37 wall minutes; the root trace measured only 32.70 seconds. This
exposes a timing-accounting limitation during host suspension, not evidence of
a generated-tool failure. No audit usage was reported, so its cost is unknown,
not measured zero. Preserve this missing audit session in addition to the
thirteen historical semantic calls and interrupted compiler usage.

The first report/transcript are copied under `flights-audit-17-timeout`; the
original log, trace and selected local power events remain preserved. Audit
17b used a new auditor on the unchanged generated tools after the machine
woke. Its completed totals are included above; this retry cannot erase the
sleep-interrupted attempt or establish fresh-teach repeatability by itself.


Full audit 17b passed 22/22 units in 8.6720 minutes: thirteen correct calls and
nine working parameters, no failures, exclusions, or untestable parameters.
The auditor's notes incorrectly say 24 units and eleven parameters; the actual
arrays and deterministic score are 22 and nine. Location SFO/LAX passed. Search
separately varied origin to OAK, destination to SAN, and date to October 22.
Booking used the first and second fresh SFO–LAX October 15 selections and
returned matching Frontier 3308 and Southwest 4319 fare offers. These are
booking-option reads, not ticket purchases. Grid separately varied all four
inputs, returning 46–49 valid date cells as overlapping windows changed.

This establishes one full fresh Flights teach plus independent audit on
fa7a627. Hotels and fresh-teach repeatability on that revision remain due.
Audit cold calls were slower than subsequent calls, but aggregate MCP durations
include pacing and setup; dedicated cold/warm backend measurements remain due.
