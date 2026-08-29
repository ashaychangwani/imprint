# Master-Driven Teach Rebuild Timeline

This file is the plain-language record of the rebuild. It explains what changed,
why it changed, and what happened in every teach attempt. Each meaningful entry
is committed on `codex/imprint-master-v066`, so `git log -- timeline.md` can be
used to find a recovery point if the work starts heading in the wrong direction.

## Working rules

- Start from the shipped Imprint `v0.6.6`, not from the experimental vNext code.
- Keep the existing vNext worktree untouched as reference only.
- Let agents make judgment calls. Keep the runtime focused on mechanical jobs
  such as protecting secrets, checking file formats, replaying requests, and
  reporting exactly what happened.
- Do not add rules for Google Hotels, Google Flights, Southwest, or any other
  individual site.
- Make decisions editable. The master may change proposed tools, parameters,
  request groups, or authentication plans when later evidence shows a better
  answer.
- Give each focused agent only the evidence it needs for its job.
- After any code or prompt change, start a new teach run. Never continue an old
  failed run with new code.
- Keep every teach unsteered while measuring it. Monitoring is allowed; silently
  helping the master would make the result unfair.
- Record every teach attempt below, including the exact recording, command, run
  identifier, result, verification result, and any conclusion drawn from it.
- Commit small, working checkpoints. Do not wait until the whole rebuild is done.

## Goal

Build one master-led teaching flow on top of the reliable parts of shipped
Imprint. Small agents will handle focused discovery, planning, compilation, and
review work. The master will decide between their suggestions and may revise a
decision later. The runtime will validate and execute those decisions without
trying to encode every possible website behavior.

Then run fresh, unsteered teaches for Google Hotels and Google Flights. Run
Southwest too if time and available recordings allow it. The target is roughly
80% or better functional accuracy, with successful checks and useful coverage,
not a score achieved by weakening verification.

## 2026-08-29 — Recovery checkpoint 1: clean starting point

### What happened

- Created a separate worktree at
  `/Users/ashaychangwani/.codex/worktrees/imprint-master-v066`.
- Created branch `codex/imprint-master-v066` from shipped tag `v0.6.6` at commit
  `5675aa7`.
- Installed the locked dependencies and ran the existing type check. It passed.
- Confirmed that the experimental vNext worktree remains separate and unchanged.

### Why

The recent experimental branch mixed useful ideas with a much larger replacement
of the teaching system. Starting from the shipped release gives us the known,
more reliable compiler and evidence pipeline. We can then add only the flexibility
and supervision that were missing, one checked change at a time.

### Decisions made

- The old saved teaching state will remain readable only for diagnosis. It will
  not be resumed by the new flow because its decisions may no longer match the
  code or prompt.
- The new editable plan will be the source of truth. A changed producer will make
  its dependent tools require new verification, but unrelated tools will remain
  valid.
- Suggestions from discovery and review agents will not change anything by
  themselves. The master must accept or reject them and record a simple reason.
- Existing generated-tool file formats and recordings will stay compatible.
- We will reuse the shipped focused evidence and compiler instead of copying the
  large vNext teaching runtime.

### Teach attempts

None yet. The implementation has not changed, so a teach at this checkpoint would
only repeat shipped `v0.6.6` behavior and would not test the new design.

## 2026-08-29 — Recovery checkpoint 2: factual request comparisons

### What changed

- Added a value-free comparison report for a generated API request and its
  recorded source request.
- The report checks in the real stop order: headers, method, origin and path,
  full URL and query, then body.
- When one comparison fails, every later comparison is marked `not_checked`.
  This prevents an unexamined field from looking as though it passed.
- When `request-transform.ts` owns the final URL or body, those comparisons are
  marked `not_applicable` instead of failed.
- A mismatch reports byte lengths, its first byte position, and—when both bodies
  are JSON—the first differing path and the two data types. It never includes
  the recorded values themselves.

### Why

The earlier experimental teach only reported “body mismatch.” That hid which
earlier comparisons had actually passed and gave the agent too little evidence,
so it guessed at several encodings and eventually abandoned a usable API route.
The runtime should report mechanical facts precisely, then let the agent decide
what those facts mean.

This checkpoint adds the comparison data only. A later checkpoint will store it
in immutable check receipts and pass those receipts to the master and final
verifier. It does not add a repair rule or make a semantic decision.

### Checks run

- Five focused request-comparison tests passed.
- The changed source and test files passed the formatter and linter.

### Teach attempts

None. This helper is not yet connected to the master teaching flow, so a fresh
teach would not exercise it honestly yet.
