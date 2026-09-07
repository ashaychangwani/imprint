# Teach validation accounting — September 7, 2026

These are eleven teaches and five independent audits, including the failed fresh validation of implementation `60392ef` (Flights attempt 5). Failed and cancelled attempts remain in the totals. Raw recordings, transcripts, and traces stay outside the repository.

## Recorded results and usage

Elapsed time comes from each completed `cli.teach` or `cli.audit` root span, rather than rounded timeline observations. Input includes cache reads and writes; do not add the cache columns again. All 546 usage spans identify `gpt-5.6-sol`.

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
| **Total** | **Includes failures/cancellations** | **642.44** | **108,583,855** | **88,040,832** | **0** | **1,245,375** | **$142.30** |

## Cost assumptions and completeness

The base API estimate uses $4/M uncached input, $0.40/M cached input, $5/M cache writes, and $20/M output from the [official GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol), checked September 7, 2026. Formula: `(4 × uncached + 0.4 × cache_read + 5 × cache_write + 20 × output) / 1,000,000`.

This is an API-equivalent estimate, not an invoice or measured Codex subscription charge. The official page specifies higher rates for requests over 272K input tokens. CLI turn/session aggregates do not establish individual request lengths, so the base estimate does not apply that surcharge. Service-tier adjustments, external tool charges, and account-specific pricing are also not established by these traces. No dollar-cost attributes were recorded.

Each span is counted once by trace/span ID. The trace file has no duplicate span IDs within a trace and no token-bearing ancestor of a counted usage span. Compiler and audit CLI usage carriers have no token-bearing children. Workflow spans are excluded. No counted usage is marked estimated.

Eight interrupted `llm.analyze` spans have no reported usage: three in cancelled Flights attempts, two optional Hotels refinement passes stopped after MVP promotion, the final deadline-interrupted booking call in Flights attempt 5, the search-contract follow-up in attempt 7, and the cancelled Hotels attempt-3 research follow-up. Cancelled or interrupted provider work may have consumed unreported tokens; the recorded total is therefore incomplete for such work. Flights attempt 6 also terminated its newly started booking compiler at the deadline; its interrupted CLI work may have usage not captured in the reported session totals. Cache writes are zero as emitted by Imprint, which can normalize an absent provider field to zero; this does not independently prove that no cache was written.

The earlier successful Flights teach took 69.40 minutes; attempt 8 took 82.29 minutes. Both exceed the 30-minute target. The successful narrow Hotels teach took 28.46 minutes. Earlier approximate timeline times include observation delay and are superseded here for process duration. Flights teach 4 failed after 52.40 minutes. These different revisions do not demonstrate repeatability.

## Evidence and remaining work

Sources: `/tmp/imprint-fresh-inputs-VYbJm1/spans.jsonl` and the completed attempt-5 through attempt-8 traces in `spans-validation.jsonl`; extracted local aggregates: `historical-accounting.json` plus `flights-teach-5-accounting.json` and `flights-teach-6-accounting.json`, plus `flights-audit-6-accounting.json` and `flights-teach-7-accounting.json`, plus `flights-teach-8-accounting.json` and `flights-audit-8-accounting.json`, plus `hotels-teach-3-accounting.json` in the same directory. Teach/audit outcomes are detailed in [the handoff](teach-handoff-2026-09-07.md). The sixteen accounted traces contain 1,496 spans and sixteen completed root spans. Later attempts appended to the validation trace file are excluded until accounted separately.

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
