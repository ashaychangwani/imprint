# Flights 33 retrospective — September 24, 2026

Flights 33 was fresh on implementation commit `997bd9f` (the later `fa5cb0e`
commit changed documentation only). It used the September 4 recording, the
same four-operation guidance, an isolated home, and the 90-minute teach
deadline. It ended with **1 ready tool and 3 not ready**, no independent audit.
The process exited after 98.28 wall minutes because deadline cleanup took
about 8.3 minutes; this was not an extension of the semantic teach deadline.
Evidence remains under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-33/`.

The master selected location search, round-trip search, round-trip booking,
and the date grid in two waves. One-way search and booking research were
proven with a fresh producer call, but those variants were not in the final
four-tool plan. Multi-city search was partial and its booking handoff was
factually blocked. Only the selected round-trip path could fulfill the
required flight-search and booking groups in this run.

The accepted-plan guidance improved one measured bottleneck. First-pass
research ended around minute 39, and the first focused planner batch ended
around minute 50. The master retained the exact location and date-grid
implementation plans. It requested a second pass only for round-trip search
and booking, because their initial proposals lacked concrete same-itinerary
result paths for the booking chain. Those two planners returned by minute 54;
compilation began near minute 56, versus minute 87.7 in Flights 32. Different
triage and a narrower final tool set also contributed; this one run cannot
attribute the full speed change to the prompt edit.

Location search passed contract, live execution, semantic review, and was
published near minute 66. Round-trip search and date grid each had passing
contract and live receipts, but neither was published. Round-trip continuation
chain checking and date-grid result evaluation were still unresolved. The
master opened a revision from factual failures around minute 81, but the
deadline stopped it. Booking compilation never began because its producer
path had not cleared the earlier wave. Transport success alone therefore does
not establish those three tools as working.

Discovery/advice/initial plan took 16.60 minutes (16.89%), first-pass
research with overlapping drafts 22.27 (22.65%), and later review, planning,
compilation and unfinished verification 59.42 (60.46%). Trace usage reports
34,711,487 input tokens, including 31,893,888 cache reads; 251,291 output;
zero reported cache writes; and an estimated $29.0538 base API equivalent.
One analyze usage span is missing, so these totals and cost are lower bounds.
The journal retained fourteen fetch-200 responses and one fetch-400. No
provider-family capacity error, disk exhaustion, power loss, or internet
disconnect caused the terminal failure. The terminal provider-deadline message
was the configured teach deadline.

The user requested that the next fresh teach remove the 90-minute override.
Flights 34 long started separately with no CLI `--timeout`, using Imprint's
built-in 12-hour default and a matching one-shot driver ceiling. Do not resume
Flights 33 under changed timing or credit its unreviewed builds as audited
tools.
