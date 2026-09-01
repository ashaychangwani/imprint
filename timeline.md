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

## 2026-08-29 — Recovery checkpoint 9: exact byte positions stay exact

### What changed

- Request mismatch positions are now counted from the real UTF-8 bytes instead
  of JavaScript character positions.
- A workflow placeholder can match a recorded value containing a newline.

### Why

The verifier must report measurements without guessing or leaking the compared
values. A wrong byte position would send an agent to the wrong part of a request
body, while the newline bug could call a valid template a mismatch.

### Checks run

- The focused request-comparison tests passed, including Unicode and multiline
  cases.

### Teach attempts

None. These are factual comparison fixes; the new controller is still not
connected.

## 2026-08-29 — Design correction: fresh runs do not need a resume system

### What happened

- A second store draft fixed the data-integrity bugs found in the first one,
  but it still grew to about 1,360 lines of source and 1,090 lines of tests.
- Most of that code handled clean pauses, version compatibility, process
  ownership, linked history nodes, and restarting an interrupted run.
- Those features solve a problem the new flow deliberately does not have. A
  teach is a fresh foreground run, and code or prompt changes always require a
  new run.
- The large draft was rejected and remains uncommitted while it is replaced.

### Decision made

The replacement will keep only what a single fresh run needs:

- immutable files addressed by their content hash;
- one atomically written, checksummed current-state file;
- references to the current plan, builds, and check receipts;
- a simple list of older receipts for the final reviewer;
- factual invalidation when the master changes a tool or one of its producers.

There will be no resume state, pause status, compatibility hash, cross-process
writer lock, linked-list ledger, or runtime vocabulary for different kinds of
master edits. The foreground controller is the only writer. A separate small
site lock will protect final promotion, not teaching strategy.

### Why

Crash recovery is useful only if the recovered decisions still match the code,
prompt, recording, and evidence. That is the same unsafe continuation pattern
that let earlier failed runs keep correcting themselves in the wrong direction.
Keeping immutable diagnostic facts is valuable; restarting old teaching work is
not.

### Teach attempts

None. The fresh-run journal and foreground controller are not connected yet.

## 2026-08-29 — Provider interruptions no longer become tool failures

### What changed

- Claude and Codex compiles keep the same provider conversation when the
  provider reports temporary capacity, overload, or rate-limit trouble.
- Retries wait longer between attempts, add a small random delay, and remain
  inside the one teach deadline.
- Cancellation and deadline signals now stop the whole compiler process tree,
  including child processes that would otherwise keep the terminal open.
- A deadline extension is accepted only after the parent teach process records
  the decision. A child cannot extend itself or publish a late result after the
  parent has stopped it.

### Why

Temporary provider trouble says nothing about the generated tool. Turning it
into a schema, replay, or live failure taught the agent to repair code that was
not broken. Keeping the same conversation also avoids starting over after a
capacity interruption.

### Checks run

- The focused provider, control-file, process, and signal tests passed.
- Repeated signal and deadline stress runs passed.
- An independent review found and helped close several timing races before it
  marked this part clean.

### Teach attempts

None. These checks use synthetic provider processes; the new teach controller
is not connected yet.

## 2026-08-29 — Focused plans bind to exact recording requests

### What changed

- Each small planning agent now receives only one tool, its allowed evidence,
  possible producers, and the relevant current plan.
- Its plan records the exact recorded request used for each workflow request,
  in order.
- A generated workflow is rejected when it adds, drops, reorders, or silently
  substitutes one of those requests.
- Planning and master replies are tied to the exact input they saw, so an old
  reply cannot be applied after the master changes the plan.

### Why

The compile agent needs freedom to understand a protocol, but the host must be
able to prove which recording facts its files came from. Exact request order is
a file-integrity fact, not a judgment about what a field means.

### Checks run

- The focused planner and master contract tests passed.
- Deadline, stale-reply, request-order, and producer-consumer cases passed.
- An independent review marked this contract clean.

### Teach attempts

None. These contracts are not yet called by the public command.

## 2026-08-29 — The first small journal draft was rejected after review

### What happened

- The replacement journal was reduced to about 600 lines and passed its own
  tests, but an independent reviewer found gaps those tests missed.
- It could accept a workflow for the wrong site, lose the accepted public
  parameter list, refer to files outside the tool, trust missing shared files,
  or save a plan that referred to an object that was never written.
- Rebuilding a producer did not honestly mark its consumers stale, and an
  accidental browser replay could still throw an error instead of returning
  `N/A`.
- Error redaction depended on the caller remembering to pass secrets every
  time. File writes also needed stronger protection against partial files and
  symbolic-link aliases.

### Decision made

The journal remains uncommitted until those exact gaps are fixed and reviewed
again. The fixes stay mechanical: site identity, parameter identity, safe file
paths, exact file contents, current dependencies, browser replay applicability,
and complete error redaction. They do not add website meanings or teaching
strategy.

### Teach attempts

None. A journal that can mislabel current work is not safe enough to drive a
teach.

## 2026-08-29 — Restore exact artifact examples in the teaching prompt

### What changed

- Added complete, site-neutral examples for an API workflow, parser, request
  transform, request-free browser workflow, and browser playbook.
- The examples show exact parameter interpolation, request order and recording
  positions, locator fallbacks, result extraction, allowed files, file hashes,
  and a producer-consumer edge.
- Added the simple check order: API uses contract, replay, then live; browser
  uses contract and live, while replay is `N/A`.
- The prompt now tells the agent to rerun contract after every edit, route each
  failure from the fact that failed, and keep every API route above the browser
  playbook unless the evidence proves none can work.
- Removed the named-site playbook example and the blanket instruction to drop
  login steps. The playbook agent now follows the accepted authentication plan.
- Removed the fixed forty-tool-call exit. The focused agent works until success,
  a supported blocker, cancellation, or the shared run deadline.

### Why

Making the runtime smaller does not mean asking an agent to guess file formats
or operating procedure. The prompt must carry that knowledge, while decisions
about tools, parameters, authentication, and execution strategy remain with the
agents.

### Checks run

- Tests extracted the examples from the prompt and parsed both workflows and
  the playbook with the real production schemas.
- The parser and request-transform examples passed TypeScript syntax checks.
- A prompt test confirms the browser guidance stays site-neutral.
- Committed as `4d251d9`.

### Teach attempts

None. Prompt correctness is necessary, but the foreground controller still has
to call the new agents and checks before a fresh teach is meaningful.

## 2026-08-29 — Green tests did not overrule independent review

### What happened

- The compiler and secret-boundary changes passed 320 tests, full type
  checking, and full linting.
- A separate reviewer still found that real teaching credentials reached an
  agent shell environment, external compiler processes could discover the raw
  recording path, and later verification work happened after the supposed
  final secret scan.
- The raw-to-redacted comparison also missed original secrets in URL and body
  fields, and a changing raw file was not checked again after its first read.
- The journal passed 203 focused tests, but a separate reviewer found that an
  invalid plan could echo a known secret in an error, a foreign old build could
  corrupt state during rebinding, and a caller could mutate the validation
  sets after journal creation.

### Decision made

Neither part is accepted or committed yet. Their authors are fixing the exact
host-boundary and write-order gaps, with new reproductions. These fixes protect
files, credentials, and factual state. They do not add website classifications
or teaching strategy.

### Why

Passing self-authored tests is useful evidence, not independent proof. Keeping
the rejected versions uncommitted preserves the last good recovery point and
prevents the foreground controller from depending on a false safety claim.

### Teach attempts

None. A fresh teach would not be trustworthy while raw inputs or journal state
can cross their intended boundaries.

## 2026-08-29 — Recovery checkpoint 10: bind a run to exact recording bytes

### What changed

- Recording selection now returns the hash of the exact combined recording
  file it selected.
- A new run can use that one value to bind its plan, generated files, and check
  receipts to the same input.
- Committed as `12e811b`.

### Why

The combined recording may be refreshed when a new recording appears. A file
path alone cannot prove which contents an agent saw. Returning the hash avoids
guessing and reuses a fact the recording selector was already computing.

### Checks run

- All seven focused recording-selection tests passed.
- Formatting, linting, whitespace, and the staged secret scan passed.

### Teach attempts

None. The public command still uses the shipped controller.

## 2026-08-29 — Keep the new controller small and foreground-only

