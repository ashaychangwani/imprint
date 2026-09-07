# Teach validation accounting — September 7, 2026

These are eight teaches and three independent audits, including the failed fresh validation of implementation `60392ef` (Flights attempt 5). Failed and cancelled attempts remain in the totals. Raw recordings, transcripts, and traces stay outside the repository.

## Recorded results and usage

Elapsed time comes from each completed `cli.teach` or `cli.audit` root span, rather than rounded timeline observations. Input includes cache reads and writes; do not add the cache columns again. All 402 usage spans identify `gpt-5.6-sol`.

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
| **Total** | **Includes failures/cancellations** | **444.29** | **78,162,761** | **64,087,552** | **0** | **905,586** | **$100.05** |

## Cost assumptions and completeness

The base API estimate uses $4/M uncached input, $0.40/M cached input, $5/M cache writes, and $20/M output from the [official GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol), checked September 7, 2026. Formula: `(4 × uncached + 0.4 × cache_read + 5 × cache_write + 20 × output) / 1,000,000`.

This is an API-equivalent estimate, not an invoice or measured Codex subscription charge. The official page specifies higher rates for requests over 272K input tokens. CLI turn/session aggregates do not establish individual request lengths, so the base estimate does not apply that surcharge. Service-tier adjustments, external tool charges, and account-specific pricing are also not established by these traces. No dollar-cost attributes were recorded.

Each span is counted once by trace/span ID. The trace file has no duplicate span IDs within a trace and no token-bearing ancestor of a counted usage span. Compiler and audit CLI usage carriers have no token-bearing children. Workflow spans are excluded. No counted usage is marked estimated.

Six interrupted `llm.analyze` spans have no reported usage: three in cancelled Flights attempts, two optional Hotels refinement passes stopped after MVP promotion, and the final deadline-interrupted booking call in Flights attempt 5. Cancelled or interrupted provider work may have consumed unreported tokens; the recorded total is therefore incomplete for such work. Flights attempt 6 also terminated its newly started booking compiler at the deadline; its interrupted CLI work may have usage not captured in the reported session totals. Cache writes are zero as emitted by Imprint, which can normalize an absent provider field to zero; this does not independently prove that no cache was written.

The successful Flights teach took 69.40 minutes, above the 30-minute target. The successful narrow Hotels teach took 28.46 minutes. Earlier approximate timeline times include observation delay and are superseded here for process duration. Flights teach 4 failed after 52.40 minutes. These different revisions do not demonstrate repeatability.

## Evidence and remaining work

Sources: `/tmp/imprint-fresh-inputs-VYbJm1/spans.jsonl` and the completed attempt-5 and attempt-6 traces in `spans-validation.jsonl`; extracted local aggregates: `historical-accounting.json` plus `flights-teach-5-accounting.json` and `flights-teach-6-accounting.json` in the same directory. Teach/audit outcomes are detailed in [the handoff](teach-handoff-2026-09-07.md). The eleven accounted traces contain 1,099 spans and eleven completed root spans. Later attempts appended to the validation trace file are excluded until accounted separately.

Attempt 6 ran on `cdf57eb`. All five selected operations had research proof, but final grid verification returned zero items and booking compilation began only shortly before the deadline. The CLI reported `provider_unavailable`; the observed cause was exhaustion of the run deadline, not a recorded provider-capacity failure. An independent audit of its three published tools is in progress and excluded from these totals until complete. It cannot establish success of the missing grid and booking tools.

Warm API execution and browser setup cannot be recovered reliably from root timing or compiler-agent timing alone. Measure them separately in new live audits, preserving tool/rung state isolation. Record new attempts, fresh producer-consumer results, and independent audit counts before claiming repeatability.
