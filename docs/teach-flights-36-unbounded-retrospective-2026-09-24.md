# Flights36 unbounded teach retrospective

Flights36 used commit `63915d8`, the documented combined Google Flights
recording, the four required operation groups, and `--unbounded` in a new
isolated home. It ended after 138.56 minutes with two published tools
(`get_flight_date_grid` and `search_flight_locations`), four not ready, and no
independent post-teach audit. The terminal error was a five-minute deadline in
the one-way missing-fixture evidence reviewer, not a whole-run timeout, disk
failure, sleep, or provider-capacity error. The complete failed run remains at
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-36-unbounded/`.

The run reached substantially more of the pipeline than Flights35. Research
proved location search, location details, one-way search, multi-city search,
date grid, and one-way booking. The booking researcher used a fresh one-way
search call as its producer. The master planned six tools in two waves.
Date-grid and location-search artifacts passed live checks and independent
reviews before publication. The one-way planner used an explicitly marked
live-only verification case tied to recorded request 206, whose response body
was not captured; it did not invent replay evidence.

The first one-way compiler correctly rejected an accepted-plan contradiction:
the target itinerary was zero-based response index 1 but rendered DOM ordinal
3, while the plan demanded index 2 and reused it in an `nth-child()` selector.
The master sent search and booking back to their retained planners. The
repaired compiler separated `result_index` from the rendered ordinal,
preserved booking context, and passed four local tests plus strict type checking.
Its live CDP call completed and the independent raw-response reviewer began.
The multi-city verifier also spent its bounded inspections on deeply nested
response framing and did not complete its review before its own deadline.

The terminal defect was in `verifyRecordingMvp`: the existing paired-recording
branch caught a non-cancellation reviewer error and returned `unverified`, but
the newly added live-only branch called the reviewer outside that catch. Its
`ProviderDeadlineError` escaped to the whole teach at 13:04:54 UTC. The fix
puts both branches under the same catch. A focused regression injects a phase
deadline error into the live-only reviewer and requires an unverified result.
This preserves a failed proof without turning it into success or ending the
entire teach. The next run must be fresh because the runtime changed.

Measured wall time was 12.74 minutes (9.19%) in discovery and initial plan,
33.57 (24.23%) in first-pass research and overlapping drafts, and 92.25
(66.58%) in master revisions, later research, compilation, and verification.
Retained response history contains 14 fetch 200s, 18 CDP-replay 200s, one
fetch-bootstrap 200, and twelve 400 responses across the attempted rungs.
Native assignment dispatch medians were 22.23 seconds for 41 initial tasks
and 17.73 seconds for 29 follow-ups; these overlap wall time. The trace
reports 59,592,892 input tokens, including 55,285,504 cache reads, 372,266
output tokens, zero reported cache writes, and a $46.7891 base API-equivalent
estimate. Two analysis spans lack usage, so tokens and cost are lower bounds.

The diagnostic `status-native.py` counts assignment creation minus completion
but does not see assignments removed on cancellation. Its lingering pending
verifier entry is therefore not evidence of a live worker deadlock. This
observability gap can be addressed separately if it obscures later diagnosis;
it did not cause the terminal failure.
