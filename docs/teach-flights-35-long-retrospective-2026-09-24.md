# Flights35-long retrospective — September 24, 2026

Flights35-long was a fresh isolated teach on the same Imprint implementation
used by Flights34 (the launch manifest names docs-only commit `9ccf133`). The
90-minute override was absent; the driver and Imprint allowed 12 hours. The
run ended by itself after 55.90 minutes with exit code 1, zero ready tools,
four not ready, and no independent audit. Its evidence remains at
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-35-long/`.
Disk was not the cause: 7.3 GiB was free after failure. The run ended before
the former 90-minute deadline.

Discovery and planning took 10.03 minutes (17.94%). First-pass research and
overlapping draft work took 23.17 minutes (41.46%). Master review, follow-up
research, and focused planning took 22.70 minutes (40.60%). Location search,
one-way search, date grid, and one-way booking API research were proven;
round-trip search and booking were partial, multi-city search was partial, and
multi-city booking was factually blocked. The master chose four tools in two
waves. The teach then stopped on the first focused planner; no tool reached
final compilation, live verification, or publication.

The immediate error was `focused planning failed for 1 of 1 tools` for
`search_one_way_flights`, followed by `Native agent acknowledged before
completing its host-validated pass`. The retained planner conversation shows
three host steps. Its first plan proposed only a live case; validation required
`recordedCall`. Its second plan linked the live case to recording request 206,
which has no captured response body, and added a replay case. Validation
rejected both the missing body and an unmatched recording/live pair. A third
repair input was delivered, but the native child never called the host
`respond` tool for that step. Instead it submitted its first JSON plan through
the family-level `submit` tool. The host correctly did not accept it as proof,
but the bridge treated the premature acknowledgement as a terminal error and
failed the entire teach.

This exposes two general issues. First, the native assignment bridge allows
family-level submission while a host-validated step is still pending; it
should reject that submission with the current step and retain the agent
conversation for repair. Second, the API verification contract currently
requires a recorded response fixture even when the selected recording has
only the request and a fresh comparable live call succeeded. The master must
either avoid selecting that capability or the contract must represent a
clearly labeled live-only verification path with recording-request provenance
and no claim that the parser was checked against a missing body. Recording
parser proof must never be fabricated. This run does not establish whether a
different comparable recorded response exists elsewhere in the recording.

The trace reports 33,133,707 input tokens, including 30,389,376 cache reads;
228,671 output tokens; zero reported cache writes; and no missing analyze
usage span. The accounting script estimates $27.7064944 at base API-equivalent
rates, not an invoice charge. It retained 29 HTTP 200 response records across
fetch and CDP replay; transport success did not establish publication. No
new teach was started after this failure.
