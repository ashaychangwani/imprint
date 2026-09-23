# Flights23 fresh teach retrospective — September 23, 2026

Flights23 used the original September 4 Google Flights recording in a new
isolated home on `8a58a54`. It reached the 90-minute deadline with **0 ready / 9
not ready** and exit code 1. No tool was published, so there was nothing to
independently audit. The complete failed run is retained under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-23/`; it must not be
resumed under changed code.

The first plan separated location search and details, one-way, round-trip and
multi-city flight search, their three matching booking consumers, and one date
grid. One-way search stayed on its one-way recording references rather than
borrowing a multi-city request. Location search and details, one-way search,
multi-city search, and round-trip search gained semantic live research proof.
Multi-city search proved a second recorded itinerary after its researcher found
the recorded click that emitted the matching API response. Round-trip search
proved fresh outbound and return choices, including a paired selection envelope.
These are research handoffs, not published or independently audited tools.

The date-grid researcher got a useful 7-by-7 initial date/fare response, but
its planned four arbitrary window bounds were contradicted by a later live
response: the departure rows matched while the return dates did not. The
researcher asked the master to narrow the public contract to the demonstrated
initial grid. The master had already spent a follow-up pass trying to retain
the unsupported bounds, and the run expired before it could revise the plan.

All three booking researchers eventually consumed fresh, matching search
results. Their direct GetBookingResults constructions still returned Google's
compact application error 13 despite HTTP 200. Round-trip used a coherent
AS1307 outbound and AS2498 return; its prepared body differed from the
recording only at the current choice token. Multi-city used a coherent AS24
second leg and identified the three changed body fields. One-way used a fresh
AS1307 selection and even rebuilt a matching booking Referer, but also got
error 13. Multi-city additionally tested browser transport without semantic
success. The remaining gap is a browser-owned booking action/session transition,
not merely a stale token or lost response. Flights22 had proved one-way booking
through a recorded page navigation and action-scoped capture, but that
successful approach was not rediscovered in Flights23 before the deadline.
Previous generated tools were not supplied to Flights23's agents.

The principal scheduling loss was a barrier wave: all search and grid tools
were in wave one, while all bookings were in wave two. One-way search was proven
at minute 38, but one-way booking did not resume with fresh output until minute
77, after unrelated round-trip, multi-city and grid follow-ups. The master
spent about ten minutes on the first research review and kept all nine tools;
final planning, compilation, verification, and publication never began. The
initial discovery/advice/plan took 20.69 minutes (22.98%); first-pass research
and overlapping draft work took 25.24 (28.04%); master review and follow-up
work took 44.10 (48.98%). One early location draft did not become a ready tool.

This was not a power, disk-exhaustion, provider-capacity, or lost-response
failure. The run had no native-family errors. Its response journal retained
22 fetch HTTP-200 responses, 19 CDP HTTP-200 responses, and four HTTP-400
responses across backends. Some CDP attempts did time out and cost tens of
seconds each. Free disk fell below 1 GiB during the run, while the run's own
evidence occupied about 73 MiB; approximately 5.8 GiB of older Imprint Chrome
temporary profiles remain untouched under the system temporary directory.

The trace reports 44,971,894 input tokens, including 41,388,544 cache-read
tokens, 284,153 output tokens, zero reported cache-write tokens, and zero
missing usage spans. The estimated base API equivalent is $36.5718776. This
estimate excludes subscription accounting, long-context surcharges, service
tiers and tool fees; cache writes unreported by the backend remain unknown.

The next checkpoint makes three small, general agent-guidance corrections:
after a coherent fresh dependent call fails with an application error, inspect
and test the recorded browser action before blocking; revise research waves so
a proven producer's consumer is not held behind unrelated partial producers;
and narrow a useful contract when recorded evidence does not establish optional
controls. These do not alter runtime proof rules. Validate on a new isolated
teach, not by resuming Flights23. A single later success would still not prove
repeatability or satisfy the independent Flights and Hotels audits.