### Decision made

- Replace the large shipped `teach.ts` flow with one thin controller rather
  than wrapping it or adding another entrypoint.
- Reuse the shipped recorder, redactor, evidence builder, compiler, emitter,
  and verifier behind small factual adapters.
- Keep only one fresh run state machine: discover, advise, decide, plan,
  compile, check, revise if needed, independently review, and promote.
- Remove resume windows, primary/all selection flags, replay skipping, and
  checkpoint-driven partial compiles from the public teach command.
- Keep `--agent codex` as an optional explicit name for the same master flow.
- A returned command must always have a terminal result. It cannot return an
  “active” or “paused” status.

### Why

Wrapping the old flow would leave two sources of truth. Replacing it makes the
master's editable plan the only semantic decision record while retaining the
parts of shipped Imprint that were already good at recording, file generation,
and execution.

The controller will translate checks into measurements only. It will not add
rules about websites, endpoint meanings, authentication categories, or how
many tools should exist.

### Teach attempts

None. The controller is mapped but not yet connected.

## 2026-08-29 — Confirm the rebuild really starts from a clean slate

### What was checked

- The rebuild branch starts at the exact `v0.6.6` commit, which is also the
  current `main` commit used for this work.
- Its history contains only the small rebuild checkpoints listed in this file.
- No vNext commit was merged or copied into this branch.
- The old vNext worktree remains separate and is used only as historical
  evidence. Its uncommitted leftovers cannot affect this rebuild.

### Decision made

Continue only in the clean `codex/imprint-master-v066` worktree. Do not merge
the vNext branch or use its unfinished teach runs as resumable work.

### Teach attempts

None. Every later validation will start a new run on this clean branch.

## 2026-08-29 — Broaden the secret-boundary review before accepting it

### What happened

- A raw credential copied inside a larger URL or form body could pass the final
  file scan because the first version compared only whole strings.
- If the operating-system test sandbox was unavailable, the compiler could
  mistake that host problem for a bad generated file and keep asking the agent
  to edit the artifact.
- Multipart login forms exposed a deeper gap: credential extraction found the
  username and password, but deterministic redaction left them in the focused
  recording, and the final scan did not understand multipart fields either.

### Decision made

Do not accept or commit this foundation yet. Repair these as general structured
data problems covering URLs, forms, multipart bodies, JSON, headers, cookies,
storage, and recorded events. An unavailable host sandbox must stop as a host
failure, never become advice to change the generated tool.

These changes remain mechanical. They do not infer what a website means and do
not add rules for Google Hotels or any other site.

### Teach attempts

None. Running a provider on a recording that may still contain a raw multipart
password would be unsafe and would not be useful validation.

## 2026-08-29 — Simplify the scope and build every discovered tool

### Direction changed

- Stop spending rebuild time on production-grade security machinery. Imprint is
  a small local development tool. Keep ordinary recording redaction and basic
  file/schema checks, but do not build a security platform around it.
- Remove primary-tool, one-tool, and partial-selection behavior from teaching.
- Candidate discovery supplies the complete proposed tool set. The master must
  account for every discovered tool instead of choosing a narrow subset.
- The master chooses build waves. Dependencies must be built first, while
  independent tools may share a wave and compile in parallel.

### Immediate action

- Stopped the active production-security review and implementation work.
- Began removing the old `--primary-tool`, `--all-tools`, single-tool resume,
  phase-resume, and replay-skipping command options.
- The new editable plan will record the master's waves explicitly, with only
  simple checks that every planned tool appears once and dependencies appear in
  earlier waves.

### Teach attempts

None. The public command still needs to be connected to the new all-tools
master controller before a run would test this direction.

## 2026-08-29 — All-tools controller checkpoint

### What changed

- Removed the old primary-tool, partial-run, and resume behavior from the new
  teaching path. A fresh run now works from the complete tool plan.
- The master chooses the build waves. Every planned tool must appear once, and
  a tool that depends on another tool must come in a later wave.
- Removed the production-security detour from this rebuild. The remaining work
  is focused on teaching, compiling, checking, and reporting tools reliably.

### Checks run

- One test built all 41 planned tools and confirmed that dependent tools waited
  for the earlier wave.
- Another test attempted all 45 planned tools, including tools after two
  failures, and returned an honest failed result only after every attempt had
  finished.

### What the first controller review found

- A failed compile or check currently ends the run before the master can use
  the failure to revise the tool.
- A tool marked only for another check may be compiled again unnecessarily.
- A revised consumer can lose the successful result from an unchanged producer
  that it needs for a dependency check.
- A returned result can be marked successful without enough evidence that it
  matches the promised behavior.

These are real teaching-flow gaps, so this checkpoint is not complete. The
focused fixes are now in progress.

### Teach attempts

None. A real teach was deliberately not started while the controller could
still stop before repair or accept a result without enough evidence.

## 2026-08-29 — Remove obsolete run journals and resume the simple path

### What happened

- Old pre-change teach journals had filled the disk and prevented tests or new
  agent work from starting.
- With explicit approval, removed only the Google Hotels and Southwest
  `.teach-runs` directories, reclaiming about 12 GiB.
- Confirmed that both sites' recordings and existing generated-tool
  directories remained in place.

### Decision made

Continue with the smallest remaining correctness work: make replay evidence
useful to focused agents, prevent false replay results, validate the complete
foreground path, then start entirely fresh teaches. Do not restore the old
semantic rulebook or add site-specific logic.

### Teach attempts

None yet. The next teach will start only after the current code passes its full
local checks and is committed as a recovery point.

## 2026-08-29 — Fresh master teaching path is locally complete

### What changed

- `imprint teach` now has one foreground teaching path. It starts a fresh run,
  stays attached until there is a final result, and prints the exact failure if
  the run cannot finish.
- Candidate discovery keeps the shipped mechanical filtering. The master must
  account for every discovered candidate, may split or merge candidates, and
  records a clear reason for anything it cannot build. There is no tool-count
  limit, primary-tool mode, or partial-success mode.
- The master chooses dependency-aware build waves. Independent tools can build
  together; consumers wait for their producers. One test builds 41 tools and
  another attempts all 45 tools even when two fail.
- Smaller agents now receive focused evidence for one decision at a time:
  tool boundaries, one tool's plan, one tool's implementation, parameter
  choice, and final completion review. Their advice is not authoritative; the
  master can revise the plan and rerun only affected tools and consumers.
- Request evidence now includes bounded, decoded request structure and neutral
  observations from a separate execution. It reports only facts such as exact
  paths, changed values, timing, and possible response-to-request correlation.
  It does not classify website behavior or decide API versus browser strategy.
- API replay now compares the exact recorded request only when the check uses
  recorded parameter values. Synthetic or unavailable values are shown as
  `not checked`, browser replay is shown as `not applicable`, and host failures
  cannot masquerade as artifact failures.
- Every old and current check receipt is retained for the independent final
  review. A tool cannot be promoted while its required current checks fail or
  while another discovered candidate is silently unaccounted for.
- Every master revision compiles into a new directory. A failed parser or
  request transform cannot leak into the next revision, and the next check
  cannot accidentally reuse Bun's cached copy of the old code.
- Removed fixed master-repair and focused-planning attempt counts. Legitimate
  agent repair continues until it succeeds, the user cancels, or the existing
  foreground deadline is reached.
- Parameter reviewers remain optional advisors. If one returns unusable
  advice, already verified tools stay valid and the master continues. Provider
  cancellation or unavailability still keeps its exact terminal meaning.
- Removed the unused code left behind by deleting the old teaching path. No
  replacement policy layer was added.

### Why

The shipped implementation was reliable because compilers saw small evidence
packages and the runtime performed mechanical checks. This keeps those useful
parts while making candidate, parameter, dependency, and backend decisions
editable by the master. The runtime reports facts and execution results; it
does not try to encode rules for every website.

### Checks run

- Type checking passed.
- Lint checked 201 files with no errors.
- Dead-code and circular-dependency checks passed with no findings.
- The complete test suite passed: 1,708 tests, 0 failures, 4,559 assertions.
- A process-cleanup stress case that failed once during the first full run
  passed in isolation, passed three repeated runs, and passed in the final full
  suite. No product change was made for that transient test result.
- The web dashboard production build passed and the local page rendered with
  the new all-tools teaching explanation and no browser-console errors.
