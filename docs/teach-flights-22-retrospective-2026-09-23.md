# Flights22 fresh teach retrospective — September 23, 2026

Flights22 used the original September 4 recording in a new isolated home on
`5d3eefa`. It ended at the 90-minute deadline with **0 ready / 9 not ready**;
there was no published tool to audit. Raw evidence is retained under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-22/`.

The recording-purpose correction worked at planning: one-way used selected
request 206, while request 245 remained with multi-city. The one-way researcher
later substituted a recorded document navigation for execution, explicitly
explained how its captured background response related to request 206, and
reported uncertainty. The shared-research interface was used: eight findings
were published with separate detail assets; agents made six targeted reads and
one list request. No detailed assets were pushed into every agent's automatic
context.

Research produced useful but incomplete evidence. Location lookup compiled as
an early draft, one-way search and one-way booking had proven live research,
multi-city search proved a fresh selected first-leg to later-leg continuation,
and the fare grid proved a narrowed two-dimensional response. None had passed
the normal final publication checks. Round-trip search remained partial because
its caller-directed selection state was not wired to normalized output.
Round-trip booking consequently lacked a proven matching producer. Multi-city
booking consumed a fresh AS1307→UA1827 chain with token, adjacent serialized
context, and ordered legs, but fetch and CDP each returned Google batchexecute
protocol error 13 without booking records. Calendar picker remained partial.
These are semantic/contract and site-protocol failures, not disk, power, or
provider-capacity failures. The run logged no native-family errors.

Measured wall time: initial discovery/advice/plan 21.56 minutes (23.95%);
first-pass research with overlapping draft work 28.15 (31.27%); master
revisions, follow-up research, and attempted later stages 40.31 (44.78%).
No final compilation or verification occurred. One-way booking became proven
about 16 seconds before the deadline; a new calendar research pass then hit
the provider deadline. The master kept all nine selected boundaries through
research review, so partial purposes continued to hold final planning even
though the user allowed difficult recorded variants to be abandoned with
documented evidence. An optional early one-way planner acknowledged before its
host-validated response; the controller rejected that draft and retained the
research, so it did not cause the terminal failure.

The trace reports 42,245,396 input tokens, including 39,021,184 cache-read
tokens, 274,110 output tokens, zero reported cache-write tokens, and an
estimated $33.9875216 base API equivalent. There were zero missing analyze
usage spans. Cache writes not reported by the trace remain unknown; the estimate
excludes subscription accounting, long-context surcharges, service tiers, and
tool fees. Failed responses, logs, and recordings remain in place.

The smallest general correction is to tell the master to keep separate
user-purpose tools when selected, but after an evidence-backed attempt to defer
a difficult purpose when the user permits best-effort variants and the remaining
plan still covers every explicitly required operation group. It must record
what was excluded and avoid claiming the MVP covers it. This is an agent scope
decision, not a site-specific runtime rule. Validate this prompt change with a
new isolated teach; Flights22 must not be resumed under changed code.
