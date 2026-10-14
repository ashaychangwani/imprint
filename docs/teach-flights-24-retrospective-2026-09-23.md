# Flights24 early-stop retrospective — September 23, 2026

Flights24 used the original September 4 recording in a fresh isolated home on
`0a38711`. It was stopped with SIGTERM after 16.74 minutes, before any live
response, because the master accepted a tool list that merged materially
different recorded tasks. The stopped run is retained under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-24/`; it must not
be resumed under changed prompts.

The advisor proposed `search_flights` across one-way, round-trip, and
multi-city recorded searches, and `get_flight_booking_options` across their
three booking flows. The master's accepted reason said these share the broad
goals of finding itineraries and retrieving booking options, and called their
different trip structures parameter variants. That would collapse distinct
caller tasks and continuation contracts into two public tools, contrary to the
requested purpose-specific boundaries. The run was stopped immediately after
this decision rather than spending the remaining budget on an invalid plan.

The existing boundary prompts said that a mode *can* be a distinct purpose,
but also allowed merging when operations share a user goal. Flights24 shows
that “searching itineraries” and “getting booking options” are too broad as
merging criteria. The next checkpoint asks the advisor and master to compare
the public contract and verification path: mode-specific request construction,
result meaning, or continuation obligations warrant separate tools even when
an endpoint or broad goal is shared. Research can still be shared underneath.
This is a site-neutral agent decision, not a runtime rule or fixed tool count.

Measured wall time was 15.99 minutes (95.51%) in discovery/advice/initial
planning and 0.75 minutes (4.49%) in just-started research. The run had no
native-family errors and no retained live responses. The interrupted trace
has no exported token-usage spans, so input/output tokens, cache reads/writes,
and cost for Flights24 are **unknown**, not zero. No tool was published or
audited. All evidence and older Chrome temporary profiles remain untouched.