- The repository whitespace check passed.
- Two independent final reviews found the stale-revision, hard-attempt-cap,
  advisory-failure, and nested-provider-status issues above. After the fixes,
  both reviewers found no remaining high- or medium-priority issue in those
  paths.

### Teach attempts

None yet. This is the green local checkpoint immediately before the first
fresh, unsteered neutral teach and the required Google Hotels and Google
Flights teaches. No pre-change run will be resumed.

## 2026-08-29 14:21 PDT — Fresh validation attempt 1: neutral fixture

### Starting conditions

- Recovery commit: `4f7e8ed`.
- Site: `hn-algolia-stream-test`.
- Input: the existing neutral recording, selected through the normal fresh
  recording resolver.
- Command: the normal foreground master teach with Codex, no resume flag, no
  steering, and the run-wide 12-hour deadline.
- Environment doctor passed before the run.

### Result

Cancelled after diagnosis: 0 ready, 2 failed. The foreground command stayed
attached and printed the exact run directory, so the earlier lifecycle bug did
not recur.

The resolver selected the correct recording. It created a fresh combined file
from the only raw session; the source and combined hashes were identical, and
both contained 21 HTTP requests, 5 events, and 2 narrations. The detector's
“0 requests” line meant its old cross-origin filter had hidden all candidate
HTTP requests, not that the recording was empty.

The master discovered `search_stories` and `open_story_comments`, but reached
revision 9 without accepting either focused implementation plan. The focused
agents proposed browser fallbacks because their evidence contained no accepted
request. The master repeatedly rejected them because it read “playbook only
when certain no API rung is compatible” as requiring proof about every
theoretical API, rather than the ability to ground and verify an artifact from
the supplied recording.

### General fixes chosen

- Give candidate discovery every non-telemetry XHR/Fetch request, regardless
  of host or authentication. Keep the shipped compact telemetry filter so
  large recordings remain usable, but do not use a host/auth heuristic to hide
  public cross-origin APIs.
- Clarify in the agent prompts that a rung is compatible only when the supplied
  recording evidence can ground and verify it. The agent must still inspect
  all available request evidence before choosing playbook, but it need not
  prove that no undocumented API exists anywhere.
- Tell the master not to repeat an unchanged incomplete plan after rejecting a
  focused proposal. It must accept an evidence-backed proposal, state a
  concrete evidence-backed alternative, or mark the operation explicitly
  unresolved.

These are site-neutral evidence and prompt changes. No Hacker News, Algolia,
Google, or browser-specific runtime rule will be added. The next validation
will be a new run, not a resume of this cancelled run.

### Fix validation before attempt 2

- The corrected neutral discovery payload contains exactly the two recorded
  Algolia XHR requests, sequences 9 and 16. It still excludes the three
  analytics requests, sequences 10, 12, and 13.
- The master now passes its exact rejection reason back to the small planning
  agents. An end-to-end test rejects the first proposal, confirms that both
  planners receive the reason, accepts the next proposal, and only then starts
  compilation.
- Type checking, lint, dead-code checks, circular-dependency checks, the
  repository whitespace check, and 92 focused tests passed.
- An independent final review found no high- or medium-priority problem in the
  change.
- Two complete-suite runs each passed 1,707 of 1,708 tests. The sole failure
  both times was the existing process-cleanup stress test, which does not
  touch these changes and had already flaked before this checkpoint. Its
  hostile 20-repetition case passed three consecutive isolated runs. No
  unrelated lifecycle change was made to hide that result.

## 2026-08-29 15:09 PDT — Fresh validation attempt 2: neutral fixture

### Result

Success: 2 ready, 0 failed. Run
`b8a7ed2e-69e6-41f4-a6ba-129e79cbfff1` used recording hash
`sha256:b35bfed4dc93f944ac7245df6d0487a500747e190c7807b41292bf42565e8acb`,
the same correct recording as attempt 1.

Candidate discovery now saw the two recorded API requests instead of zero. The
master planned both discovered operations:

- `search_stories` used the recorded Algolia API and passed its checks through
  the ordinary fetch path.
- `open_story_comments` first tried the recorded page request as an API. A host
  check rejected that artifact even though its live semantic test worked. The
  master kept the passing search tool, rebuilt only the affected comments tool
  in a fresh directory, chose the recorded navigation playbook fallback, and
  passed the browser check.

The independent completion reviewer accepted both tools, and both were
promoted. The earlier repeated planning rejection loop did not recur.

### Independent audit issue and fix

The first audit was inconclusive because the default Claude subscription is
disabled. A second audit using Codex found a separate file-scanning bug: teach
promotion had correctly kept the previous `search_stories` tool in a hidden
backup directory, but audit counted that backup as a third active tool. Codex
skipped the duplicate name, which made a conclusive audit impossible, so the
audit was cancelled.

The shared tool scanner now ignores dot-prefixed history directories. It still
keeps those backups on disk for recovery; it simply does not expose them as MCP
tools or audit targets. This is a general file-layout fix, not a teaching rule.
Type checking, lint, 67 focused loader/audit tests, and the repository
whitespace check passed. A new fresh neutral teach will validate this code
change before the Google runs; attempt 2 will not be resumed.

## 2026-08-29 15:42 PDT — Fresh validation attempt 3: neutral fixture

### Result

Cancelled after diagnosis: 1 ready, 1 failed. Run
`31e3aedc-2c6c-4228-8e92-e375077e2ff3` used the same correct recording hash
and again discovered two requests and two operations.

The first `search_stories` artifact passed contract and live execution but
failed exact replay: it emitted an empty POST body where the recording had 16
bytes. The master correctly rebuilt it with the recorded body, after which its
contract, replay, and live checks all passed.

The master consistently chose the browser playbook fallback for
`open_story_comments`. The focused compiler also tried to follow that plan,
but the compiler host rejected `playbook.yaml` as an allowed file. When the
agent called `done`, the host then demanded the API-only files `parser.ts`,
`parser.test.ts`, and `integration.test.ts`. This forced the agent to replace
the correct browser artifact with a one-request API workflow, which the
master's contract check correctly rejected. Fresh repair compilers repeated
the same contradiction, so the run was cancelled instead of letting it loop
until the 12-hour deadline.

### General fix chosen

Pass the master-accepted strategy to the compiler host as typed data. For an
API plan, keep the existing API files and checks. For a playbook fallback,
allow and validate only the request-free `workflow.json` plus
`playbook.yaml`; do not demand API parser or integration files, and let the
master perform the existing live browser check. The compiler prompt will state
these two file contracts near the top instead of presenting API files as
unconditional.

This is mechanical agreement between an agent decision and the host. It adds
no website rule and does not let the runtime choose API versus browser. The
cancelled run will never be resumed.

## 2026-08-29 15:57 PDT — Browser fallback boundary clarified

The fallback compiler fix is complete and narrowly tested. It only makes the
compiler obey a fallback choice that the master has already justified; it does
not require a playbook or make one easier for the runtime to select. The API
file contract and API verification path remain unchanged. Type checking,
formatting, 441 focused compiler/master tests, and the repository whitespace
check passed.

Google Hotels and Google Flights are different from the neutral comments-page
fixture: their recordings contain the API traffic needed for useful tools. A
fresh run that chooses a playbook for either site will therefore be recorded as
an API teaching failure to diagnose, not accepted as a successful teach. This
is a validation expectation, not a Google-specific runtime rule. The next run
will be a fresh Google Hotels teach; no failed run will be resumed.

## 2026-08-29 16:09 PDT — Fresh Google Hotels attempt 1

### Input

The automatic recording resolver rebuilt the aggregate from all four raw
recordings before the run. The selected file contained 611 requests, 328
events, and 24 narration lines. It passed `imprint check` with no warnings and
had hash `sha256:85ceb6570b12c69d095ef288873659d9f293c4ddeb38251396e9cca630d07241`.

### Result

Failed before a teaching plan or strategy existed. Run
`b998f33b-483a-43e8-83f7-5423793a11a9` completed candidate discovery and the
independent browser observation, which captured 1,445 requests. Discovery
proposed two operations. The first advisor request then contained 4,578,240
characters, above the Codex input limit of 1,048,576, so the provider rejected
it. The foreground command returned exit code 1 and wrote an honest failed
terminal record with 0 ready and 0 failed tools.

