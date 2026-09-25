# Flights47 retrospective — September 25, 2026

Flights47 used a fresh isolated home and recording on commit `5541720`. It ran
109.7 minutes and was stopped cleanly after a general runtime verification gap
was reproduced. The run published location lookup and round-trip date-grid
MVPs. Round-trip search and booking remained unfinished, and no external audit
ran. Its evidence is retained under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-47-unbounded/`;
the run ID is `72067db7-f9d7-48f2-b50c-239804b46ef1`.

The master chose four tools covering the required operation groups. API
research demonstrated a fresh SJC–SAN–SJC search and booking path: selected
AS 1307 and AS 432 produced a matching booking response with a USD 207 option.
The master also explicitly selected the round-trip continuation live case for
booking's producer edge. This confirms that the previous cross-tool case
selection fix reached the planner and avoided the default initial-search case.

Search verification exposed two separate facts. Its return-stage recorded
and live responses passed independent evidence evaluation, including complete
booking contexts. Its initial-stage comparison failed because the generated
parser returned a constructed `CBw...` context instead of the server's
recorded `CAIS...` selection value. The master correctly recalled the retained
compiler, which repaired the parser and request transform. Subsequent live
checks failed before the request left the host: the verification plan still
supplied the older static `CBw...` value to the continuation case. The runtime
ran that case before the initial case and had no interface for binding a fresh
result from one live case into another live case of the same tool. Further
compiler-only repairs could not alter the host-supplied test argument.

The general correction adds explicit `sourceCaseBindings` to live verification
cases. An agent names an earlier live source case, a concrete result path, and
the dependent parameter. Runtime execution supplies that fresh scalar and
retains exact case receipts. Unknown, later, non-live, or undeclared sources
are rejected. The fix adds no Flights-specific rule or public tool parameter.
It passed a focused same-tool end-to-end regression, schema regressions, the
full 2,073-test suite, lint, and type checking. It still needs a fresh teach
and independent audit; the interrupted run is not a successful teach.

The trace reports 59,971,802 input tokens, including 55,808,384 cache reads,
409,657 output tokens, and zero reported cache writes. One analysis span has
no usage record. The $47.1701656 base API-equivalent estimate is a lower
bound, not a final bill. Disk and power did not interrupt this attempt.
