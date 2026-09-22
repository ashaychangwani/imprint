# Reliability checkpoints — September 22, 2026

Continue `codex/imprint-master-v066-validation` in the existing validation worktree.
Checkpoint 1 repairs newly exposed semantic-output errors without accepting invalid
output. It passes 199 focused tests, lint, type checking and website checks.
Fresh teach effectiveness is **unvalidated**. Remaining checkpoints: failed-chain
response retention, selected wire evidence, SDK terminal handling, candidate
references and draft scheduling. Optional optimizations stop once acceptance is met
unless measured latency still warrants them. See the approved conversation plan.

Historical preflight at 05:40 UTC September 22: laptop at 10% on battery, approximately 41 minutes
remaining; fresh teach paused pending adequate power. Disk 13 GiB. Both original
recordings exist. No active teach/audit. Existing local trace collector PID 30590
is listening on 6443; verify export/retention before use. No cron was created.

Private campaign root:
`/Users/ashaychangwani/.imprint/experiments/reteach-systemic-2026-09-21`.
All earlier failures, recordings and dashboard files remain unchanged. New local
screenshots are `coordinator-repair-desktop.png` and `coordinator-repair-mobile.png`.
Regression log: `coordinator-repair-checkpoint-tests.log` in that root.

The user explicitly instructed proceeding on battery; power is no longer a launch
gate. After verifying space, collector and no concurrent live work,
start a new unused `flights-13` home with the already inspected driver:

```sh
python3 /Users/ashaychangwani/.imprint/experiments/reteach-systemic-2026-09-21/run.py flights-13 google-flights
```

The driver uses the original recording, unchanged four-operation guidance, fresh
IMPRINT_HOME, 90-minute deadline, idle-sleep assertion, trace collection and a
commit/command manifest. Target 30 minutes and assess progress at 60. Audit with
`--strict` and 45-minute deadline if all four tools publish. Preserve every failed
attempt. Do not resume Flights 12 or load its generated artifacts into teachers.
Flights must pass twice, followed by Hotels destination/date tools twice, each
with an independent strict audit on unchanged code. No MR, push or merge.


Flights 13 started at 05:48:40 UTC on runtime checkpoint 620129d, PID 104,
with a fresh home and unchanged scope. Target 06:18 UTC, assess 06:48 UTC,
hard deadline 07:18 UTC. Trace collection is receiving the new run's events.
No previous run was resumed and no runtime changes are allowed during this run.


Flights 13 ended at the 90-minute deadline with two published tools and exit 1.
The coordinator format loop did not terminate it; a research report used the new
feedback successfully. Search provenance mismatch and the wrong producer token
consumed repair time. Independent search verification remained incomplete.
The strict partial audit `flights-13-audit` is running on unchanged 620129d against
location and calendar only. Finish and account for that audit before checkpoint 2.
Next implementation: per-request response retention and bounded inspection, using
the retained synthetic failed-chain reproduction. Start a fresh flights-14 after
that checkpoint's tests and commit. Power is not a launch gate per user instruction.


Partial audit completed: exit 2, inconclusive, two correct invocations and three
working parameters; calendar origin/destination untestable. Neither the displayed
100% on five graded units nor the two tools establishes a full strict pass.
Teach/audit processes exited. Proceed to checkpoint 2; no live work is active.