This was not an API-versus-playbook failure: that decision had not happened.
The evidence builder expanded deeply nested request bodies into thousands of
small prompt documents without a total prompt budget. The next change will be
a site-neutral mechanical context bound that preserves broad request/event
summaries and the most useful focused facts while leaving exact bodies
available to the compile agent's existing on-demand readers. This failed run
will not be resumed.

## 2026-08-29 16:45 PDT — Reuse the shipped candidate detector module under the master

The initial selection stage reuses the shipped Imprint detector module and its
compact recording format. It is not being replaced by a master rulebook. The
compact recording payload is now built once, passed to that detector, and then
reused for the small boundary advisor and master. The detector's output is a
starting proposal: the master may add a missed operation, remove an unsupported
one, or merge, split, rename, and reorder tools before compilation.

The first Hotels attempt showed that the detector itself worked and proposed two
operations. The failure came from the later review step expanding the same
recording into a 4.58-million-character prompt. The fix therefore leaves
candidate judgment with the existing detector and agents, while mechanically
packing evidence so it fits the provider:

- Discovery carries a content-complete, mechanically chunked copy of every
  compact detector request, event, and narration entry, including requests the
  detector did not assign to a candidate. Core discovery
  evidence is required and cannot be silently dropped.
- The redundant discovery-wide request classifier was removed. Detailed
  request comparisons are reserved for each focused planning agent.
- Each focused planner receives a compact summary of every request and event,
  then representative request details in breadth-first order. An empty detector
  representative list now correctly falls back to the candidate's owned
  requests.
- When the master weighs several parameter-advisor suggestions, it receives
  their reasons, content-addressed evidence summaries, and the bounded focused
  evidence entries each advisor cited instead of copying hundreds of thousands
  of characters for every tool into one prompt. The master can inspect those
  facts and disagree with the suggestion.
- Candidate accounting now distinguishes unfinished work from a detector false
  positive. The master may explicitly exclude an unsupported or non-user-facing
  proposal, but the fresh completion reviewer must approve that reason against
  the discovery evidence. A credible operation that is merely difficult remains
  unresolved and still prevents completion.

On the exact Hotels recording, all 120 compact requests, 328 events, and 24
narration entries remain present. The conservative full discovery/master prompt
is about 550,000 characters, below Codex's 1,048,576-character limit. A
two-tool parameter-review stress case that previously produced about 1.92
million characters now produces about 30,000. Type checking, lint, and 111
focused tests pass. The complete suite passed 1,717 of 1,718 tests; its one
failure was the already known process-cleanup stress flake, which then passed
three consecutive isolated runs. No unrelated lifecycle code was changed. No
Google-specific selection or strategy rule was added.

## 2026-08-29 17:07 PDT — Restore the shipped detector's useful breadth

A direct comparison with the `v0.6.6` tag found one important drift in the
previous entry: the code module and compact input format were reused, but its
instructions had been weakened. The newer wording no longer strongly asked for
standalone lookup and read-only tools and said not to prefer a broader starting
set. That could explain why a recording with many useful operations began with
only two proposals.

The detector instructions now restore the shipped behavior: propose a separate
candidate for every independently useful read-only or lookup operation, keep
different uses of the same endpoint together as parameter variations, and let
the later advisor and master merge anything that was split too aggressively.
The rigid parts were intentionally not restored: there is no primary tool, no
exactly-one rule, no permanent selection, and no runtime rule that prevents the
master from adding, removing, merging, splitting, or revising candidates.

The detector and the master receive the same compact object. The master also
receives every compact request, event, and narration item, including evidence
the detector did not claim. This keeps the proven first proposal while making
it revisable.

Two mechanical review gaps were also corrected. Parameter advisors may still
cite exact facts, but all citations together now fit one fixed prompt budget and
the master is told how many extra citations were left out. At least one cited
fact per advisor must remain. Completion reviewers must cite evidence that was
actually supplied for a candidate exclusion; an invented reference is rejected.
Neither change decides what a tool or parameter means.

Validation now passes type checking, lint, and 147 focused detector/master
tests. Three independent read-only reviews found no remaining blocker for the
Hotels, Flights, or Southwest recordings. The complete repository run passed
1,721 of 1,722 tests; the only miss was the known timing-sensitive process
cleanup stress test, which passed immediately when rerun by itself. No process
cleanup code was changed in this checkpoint.

## 2026-08-29 17:29 PDT — Fresh Google Hotels attempt 2

### Result

Failed before compilation. Run `88ad7055-f4a2-4f1f-bf25-fb682c688059`
used the same current combined recording and hash as attempt 1. The restored
detector proposed three operations instead of two. The master kept all three:
`suggest_hotel_searches`, `search_hotels`, and `get_hotel_details`. All three
used the API strategy; details depended on search, so the master created two
build waves. No playbook was selected.

The master revised `search_hotels` after its first focused plan, which correctly
made only that tool's old implementation plan stale. The controller then asked
a clean focused planner to re-plan only `search_hotels`. That call failed, so
the command honestly returned `0 ready, 3 failed` rather than compiling an
incomplete plan.

The saved error only said `focused planning failed for 1 of 1 tools`. The
underlying planner error was still inside the in-memory aggregate error, but
the aggregate's short heading replaced it in both the terminal and run record.
That makes diagnosis impossible after the process exits.

### General fix chosen

Keep the tool name and its exact nested planner error in the aggregate message.
This does not change planning, retry counts, tool selection, parameters, or
strategy. It only preserves the facts already produced by the failed agent
call. Type checking, lint, and 15 controller tests pass. This failed run will
not be resumed; the next validation will be another fresh Hotels run.

## 2026-08-29 17:40 PDT — Fresh Google Hotels attempt 3

### Result

Failed before planning or compilation. Run
`32a0fc81-057c-48cd-9a72-26f04d395c7d` used the latest combined Hotels
recording. The shipped detector again found three operations, and the
independent replay captured 1,462 requests. The command stayed in the
foreground and honestly returned a failure.

The detector copied five narration entry numbers into its event-number field.
Those numbers existed in the exact compact input, but they were narration IDs,
not browser-event IDs. The strict handoff therefore rejected the entire
three-tool proposal before the advisor or master could review it. No tool was
planned, compiled, or checked.

### General fixes chosen

Keep using the shipped detector and keep its tool proposal editable. Clarify in
its instructions that request, event, and narration numbers are different. At
the handoff, remove only a narration number copied into the event-number field.
Completely unknown numbers and every other malformed citation still fail the
strict check. Do not change tool names, meanings, parameters, dependencies,
confidence, or the recording evidence shown to the master. This is bookkeeping,
not tool selection.

The previous failed run also revealed one contradictory instruction. The
focused planner was correctly told to leave replay values empty when the exact
recorded public inputs could not be recovered, while the master was told every
case must contain every public input. The master instruction now matches the
planner and runtime: an unavailable replay has no values, is reported as not
checked, and is not by itself a reason to abandon the API design.

These changes are site-neutral. They add no Google policy and no new teaching
strategy. All 139 focused tests pass, along with type checking and lint. This
failed run will not be resumed; validation will start with another fresh
Hotels run.

The complete repository run passed 1,725 of 1,726 tests. The only miss was the
same timing-sensitive process-cleanup stress test seen in earlier checkpoints;
it passed immediately when rerun by itself. No process-cleanup code changed.

## 2026-08-29 18:04 PDT — Fresh Google Hotels attempt 4

### Result

Failed during focused planning, before compilation. Run
`59c2148d-e404-41a5-8230-70204865da68` used the latest combined Hotels
recording. The shipped detector found three operations again. The narration-ID
handoff fix worked: the advisor and master were reached, so attempt 3's failure
did not repeat. The independent replay captured 1,445 requests. No playbook was
selected.

One of the three focused planners, for `hotel_search_suggestions`, returned an
invalid evidence reference even after its one repair attempt. The command now
preserved the useful exact error: its recorded replay case cited one small piece
inside the focused evidence bundle instead of the one reference for the whole
bundle. No tool reached compilation or verification.

### General fix chosen

Make the existing evidence contract unambiguous. The planner now receives a
short explicit list of the references it is allowed to copy. Its instructions
say to use that list for the tool and every verification case, and not to copy
the separate references attached to individual evidence pieces. The validator
also rejects a planner that changes the supplied list, and its repair message
names the exact field to copy.

