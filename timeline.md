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

## 2026-08-29 — Design review: three working drafts sent back

### What happened

- A bounded body-inspection draft passed 174 focused tests, formatting, and the
  type check. An independent hostile-input review still found that it could
  label an echoed user value as server-produced, show that value automatically,
  lose JSON-string and form-encoding differences, expose data placed in object
  keys, and do too much work on repeated form fields. The draft was returned for
  a site-neutral, value-free replacement. It has not been committed.
- The first set of small master/advisor agents passed its own tests, but review
  found that their outputs could cite invented recording positions, create
  dependency loops, rely on unbounded evidence text, and approve completion
  without being tied tightly enough to current check facts. That version was
  replaced in the working tree and is undergoing a second independent review.
- The first immutable-store draft passed its original tests, but a two-writer
  probe proved that one process could erase another process's receipt. Other
  probes showed that caller-provided recording positions, incomplete artifacts,
  arbitrary detail files, and an unsupported completion pass could be accepted.
  The corrected first pass grew to nearly two thousand lines, so it was also
  discarded before handoff. Its replacement will use one write lock and a chain
  of complete immutable snapshots instead of a new event/recovery framework.

### Why

A green test suite only proves the cases the suite contains. These failures
would recreate the exact problems this rebuild is meant to remove: the runtime
guessing at meaning, hidden evidence loss, unsafe continuation, and a large state
machine that is hard to reason about. Keeping them out of git makes the last
accepted checkpoint a genuinely safe recovery point.

### Decision made

- Automatic evidence remains factual and value-free. When exact paths or
  redacted values are genuinely needed, the agent must request a small,
  explicitly scoped view.
- A response/request match will be reported only as a match. The runtime will
  not call it a minted token, authentication state, or user input.
- Completion must be tied to the exact current plan, artifacts, checks, and a
  fresh independent review attempt. A caller cannot manufacture a passing
  review record.
- Persistence will use the smallest mechanical design that provides one writer,
  immutable history, and exact stale-write detection. It will not grow a list of
  teaching operations or recovery rules.

### Teach attempts

None. The public command still points at shipped Imprint, and none of these
working drafts is a valid new teaching flow yet.

## 2026-08-29 — Recovery checkpoint 6: the master chooses tool priority

### What changed

- Removed the rule that an editable teaching plan must contain exactly one tool
  marked as primary.
- Kept the `primary` flag as optional agent advice and display information. A
  plan may contain no primary flags or several of them without the runtime
  rejecting otherwise valid tools.
- Kept the mechanical checks for unique tool identities, real recording
  positions, valid evidence hashes, known dependencies, and dependency cycles.

### Why

Choosing the most important tool is a judgment call. It should not stop a teach
run or force the master to rewrite a sound proposal just to satisfy a runtime
count. The master can explain which advice it accepted when it finalizes the
tool set.

### Checks run

- All 21 editable-plan tests passed with 69 assertions.
- The changed files passed formatting, linting, and the whitespace check.

### Teach attempts

None. The new foreground master controller is not connected yet, so a teach
would still exercise the shipped controller rather than this plan.

## 2026-08-29 — Recovery checkpoint 7: small agents with exact facts

### What changed

- Added four narrow agent roles around the editable plan: one advisor reviews
  tool boundaries, the master makes the editable decision, one advisor reviews
  a verified tool's public parameters, and a fresh reviewer checks the proposed
  final outcome.
- The tool advisor receives request and event boundaries but not authentication
  notes or parameter guesses. The parameter advisor receives only its target
  tool, the checks for that tool, and any producers feeding it. Unrelated tools
  are left out of these prompts.
- Agent replies use strict, current examples and reject missing, extra, stale,
  or invented fields. Unknown detector parameter details remain explicitly
  unknown instead of being guessed.
- The master can keep, remove, merge, split, or revise tools and parameters. A
  recording with no honest candidate can remain an empty plan and be reviewed
  as blocked instead of forcing a fake tool.
- The master prompt now says every API rung outranks the playbook fallback. It
  may choose the fallback only when the supplied evidence makes it certain that
  no API rung is compatible; the runtime does not make that choice.
- Current checks bind to the exact recording, compiled files, implementation
  plan, dependencies, and ordered replay requests. API replay reports every
  target, including the unchecked remainder after a failure. Browser replay is
  recorded as not applicable and cannot contain fake request comparisons.
- A host failure after one or more successful request comparisons preserves
  those successful facts. The runtime no longer rewrites the whole replay as
  if nothing had been checked.
- Receipt identifiers and file references are unique across all current tools
  and cannot reappear in older history. This prevents an old receipt from being
  mistaken for a current one.
- Agent calls now share the teach run's absolute deadline. Output parsing and a
  one-time schema repair remain inside that same deadline, and an already
  expired run makes no provider call.
- The final reviewer sees the exact current checks plus a bounded view of the
  immutable older check history. Completion still requires current contract,
  replay where applicable, live, and producer-consumer checks. A blocked result
  requires evidence for every blocker claim.

### Why

The master needs semantic freedom, while the host needs to know that every fact
belongs to the current recording and current files. These contracts enforce
identity, file hashes, ordering, deadlines, and check truth without deciding
what a website means or how many tools it should have.

Two review rounds found and removed subtle false assumptions before this
checkpoint: replay originally erased successful work before a later host error,
representative requests could point outside their tool, receipt identifiers
could be reused, and parsing could finish after the run deadline. The focused
prompt views also keep the small advisors from inheriting the master's entire
context.

### Checks run

- Eighty-one focused plan and agent tests passed with 265 assertions.
- The semantic files passed TypeScript checking, formatting, linting, and the
  whitespace check.
- Canonical examples embedded in all four prompts parse with their real output
  schemas.

### Important boundary

This checkpoint defines the agent roles and factual contracts only. The new
on-disk store and foreground controller are not connected yet, so production
teaching still does not call these roles. That integration is the next stage;
this checkpoint is intentionally recoverable on its own.

### Teach attempts

None. Running a teach now would still use the shipped controller and would not
validate this new path.

## 2026-08-29 — Recovery checkpoint 8: write down the responsibility line

### What changed

- Replaced the remaining project guidance that described values using runtime
  labels such as “browser-minted.”
- Wrote down the simpler boundary used by this rebuild: agents choose tools,
  parameters, request groupings, state use, authentication, and API versus
  browser strategy; the runtime protects files and secrets, executes checks,
  retries providers, and records exact facts.
- Kept API-first and playbook-last as advice in the teaching prompt, not as a
  runtime decision.

### Why

The old wording could encourage a future change to rebuild the same growing
classification system that made vNext brittle. A path, byte length, match, or
mismatch is a fact. What that fact means belongs to the teaching agents.

### Teach attempts

None. This is project guidance only; the new foreground controller is still not
connected.
