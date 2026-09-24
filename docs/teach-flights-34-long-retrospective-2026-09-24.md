# Flights34-long retrospective — September 24, 2026

Flights34-long was a fresh, isolated teach on the same implementation as
Flights33 (`997bd9f`; the launch manifest names the later docs-only commit
`fa5cb0e`). It used the documented Flights recording and operation scope. The
one-shot driver omitted `--timeout 90m`; both it and Imprint allowed up to 12
hours. No recurring monitor was created.

I interrupted the run at 41.59 minutes with SIGINT because available disk
space reached 486 MiB. It exited 130 and recorded a cancelled terminal state:
0 ready tools, 12 unfinished, no independent audit. This is an interrupted
experiment, not evidence that a longer teach succeeds or fails at 90 minutes.
Do not resume it under changed code. Its evidence remains at
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-34-long/`.

## What happened before interruption

Initial discovery and planning took 11.01 minutes (26.47%); research and one
overlapping compiler draft took the remaining 30.58 minutes (73.53%). The
master had not begun post-research review. The run selected 50 recording
requests, compared with Flights33's 38, so the two runs are not a controlled
comparison of timeout alone.

Five API research handoffs were proven: location search, location details,
one-way search, round-trip search, and multi-city search with bags. Four were
partial: round-trip date grid, basic multi-city search, multi-city by carrier,
and multi-city by time. Round-trip and multi-city booking research were
factually blocked; one-way booking research was still running. The multi-city
with-bags tool entered draft compilation, but no compilation or publication
completed. Transport-level HTTP 200 responses were not treated as semantic
success.

Booking was blocked by missing **intermediate selection context**, not by a
provider-capacity rejection. The round-trip researcher found that the fresh
search output had only the initial outbound-choice state and lacked the return
leg needed for GetBookingResults. The multi-city researcher found that the
recorded booking flow has two staged selections: the first produces
second-leg shopping, and the second supplies both selected segments and fresh
opaque state. A booking consumer cannot validly use the initial search output
as if it were that later state. The run ended before the master could revise
the tool graph around these findings.

## Disk and memory

Free space fell from about 8.2 GiB at launch to 486 MiB at interruption. The
run's retained evidence was only 104 MiB. macOS created six 1 GiB swap files
and one 512 MiB swap file during the run (6.5 GiB total). Measured swap
allocation rose from 13,312 MiB at minute 31.5 to 14,848 MiB at minute 41.6.
This accounts for most of the free-space loss. The timing suggests system
memory pressure during parallel research, but these observations alone cannot
attribute all swap demand to Imprint rather than other running apps. No data,
recordings, logs, or swap files were deleted.

## Usage and next decision

The trace reports 41,204,467 input tokens, including 38,007,936 cache reads;
277,865 output tokens; zero reported cache writes; and no missing analyze-usage
span. At the accounting script's base API-equivalent rates, the estimate is
$33.5465984. This is not a measured invoice charge. The run retained 61
response records across backends and status codes, including failed requests.

Before another long teach, restore disk headroom without deleting evidence,
measure peak per-process memory and swap growth, and decide how to keep
parallel research within the host's actual memory capacity. Separately, the
agent-selected plan needs explicit intermediate selection tools or contracts
for booking. Those are conclusions from this run's recorded and fresh
evidence, not a site-specific runtime rule. No new teach was started.