This does not alter candidate selection, parameters, strategy, request choice,
or evidence content. It only makes an existing bookkeeping requirement clear.
A production-shaped regression test now starts with the same wrong inner
reference, verifies the repair call receives the allowed whole-bundle
reference, and succeeds on the corrected answer. All 119 focused tests pass,
along with type checking and lint. This run will not be resumed; the next
Hotels validation will be fresh.

## 2026-08-29 18:56 PDT — Fresh Google Hotels attempt 5

### Result

Failed after compilation and live checking. Run
`9d5331e7-2801-4765-ab03-9b636779efcc` used the latest combined Hotels
recording. The detector proposed three API tools: destination suggestions,
stay search, and hotel details. The master kept all three and placed them in
three dependency-ordered build waves. No playbook was selected.

Suggestions and the large fifteen-parameter search tool compiled. The details
tool worked live for the recorded Hyatt token, dates, traveler counts, and
currency. Its independent verifier then found the important real failure: the
search tool exposed a `CIABI...` photo identifier as its hotel token, while the
details requests need the separate `ChcI...` property selector. A fresh search
result therefore produced empty details. The focused compiler gave up instead
of falsely claiming success.

The master used those facts correctly. It kept all three API operations,
changed search to return the real property selector, changed the chain to pass
that selector into details, and asked for fresh plans for all affected tools.
The final merge accidentally carried an old implementation-plan reference
after changing the search tool and chain. The integrity check rejected that
stale reference twice, so the foreground command honestly ended with `0 ready,
3 failed`.

### General fix chosen

Keep the strict stored-plan integrity check, but do not abort a teach because
the master echoed an old plan while changing its inputs. At the master-output
handoff, remove only a supplied implementation-plan reference whose recorded
input hash no longer matches the changed tool. Preserve every semantic change
the master made, then let the existing focused-planner loop rebuild only the
affected tool. Unknown or forged plan references remain rejected.

The master prompt now also says to omit an old plan whenever parameters,
evidence, strategy, compile context, or chain edges change. Unit and end-to-end
regressions prove that the semantic edit survives, the stale plan is cleared,
unchanged tools retain their plans, the affected tool is replanned, and the run
can complete. This run will never be resumed.

## 2026-08-29 19:32 PDT — Restore shipped discovery without making it permanent

The first tool proposal now comes from the useful shipped Imprint discovery
path again. The shipped relevance step narrows the recording for the shipped
detector, and the detector can retry once when it appears to have collapsed
several busy API families into one tool. Discovery does not run the old safety
review calls because their answers would not control execution here. There is
still no primary tool, one-tool rule, or maximum tool count.

The old rigidity was not restored. The narrowed request list is advice for the
detector only. The master, focused planners, compiler, replay checks, and
independent execution all retain the complete redacted recording. The master
also sees every browser API request, including one a simple telemetry filter
might have hidden. This means the master can add an operation the detector
missed, change boundaries, or change parameters later. If the narrowing step
returns an ordinary error, discovery continues from the complete recording.
Cancellation, provider failure, and the run deadline still stop it.

Two over-broad old hints were deliberately left out. Public APIs are not hidden
just because they use a different host, and ordinary fields such as
`property_token`, `selection_token`, and `next_page_token` are not called login
traffic. Login endpoints and real credential placeholders remain visible as
authentication evidence for the agents to interpret.

One evidence handoff bug was also fixed. Evidence entries are never silently
cut into invalid JSON. For tool-boundary review, the master now gets a compact
index containing every browser API request, with its URL, timing, type, status,
exact lengths, and fingerprints. Large headers and wire bodies are deliberately
left for the focused planner after a boundary is chosen. This keeps all request
choices visible without filling the master prompt with repeated browser data.
On the latest recordings, the complete master index is about 254,000 characters
for Hotels, 546,000 for Flights, and 577,000 for Southwest, all below the
750,000-character evidence limit. The full detailed Flights and Southwest views
would not have fit.

Two small failure guards were added. If the detector's optional second attempt
invents a request or browser-event number, assigns a representative request to
the wrong tool, or creates a broken dependency loop, Imprint keeps the valid
first answer. A malformed encoded request URL also stays usable instead of
crashing discovery.

This checkpoint adds no Google- or travel-specific behavior. It restores the
shipped detector as a suggesting subagent while leaving the master in control.
All 180 combined discovery, compiler, and master tests pass, along with type
checking and lint. The complete repository suite passes all 1,749 tests.

## 2026-08-29 20:01 PDT — Remove the last runtime tool-selection opinion

A final simplicity review found one part of the restored code that should not
survive: after the detector proposed one tool, the runtime counted endpoint
families, called the detector again, and automatically preferred the answer
with more tools. Its endpoint grouping also knew about Google's `rpcid` query
format. That was a hidden tool-selection opinion and a Google-shaped rule.

The automatic second attempt and endpoint grouping were removed. The shipped
detector now proposes tools once. The separate tool-boundary advisor and master
review that proposal, and the master can add, remove, merge, or split tools
using the complete request index. This keeps correction agent-owned instead of
teaching the runtime that “more tools” is always better.

The same review found that the old login-adjacent hint still matched the bare
word `token`. That could label ordinary fields such as `selection_token`,
`property_token`, or `next_page_token` as login traffic after a user signed in.
The bare match was removed; explicit signals such as MFA, OTP, verification,
challenge, OAuth, and trusted-device requests remain.

The focused discovery and compiler suite passes all 170 tests. Type checking,
lint, and the complete repository suite also pass; the full suite is 1,739
tests. Independent code, simplicity, and design-boundary reviews found no
remaining issue.

## 2026-08-29 22:02 PDT — Fresh Hotels run proves discovery works, then exposes a later API failure

A completely fresh, unsteered Google Hotels teach was started as run
`9f820ff3-7fcf-4b24-8dd2-6edf4a73fac3`. It used the latest combined recording.
This run will never be resumed after the changes described below.

The restored shipped discovery path did its job. It proposed four useful
operations: location suggestions, hotel search, hotel details, and booking
options. The master accepted all four and arranged them in dependency waves.
This is strong evidence that candidate selection is no longer the problem in
this run, so it will not be changed in response to the later failures.

Location suggestions compiled as an API tool and passed its contract, exact
recording replay, and live test. The replay matched all 691 recorded bytes, and
the live request returned ten results in 286 milliseconds.

The remaining API tools exposed a different problem. The search compiler had
the complete recorded request body, but rebuilt its complex body from guessed
positions and passed a readable location label where the recorded sequence
appeared to require the exact selection produced by the suggestion response.
Its live reply contained only control data. Details and booking also found real
request or result problems during their checks. These are failed artifacts,
not evidence that the recorded API itself is unusable.

The master correctly revised parameters and started fresh compile agents, but
after those agents still failed it incorrectly changed search, details, and
booking to browser playbooks. The search playbook then failed its live check
with no results. A later producer-to-consumer playbook check stopped making
progress and the foreground command did not return. The run was manually
cancelled after confirming that it was idle. No audit was run because the teach
did not complete.

Two general fixes follow from this evidence. First, API planning and compilation
must preserve exact response-produced selection data and begin with exact
recorded request bytes, changing only fields whose construction is supported by
evidence. A failed generated artifact does not by itself prove that API use is
impossible or justify a browser fallback. Second, every browser launch, check,
and cleanup step needs a real bounded deadline so one stuck browser operation
cannot hold the foreground command forever. Neither fix requires a Hotels rule
or a change to candidate selection.

## 2026-08-29 22:47 PDT — Give API compilers exact facts before allowing fallback

The original shipped candidate-selector core remains in place. It still runs
once as a proposing agent, after which the advisor and master can revise every
tool boundary. Its old exactly-one-primary restriction is gone, and no new
candidate-count or site rule was added.

The failed Hotels run showed that the compiler and verifier were looking at
different versions of a request. The verifier saw the static body template but
did not see `request-transform.ts`, even though the runtime had applied that
transform. The runtime now reports only simple execution facts: which request
was prepared, transformed, and sent; whether a body existed or changed; its
byte length; and the HTTP status. The verifier also receives the transform and
request test, so it no longer has to guess what was sent. A missing or broken
declared transform now fails before any static template is sent, including for
login tools.

