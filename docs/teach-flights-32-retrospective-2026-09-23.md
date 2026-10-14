# Flights 32 retrospective — September 23, 2026

Flights 32 was a fresh isolated teach on `fe06474`, using the recorded session
and four required operation groups in `docs/teach-handoff-2026-09-07.md`.
It reached the 90-minute hard deadline with **0 ready, 7 not ready**, and no
independent audit. All evidence remains in
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-32/`.

The first-pass API research proved nine distinct operations, including fresh
producer-to-consumer calls for one-way, round-trip, and multi-city booking.
The master selected seven tools in two waves. It excluded the one-way search
and booking tools because recorded request 206 has no captured response body;
the available one-way UI evidence cannot serve as a comparable parser fixture
or complete browser fallback. That is an explicitly documented coverage limit,
not a successful one-way tool. The selected seven covered location, search,
date grid, and booking through round-trip and multi-city paths.

The journal opened at minute 77.5. This confirms that the `jsonRef` snapshot
fix prevented Flights 31's bootstrap-reference mismatch in a real run.
Compilation began at minute 87.7 for three first-wave tools. The provider
deadline stopped all three at minute 90 before any tool was ready. No provider
capacity error, machine shutdown, or disk exhaustion caused this failure.

The dominant cost was repeated focused planning. Research ran from minute
22.4 to 52.8. The first planner proposals completed between minute 43.8 and
71.8, then the master took 5.7 minutes to select a seven-tool plan. That plan
changed fields in every accepted proposal and retained none of their exact
`implementationPlan` bindings. Some changes were substantive, including
public parameter wording and selected request sequences; others changed only
descriptive notes or strategy rationale. Imprint correctly discarded the
stale bindings and ran seven planners again from minute 77.5 to 83.4. A second
master decision then consumed 4.4 minutes. The compiler had only 2.3 minutes.

Sequential macro timing: initial discovery/advice/plan 22.42 minutes
(24.91%); first-pass research and overlapping drafts 30.43 minutes (33.80%);
review, repeated planning, and unfinished compilation 37.18 minutes
(41.29%). Native assignment dispatch median was 32.29 seconds initially and
61.68 seconds for follow-ups; these sums overlap other work. Twenty successful
fetch responses were retained. Trace usage reports 46,695,195 input tokens,
including 42,856,832 cache reads; 254,599 output; zero reported cache writes;
no missing analyze usage; and an estimated $37.5881648 base API equivalent.

The next general correction is to ask the master to carry an accepted focused
proposal's complete tool and implementation-plan reference unchanged, placing
explanation in its decision reason. A genuinely changed contract still needs
replanning and exact proof. This is prompt guidance, not automatic runtime
rewriting; a fresh teach is required to learn whether it saves time without
weakening verification.
