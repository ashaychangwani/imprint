# Imprint teach retrospective — September 23, 2026

Window: **11:21–23:21 UTC** (04:21–16:21 Pacific). Flights 26 started before
this window and ended during it. Flights 27–32 started and ended within it.
Flights 33 started at 23:19 UTC and was still in discovery at the cutoff. The
user directed us to start **no teach after Flights 33**; let that already
started run finish and then stop the teach campaign.

## Outcome

Flights 27–32 were six fresh, isolated 90-minute-class attempts on successive
commits. **None published a ready tool or reached independent audit.** Their
combined wall time was **537.57 minutes (8.96 hours)**. Flights 26 additionally
occupied about 65 minutes of this window; Flights 33 was ongoing. No Hotels
teach ran. There is therefore no repeatability or cross-site success claim.

| Run | Commit | Result and decisive blocker |
| --- | --- | --- |
| Flights 26 | `5a16bab` | 0/9 ready at 90m. One-way research was useful, but the initial recorded request was misclassified after a Multi-city click; planners started too late. The run began before this window. |
| Flights 27 | `73cda93` | 0/9 ready at 90m. Recording-purpose selection was corrected. Multi-city booking used a fresh selection, but date-grid and booking public inputs remained unproven; followups consumed publication time. |
| Flights 28 | `a99e80d` | 0/9 ready at 90m. Round-trip continuation waited on stable non-clickable DOM targets, then remained partial; date-grid inputs were narrowed only late. |
| Flights 29 | `ee126d6` | 0/8 ready at 90m. Followup research eventually proved round-trip continuation and one-way booking, but repeated large recording projections and long research turns left no publication window. |
| Flights 30 | `fb2bdd6` | 0/10 ready at 90m. Dependent researchers started before fresh producers; shared-memory lookup rejected a real run-local object. A separate late provider-capacity outage logged 34 retries until deadline. |
| Flights 31 | `767056b` | 0/11 ready at 87.43m. All research paths were proven and dependency scheduling worked, but journal creation rejected a mutable bootstrap seed before compilation. |
| Flights 32 | `fe06474` | 0/7 ready at 90m. Journal creation succeeded. The master changed all accepted planner bindings, causing a second seven-tool planner pass; compilation started at minute 87.7 and hit the deadline. |

The six complete in-window runs spent **122.20 minutes (22.7%)** in initial
discovery/advice/plan, **171.78 (32.0%)** in first-pass research with overlapping
drafts, and **243.58 (45.3%)** in master review, followups, planning and
unfinished compilation. Those are sequential wall phases. Per-agent intervals
overlap and must not be summed. Flights 32 gives a sharper critical path:
research ended at minute 52.8, first planner batch at 71.8, first master
decision at 77.5, second planner batch at 83.4, second master decision at
87.7, then 2.3 minutes of compilation. Its seven-tool plan omitted one-way
search and booking because recorded request 206 has no response body for a
comparable parser fixture; this is an explicit coverage gap, not a verified
one-way capability.

Across Flights 27–32, trace usage reports **275,889,499 input tokens**,
including **253,290,880 cache reads**, **1,821,717 output tokens**, **zero
reported cache writes**, and **$228.15 estimated base API equivalent**.
The cost is an estimate, not a subscription invoice; unreported provider-side
cache writes are unknown. Flights 26's full-run totals are excluded from this
in-window aggregate because it started before the window. No usage spans were
missing in the six completed traces.

## What changed and what was actually validated

Eight commits landed within the window. The action-linked recording projection
and candidate-reference provenance correction (`73cda93`) stopped the earlier
one-way/multi-city request mix-up in Flights 27. The narrow-MVP master guidance
(`a99e80d`) did not yet yield publication. The non-clickable-target correction
(`ee126d6`) was not exercised by Flights 29, so no speed claim follows. The
reference-only research followup (`fb2bdd6`) reduced observed followup inputs
from roughly 226–329k to 136–154k characters in Flights 30; that is a measured
context reduction, not an audited outcome. Producer-gated research and
run-local immutable memory reads (`767056b`) worked in Flights 31. The
bootstrap snapshot fix (`fe06474`) worked in Flights 32. Master guidance to
preserve exact accepted planner bindings (`997bd9f`) passed 2,059 tests, lint,
and type checking; Flights 33 is its first live validation and is unfinished.

The failure class was **not** a recurring computer shutdown or internet loss.
Disk was tight, reaching about 674 MiB free after Flights 30, but no run failed
for lack of space. Flights 30 had a genuine transient provider-capacity outage;
the existing retries did not recover before the run deadline. Google protocol
error 13 blocked some direct replays, while browser-owned API calls produced
useful live evidence in several runs. The dominant recurring architectural
problem was that research proof did not become a published, audited tool within
the deadline. Each run exposed a new boundary between research, planning,
journal creation, compilation, and verification. Flights 32 got furthest into
compilation, but still produced no usable artifact.

After Flights 33, stop fresh teach attempts as requested. Preserve every run's
evidence. Judge Flights 33 separately on published tools and independent audit,
not research handoffs. Before any later campaign, verify exact proposal reuse
and publication timing with focused integration fixtures; keep agent decisions
and invalid-proof rejection intact. If a future full teach is authorized, audit
Flights before repeating on unchanged code and only then resume Hotels. Do not
feed failed-run tools into a new teaching agent.