The focused compiler gained one mechanical comparison tool. It renders the
current workflow without using the network, applies the current transform,
feeds the recorded responses through multi-request chains, and compares the
prepared request with its recorded source. It reports exact URL equality,
value-free query equality, body sizes, and bounded structural differences. It
uses synthetic credential values and fresh copies of only the current tool and
the exact relative helper files it imports (including shared or sibling-tool
modules), so edits are never hidden by Bun's module cache and
stored secrets are never handed to the compiler. The agent still decides what
the differences mean and how to repair them.

The planning and master prompts now require vague phrases such as “resolve the
current state” to name a real producer, response path, request, or supported
calculation. They also say that a failed compiler artifact is not proof that an
API is incompatible. Before choosing the final browser fallback, the master
must inspect remaining request provenance and try a fresh API plan when an
untested evidence-backed path remains. This is guidance for the agent, not a
runtime fallback classifier.

Browser checks now have one complete deadline covering launch, setup, steps,
result reading, and cleanup. Late success after the deadline is rejected,
cleanup is bounded, caller cancellation clears long timers, and an internal
browser timeout remains a visible network failure rather than hanging the
foreground command. A neutral end-to-end test proves that a stuck browser chain
becomes a factual host error, the master can revise only the affected edge, and
the run can continue.

Two independent reviews found three narrow lifecycle boundaries before this
checkpoint. The offline comparison snapshot could still copy unrelated site
files when the older direct compiler wrote into a site root; it now copies only
`workflow.json` and the exact declared module dependencies. A diagnostic
screenshot could outlive the browser deadline and throw instead of returning a
factual network failure; it now stays best effort. Finally, one large batch of
request-stage facts could be shortened before the verifier read it; the private
fact channel now keeps the complete bounded batch while the public log remains
short. Regressions cover all three cases.

The selector and all runtime changes remain site-neutral. Focused validation
passes 313 tests, along with type checking, lint, dead-code checks, and
circular-dependency checks. The full repository run passed 1,754 of 1,755
tests; one unrelated recorder browser test hit its 30-second test limit, then
passed alone in 4.1 seconds. A real child-process regression also proves that
request-stage facts survive the probe process without copying parameter values.

## 2026-08-30 00:30 PDT — Fresh Hotels run proves editable discovery, then finds a revision bug

A new, unsteered Google Hotels teach started as run
`3458b787-c69d-4c4d-9326-cd0b8ee87ffc`. It used the newly rebuilt latest
combined recording, made from all four current Hotels recordings. This run
ended failed and will never be resumed.

The original shipped candidate detector again proposed a useful starting set.
It found four operations: destination suggestions, hotel search, destination
map boundaries, and hotel details. The master kept all four as API tools and
put them into dependency waves. It never switched to a browser playbook.

The run also proved that the proposal was editable. Destination suggestions
passed. A map compiler proposed removing latitude and longitude after one live
comparison suggested they were fixed transport values, but the master rejected
that mismatch and kept all three recorded inputs pending stronger proof.
Search checking found that changing a city name and identifier inside a
recorded Chicago request was not enough. The master therefore changed the plan
so search chooses a complete recorded Denver or Tahoe City destination
structure instead of patching isolated fields inside the Chicago structure.
Hotel details matched all four recorded requests and worked directly, but its
required fresh search-to-details check could not pass because search still
returned no usable hotel rows. These decisions came from agent review of exact
request and result facts, not from new runtime rules.

The command ultimately stopped for an internal revision-order bug. A fresh
details proposal changed what it expected from search. That correctly made the
old search build plan obsolete, but the host rejected the obsolete plan before
the master had a chance to remove and rebuild it. The terminal honestly
reported `0 ready, 4 failed` and named the stale search plan.

The general fix is deliberately small. While combining a focused proposal with
the current plan, the host now removes only build plans whose inputs have just
become obsolete. It still gives the complete proposed change to the master,
and the existing repair loop then asks fresh focused agents to rebuild every
affected tool. When several focused planners run together, the host also keeps
the exact inputs each planner actually saw. If one planner changes a link that
another planner had already used, that second answer is deferred to the next
fresh planning pass instead of being relabeled as current. Proposed links,
including a dependency first discovered between two same-wave tools, determine
which consumer answer is kept first. Independently valid suggestions may still
conflict with each other, such as choosing the same link name. Those conflicts
now reach the master to resolve instead of stopping before the master runs; the
master's final plan must still pass every complete plan check. Unknown or
forged individual plans remain rejected. Regressions cover changed and removed
links: the new consumer plan is accepted and the old producer plan is cleared.
Three-tool, new-dependency, and conflicting-suggestion regressions also prove
that compatible work is retained instead of being needlessly repeated. An
independent full-controller probe confirmed that the deferred producer receives
the changed link on its next fresh planning pass.

## 2026-08-30 01:05 PDT — Preserve each planner's actual starting point

Two reviews found small holes in the first version of this fix. Individual
suggestions still need to reject made-up recording request numbers, duplicate
inputs, and a tool depending on itself even while disagreements between
different suggestions are left for the master. Those checks were restored
without restoring the all-or-nothing combined check. A second issue appeared
when one planner renamed a producer while its consumer still used the old name
from the plan they had both received. Suggestions are now checked against that
starting plan, not against sibling answers that arrived concurrently. The
master therefore sees both opinions and decides whether to accept the rename.

The focused agent and controller suite now passes all 100 tests. An independent
review also passed 150 broader planning, controller, end-to-end, and plan tests,
plus type checking, lint, and the changed-file integrity check. Dead-code and
circular-dependency checks pass. One earlier full run passed 1,765 of 1,766
tests; a recorder browser test reached its 30-second limit and then passed alone
in 4.2 seconds. After the final rename fix, the exact current tree passed 1,766
of 1,767 tests; a different recorder browser test reached the same 30-second
limit and then passed alone in 5.2 seconds. All teach tests passed in both full
runs. The independent reviews found no remaining issue in this change.

## 2026-08-31 09:10 PDT — A fresh Hotels run proved one tool, then repeated too much work

A new, unsteered Google Hotels teach started as run
`3ef1c91d-dd9e-488a-b2b2-9f79f8c54ded` from the latest combined recording. It
ended failed and will not be resumed. The run planned destination suggestions,
hotel search, and hotel details. Destination suggestions reached a ready build
and passed its recorded replay and live check. Search and details did not
become usable, and the failed run promoted nothing.

The run exposed a general sequencing mistake. After a compiler had produced a
valid tool, it immediately launched a second agent to test the live meaning of
every parameter. A negative answer was fed back into the same compiler up to
five times before the master saw anything. This made one tool consume a large
part of the run, encouraged repeated corrections inside one stale conversation,
and delayed useful progress on the remaining tools. The final visible error was
an old master binding, but that was the last symptom rather than the main
source of the wasted time.

This was not a Google Hotels problem and did not justify a Hotels rule. It
showed that core delivery and optional breadth work had been incorrectly tied
together.

## 2026-08-31 14:47 PDT — Ship a usable core first; finesse breadth separately

The master compiler now has a narrow MVP mode. It still has to produce valid
files, match the master's current tool name and public parameter contract, pass
its parser and request tests, type-check, and stay grounded in the recording.
It no longer starts the exhaustive live parameter reviewer or keeps the same
compiler alive for five semantic repair rounds. Direct `imprint generate`
keeps its existing full review; only the master-led teach path uses MVP mode.

Each dependency wave is now built and checked before the next wave starts. A
producer is saved to the run journal immediately after its files pass, then it
must pass recorded replay, one real live baseline, any declared chain checks,
and one small result review. That review asks only whether the default result
actually demonstrates the promised core operation. It does not test every
parameter or demand broad coverage. The exact tool is installed as soon as
that core proof passes, before its consumers compile. A rejected producer does
not unlock its consumers, while unrelated tools can still proceed. If a later
consumer fails, the installed producer remains available.

After installation, two optional jobs start while the next wave compiles. One
agent reviews the public parameter choices. The existing full live verifier
runs against a disposable copy of the tool to test parameter behavior and
breadth without changing the installed MVP. These jobs run one tool at a time,
and their reports are saved under `finesse/<tool>/<build>.json`. A plan change
marks an old answer stale. Teach cancels unfinished finesse work when all MVPs
are done; completed partial reports are still saved. Finesse cannot edit the
plan, discard an installed tool, hold the command open for semantic work, or
turn a finished MVP back into a failure.

