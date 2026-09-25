# Flights45 retrospective — September 25, 2026

Flights45 ran for 261.7 minutes on `d9433bf` without a teach deadline. It was
stopped deliberately before another revision because its accepted plan could
not prove a fresh producer-to-consumer booking call. Seven tools reached the
built-in usable-MVP gate; round-trip search, round-trip continuation, round-trip
booking, and multi-city booking were unfinished. No independent external audit
ran, so this attempt is not a Flights pass.

Evidence is retained under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-45-unbounded`.
The run ID is `8034b91e-fe8f-4e2d-ba48-096a109992ef`.

The next-leg recording contains four ordered response snapshots. An initial
evidence pass froze the order from stage 2, while the later complete stage 3
snapshot moved AS36 ahead of AS24. The compiler changed its parser to satisfy
that stale expectation. A second independent pass inspected the final frame,
rejected the stage-2 parser, and the retained compiler restored final-frame
selection. The repaired tool passed semantic and MVP review and published.
This recovery worked, but repeated evidence derivation and compilation added
many minutes.

The round-trip plan paired recorded October 12 outbound travel with live
October 15 travel, even though October 12 remained in the future. Independent
verification correctly marked the pair incomparable. The compiler correctly
refused to repair this planner-owned case. A focused planner eventually returned
an October 12 live case; the attempt was stopped before that revision was
verified.

Multi-city booking research tested a selected two-leg itinerary and obtained
seller and handoff data. Its generated parser then omitted two recorded
leg-specific condition descriptors, so independent semantic review failed.
More seriously, the accepted live verification case copied the exact opaque
token from the earlier research observation. The plan declared a dependency on
`get_multi_city_next_leg_flights` but had no chain edge into booking. The live
response and parser check therefore did not prove a fresh generated-tool chain.
Other accepted dependent tools also lacked chain edges. This is a general plan
consistency defect, not a Google Flights transport failure.

The next checkpoint makes an accepted implementation plan require an executable
edge for each declared producer dependency. Agents may remove a dependency
that only ordered research; when a live value truly flows, they must expose a
scalar producer result and bind it. The runtime checks the declared relationship
without choosing a tool boundary, input, or result path.

The trace reports 89,266,984 input tokens, including 84,524,416 cache reads,
440,501 output tokens, zero reported cache writes, and a $61.5900584 base
API-equivalent lower bound. Seven analysis spans lack usage, so total cost is
not fully measured. The run remained active until the deliberate SIGINT; disk
had about 2.9 GiB free at the stop, and neither sleep nor power interrupted it.
