# Shared research and adaptive concurrency — implementation checkpoints

The approved September 22 plan replaces a fixed two-worker limit with adaptive
admission starting at ten. Agents choose separate tools for materially different
inputs/dependencies; no use-case schema is planned. They will share concise,
evidence-backed findings within the current run using the existing journal.
GPT-5.6 Sol screened shared-memory projects above 1,000 GitHub stars; no external
dependency was selected because the useful small stores duplicate local storage
without supplying Imprint's immutable evidence bindings.

Continue `codex/imprint-master-v066-validation`. No push, MR, merge, cron, dashboard
changes or deletion. Original recordings and failed evidence remain private.
Power is not a launch gate. Check disk and evidence paths before each experiment.

## Checkpoint 1 — implemented, fresh validation pending

`TeachScheduler` owns focused work and provider admissions for a fresh teach.
Three distinct capacity failures within sixty seconds halve the limit, down to
one. It waits thirty seconds after reduction, honors longer explicit provider
Retry-After delays, ignores duplicate/old-generation failure reductions, and
probes upward by one after sixty healthy seconds and five successes when work
is queued. Existing calls drain. Parents awaiting focused child waves yield
their worker slots; provider backoff yields permits without resetting history.
Master/reviewer calls use provider admission and optional advisors share workers.
Website failures and deterministic provider errors do not reduce capacity.

The journal-adjacent `scheduling.jsonl` stores admission/release times, queue waits,
limit changes and their reasons. A write failure explicitly reports unavailable
scheduling measurements instead of stranding active calls. No site semantics or
proof acceptance rule changed. The earlier coordinator-repair fix remains intact.

Focused regression coverage includes reductions down to one, recovery, cancelled
queues, deadlines, longer retry delays, nested retry deduplication and shared
worker/provider admission. The controller integration includes nested planners
and optional advisors. README, architecture, landing page and reteach skill reflect
the user-approved change. This is not a claimed live reliability improvement yet.

## Next validation

Flights 14 started at 08:42:13 UTC on runtime `a8601a5`, using a new isolated
home and the original recording/scope. Teach PID 45458; inspected driver PID 45442.
Target 09:12 UTC, assess 09:42 UTC, hard deadline 10:12 UTC. No runtime or prompt
edits are permitted during this experiment; documentation may record progress.

The user added a complexity bound while this run started: permit **at most five
adaptive-scheduler bug-fix rounds**, each with a fresh teach, then remove adaptive
scheduling if it remains problematic. Current count: **0 of 5**; Flights 14 is
the initial validation. Fall back sooner if complexity is not justified. Preserve
all unrelated fixes and evidence. The fallback is a static four-worker limit,
then three and two if concurrency/provider-capacity failures persist. Diagnose
unrelated request/parser/proof failures separately rather than claiming that lower
concurrency repairs them. Every fallback setting gets fresh validation and its
own recorded configuration; never reset or resume this failed run to compare it.

Private evidence root:
`/Users/ashaychangwani/.imprint/experiments/reteach-systemic-2026-09-21`.
Original Flights/Hotels recordings were verified; disk has 11 GiB available.
The existing collector on 6443 was inspected and responds ready.
Use the inspected `run.py` with a new unused `flights-14` home after committing:

```sh
python3 /Users/ashaychangwani/.imprint/experiments/reteach-systemic-2026-09-21/run.py flights-14 google-flights
```

Keep the original recording and four-operation guidance. Target thirty minutes,
assess at sixty, enforce ninety; strict audits retain forty-five minutes. Retain
all failed attempts and accounting, including missing usage. Inspect scheduling
events along with model spans; a run without capacity failures does not exercise
live reduction/recovery. Tests cover the controller policy independently.

## Remaining checkpoints

2. Persist each response immediately, with attempt/backend/request identities and
   bounded failed-response inspection. Preserve completed-chain compatibility.
3. Agent-selected separate tools, revised recording associations, early advisor
   evidence, and a run-local publish/list/read findings interface. Share findings
   and immutable artifact references, never substitute sibling proof or old tokens.
4. SDK terminal completion and bounded cleanup, plus agent-requested delegation
   and integration through the shared scheduler. Prioritize queued research over
   speculative drafts and preserve reusable work.

Each checkpoint requires focused regressions, affected integrations, lint/type
checks, documentation, timeline, commit and a fresh Flights teach. Do not resume a
failed run under changed code. Reproduce deterministic blockers before the smallest
general correction. No site-specific execution or prompt fixes.

Acceptance remains two fresh audited Flights teaches covering location/search/
calendar/booking, then two Hotels destination/date teaches and audits on unchanged
code. Agents may split tools, so exact tool count is not the scope definition.
Attempt recorded variants on a best-effort basis, report exclusions, and verify
every advertised tool independently. Guest count stays excluded until demonstrated.
