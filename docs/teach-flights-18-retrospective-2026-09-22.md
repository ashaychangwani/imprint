# Flights 18 retrospective

**Failed: zero published tools, ten not ready, no independent audit.** The fresh
teach on runtime 57d8d32 ended September 22 at 16:15 UTC after 51.856 minutes.
The terminal error was a ten-minute wait for the shared live-verification file
lock in date-grid research. That call never reached execution. The native family
closed and its owned process group was empty. No provider capacity failure was
recorded. Eleven GiB remained free; no power or general connectivity failure ended
the run.

## What failed

Independent researcher workflows shared one polling file lock under staging/api-research.
Later arrivals could overtake a waiter. Date-grid submitted its test at 15:52:24,
wrote its candidate, then produced no response or subsequent research assignment.
The final error explicitly names its lock timeout. A synthetic, network-free
reproduction demonstrates overtaking and timeout. This is an Imprint coordination
failure, not evidence that the calendar endpoint failed.

The generic timeout prevented master review of all first-pass results. Cleanup
waited for already-started planners: the last other researcher completed at
16:08:17, and the last planner at 16:14:59. Do not count that settlement interval
as productive master review. A separate correction is prepared: remove the
research-only file lock, preserving each pass's sequential executor and isolated
browser state. Existing origin pacing reserves starts before waiting and supports
cancellation. No new scheduler is needed. Authentication and integration-verification
locks remain unchanged. Overlapping slow requests can increase resource use and
must be measured in a fresh run.

## Coverage and evidence

The master selected ten tools for lookup/details, round-trip and multi-city
search/booking, airline/alliance, baggage, time windows and date grid. Seven
research handoffs claimed proven results; both booking researchers correctly
remained blocked without fresh complete producer selections. Initial search
results alone do not prove the continuation needed for booking. Only the lookup
draft compiled. Nothing was published or independently audited.

One-way was excluded because the two actual recorded one-way requests lack
response bodies. Request 245 is multi-city; the earlier Flights 17 one-way label
was corrected separately. No old generated tool or research memory was supplied.

The time-window researcher invented a disjoint departure window and labeled it a
freshness change. This violates the requested fixed recording-backed verification
set, even though the call returned different flight records. Its final proven
claim used that observation. No master review or publication accepted it before
failure. Existing prompt guidance already forbids invented challenges; record this
as an unresolved instruction-following/coverage issue, not a successful case.

Forty-three per-response records remain, including 27 HTTP 400 responses and 16
HTTP 200 responses. Some 200 responses were protocol errors or incomplete results;
transport status is not semantic proof. Shared findings were published, but a
latency benefit from reuse remains unproven.

## Timing and accounting

| Sequential wall interval | Minutes | Share |
| --- | ---: | ---: |
| Initial discovery, advice and plan | 21.511 | 41.48% |
| First research, overlapping drafts and final settlement | 30.345 | 58.52% |
| Master research review, final verification and publication | 0 | 0% |

The native family used 47 assignments and 340 assignment reads for at least 308
unique prompt pages. Initial dispatch median was 44.44 seconds; follow-up median
30.01 seconds. Dispatch intervals overlap and cannot be summed into wall savings.
Peak ten child turns includes tool waits, not simultaneous model requests.

Reported usage: 32,526,293 input including 29,959,552 cache reads, 207,195 output,
zero reported cache writes, $26.3946848 base API equivalent. Twenty-one native
family totals are reported snapshots. This run has no missing analysis usage span,
but snapshots cannot establish otherwise unreported backend usage. Campaign trace
total through this run is $351.309628, with 18 missing analysis usage spans.
Separate native smokes are outside that ledger. These are existing campaign base
rates, not an invoice or a speed/reliability claim.

Private evidence: ~/.imprint/experiments/reteach-systemic-2026-09-21/flights-18,
including manifest.json, run.log, native-retrospective.json and the synthetic
same-site-lock-reproduction files. The retained run ID is
f70a4e01-90a5-4d8c-a82d-477a409c3e37. Original data remains untouched.