The final independent reviewer still checks the complete tool list, factual
history, exclusions, and core results. It does not repeat parameter breadth
testing. Because every tool has already been installed, final completion now
records that review without copying all tools again. A failure in redundant
final copying therefore cannot undo an otherwise finished teach.

Regression tests prove that a producer is reviewed and installed before its
consumer starts; rejected producers are reviewed once, install nothing, and do
not unlock consumers; a later provider failure reports the already-installed
producer as ready; parameter advice and live finesse overlap later compilation;
and a stuck optional job cannot delay completion or erase a completed partial
report. The compiler receipt is also fail-closed: a full compile needs durable
live-review proof, while master MVP mode must explicitly say that live breadth
was deferred. No site-specific runtime classification or policy was added.
The next validation will be a completely fresh teach run, never a resume of the
failed Hotels run above.

One final independent review found a dependency gap in the first version. A
tool kept from an earlier pass could still be checked and installed even when
the current version of the tool it depended on had failed the small MVP review.
Kept tools now pass through the same producer-ready gate as newly built tools,
so a rejected producer cannot be bypassed by reusing an older consumer.
A three-tool test rebuilds and rejects a producer after its consumer was kept;
it proves that neither that consumer nor its downstream tool is installed from
the now-invalid chain.

All 145 focused MVP, compiler-receipt, controller, and finesse tests pass. Type
checking, lint, unused-code checks, and circular-dependency checks also pass.
The full repository run passed 1,785 of 1,786 tests; one existing recorder
browser test reached its 30-second limit, then passed alone in 2.9 seconds.

## 2026-08-31 15:51 PDT — Fresh Hotels attempt exposed mixed provider routing

A new, unsteered Google Hotels teach started as run
`0c2a1ec0-f845-4168-b21b-69f18ff6620e`. It selected the latest combined
recording, `sessions/combined-2026-08-29T22-59-08-951Z.json`, whose SHA-256 is
`85ceb6570b12c69d095ef288873659d9f293c4ddeb38251396e9cca630d07241`.
The selected source and the run's redacted copy both contain 328 events, 611
requests, and 24 narration records. This run ended before candidate discovery
and will not be resumed.

The command used `--agent codex`, but that flag only selected the master-shaped
flow while provider auto-detection separately chose the installed Claude CLI.
Claude access is disabled for this organization. Request triage correctly fell
back to the complete recording, but candidate detection then made the same
Claude call and the run ended with `0 ready, 0 failed`. No candidate, plan, or
tool build had started.

This was misleading command behavior, not a recording or website failure.
`--agent codex` now defaults every teaching role to `codex-cli`, including
triage, discovery, planning, compilation, review, and optional finesse. An
explicit `--provider` still wins, and the plain command without either flag
still uses automatic provider selection. The trace and CLI help now report this
choice honestly. Focused provider and help tests pass, along with type checking.
The next Hotels validation will be another new run.

## 2026-08-31 16:55 PDT — Hotels ships four MVPs; audit identifies later finesse work

A new, unsteered Google Hotels teach started as run
`8f674ad2-aaed-4ea4-8967-da7ce029d20e` from the same current four-recording
combined file. Codex triage selected 61 of 140 eligible requests. The shipped
candidate detector proposed four operations, and the master kept all four as
API tools in three waves: location suggestions, hotel search, then hotel
details and booking options in parallel. No browser playbook was chosen.

The new delivery order worked as intended. Location suggestions first had a
159-versus-165-byte replay mismatch. The master started a fresh compiler, fixed
it, installed the tool, and immediately started search while optional parameter
work ran separately. Search's first broad 15-parameter design hit a live parser
error. The master reduced the core contract to the two grounded inputs,
`location` and `currency`; a fresh build passed replay, live, and the real
suggestion-to-search chain and was installed. Details and booking then compiled
together. Details was installed after its core and search-chain checks passed.
Booking had a two-byte replay mismatch, was rebuilt in a fresh compiler, then
passed replay, live, four search-chain bindings, and core review.

The command ended successfully with `4 ready, 0 failed`. Each producer was
installed before its consumers started, and successful upstream work remained
installed through later repairs. Three optional finesse reports finished before
the foreground run ended; booking finesse was saved as deferred rather than
holding completion open. The suggestion and search finesse reports approved
their small parameter sets. The details finesse report correctly found that
property identity could mix incompatible sources and that currency only echoed
without changing useful data.

The ordinary Codex audit then tested five tools because the site directory also
contains the older `get_hotel_web_links` browser tool, which this fresh teach did
not build or remove. The overall audit scored 62.96%: 17 correct, 10 broken, and
2 infrastructure cases. The fresh suggestion and search tools worked across
all tested variations. Details returned useful records, but changing
`property_token` was a no-op. Booking returned an empty list across nine
realistic future stays and producer-selected properties, so the auditor marked
those calls broken. The two infrastructure cases were repeated click timeouts
in the retained browser web-links tool.

This proves the MVP-first lifecycle now ships usable work instead of losing the
whole run, but it does not yet meet the roughly 80% audit target. The remaining
problems are specific generated-artifact and parameter-quality findings, not
evidence for a Hotels runtime rule. We will run the same unsteered flow on
Google Flights before deciding whether any general prompt or finesse workflow
change is justified.

## 2026-08-31 18:05 PDT — Fresh Flights baseline preserves one MVP, then repeats unchanged failures

A new, unsteered Google Flights teach started as run
`b0d5c955-6148-4023-9d81-74e749669708`. It selected the correct latest combined
recording, `sessions/combined-2026-08-30T02-48-09-040Z.json`, whose SHA-256 is
`fb2f07e27379817a10eb1e96702bd29fab63836f0656cc36d59ad0011a8c53af`.
The shipped detector found four API operations: resolve a location, get calendar
prices, search flights, and get booking options. No browser playbook was chosen.

The location resolver worked. Its final build passed its file checks, matched
the recorded request exactly, and returned 11 live results in 263 ms on a warm
connection. It was published before the later tools ran and remained available
through the rest of the attempt.

The run then exposed three general delivery problems. First, the master rejected
a compact four-request search MVP only because it did not yet include every
optional filter. It expanded the first delivery to 15 requests and 23 public
parameters, which took nearly seven minutes to compile. Second, the resulting
search build passed its live and producer-consumer checks, but the recording did
not contain usable baseline values for exact replay. All 15 comparisons were
honestly marked `not_checked`; the controller treated that known absence as a
failure instead of an unavailable check. Third, the current calendar build
passed its mechanical checks but returned no live prices, so the small MVP
review correctly rejected it.

After those facts were recorded, revisions 6 through 10 made no real change to
the plan, files, or proof. The master kept changing only its explanation. It
claimed the calendar result was nonempty and later claimed the rejection
belonged to an older build, even though the saved review names the current build
and current live result. With revision labels and explanations removed, all five
plans have the same SHA-256,
`0ec82652ee683e9f2c97252575e7a4f9ad2afcebcfbef519e6b6f4fb5d7631e3`.
The normal deadline is 12 hours, so the command would have continued repeating.
It was manually cancelled after 1 hour 8 minutes at revision 10. The honest
terminal result was `1 ready, 3 failed`; booking never started because search
never became a published producer. No provider-capacity failure occurred.

The baseline worktree was left unchanged throughout this run. General fixes
were built and tested in a separate worktree so the live prompt could not change
under the running agent:

- `f7b7f92` makes the first public parameter contract cover one credible core
  use case plus required chain inputs. Optional filters and variants move to the
  already separate best-effort finesse jobs, which now start independently as
  soon as each MVP is published.
- `e84ac6b` prevents an explanation-only plan revision from overriding a saved
  rejection of the exact same build and live result.
- `9a3452c` lets an API MVP proceed when every accepted request comparison is
  explicitly `not_checked` because no replay baseline exists. Any mismatch,
  partial comparison, or host failure still fails.

These changes contain no Flights- or Hotels-specific conditions. The focused
MVP tests, type checking, and lint pass. The full repository run passed 1,794 of
1,795 tests; the one recorder browser test hit its 30-second limit under the
full load, then its complete test file passed alone with 8 of 8 tests.

## 2026-08-31 18:15 PDT — Bound the fallback honestly and stop identical repair loops

