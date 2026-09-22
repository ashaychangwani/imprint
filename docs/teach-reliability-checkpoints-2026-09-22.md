# Reliability checkpoints — September 22, 2026

Continue `codex/imprint-master-v066-validation` in the existing validation worktree.
Checkpoint 1 repairs newly exposed semantic-output errors without accepting invalid
output. It passes 199 focused tests, lint, type checking and website checks.
Fresh teach effectiveness is **unvalidated**. Remaining checkpoints: failed-chain
response retention, selected wire evidence, SDK terminal handling, candidate
references and draft scheduling. Optional optimizations stop once acceptance is met
unless measured latency still warrants them. See the approved conversation plan.

At 05:40 UTC September 22: laptop at 10% on battery, approximately 41 minutes
remaining; fresh teach paused pending adequate power. Disk 13 GiB. Both original
recordings exist. No active teach/audit. Existing local trace collector PID 30590
is listening on 6443; verify export/retention before use. No cron was created.

Private campaign root:
`/Users/ashaychangwani/.imprint/experiments/reteach-systemic-2026-09-21`.
All earlier failures, recordings and dashboard files remain unchanged. New local
screenshots are `coordinator-repair-desktop.png` and `coordinator-repair-mobile.png`.
Regression log: `coordinator-repair-checkpoint-tests.log` in that root.

After verifying adequate power, space, collector and no concurrent live work,
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
