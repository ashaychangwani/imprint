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

## 2026-08-29 — Recovery checkpoint 3: trustworthy recording selection

### What changed

- Added one resolver for the recording used by a fresh teach.
- It chooses a valid combined recording when that recording already represents
  every current raw recording for the site.
- If a raw recording was added or changed, it creates a new combined recording
  with the shipped merge code before teaching starts.
- Freshness is based on the contents of the raw recordings, not their file
  dates. Touching a file therefore does not cause needless work, while changing
  its contents cannot be missed because an old date was preserved.
- A small sidecar records only hashes and counts. It contains no requests,
  cookies, storage, narration, URLs, headers, or secret values.
- Malformed combined files are preserved as diagnostic evidence but are skipped.
  No existing recording is deleted or overwritten.

### Why

Running `imprint teach <site> --agent codex` should not require the user to find
and pass a session path. It should use the most complete current evidence. The
experimental implementation sometimes selected an older combined file even when
a newer raw recording existed. Exact content hashes make that choice factual
without teaching the runtime anything about the site's meaning.

This checkpoint exports the resolver but does not change the public command yet.
The master controller will call it when the single teaching path is wired.

### Checks run

- Seven new recording-selection tests passed.
- Sixteen existing session-merge tests still passed.
- The changed source and test files passed the formatter and linter.

### Teach attempts

None. The public command still uses the shipped entrypoint at this checkpoint.

## 2026-08-29 — Recovery checkpoint 4: provider interruptions do not become artifact failures

### What changed

- Added one shared retry policy for temporary provider capacity, overload, and
  rate-limit failures.
- Retries use exponential backoff with jitter and never wait more than 30
  seconds between calls.
- The same logical LLM call stays alive until the provider recovers, the user
  cancels, or the caller's existing deadline ends. A caller-approved deadline
  extension updates both the retry clock and the agent's clock once.
- Schema errors, bad requests, authentication failures, authorization failures,
  and billing or quota problems return immediately instead of looping.
- Ordinary focused LLM calls and the in-process tool-using agent loop now share
  this behavior.
- Added the rule to `CLAUDE.md`; `AGENTS.md` already includes that file.

### Important boundary

The external Codex and Claude compiler subprocesses are not wrapped yet. A first
attempt restarted their entire compile after a capacity error, which would have
created a new agent over partial artifacts. That was removed before this
checkpoint. Those compilers may only gain this behavior through a real
same-session continuation. We will not label a fresh compiler as a retry.

The new master must also pass its cancellation signal and run deadline into
ordinary LLM calls. The shared layer supports both, but the legacy public teach
path does not thread them through every call.

### Why

Temporary provider unavailability says nothing about whether a generated tool is
correct. Turning it into a red tool or restarting compilation encourages agents
to repair good artifacts for the wrong reason. Backoff belongs in execution
mechanics, while artifact failures remain reserved for factual artifact checks.

### Checks run

- Sixty-two provider, LLM, and agent-loop tests passed.
- Thirty Codex, Claude, and teach compile regression tests passed.
- The changed files passed the formatter and linter.
- The full TypeScript type check passed during this slice.

### Teach attempts

None. The single master controller is not wired yet.

## 2026-08-29 — Design review: two prototypes rejected before commit

### What happened

- An initial editable-state prototype mixed plan edits, run status, artifacts,
  receipts, persistence, and resume handling into one 1,363-line file.
- Its tests passed, but an independent review found that it could resume work
  that had never reached a clean pause, overwrite newer state with an older
  copy, attach a plan to the wrong recording, and mark a run complete without
  proving the required checks had passed.
- It also encoded separate runtime operations for rename, merge, split, primary
  selection, parameter changes, and other master decisions.
- A separate body-explorer prototype was also rejected. It erased the
  difference between a JSON-encoded string and an actual JSON object, and its
  comparison limit did not stop traversal when promised.
- Neither prototype was committed. Both were removed from the working tree.

### Why

Passing tests are not enough when the tests preserve the wrong behavior. The
first prototype recreated the unsafe resume pattern this rebuild is meant to
remove, and it made the runtime interpret too many kinds of agent decisions.
The second could give an agent false evidence about the exact request encoding.

The replacements are deliberately smaller. The master supplies a complete
desired plan instead of asking the runtime to perform a special kind of edit.
Body inspection will preserve the exact encoding and will extend the shipped
evidence tools rather than becoming a second parallel subsystem.

### Teach attempts

None. These prototypes never reached the public command and were rejected
before a checkpoint commit.

## 2026-08-29 — Recovery checkpoint 5: a small editable teaching plan

### What changed

- Added a 411-line, site-neutral teaching-plan module. The master supplies the
  complete desired plan on every revision; the runtime does not implement
  separate rename, merge, split, parameter-edit, or repair operations.
- Each tool has a stable internal identifier, its proposed public definition,
  exact content hashes for its evidence, a focused compile context, and the
  master's API-or-playbook-fallback choice with a plain-language reason.
- An accepted implementation plan is tied to the exact compile inputs it was
  based on. If parameters, request scope, evidence, focused context, or strategy
  changes, the old implementation plan is rejected as stale.
- A plan change reports three mechanical effects: tools that need a new plan,
  tools whose compiled artifact is stale, and downstream tools that need new
  verification. A changed producer does not force an unrelated tool to compile
  again.
- Explanatory changes such as confidence, rationale, primary selection, or a
  clearer strategy reason do not invalidate working code.
- The plan is bound to the run's exact site, recording hash, and request/event
  sequence numbers. References must be normalized, workspace-relative paths and
  carry content hashes.
- Every revision carries the master's accepted, rejected, or revised decision
  and why. The later immutable store will link all revision snapshots into the
  durable decision history.

### Why

The master needs freedom to replace the whole proposal when the evidence changes.
The runtime only needs to compare the previous complete proposal with the next
one and say what factual work became stale. Tying an implementation plan to its
inputs prevents the exact failure where changed parameters are compiled using an
older agent plan.

The API/playbook choice is written by the master, not inferred by a site rule.
That choice gives the runtime just enough information to make browser replay
`not applicable` while still requiring real browser contract and live checks.

### Checks run

- Twenty-one focused plan tests passed with sixty-nine assertions.
- The changed files passed the formatter and linter.
- The full TypeScript type check passed.

### Important boundary

This checkpoint is the pure plan and change calculation only. The immutable
on-disk store, artifact manifests, check receipts, paused-only resume, and final
completion gate are deliberately separate work. No public command uses this
module yet.

### Teach attempts

None. The master controller is not wired yet, so a teach would not exercise this
checkpoint.