Review of the Flights evidence found three small host-side gaps. They were fixed
without adding any site knowledge or deciding what a flight or hotel parameter
means.

An unchecked API replay is now accepted only when the exact saved implementation
plan says that recorded parameter values were unavailable. That statement is
stored as value-free metadata beside the content-addressed plan. A tool cannot
skip a replay that its plan said was possible, while an honest unavailable
baseline no longer blocks a useful live-tested MVP.

The controller now recognizes a repeated failed state by hashing the actual tool
plan, builds, dependency bindings, check facts, and failure. Revision numbers,
explanations, receipt numbers, and timing are deliberately ignored. The master
gets one opportunity to revise and one real retry. If the same facts return with
no real change, the run ends as failed instead of calling the master until the
12-hour deadline. Any changed plan, artifact, proof, or failure remains free to
continue. Published MVPs stay installed and are counted as ready in the terminal
result. The focused planning loop has the same protection when the master keeps
rejecting a proposal without changing the missing plan.

Optional breadth work remains outside the delivery path. Its live verifier keeps
its existing one-at-a-time queue, and parameter-advisor calls now use a separate
two-at-a-time lane so a large recording cannot flood the provider while core
tools compile. Both kinds of optional work start only after the exact MVP is
published. Finesse freshness follows the target build and its dependency-bound
execution hash, not the whole plan revision, so an unrelated downstream repair
does not discard valid advice.

The combined focused suite passes 149 tests with no failures. Type checking,
lint, and whitespace checks pass. The full repository suite passed 1,798 of
1,799 tests; one recorder browser test reached its 30-second limit under full
load, then the complete recorder file passed 8 of 8 by itself. A separate review
found two first-pass issues in the loop fingerprint, both now fixed: new master
guidance gets a fresh focused-planner attempt, while paraphrased failure prose or
volatile host-error text cannot disguise an otherwise identical failed state.
The final re-review found no remaining high- or medium-priority issue.

## 2026-08-31 18:42 PDT — Fresh Flights run found a plan handoff bug before compilation

A new, unsteered Google Flights teach started as run
`55b6b81d-baba-492c-8aa5-be7057e1b58d`. It selected the same correct latest
combined recording. Independent observation captured 412 requests, and the
shipped detector proposed five operations. The master selected three tools, but
the run failed before creating its journal or compiling any tool.

The failure was a generic handoff mistake introduced with the honest replay
fallback. The runtime added one derived replay field to each saved
implementation-plan reference, then required the master to copy that runtime
bookkeeping field exactly. The master copied the stable content identity but
omitted the new derived field on all three selected plans. One automatic repair
made the same omission, so the command ended honestly as failed with zero ready.
This was not a candidate, replay, browser, compiler, or Flights-specific
failure.

The master now selects a supplied plan by its stable content-addressed identity.
The runtime restores its own derived replay metadata from that exact supplied
plan before doing the full integrity check. A made-up path, content hash,
compile-input hash, or request-provenance hash is still rejected. The prompt
also documents the optional replay field so the agent has the complete shape,
without making runtime bookkeeping part of its judgment.

The focused suite passes 106 tests, including a regression in which the master
omits the derived replay field and the host restores it from the selected saved
plan. Type checking, lint, and whitespace checks pass. The failed run will not
be resumed; the next validation will be another fresh, unsteered Flights teach.

## 2026-08-31 19:07 PDT — Fresh Flights reached compilation, then factual labels sent repair backward

Fresh run `e86bc50e-e2bb-43e3-b09d-326d19cb9c4f` used the correct recording and
passed the plan-reference handoff that stopped the previous run. Independent
observation captured 409 requests. The master kept four API tools and arranged
them in three dependency waves: resolve a location; then calendar prices and
flight search in parallel; then booking options. The first versions were small
MVPs. For example, search covered one recorded one-way request and explicitly
left broader shopping variants for later finesse.

The location resolver compiled in about two minutes. Its contract passed and a
live check returned one result. Exact replay correctly found a two-byte request
difference at byte 45: the recording encoded the space in `san fran` as `%20`,
while the generated form used `+`. The artifact could not be published, so its
dependent waves correctly stayed blocked.

The run then exposed a generic factual-label bug. The low-level comparison knew
that the recording was 148 bytes and the rendered artifact was 146 bytes, but
the saved receipt called the rendered size `expectedBytes` and the recorded size
`actualBytes`. The master naturally read those names in the usual direction. It
therefore rejected focused plans that targeted the correct 148-byte recording
and repeatedly asked for the wrong 146-byte body.

Revisions 2 through 5 repeated the same decision with different wording. The
focused-planning no-progress guard included that free-form wording in its
fingerprint, so each paraphrase looked like new progress even though the tool,
evidence, requested repair, and compile inputs were unchanged. The default
deadline would have allowed this to continue for up to 12 hours. After the
fourth identical direction proved the loop, the run was manually cancelled. It
ended honestly as cancelled with zero ready and four failed; no dependent tool
compiled and no finesse job started. The run will not be resumed.

Two small, site-neutral repairs are next. Replay receipts will use the ordinary
meaning: expected bytes are the accepted recording and actual bytes are the
rendered artifact, with the prompt stating that explicitly. The planning guard
will bound retries by the mechanical tool/proposal/input state rather than by a
changing explanation, while still allowing a changed tool, dependency, proof,
or compile input to start fresh work.

## 2026-08-31 19:31 PDT — Corrected replay direction and bounded repeated proposal review

Replay receipts now use their ordinary meaning: `expectedBytes` is the accepted
recording baseline and `actualBytes` is the request rendered by the current
artifact. The compile and master prompts state the same definition. The schema
did not change, so old receipts remain readable; only the previously reversed
assignment was corrected. Tests cover both mismatches and successful comparisons
whose sanitized recording and template artifact have different serialized
lengths.

The focused-planning guard now lets new master guidance reach the focused
planner, then compares the concrete proposal before asking the master to review
it again. It tracks only the sorted compile inputs of tools still missing plans
and path-free hashes of their executable proposals. A changed public tool,
dependency, request plan, response plan, or derived request metadata remains new
work. Rephrased explanations, confidence scores, rationale text, equivalent
array ordering, and content-reference paths do not count as progress.

The first draft of this guard was not merged because it ignored all master
guidance. A second draft was also held back because full-plan prose and ordering
could still evade it. The merged version preserves agent editability while
stopping only an executable proposal the master has already reviewed. An
independent re-review found no remaining high- or medium-priority issue.

The combined focused suite passes 157 tests with no failures. Type checking,
lint, and whitespace checks pass. The fixes are commits `1590baa` and
`eca7a67`. The next validation will again start as a fresh, unsteered Flights
teach from the latest combined recording.

## 2026-08-31 19:36 PDT — Fresh Flights detector mixed request IDs into event evidence

Fresh run `eeab1720-a017-4c8f-ae2f-4c1bd36dbcfc` again used the intended latest
recording. Triage kept 50 requests and independent replay captured 413 requests.
The shipped detector proposed four operations, but the run failed before the
advisor, master, journal, or compiler started.

One proposal put IDs `748` and `758` into its browser-event list. Both IDs are
real successful `GetShoppingResults` requests in the recording, not events. The
detector prompt already says these number spaces are distinct, but the model
interleaved the requests with the click events that triggered them. The current
master handoff removes narration IDs from an event list but leaves request IDs
and invented IDs for a later strict check. That check rejected the whole
discovery package, even though event citations are only optional hints and the
complete evidence was still available.

The general repair is to ground only the raw detector's event-hint list against
the recording's real event IDs. Real events survive; request IDs, narration IDs,
and invented IDs do not. The candidate itself and every request, parameter,
dependency, and evidence document remain untouched for the advisor and master
to judge. Later advisor and master outputs remain strictly validated. This is a
mechanical detector-to-master handoff fix, not a Flights rule or a change to
candidate selection semantics. The failed run will not be resumed.

The repair is commit `fb0347f`. It replaces the earlier narration-only cleanup
with the single recording-event intersection and removes the now-unneeded
narration index from the controller. Tests prove real events survive, invalid
event hints disappear without deleting the candidate, complete evidence still
reaches the advisor, and any invalid event added later by the advisor or master
is still rejected. The combined focused suite passes 198 tests, with type
checking, lint, and whitespace checks clean.
