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

## 2026-08-31 20:56 PDT — Fresh Flights proved MVP-first delivery, then stale failures caused a planning loop

Fresh, unsteered run `e4de54bb-b7b9-4f22-a0ed-13aa01438225` used the intended
latest combined Flights recording. The detector handoff passed. The master kept
four API tools in three dependency waves: location resolution; calendar fares
and flight search; then booking options. It did not choose browser playbooks.

The location resolver reached a real usable minimum first. Its contract passed,
both recorded requests replayed byte for byte, and a live call returned a
location. The controller immediately installed that one tool instead of waiting
for the other three. It then started the parameter and breadth pass in the
background while calendar and search began. The optional pass kept the one
public `query` input and proved two live locations in roughly 0.4 seconds each.
This is direct evidence that the new MVP-first lane can publish a producer,
unblock later work, and run optional improvement beside the main teach.

Calendar and search passed several mechanical request and live-transport checks,
but their live parsed results were empty. The small result reviewer correctly
rejected them, so neither empty tool was installed and booking remained blocked.
This was minimum usefulness, not optional breadth: an HTTP 200 with zero usable
fares or itineraries is not a shippable core tool.

The agents then found useful new evidence. A calendar planner found the correct
nested fare rows and learned that calendar consumes the resolver's airport code,
while search uses a different resolver field. A later search compile also
introduced one extra `Accept` header; exact replay caught the unrecorded 16 bytes
even though the compiler's offline comparison missed them. These are factual,
site-neutral examples of why exact checks and editable plans are both needed.

The run was stopped only after revision 13 proved a controller loop. New
calendar and search plans were being rejected with failures from older builds
before the new plans had been compiled or checked. Changing a chain output path
also discarded the already working resolver plan and all current receipts even
though the installed resolver already returned both relevant fields. The
controller therefore started rebuilding work it had already proved. Continuing
would not have produced new evidence.

The command ended as cancelled and printed `0 ready, 4 failed` because the
current journal revision no longer pointed at the already installed resolver.
The resolver remains installed on disk, but the terminal did not explain that
distinction. The run will never be resumed.

The next repairs are deliberately narrow and general: bind every failure to the
exact plan/build that produced it so an older failure cannot reject an untested
replacement; retain a published producer across a chain-edge edit long enough
to test whether its existing output already satisfies the new edge; and report
previously installed MVPs honestly when a later revision becomes stale. After
those changes, validation will start with another fresh run.

## 2026-09-01 05:05 PDT — Removed replay policy and made repair facts belong to the exact failed work

The earlier controller made recorded-request replay a required publication
step. It added `replayParameterValueOrigin` only to remember whether the
planner had supplied recorded parameter values or claimed they were
unavailable. That let the runtime decide when an unchecked replay could be
waived. It was not needed to run a generated tool, and copying that hidden
host-added field back through the master output created a second undocumented
contract. The field and the required replay gate are now gone.

Recorded-request comparison remains available to the compiler as an on-demand
diagnostic. It is useful when a live call fails, returns an empty or implausible
result, or leaves request construction uncertain. It is not universal proof:
`+` and `%20` can mean the same form value, JSON and headers can be serialized
differently, and dates, authentication, nonces, signatures, and old recordings
can legitimately change bytes. Contract and live execution are the required
mechanical path. The agent prompt now says to use the comparison as a clue and
to prove that each public parameter reaches the intended field, position, and
type rather than demanding byte equality.

Event IDs are also only hints now. The detector had copied nearby request IDs
from an interleaved timeline into `eventSeqs`; those number spaces look alike
but are unrelated. The handoff mechanically keeps only IDs that really occur in
the recording's top-level event list, and later optional event citations cannot
stop discovery or repair. The detector, advisor, planner, and master prompts
all say to use an empty event list when uncertain and never copy request or
narration IDs. Codex teaching and discovery default to `gpt-5.6-sol` unless the
user explicitly selects another model.

Old failures no longer leak into replacement work. A failed check now carries
the exact receipt, build, tool, and chain edge that produced it. Those facts go
once to the master repair decision. The fresh planner sees the master's new
reason and current plan, not the old failure as if it had already happened to
the new proposal. Returned API error codes and messages are included in the
bounded repair facts, and two different failures on the same artifact are no
longer mistaken for one repeated failure.

The journal now distinguishes a generated artifact that violates the accepted
schema or request map from a real file/journal failure. The first returns exact
facts to the master for repair; the second stops as a host error instead of
blaming the artifact. A prior artifact becomes a repair seed only after its
contract, live result, small usefulness review, and publication succeed. A
later artifact that merely parses but fails live or usefulness review cannot
replace that last working seed. A fresh compiler context receives that working
artifact plus the exact current repair guidance. If the master changes between
API and browser strategy, incompatible executable files are not copied.

Dependency edits no longer cause broad runtime recompilation. Changing one
edge invalidates only that edge's receipt. Rebuilding a producer keeps consumer
artifacts and their standalone checks, while invalidating only chain receipts
that consumed the replaced producer build or exact live result. Standalone live
results and per-edge chain results are stored separately, so a bad incoming
edge cannot overwrite a working tool or poison an unrelated outgoing edge. The
independent completion reviewer now sees the bounded result for every current
chain edge as well as each tool's standalone result.

The runtime intentionally checks explicit edges one at a time. It does not
guess which incoming result should feed an outgoing edge when a tool has
multiple parents; that graph meaning remains a master decision rather than a
new runtime rule. No Google-specific rule or request classifier was added.

Focused controller, journal, agent-contract, prompt, and end-to-end regression
tests pass. The first full run exposed two unrelated process/Chromium stress
test flakes; both passed immediately in isolation. A clean full rerun then
passed all 1,810 tests. Type checking, lint, dead-code checks,
circular-dependency checks, and whitespace checks are clean. A fresh unsteered
teach is next; no pre-change run will be resumed.

## 2026-09-01 05:20 PDT — Finished the KISS pass before the next fresh teach

The first pass had removed replay from the controller but left old helper code
that could still manufacture exact byte-comparison receipts. That code is now
gone. The journal no longer invents `REPLAY N/A` for browser tools, and no
current prompt or completion rule requires a replay receipt. Old receipt files
can still be read for diagnosis. The compiler's `compare_rendered_requests`
tool remains available when an agent wants to investigate request construction;
it is not a publication gate.

A failed first draft is now available to the next fresh compiler for the same
tool and strategy. This avoids making the compiler rediscover everything after
a small schema, provenance, live, or result defect. This is not a resumed agent
session: the next compiler starts with a clean context, reads the prior files,
and gets only the current plan and exact current failure. Once a build has
actually passed and been installed, that known-good build always takes priority
over later broken drafts. API files are never seeded into a browser compile or
vice versa.

Thrown completion-review and journal errors no longer go to the master as if a
tool design were wrong. Parallel compile workers finish settling before one of
those host errors is reported, preventing late journal writes after the command
has already failed. Clear disk, quota, permission, and file-descriptor failures
stop as host failures. A missing generated artifact remains an ordinary compile
defect that the agent can fix.

Returned API failures now tell the master the HTTP status, the last bounded
request-stage facts, the bounded message and response preview, missing-state
facts, remediation, and continuation field names without copying continuation
values. Two failures with the same generic message but different HTTP or stage
facts are therefore different repair evidence. The final reviewer is also
proved able to reject one exact producer-consumer result even after the earlier
small edge review accepted it.

The focused controller tests pass 46/46. Type checking, lint, dead-code,
circular-dependency, and whitespace checks are clean. Two full-suite attempts
each passed 1,804 of 1,806 tests and hit different pre-existing Mac process or
Chromium timing flakes; every reported flaky case passed immediately when run
alone. No teach-specific test failed. The next action is a Git checkpoint and a
fresh, unsteered teach using the latest combined recording.

## 2026-09-01 05:20 PDT — Started fresh, unsteered Google Flights validation

After checkpoint `dfff549`, I started
`bun run src/cli.ts teach google-flights --agent codex` with no resume flag, no
site-specific prompt, and no steering. The automatic recording resolver selected
the current combined Flights recording. Fresh run
`50f8d201-001e-4ea7-a306-786756ebc460` began with 160 relevance candidates;
triage retained 48 requests, and candidate discovery started beside the
best-effort independent browser observation. This entry records only the start;
the result will be added when the foreground command reaches a real terminal
state.

## 2026-09-01 05:40 PDT — Fresh Flights stopped before compilation because two tool-name formats were confused

The fresh run ended honestly as failed before any tool compiler started. The
discovery stage found four operations, but the master returned an internally
inconsistent plan: a booking tool said it depended on `flight_search`. That was
the producer's stable internal ID; the dependency field required the producer's
public tool name, `search_flights`. The command therefore printed zero ready and
zero failed tools because no valid plan or tool journal had yet been created.
The failed run is read-only and will never be resumed.

The runtime was right not to execute a plan containing a reference to a tool
name that did not exist. It should not guess that an ID was intended or silently
rewrite the master's decision. The setup around that factual check was wrong:
the prompt did not plainly separate public tool names from stable IDs, its main
example showed no dependency, the error was reported at the whole-plan level,
and the repair call kept only the first 12,000 bytes of the previous answer.
Real four-tool Flights and Hotels answers are already larger than that, so the
repair agent could not see the later tool and dependency that needed changing.

The fix remains site-neutral and small. The master and boundary-advisor prompts
now say exactly which fields use public names and which use stable IDs, include
a two-tool example, and require every rename to be propagated. Repair receives
the complete previous answer and a short explanation of the repair envelope,
including that it must return one complete replacement object. Candidate errors
now retain their exact field path, so the repair sees the offending dependency
instead of only “the plan is invalid.” The compiler seed wording was also made
factual: prior files may be either a rejected draft or a known-good build, so the
compiler is no longer falsely told that every supplied seed is working.

The focused agent tests pass 92/92 and the controller tests pass 46/46. Type
checking and lint are clean. After the remaining repository checks and a Git
checkpoint, validation will start another fresh unsteered teach rather than
resuming this failed run.

## 2026-09-01 07:18 PDT — Fresh Flights proved planning and early publishing, then exposed a repair handoff loop

Checkpoint `d991899` fixed the plan-name failure, and a completely fresh,
unsteered Flights run `2e90eb09-9f8e-4087-96d4-f82771320937` selected the latest
combined recording. Discovery again found four operations. This time the master
returned a valid four-tool plan in two waves on its first attempt, so the naming
and repair-context fix worked.

The airport lookup reached a useful minimum, passed its contract and live check,
and was published immediately. Plain fetch won its first live race in about 0.46
seconds. Its optional parameter review continued in the background while the
other tools compiled. Later revisions preserved this working producer and both
of its factual receipts.

Calendar and flight search did not reach useful results. Calendar moved through
several different real defects: a malformed request, an empty result, a genuine
RPC error, and then missing page-produced state. One draft briefly fixed the HTTP
request but still returned no useful fares. Search repeatedly reached the live
API through plain fetch, often in well under one second, but seven successive
core reviews saw an empty normalized result. Booking correctly remained waiting
for its producer instead of compiling against an unproved search result.

Every repair used a fresh planner and compiler, and the runtime kept the working
airport tool. The remaining loop was an information handoff failure. The raw
focused evidence contained the needed request details, but a requirement learned
in one plan disappeared from the next plan. Fresh compilers saw prior files but
not a durable checklist of unresolved repair facts. For search, they saw only
the empty parsed result—not enough of the prepared live request, captured state,
raw response, and parser input to tell whether the request or parser was wrong.
They therefore kept making new guesses that passed their own local tests.

After eight independent calendar/search draft cycles produced the same practical
outcome, I cancelled the diagnostic rather than let its default 12-hour deadline
consume the day. The terminal honestly reported `1 ready, 3 failed`. The airport
MVP remains installed. This run is read-only and will never be resumed.

The next fix will stay small and site-neutral: carry the prior implementation
plan and unresolved repair facts into the next fresh context as history, clearly
label old failures as belonging to the old build, and supply one bounded factual
live diagnostic. The compile prompt will explain its state-capture choices and
say to use the existing request comparison only after a request-construction or
implausible-response failure. There will be no runtime byte-equality gate,
automatic request rewrite, semantic classifier, or Google rule.

## 2026-09-01 07:39 PDT — Kept repair intelligence in the agents instead of adding another runtime gate

The 146-byte versus 148-byte request example clarified the boundary. Exact
request comparison is useful for diagnosing construction mistakes, such as one
encoding spelling a space differently, but it cannot be made universally
authoritative. Dates, old recordings, authentication state, nonces, signatures,
header order, and equivalent encodings can all produce legitimate differences.
The runtime therefore still does not require replay or byte equality. The
compiler can use the existing offline comparison after a failed, empty, or
implausible live result, and its prompt now explains that a failed comparison is
only an incomplete diagnostic—not a verdict on the artifact.

The fresh Flights loop did not justify adding request tracing throughout every
HTTP and browser backend. That would have enlarged the runtime and recreated
the same policy problem. Instead, the handoff now carries one small, documented,
input-only repair object: the complete previous implementation plan and only
the latest failure facts, bound to the exact older plan and build that produced
them. A fresh planner and compiler may preserve, revise, or reject those older
decisions. The facts are overwritten on the next failure and cleared after
success; they are never accumulated into a growing theory of the site. A
rejected semantic result also includes its bounded expected result, actual
parsed preview, shape, count, and receipt reference, so the next agent is not
left with only “result rejected.”

The compile instructions had a separate factual bug. They said `done` would run
live verification and return failures to the same compiler, but master MVP mode
actually returns after deterministic checks and the master performs live work
later. The prompt and MCP tool description now say this plainly. They also
document the real `mode: "navigate"` switch, explain that transform navigation
options cannot turn a fetch into navigation, and explain the capture capability
labels as descriptions rather than backend commands. This addresses the failed
Flights drafts without choosing a browser strategy in runtime.

Optional event citations remain non-blocking. The earlier wrong IDs came from
confusing three neighboring number spaces—requests, narration, and top-level
events. The discovery prompt now names those spaces, the payload presents them
separately, and the handoff keeps only IDs found in the real top-level event
list. This is a prompt/setup correction, not a semantic runtime rejection.
Codex discovery and all other Codex teaching roles already default to
`gpt-5.6-sol` unless the user explicitly chooses another model.

Dependency bookkeeping remains only where it records factual proof. Editing a
chain path does not rebuild or discard either artifact; it invalidates only the
old chain receipt that names the old path or producer result. Existing plan,
journal, and full-controller tests prove that a working producer and its
standalone contract/live receipts remain intact. Removing that last receipt
invalidation would let the terminal claim a new dependency passed using an old
dependency result, so it is retained as truth bookkeeping rather than a
teaching decision.

The focused repair, prompt, compile-tool, and master-controller tests pass
178/178. Lint, type checking, dead-code, circular-dependency, and whitespace
checks are clean. The full repository suite passed 1,809 of 1,810 tests; one
unrelated Chromium shutdown stress test timed out under whole-suite load and
then passed in about two seconds when run alone. Earlier recorder and hostile
process-cleanup flakes also passed repeatedly in isolation. None of the changed
files implement recording or process cleanup, so this repair does not add teach
logic for those timing flakes. The next validation will be another fresh,
unsteered teach; the cancelled Flights run will not be resumed.

## 2026-09-01 08:03 PDT — Closed the last repair-handoff gaps before another fresh teach

Independent review found that the earlier patch still did not tell the master
how to request a new artifact when the public tool design was already correct.
The answer is now explicit and simple: keep the tool and its public contract,
but leave out its old implementation plan. That calls a fresh focused planner
and compiler, gives them the compatible prior files, and avoids changing an
unrelated field merely to trick the runtime into rebuilding. A full controller
test now proves that this produces a second build and can complete successfully.

The failure handoff had two smaller bookkeeping bugs. First, a long failure was
converted to JSON and then cut in the middle, which could make it unreadable and
cause the next agent to lose the expected-versus-actual result. Check-history
JSON is now kept complete within its existing bounded fields. Second, a receipt
was checked for the right tool and check name but not for the exact current
build. The handoff now rejects an old build or superseded receipt instead of
attaching it to the new plan.

When the master deliberately recalls a producer because a consumer or chain
failed, that producer now receives the current failure package as well as its
own prior plan and files. This is not an automatic dependency theory: the
runtime sends the cross-tool context only after the master has explicitly
chosen that producer for recompilation. Tests prove that downstream artifacts
remain in place while the selected producer is rebuilt.

The compile instructions now use one consistent meaning for `done`: in the
master MVP flow it hands the artifact back to the master for live checking; in
standalone mode it continues to the independent verifier. The request
comparison instructions no longer promise partial output when a later request
preparation fails. Capture capability labels are described accurately as the
minimum mechanism able to obtain missing state, while the agent still decides
what that state means and which teaching strategy to use.

A final review tightened three more factual details. A chain-only wiring repair
now explicitly keeps both working artifacts and changes only the edge; it does
not use the artifact-recompile instruction. If an asynchronous check tries to
hand off a receipt that has already been replaced or belongs to an old build,
the controller prints an internal diagnostic, ignores that stale failure, and
re-reads current state instead of ending the teach. Finally, a top-level object
result no longer invents `count: 1`; only top-level arrays receive an automatic
count, while object results use `null` and leave their real nested counts in the
bounded result preview.

The expanded focused suite passes 208/208. Lint, type checking, dead-code, and
circular-dependency checks pass. The final full-suite run passed 1,811 of 1,812
tests. The only failure was the same unrelated Mac Chromium-exit stress flake;
the hostile-process test passed this time. Those exact stress tests passed
repeatedly in isolation earlier (five recorder repetitions and sixty hostile
cleanup repetitions). No changed file implements recording or process cleanup.
After the Git checkpoint, the next action is a completely fresh, unsteered
Flights teach.

## 2026-09-01 09:01 PDT — Fresh Flights found five API tools and exposed two small control bugs

After checkpoint `38203d5`, I started a completely fresh, unsteered
`google-flights` teach. Run `23c7c9de-6c5c-46d2-8f39-2f8306b2c1f1`
automatically selected the latest combined recording with hash
`fb2f07e27379817a10eb1e96702bd29fab63836f0656cc36d59ad0011a8c53af`.
It was not resumed from an older run and received no site-specific direction.

Discovery found five useful API operations: airport lookup, airport details,
calendar prices, flight search, and booking options. The master kept all five,
put their dependencies into waves, and did not choose browser fallback. Airport
lookup passed and was published. Airport details also worked by itself. Calendar
reached its recorded API shape but its current page bootstrap did not produce a
declared build value. Flight search reached the live endpoint but received HTTP
400. Booking correctly waited for flight search instead of compiling against a
failed producer.

The airport-details dependency test then revealed a host-checker mistake. The
producer returned the correlated pair `location_id=/m/013110` and
`location_type=1`. The checker made two separate calls, pairing each producer
value with the other parameter's default. It therefore tested `/m/013110, 0`
and `SJC, 1`, but never tested the real pair `/m/013110, 1`. The master was given
a misleading failed result and reasonably asked for a new details artifact.

An earlier master response exposed a separate control ambiguity. Its written
reason said to retain the working details and booking implementations and recall
three other tools, but its JSON accidentally omitted the implementation plan
from all five tools. The host had overloaded omission to mean “recall,” so it
discarded all five plans despite the master's stated intent. This was not a
compiler failure and not a reason to add more semantic runtime policy.

I cancelled the diagnostic at revision 6 after about 51 minutes so these host
bugs could be corrected before another validation. The command said `1 ready, 4
failed`, which was inaccurate: one tool was ready, three were being repaired,
and booking was waiting. This run is now read-only and will never be resumed.

## 2026-09-01 09:30 PDT — Made recall explicit and tested correlated producer values together

The master now has one visible, documented command, `recallToolIds`, for asking
fresh focused planners and compilers to repair selected tools. Leaving a plan
out by accident no longer discards a working artifact; unchanged tools are
carried forward unless the master explicitly recalls them. A real change to a
tool's inputs still makes an incompatible old plan unusable, because an old
artifact cannot truthfully claim it implements a new contract. There is no tool
count cap on recall. The repair compiler receives the prior files, the master's
reason, and the latest facts relevant to that tool rather than an unrelated
site-wide failure dump.

The chain checker now sends all declared producer-backed fields to the consumer
in one call, including fields supplied by different producers. It keeps one
factual receipt per declared connection. Multiple possible source paths for the
same consumer parameter remain separate calls, while every other declared
field stays producer-backed in those calls. If any incoming connection changes,
only that consumer's old chain receipts are cleared and rerun; its artifact,
standalone checks, and unrelated consumers remain intact. This is a general
dependency fix, not a Flights rule.

The failed state captures do not justify another compile-time classifier. The
calendar and search artifacts both declared bootstrap capture recipes, and the
existing structural checks correctly accepted those recipes. Only a live page
can prove that an old recorded pattern still produces a value today. Structural
checks therefore remain responsible for whether a recipe can work; live checks
remain responsible for whether it actually works now.

Cancelled or provider-interrupted commands now label remaining tools as
`unfinished`, not `failed`. Focused master/controller tests, type checking,
lint, dead-code checking, circular-dependency checking, and whitespace checks
are clean. The next validation will be a new Flights run after this checkpoint,
never a resume of the cancelled run.

## 2026-09-01 10:01 PDT — Removed the checker's last guess about dependency combinations

Review found that the first correlated-value fix still made a runtime guess. It
paired the first source for each parameter, then swapped in alternatives one at
a time. With two real alternative pairs, that could test mixed pairs that the
master never intended and miss a valid pair. It could also mark connections as
failed before it had actually checked them and clear proof for an unrelated
alternative.

The plan now has one small, optional field named `invocationGroup`. The master
or focused planner uses the same group name on values that must be passed to a
consumer together. Different alternatives use different group names. Leaving
the field out means that connection is tested alone. The runtime does not infer
groups from request names, producer names, parameter names, or array order; it
executes exactly the groups the agents chose. The detailed prompts explain this
with current schemas and examples.

Receipts now name every producer result actually used by a grouped call. If a
value cannot be bound, only that exact connection receives the failure receipt.
If the consumer call itself fails, the repair fact names the whole group. A
producer change clears only groups that used that producer, and a group edit
clears only the old and new versions of that group. The consumer artifact and
its standalone proof stay in place; the master still explicitly decides whether
an artifact needs a fresh compiler through `recallToolIds`.

The terminal result and saved `terminal.json` now call the count
`nonReadyTools`. The displayed word depends on the real outcome: failed,
blocked, or unfinished. This removes the last internal label that called
cancelled or provider-interrupted work a failure.

The final baseline reviewer also receives the exact connections used in a
grouped call, so it judges what was actually checked instead of silently
assuming a one-value call. Independent contract and runtime reviews are clean.
The changed-path suite passes 293/293; type checking, lint, dead-code,
circular-dependency, and
whitespace checks pass. The repository-wide suite passed 1,823 of 1,824 tests;
the only failure was the unchanged Mac Chromium-exit timing test, which passed
immediately when rerun alone. The next validation remains a completely fresh,
unsteered Flights teach after a Git checkpoint.

## 2026-09-01 10:58 PDT — Fresh Flights kept one MVP but exposed misleading backend feedback

After checkpoint `1bb6aa0`, I started a completely fresh, unsteered
`google-flights` teach. Run `397a57aa-406d-4592-b618-ebac9be40f6e`
automatically selected the latest combined recording with hash
`fb2f07e27379817a10eb1e96702bd29fab63836f0656cc36d59ad0011a8c53af`.
It was never resumed and received no site-specific advice.

Discovery proposed four API operations: location lookup, calendar prices,
flight search, and booking options. The master kept all four and placed them in
three dependency waves. Location lookup passed its contract and live check and
was published immediately. Its parameter review then ran in the background
while calendar and search compiled in parallel. This proved that the foreground
command stayed attached, one working MVP could ship before the whole teach was
perfect, and a published producer survived later repair revisions.

Calendar and search both passed their file/schema checks but their generated
API requests received HTTP 400 from the current service. Their repair compilers
read the previous files and the new failure evidence rather than starting
without context. The calendar compiler reported that it needed to intercept a
page-generated request, then gave up after two API repair attempts. Later
review showed that this conclusion was not proven: the generated request was
also malformed, and the compiler had never completed the available offline
comparison. The master later chose the playbook fallback; that playbook timed
out on its second click and did not become ready. Search made several API
repairs and did obtain a fresh page session ID, but its generated request was
still malformed and returned 400. Booking correctly stayed behind its failed
search producer.

The run exposed a generic feedback bug. The parallel backend probe recorded
that CDP reached search request 1 and received HTTP 400. The later sequential
ladder returned only its last `stealth-fetch` error, which said request 0 needed
top-level browser navigation. Only that last message reached the master. The
master therefore incorrectly concluded that the API request had never run and
recalled search again. The runtime must preserve all attempted backend outcomes
as facts instead of choosing a misleading final one.

The command finally ended after about 47 minutes with `1 ready, 3 failed` and
the message `codex-cli exited 101 without provider diagnostics` during the next
master decision. Because the exit contained no structured provider fact, the
ordinary provider retry wrapper did not retry it. This run is now read-only and
will never be resumed. The next work is limited to generic fixes for preserving
backend outcomes and retrying a diagnostic-free Codex process interruption;
there will be no Flights-specific runtime rule.

## 2026-09-01 11:20 PDT — Kept failure facts intact and fixed agent information gaps

The request-byte comparison remains an optional investigation tool, not a
runtime pass/fail gate. Exact bytes are useful for finding construction mistakes
such as `+` versus `%20`, but they cannot be a universal definition of a good
request because dates, login state, one-time values, signatures, and even two
equivalent encodings can legitimately differ. The removed
`replayParameterValueOrigin` field has not been restored. The master is never
required to echo hidden runtime bookkeeping.

The fresh Flights run showed that the runtime tried several execution methods
but told the master only about the last failure. One browser-backed attempt had
actually reached the main request and received HTTP 400; a later method failed
earlier during page navigation. The runtime now carries the short factual
history of every attempt separately and puts it near the top of the master's
failure report. It does not interpret which failure matters. Tests prove that a
long first error cannot hide the HTTP 400 or the final navigation failure.

A Codex process that exits with code 101 and no diagnostic is now treated as a
provider interruption. The existing capped backoff retries the same logical
call. Other exit codes, a 101 with a real diagnostic, and normal schema or
request failures are still returned immediately rather than retried.

The agent setup also had two concrete information gaps. The planner had
proposed intercepting a request generated inside the page even though the
current artifact format cannot do that. The master, planner, and compiler now
receive the same short list of what the artifact can actually express, and are
told to reject an impossible plan without treating that plan defect as proof
that the API is unusable. Separately, the browser compiler could see event IDs
but could not read their exact recorded element details. It now has a simple
`read_event` tool and must ground every browser action and locator in those
details instead of inventing controls.

The parameter wording is now unambiguous: detector parameters are suggestions.
The planner and master may add, remove, or rename them. Only the smaller list
the master finally accepts becomes the first MVP contract. A fixed/default mode
does not require a public parameter or an extra browser click merely because
discovery guessed one.

Optional event IDs remain nonblocking. The discovery prompt clearly separates
request, narration, and event number spaces, and Codex discovery defaults to
`gpt-5.6-sol`. If an agent still cites the wrong optional event ID, the host
drops only that citation and preserves the proposed operation. Plan decisions
now also ask for a fresh timestamp on every recorded revision. Finally, a
failed terminal summary says tools are `not ready` instead of claiming every
unbuilt dependent tool personally failed.

## 2026-09-01 11:38 PDT — Closed the remaining feedback gaps and removed one hidden strategy guess

Independent review found that the first provider fix covered master and planner
calls but not the focused Codex compiler. A diagnostic-free Codex exit 101 from
inside a compile is now the same temporary provider interruption: when Codex
returned a conversation ID, Imprint backs off and resumes that exact compile;
when no ID exists, the run reports provider unavailability instead of blaming
the artifact. Tests exercise both cases.

The backend history also had one remaining hole. When parallel probes selected
a result such as `AUTH_EXPIRED` or `RATE_LIMITED`, the return path kept only the
selected backend even though every probe had run. Every parallel outcome now
travels with the selected result, whether it passed or failed. The master still
decides which fact matters.

Review also identified an older runtime heuristic that called some
multi-request shapes “anti-bot” and silently moved CDP to the front. That is the
kind of semantic strategy guess this rebuild is meant to remove. The heuristic
and its special ordering are gone. The API ladder has one fixed order and does
not inspect request meaning. Probe eligibility uses only explicit artifact
facts: a declared navigation request, a bootstrap, or a declared browser
capture. A separate value-free hash still notices `${state.*}` placeholders so
an old backend cache cannot be reused after the artifact's mechanical needs
change.

The compiler's prompt and callable tools are now checked against each other.
Claude can call exact event lookup, request search, the optional offline request
comparison, and local diagnostics, and the prompt table documents each one.
Offline comparison can now feed a recorded response through a declared
navigation request and inspect a later API request without launching Chrome.
If navigation preparation fails or is skipped, the result says `not checked`
instead of the misleading `N/A`. Event lookup promises exact redacted event
detail, and promises DOM detail only for event types that actually recorded it.

Focused tests, type checking, lint, dead-code checks, circular-dependency checks,
and whitespace checks pass. A repository-wide run before the last small test
wording correction had only the unchanged detached-process timing flake plus
one expectation intentionally made stale by the new all-attempt history. A
clean full-suite rerun is the next checkpoint step.

## 2026-09-01 11:47 PDT — Final review and repository-wide validation

Three independent reviews covered the agent/runtime contract, stale-plan and
producer handling, provider recovery, backend history, and the general change
set. They found no remaining code defect. One reviewer found stale architecture
text that still described the deleted semantic CDP-first heuristic. That text
now describes the fixed initial ladder and the later reordering based only on
observed successful runs.

The first repository-wide test attempt filled the disk because 543 abandoned
Imprint Chrome test profiles occupied 3.5 GB in the system temporary directory.
That caused the recorder test to time out and later tests to fail while creating
temporary files. No live process used those profiles, so only the generated
`imprint-chrome-*` temporary directories were removed. Recordings, generated
tools, source files, and normal browser profiles were untouched. The recorder
suite then passed 8 of 8 tests.

The clean repository-wide rerun passed 1,830 tests. Two process-teardown timing
tests failed only when the entire suite ran concurrently; each passed
immediately on its own (one recorder Chromium-exit test and one hostile
grandchild-reaping stress test). The focused tests for this change passed in
all three independent reviews, and the previously cascading compile, store,
and verifier tests passed 80 of 80 when rerun directly. These two timing flakes
are environmental and are not being turned into teach-runtime policy.

## 2026-09-01 14:20 PDT — Kept real agent conversations and removed chain grouping

The long Flights repairs were repeatedly paying the cost of re-explaining a
tool to a new agent. Imprint's small semantic roles also used
`codex exec --ephemeral`, so even the master and focused planner forgot earlier
turns. Those calls now use the official Codex SDK. One SDK thread is retained
for the master, one for discovery review, and one per tool and focused role.
Later messages append to the same thread. Imprint does not summarize or compact
those conversations; Codex owns its normal context management and compaction.
A provider interruption also keeps the same thread object instead of forking a
new conversation during backoff.

The tool compiler already had a resumable Codex conversation, but the master
started a new one for every ordinary repair. The controller now remembers the
compiler session for each public tool and strategy. A contract, request, or
live-check repair returns to that session with the current plan and exact new
facts. It also seeds the last artifact directory, so a small requested change
can be a small edit. A real API-to-browser strategy change still starts a new
compiler because it is a different job. Tests prove that the second
same-strategy attempt receives both the prior files and the first session ID.

The master-facing repair command is now `recallToolNames`, and its values are
public tool names. The prompt now tells agents to use that public name for all
references instead of reasoning about a second ID namespace. Existing journal
fields remain as storage details for compatibility, but the teaching decision
no longer asks the master to choose between two names.

The chain checker no longer has optional groups or alternative routes that the
runtime combines. All bindings for one consumer are one explicit invocation.
The master chooses at most one producer binding for each consumer parameter;
if evidence shows alternatives, the master chooses the best-supported route.
The runtime only reads those paths, invokes the consumer once, and records the
facts. Changing any binding invalidates that consumer invocation's old chain
receipts, not unrelated artifacts.

No site-specific rule was added. Type checking and the focused planning,
journal, provider-recovery, controller, and end-to-end tests pass. A fresh
teach has not started yet; repository-wide validation and a commit come first,
then the next Google Flights teach starts from the latest combined recording.

Repository-wide validation then passed type checking, lint, dead-code checks,
and circular-dependency checks. The full run passed 1,830 tests and hit the same
known process-teardown timing flake recorded at 11:47; that single hostile
grandchild test passed immediately on its own. No teach policy was added for
the environmental flake.

## 2026-09-01 16:17 PDT — The fresh Flights run exposed two avoidable delays

Fresh run `f4ae1732-c754-4d95-9aeb-9b4d1763a4be` used the latest combined
Google Flights recording and found five operations. It published a working
`resolve_flight_location` MVP, but ended with one ready tool and four not ready.
This was a useful clean failure: it showed that retained conversations alone
were not enough because Imprint was still treating each turn like a stateless
request.

Compilation did not begin until about minute 18. Roughly six minutes were spent
replaying the entire recording in Chrome to produce an optional second copy of
network evidence. Planning then repeatedly sent the master the same discovery
bundle. The four master inputs were about 592 KB, 624 KB, 680 KB, and 683 KB.
Most of every input was the same 546 KB discovery evidence. The retained thread
consumed about 696,000 cumulative input tokens. Codex compacted earlier history,
but the next oversized full snapshot filled the window again and ended the run.

Teach no longer replays the whole session in Chrome before planning. The saved
recording remains authoritative; a browser is used later only if an actual
compiled candidate needs that transport. The retained Codex master now receives
discovery once. Later messages contain only the new planner proposals,
verification failure, or parameter advice. Output validation still uses the
complete host state, so reducing the prompt does not weaken schema or binding
checks. Output-repair turns likewise send the prior answer and exact errors
without repeating the original task. Codex's own automatic compaction is set to
run at 100,000 tokens; Imprint does not write its own conversation summary.

Verification also no longer starts fetch, stealth, and a cold Chrome together
and waits for all three after fetch has already succeeded. It walks the fixed
generic ladder and stops at the first usable result, preserving facts for every
rung that was actually attempted. This removes the observed 30-second Chrome
wait from ordinary Google Flights API checks without adding site-specific
rules. Focused agent, controller, backend, and SDK tests pass, as do type
checking, lint, and whitespace checks. A fresh teach after the final full test
and commit is the next validation; the failed pre-change run will not resume.

## 2026-09-01 16:49 PDT — Fresh Flights run proved context was fixed but repair routing still looped

Fresh run `38c3bd00-25a8-4eaf-b312-a2eb32ba4216` used the latest combined
Google Flights recording. It moved directly from triage to discovery without
the old whole-session browser replay, found five operations, and kept one
master conversation. The master's new inputs were about 39 KB, 43 KB, and
25 KB instead of the prior 592–683 KB snapshots, so the context-overflow fix
worked.

The run still took 30 minutes and ended honestly with two ready tools and three
not ready. `search_flight_locations` and `resolve_flight_location` compiled,
passed live fetch checks, and published as usable MVPs. Calendar and flight
search compiled but their live POSTs returned HTTP 400. Browser-backed
transports were attempted only after those real API failures; this was backend
verification, not the removed discovery-time observation.

The live audit found the remaining avoidable loop. The master correctly said
the API tool designs were still valid and asked to repair the compiled
artifacts. However, the host interpreted `recallToolNames` as “discard the
implementation plan and call the planner again.” That produced master →
planner → master turns before the retained compiler could receive a narrow
repair. One planner then hit the run-wide deadline, so the intended compiler
repair never started.

`recallToolNames` now means exactly “rebuild this public tool's artifact.” The
journal invalidates that tool's build and receipts but preserves its accepted
implementation plan. The master reason and source-bound failure facts go
straight to the same retained compiler conversation. A planner runs again only
when the master actually changes compile inputs such as parameters, strategy,
evidence, or the request plan. Focused agent, journal, and foreground
controller tests prove that an unchanged recall skips the planner while the
compiler receives the prior build, failure facts, and repair guidance.

## 2026-09-01 18:20 PDT — Stopped the browser detour and kept only the good Flights selection

Fresh Flights run `ccaa4f00-3fc7-4869-b7d0-5176c69e0f5d` began with a sound
four-tool API plan: location lookup, calendar fares, flight search, and booking
options. Later repairs changed calendar and search to browser playbooks and
dropped booking options. That was the wrong direction, so the run was stopped
with one ready tool and three unfinished tools. None of its compiled files or
failed repairs will be resumed.

Starting discovery over would also throw away work that was already good. Teach
therefore has a narrow `--from-candidates <run-id>` restart. It copies only the
chosen operation boundaries and the recording evidence behind them. The source
site and exact recording hash must match. The new run gets a new folder, plan,
master conversation, planner conversations, compiler conversations, builds,
and checks. The first new master message includes the complete selection so it
does not assume an old conversation still exists. Older runs without the new
checkpoint file can recover the earliest selection from their saved history;
every recovered file is checked against its recorded hash first.

The agent instructions now make browser playbooks the final escape hatch. A
single HTTP failure, empty result, changing-looking field, or request mismatch
does not prove an API is impossible. When request construction is uncertain,
the retained compiler should try a small set of two or three meaningful API
combinations, normally including the closest recorded request and the strongest
fresh-state version. It records what changed and what happened, but avoids a
slow exhaustive search. These are general instructions and contain no Google
Flights-specific runtime rule.

An independent review found no path for old builds, check results, compiler
sessions, or staged files to cross into the restart. Type checking and 209
focused CLI, agent, and end-to-end tests pass. The full run passed 1,831 tests;
one prompt expectation needed the explicit “100% certain” fallback wording and
the same known process-cleanup timing test flaked under full-suite load. Both
passed immediately when rerun. Lint, type checking, dead-code checks, circular
dependency checks, and whitespace checks pass. The next step is to commit this
checkpoint and start a fresh Flights teach from the preserved four-tool
selection and its exact recording, with a 60-minute hard limit and a 15-minute
expected completion time.

## 2026-09-01 19:15 PDT — The candidate restart worked; factual repair feedback did not

The first restart attempt, run `34f37789-308f-46c2-85b0-d376e81b27bc`, used
the killed run's local redacted copy rather than the original combined
recording. Its bytes did not match the candidate checkpoint, so the new hash
guard rejected it immediately. The latest combined source recording was then
matched by its exact hash and used for the real fresh run. This confirmed that
candidate reuse is tied to the recording that actually produced the selection.

Fresh Flights run `6e3c489f-4404-424e-b749-e9d335bac32a` loaded the four-tool
selection in about two seconds and planned four API tools in two waves:
location lookup, calendar fares, flight search, and booking options. It did not
switch any tool to a playbook. Location lookup passed and was published. The
calendar and search requests eventually ran, but their parsers returned empty
results, so booking correctly remained waiting on search. The run ended after
about 39 minutes with one ready tool and three unfinished tools.

The final crash was not an agent choosing to ship bad work. After the last
search check, the small result-review agent was called. Its Codex child process
exited with code 101 before producing any response. The newer Codex SDK exposed
that as ordinary text, so the existing temporary-provider retry never saw it.
That exact SDK message now goes through the same capped backoff as other blank
provider interruptions while retaining the same agent conversation. A real
diagnostic or a different exit code still fails normally.

Two general runtime mistakes also cost time. First, a search request failed
locally while its transform was building request 2, but Imprint repeated the
same local failure through fetch bootstrap, CDP, and stealth fetch. A review
caught that a later transform can depend on an earlier response, so it is not
always independent of transport. Only a request-construction failure before
request 0 reaches the network now returns straight to the retained compiler.
Later response-dependent transforms, real HTTP responses, and browser-capable
missing state keep the normal fallback ladder. This narrow shortcut uses only
the recorded execution stage and has no site knowledge.

Second, both retained compilers had already compared their rendered requests
with the recording and reported useful differences. The controller discarded
those summaries before asking the master what to do next. It also kept only the
parser's empty result and hid the shape of the current API response. Compiler
summaries now follow the exact build into the next repair turn, including when
the host rejects a file on schema or recording-provenance grounds. Live checks
add value-free response facts: status, byte length, content type, value type,
array length, and top-level keys. Failed HTTP responses are observed before
their status is classified. No raw response values are copied into the journal,
and these facts are agent evidence rather than new pass/fail rules.

The foreground command was also launching a second full live breadth verifier
for every already-published MVP. On the location tool that repeated four cold
Chrome starts even though the authoritative live check had already passed.
Foreground teach now launches only the small parameter-choice advisor in the
background. Full breadth testing remains later finesse work and cannot consume
the browser and provider capacity needed to unblock the remaining MVPs.

No Google-specific policy was added. A review also fixed optional parameter
advice so its cache identity includes both the tool bytes and its current
dependency wiring. Focused type checking and lint, plus 251
runtime/controller/provider tests, pass. The repository-wide suite passed
1,837 tests and hit one already-known process-cleanup timing flake under full
load; that exact hostile-process test passed immediately when run alone.
Dead-code and circular-dependency checks also pass. After this checkpoint is
committed, the next attempt will again be a fresh run from the candidate
checkpoint and the exact combined recording, never a resume of this failed
build.

## 2026-09-01 20:12 PDT — Fresh dates were mixed with an old recorded route

Fresh Flights run `a21b7f1a-ccba-417e-9c55-e333cc1856a5` reused only the good
four-operation selection from the earlier run. It planned four API tools in two
waves. Location lookup passed and was published. Calendar and search both
reached Google with HTTP 200 responses, but Google returned small error-shaped
responses instead of fares or flights. Booking correctly remained waiting on
search.

The master and retained compilers tried several API repairs. This was useful:
search improved from missing browser state, to HTTP 400, to HTTP 200. The
transport memory also remembered that calendar had previously reached Google
through CDP and that search had reached it through ordinary fetch, so later
revisions did not probe every transport again. The run nevertheless lasted too
long. On its fifth repair decision, the master changed calendar, search, and
booking to browser playbooks. Because playbook is supposed to be the last
resort, the run was cancelled with one ready tool and three unfinished tools.
Nothing from this run will be resumed as a build.

Inspection found a simpler explanation that the API repairs missed. The live
test correctly chose future October dates, but the generated calendar and
search requests still sent a recorded route or `Referer` containing June
dates. The body described one trip while the surrounding page context described
another. Comparing the generated request with the old recording encouraged the
compiler to restore the old header, but that comparison said nothing about
whether the new live request agreed with itself.

The instructions now tell the planner, compiler, and master to treat all copies
of a changing input as one unit. A new date, route, locale, or similar value
must agree in the body, URL, bootstrap URL, headers, and captured state. Old
recorded strings remain useful replay evidence but cannot be hardcoded into a
different live call. Before choosing a playbook, the master must first rule out
this kind of mixed old/new request. This is agent guidance, not a new
site-specific runtime rule.

The run exposed a second general bug. Imprint correctly kept API files separate
from playbook files, but it also started a new compiler conversation whenever
the strategy changed. That discarded the agent's full repair history at the
moment it was most important. Compiler conversations are now retained by the
public tool name alone. Draft files remain isolated by strategy, so a playbook
cannot accidentally inherit API files. A new end-to-end test proves both
properties, and the focused controller, prompt, type, and lint checks pass.

## 2026-09-01 21:00 PDT — The request comparison crashed, so the wrong body looked credible

Fresh Flights run `991d471f-a9e1-4c00-ba02-abbabdce82d3` again reused only the
four good operation boundaries. It kept all four tools on the API path for four
repair revisions. Location lookup passed and was published. Calendar reached
HTTP 200 but returned no fares. Search improved from HTTP 400 to HTTP 200 in a
manual diagnostic, but returned no flights. Booking remained correctly blocked
behind search. When the fifth master decision proposed browser playbooks for
the remaining three tools, the run was cancelled with one ready tool and three
unfinished tools.

The retained conversations and new instructions worked. The master found a
stale request id, kept the date/body/Referer fields together, repaired the
calendar location extraction, and did not choose playbook after the first few
failures. However, it was working from an incorrect claim that the generated
search body already matched the successful recording.

The offline request comparison had actually crashed before preparing the
search request. A recorded multiline Content-Security-Policy response header
cannot be passed directly to the Fetch `Headers` class. Because the bootstrap
response could not be constructed, the later search body was never compared.
The compiler then wrote tests against its own invented array shape. Those tests
passed, but the generated body contained one extra array layer around every
airport. Its encoded route also used a different fixed trip-type byte from the
recorded route. The master spent later repairs varying BGR headers around that
unproven request.

The shipped search example was also probed with current future dates. It no
longer returns usable flights: CDP reaches HTTP 200, but the current response
does not contain recognizable itineraries. It remains useful design evidence,
but its old backend cache is not proof that it works today.

Offline rendering now unfolds multiline recorded response headers into normal
HTTP whitespace and ignores only an individual header that still cannot be
represented. It no longer discards the downstream request comparison. Running
the repaired diagnostic against the failed search artifact prepared both
requests and immediately reported the exact extra array depth, the 571-versus-
595-byte body difference, and the Referer mismatch. The instructions also say
that `not_checked` is an open construction question, and that agent-authored
tests must anchor positional bodies to the successful recording rather than to
the generated structure itself. Exact `read_file` and `write_file` argument
names are now shown to prevent the repeated tool-call typo seen in each repair.
These are site-neutral diagnostic and prompt fixes; no Google-specific runtime
decision was added.

The complete project check passes after this change: 1,839 tests, type checking,
lint, unused-code analysis, and the circular-dependency check are all clean.

## 2026-09-01 21:39 PDT — Flights proved the request fix, then chose browser automation too early

Fresh Flights run `bb4332f1-6f1f-4726-88f6-86ab4d8591ca` reused only the four
accepted operation boundaries from the earlier run. Planning and every build
started fresh. The master again planned four API tools in two dependency waves.

The repaired request comparison changed the outcome materially. Location lookup
passed its live check and was published. Search no longer sent the extra airport
array layer: its first repaired request reached Google through ordinary fetch in
143 ms. Calendar initially failed, but its retained compiler repaired the query
and request structure; a later ordinary-fetch check passed in 553 ms and the
journal retained both its contract and live receipts. This confirms that the
previous request-comparison crash was hiding a real construction defect.

The run still exceeded the 15-minute target. Initial planning took about five
minutes. More importantly, an unchanged tool could spend about 30 seconds in
`fetch-bootstrap`, learn that its browser-minted cookie was unvalidated, and
then spend another 30 seconds starting CDP. Calendar paid that pair more than
once after revisions. Search later demonstrated that the warm path works: CDP
reused an already-open browser and completed in 2.3 seconds. The missing piece
was remembering the conclusive unvalidated-bootstrap result for a tool whose
artifact was being revised.

On the third search repair, the master changed the strategy to a nine-step
browser playbook because three current API combinations returned tiny or empty
responses and it believed a fresh changing header could only come from the
page. The browser evidence did not contain the complete interaction. The
compiler consequently brute-forced many nearby event numbers to invent the
missing locators. As soon as the live playbook began, the run was cancelled.
It is diagnostic evidence only and will not be resumed.

The teaching instructions now make the simpler choice explicit: when API
evidence remains grounded but current live behavior is inconclusive, publish
the other usable API MVPs and leave this tool unresolved. Do not use a guessed
playbook as an MVP shortcut. A browser fallback must already have a complete
ordered recording for every input, selection, submit action, and result
extraction; the compiler must not scan arbitrary event numbers to fill gaps.
An HTTP-success response that is tiny or empty must also be inspected as a
response/parser fact before blaming a changing header.

The compile-time backend ladder now remembers, for that public tool and current
process only, when browser bootstrap conclusively produced an unvalidated jar.
Later artifact revisions skip that same doomed 30-second rung and continue to
CDP or the remaining transports. This is a mechanical performance memory, not
a site rule, and it does not affect installed-tool runtime behavior. Focused
tests cover both the prompt contract and the saved retry; 186 tests pass.

The full project run exposed an older process-cleanup race under parallel test
load. Imprint stopped waiting when a killed child's ownership marker vanished,
although macOS could still report the already-killed process id briefly. Cleanup
now waits on the exact process ids it already observed, within a bounded
1.5-second ceiling. This prevents a finished compiler from leaving a short-lived
grandchild behind. The final complete check passes: 1,841 tests, type checking,
lint, unused-code analysis, and circular-dependency analysis are all clean.

## 2026-09-01 22:27 PDT — Fallback stopped, but calendar repair did not stop

Fresh Flights run `019b2d32-a635-4b03-9d9d-adb7b484cccd` again reused only the
four accepted operation boundaries. It planned four API tools. Location passed
live CDP and published. Search and calendar stayed on API throughout; the master
never proposed a playbook. This proves the incomplete-browser-evidence rule
prevented the earlier bad fallback.

The new backend memory also worked on later revisions. Calendar skipped its
known-unvalidated browser-bootstrap rung and reached ordinary fetch in 484 ms,
417 ms, and 501 ms. Search skipped that rung and began with its previously
successful CDP path. One warm CDP call took 1.0 second; later revisions paid a
cold launch because the 15-second idle pool expired while the compiler was
editing. No revision repeated the full four-rung probe.

The run remained too slow. Planning took about five minutes. The first search
compile then spent almost six minutes in many small read/write/test cycles before
handoff. Search was eventually marked unresolved rather than converted to a
playbook, which is honest. Calendar's transport repeatedly returned HTTP success
but the semantic review kept finding an empty or unusable fare result. The
retained compiler went through five repair turns and finally called `give_up`.
The master then immediately launched a sixth calendar repair instead of shipping
the verified location MVP. The run was cancelled at roughly 41 minutes with one
ready tool and three unfinished tools.

The master instructions now state that a supported retained-compiler `give_up`
after the small hypothesis set is a stop signal for that MVP cycle. Without
genuinely new evidence, the master must keep the candidate as specifically
unresolved, remove it from current build waves, and finish with verified MVPs.
It must not relabel the same idea or scan more events merely to create another
repair turn. This remains an agent decision rule, not a runtime retry counter.

The complete project check passes after this change: 1,842 tests, type checking,
lint, unused-code analysis, and circular-dependency analysis are all clean.

## 2026-09-02 00:32 PDT — The compiler kept its context, but the master kept the wrong plan

Fresh Flights run `9e016566-8f4f-4c44-b07c-5ab5dafc573a` reused the accepted
operation boundaries and ran for about 22 minutes. Location lookup passed and
was published. Calendar, search, and the route resolver remained unfinished.
The terminal said `failed`, even though one usable MVP had already shipped.

Three independent reviews reached the same root cause. The compiler was not
forgetting its work: calendar repairs all used the same retained compiler
conversation. The problem was the plan it was required to follow. Calendar's
direct result request already contained the airport codes, but the plan also
forced two earlier location lookups without proving that their responses
supplied anything the result request consumed. Separately, the resolver and
search planners found useful fresh-page bootstrap requests, but the calendar
planner could not see those discoveries because the first focused planning
passes ran at the same time. The master saw all proposals afterward but was not
told to reconcile them. It therefore sent the unchanged three-request plan
back to the compiler several times.

Search had the same class of problem: the accepted plan combined fresh session
values from one request with a changing recorded value from a different
invocation. The compiler could inspect the recording, but the accepted plan was
host-bound, and its `give_up` instructions did not clearly allow it to report a
wrong request graph or missing transport-value source to the master.

The correction is site-neutral and stays in agent judgment. Candidate
selection, focused planning, master review, and compilation now all start from
the smallest directly recorded result request. Every earlier dependency must
name the exact response value or state it produces and the exact later request
location that consumes it. Planners receive compact evidence already grounded
by sibling tools. Because initial planners run concurrently, the master is told
to carry a newly discovered sibling bootstrap into only the affected tool,
discard that stale implementation plan, and run one focused second planning
pass. Changing query, body, header, cookie, and captured-state values must each
have a named live source. A compiler can now use `give_up` to report that the
accepted request graph, dependency, bootstrap placement, or transport source is
wrong so the master can revise the plan instead of repeating artifact edits.

The terminal failure was a separate runtime bug. Global proof correctly knew
that three operations were unresolved, but per-tool filtering produced an empty
repair list. The controller still asked the master to repair that empty list,
received the same plan, and failed its recurrence check. A mixed result now
undergoes independent review and ends explicitly as `partial`: verified MVPs
remain promoted and unresolved discovered operations remain visible. It never
claims full completion.

Neutral end-to-end tests prove both important paths. One verified producer plus
one supported unresolved operation ends once as partial. In the second test, a
sibling planner discovers a bootstrap after the target's first pass; the master
adds that evidence, only the target replans, no stale compiler recall occurs,
and the compiler receives the revised bootstrap-plus-result request order once.
The focused suite passes 229 tests; type checking, lint, unused-code analysis,
and circular-dependency analysis pass. The first full run had one unrelated
macOS hostile-process cleanup timing failure; that exact stress test passed when
rerun immediately, and the complete project check then passed all 1,845 tests.

## 2026-09-02 01:22 PDT — Minimal requests worked; two controller loops wasted the result

Fresh Flights run `1faa59e0-6507-4865-8f77-457b58b1ed1c` started from the
previously accepted candidate boundaries, with fresh planning and compilation.
The corrected planning instructions materially improved the first plan.
Calendar used only its direct result request and explicitly rejected two
unproven location lookups. Search used one result request plus relevant
fresh-page bootstrap evidence. All four tools stayed on the API path; none
fell back to a playbook.

The compilers then exposed a real missing fact instead of blindly editing code:
a changing request header had no known live producer. The independent reviewer
correctly required the master to test whether the header was unnecessary before
calling the tools blocked. That omission test ran. Location resolution passed
and published. Calendar reached the server but returned no usable fare result.
Search reached the server through CDP but returned an unusable error-shaped
result. A warm CDP call took 337 ms, confirming that repeated setup was not the
bottleneck. One search compile still spent more than eight minutes learning to
parse a large framed response; that remains a speed problem in the evidence
given to the compiler, not a reason for a Google-specific runtime rule.

The run exposed two controller bugs. First, when the master restored unresolved
tools for another test, it also rewrote explanatory text on the already verified
location tool. That harmless prose changed the tool's plan identity and caused
the working tool to compile and verify again, twice. The master prompt now says
that a proven, untargeted tool must be copied byte-for-byte; review explanations
belong in the decision note, not inside the tool object.

Second, the completion reviewer was asked to judge whether unresolved tools had
been tried thoroughly, but it received only the original recording evidence.
It did not receive the later immutable check failures, so it had to reject the
otherwise honest partial result. The controller now adds the latest factual
failure receipts to the review evidence for each unresolved public tool name.
This keeps the reviewer strict while giving it the facts needed to support a
blocker or request a real repair.

The diagnostic run was cancelled at about 42 minutes rather than allowing these
two loops to consume the 60-minute ceiling. It is not resumable validation.
Focused validation of the fixes passes type checking, lint, and 229 controller,
prompt, store, and CLI tests. A neutral end-to-end test now proves that an
unresolved consumer's actual failure is visible to the completion reviewer.

## 2026-09-02 01:58 PDT — Fresh Flights teach finished partial in ten and a half minutes

Fresh run `0528bc41-bee3-4723-b974-04876b90809e` reused only the four accepted
operation boundaries and did all planning and compilation again. It used the
latest combined recording, `combined-2026-08-30T02-48-09-040Z.json`; the hash
stored in the run exactly matches that file. Its source manifest contains seven
recordings. The combined file and the run copy both contain 1,240 requests, 321
events, and 31 narration entries.

The recording contains 68 flight-search requests, five booking requests, many
location requests, and only one calendar-fare request. Therefore the planner's
one-request search design was a deliberate minimal implementation chosen from
many examples, while the one calendar request is genuinely the only recorded
calendar example. No recording was skipped or replaced.

The new planning guidance worked. Calendar chose its direct result request and
explicitly rejected two location lookups because their responses supplied
nothing the fare request consumed. Search also chose one direct result request.
All four operations remained API designs. Location compiled, passed live CDP,
returned credible Boston location matches, and published.

Calendar tried two bounded constructions: current bootstrap values without the
unexplained changing header, then the closest recorded construction. Both
reached the server with HTTP 200 but returned the same 131-byte non-result, so
the parsed fare list was empty. Search stopped in 51 seconds after proving that
the bootstrap supplied two session values but not a changing request header.
Booking stayed unresolved because its search producer was unavailable.

The controller behaved correctly: the published location tool was not rebuilt,
the independent reviewer received the real failure facts, and the run ended
clearly as `partial` with one ready tool and three unresolved operations. The
run lasted about ten and a half minutes instead of looping toward the 60-minute
ceiling.

The run also exposed one remaining reasoning gap. Search treated “no live
producer for this recorded field” as “this field is required.” Those are
different claims. Site-neutral agent instructions now require planners, the
master, compiler, and completion reviewer to keep them separate. When necessity
is not proven, the master must authorize a bounded omission construction and,
when exact repeated-request evidence supports it, a generated-value construction
before accepting the blocker. The runtime still makes no semantic classification
and no Google-specific policy was added.

## 2026-09-02 02:37 PDT — Fresh generation tested the right question but missed the right combination

Fresh Flights run `8d431fc1-2480-4463-8fe7-ce6357f71c34` validated the new
reasoning instructions. Planning explicitly separated “no producer” from “field
is required.” Search compiled an API artifact that omitted the unexplained
changing fields instead of giving up. Calendar did the same. Location passed and
published. The search omission call reached Google through warm CDP in 362 ms,
but its 129-byte response contained no flights. Calendar and search then tried
fresh bootstrap state, coherent parameterized bodies and Referers, recorded
request ids, and finally recorded changing headers. Every construction returned
a tiny HTTP-success response with no semantic results. The run ended honestly
as partial after 29 minutes 43 seconds: one ready tool and three unresolved.
No playbook was used or proposed.

The user clarified that 30 minutes is an acceptable normal target for Google
Flights and Google Hotels. Simpler sites should still aim near 15 minutes. The
run-wide kill ceiling remains 60 minutes, and complex-site runs should still be
audited near 30 minutes for repeated work.

After-the-fact comparison with the checked-in Google Flights example explains
why the example is stronger. It was not the untouched output of one teach run.
The first generated snapshot landed on June 6, a live-search correction landed
on June 26, and a large audit-driven rewrite landed on June 30. That audit added
a shared transport helper, fresh request-id generation, stronger parsers and
token contracts, and re-probed the tools live. The saved backend receipts then
showed search and calendar passing CDP replay, including an 886 ms warm search
and a 550 ms calendar call.

The important construction difference is site-neutral. The shipped search tool
combines fresh page session values with a freshly generated request id and omits
the changing browser header. The new run tried omission without a fresh request
id, then moved toward recorded request ids and recorded headers. It never tried
the successful lifecycle combination. The shipped calendar similarly combines
fresh session values, a fresh request id, and the recorded header. The new run
treated generation as unsupported because the planning prompts mentioned
“supported generated values” without naming the mechanisms the artifact actually
provides.

The prompts now list the exact fresh-value primitives and explain that a request
transform may implement an evidence-supported time/random computation. They also
tell every reasoning role to test coherent constructions: fresh session state
plus fresh per-call values plus omission of unproven fields, with the closest
recorded request kept only as a diagnostic. This remains an agent decision based
on repeated-request evidence; no runtime field classifier or Google-specific
rule was introduced.

## 2026-09-02 02:45 PDT — Repair turns now use the run deadline, not an early prompt cap

There was no runtime counter that stopped a tool after exactly five repairs. The
earlier Flights run happened to reach five compiler repairs, and the master
prompt separately told the agent to try only two or three combinations and treat
a supported compiler `give_up` as the end of that MVP cycle. In practice, that
could stop useful reasoning well before the 60-minute run deadline.

That early-stop instruction has been removed. A compiler `give_up` is now a
factual handoff to the master. The master can keep using the same retained
conversation and try further distinct, evidence-backed constructions until the
tool verifies, the evidence truly rules out the remaining ideas, the user
cancels, or the shared 60-minute deadline expires. The existing repeated-state
guard still rejects an exact retry of the same plan, artifacts, checks, and
failure; it is not a numeric repair limit.

## 2026-09-02 03:22 PDT — Empty calendar output exposed a false semantic pass

Fresh Flights run `8ab4fdc7-39ee-4c5b-a641-6ef24af00919` ended partial after
about 35 minutes. It reported two ready tools, but only location lookup was
actually proven. Calendar returned HTTP success with a 130–131 byte protocol
response and zero fare rows. The planning agent had weakened its live
expectation to allow “a truthful empty result,” so both the one-tool semantic
reviewer and final reviewer accepted the empty result. Independent CDP calls for
three busy routes all returned the same tiny empty response. The recorded
response was 6,919 bytes and contained 38 fare rows. Calendar was therefore a
false-positive semantic pass, not a working MVP.

The compiler was not at fault. In one retained conversation it corrected two
artifact bugs, matched the recorded 446-byte request body, passed six offline
tests, and built a parser that extracts the 38 recorded rows. The unresolved
problem remained live transport. Search retained its compiler conversation
through six distinct repair cycles and every empty or protocol-error response
was correctly rejected. Booking remained unresolved because search never
produced usable selection state.

The semantic contract is now explicit and site-neutral. A verification case may
not weaken a retrieval tool's intended output by saying empty is acceptable.
The initial MVP must demonstrate at least one core record unless the operation's
purpose is itself to prove absence. Mechanical receipts and semantic evidence
now use an emitted object's explicit integer `count`, so `{entries: [], count:
0}` is reported as zero core results rather than one wrapper object.

## 2026-09-02 04:08 PDT — Restart proved the semantic fix and ended honestly

Fresh Flights run `624964ca-d96a-4206-b278-2ca4b461f2d2` reused only the
previously reviewed candidate boundaries and restarted planning, compilation,
and verification on the correct combined recording. It finished partial after
about 45 minutes with one ready tool and three explicitly unresolved tools.
Only `resolve_flight_location` was promoted.

The run repeatedly exercised the bug fixed above. Calendar reached Google via
CDP several times but returned zero fares, usually as a 130–132 byte protocol
error or diagnostic response. Search likewise returned zero flights or failed
to obtain required live page state. The checker rejected every empty result,
reported an explicit count of zero, and never promoted either tool merely
because the HTTP request completed. Booking stayed unresolved because Search
never produced the selection value it consumes. No playbook fallback was used.

The retained Calendar and Search compiler conversations were resumed for each
repair, so earlier reasoning was not discarded. The master stopped retrying
Calendar when it had exhausted its distinct evidence-backed constructions, then
gave Search one further construction before requesting independent completion
review. The terminal accurately reported `1 ready, 3 unresolved`.

For comparison, a clean run of shipped Imprint on the same recording took about
40 minutes and claimed three ready tools, but independent checks found only its
location tool genuinely returned data. Its Search and Booking tools returned
empty wrapper objects, and it missed Calendar entirely. The current flow is not
yet better at reconstructing the hard live requests, but it is now materially
more honest: it discovers all four operations and refuses to ship hollow API
results.

## 2026-09-02 05:05 PDT — The request-repair prompt forbade the missing combination

The retained Calendar and Search transcripts showed a clear reasoning mistake.
The prompt said each request hypothesis must be “coherent,” then warned against
combining fresh session values with a recorded opaque value. The master followed
that literally. It tried fresh session state with an omitted opaque header, and
it tried a fully recorded diagnostic, but it never tried fresh session state,
a fresh call identifier, and a potentially longer-lived recorded protocol
header together. Real requests often contain values with different lifetimes,
so the prompt had incorrectly ruled out a plausible construction.

The compilers also stayed inside the one representative request selected for
each candidate. Neither used the existing `search_requests` tool to examine the
many matching calls elsewhere in the combined recording. Search therefore
treated one five-digit call-identifier generator as if it exhausted all fresh
generator shapes. Calendar treated the absence of a known producer for its
opaque header as proof that the recorded value could not be used, without first
checking whether related calls showed it behaving like a longer-lived literal.

The correction is prompt-only and site-neutral. Candidate scope now limits the
operation being built, not the evidence the compiler may inspect. Compilers are
told to search the entire combined recording for matching calls across sessions,
and to inspect nearby calls in the same request family for one-off endpoints.
“Coherent” now explicitly allows a request to combine fresh session state, a
fresh per-call value, and a stable recorded protocol literal. One failed
generator shape no longer counts as exhausting every generated construction,
and the independent completion reviewer must reject blockers that skip this
evidence. The old numeric three-hypothesis prompt cap was also removed; useful
distinct hypotheses may continue until the shared run deadline.

A direct postmortem call of the checked-in Flights Search example was also run
with current future dates. It did not return flights today: CDP reached the
service but its parser found no recognizable itineraries, and the other backend
rungs failed. This means the example remains useful historical evidence about
request design, but it is not a currently working answer that the teach process
could simply rediscover. The fresh teach must still prove its own live result.

## 2026-09-02 14:12 PDT — Split API research from artifact compilation

The short-lived experiment that let the compiler call `probe_api` directly was
rolled back. Commit `e785eda` reverses only `d4d04b6` and its follow-up
`2bdf14d`; it does not roll the branch back to `main` or discard the earlier
master-teach work. The prior Flights run had already exited, so it was not
resumed after this prompt and code change.

The replacement gives each API tool two small, persistent conversations. An API
researcher receives the recording evidence and accepted plan, tests candidate
requests through Imprint's existing fetch/CDP ladder, reads the returned data,
and continues until one exact request returns the promised core records. It
cannot write a parser or choose a browser playbook. Once it proves a request,
the compiler receives those exact tested files and focuses on the parser,
offline tests, integration case, and normal Imprint packaging. The compiler is
told not to restart the request search or silently replace the proven request.

Both conversations keep their own history through the existing Codex SDK
session support; they are not recreated between repairs and Imprint does not
manually summarize them. The host only checks file shape, recording references,
and that the request handed to the compiler is byte-for-byte the request that
was actually tested. It does not add site rules or decide what changing values
mean. All 1,852 tests, type checking, and lint passed. A fresh teach run has
not yet started; it will be the next validation after this checkpoint is
committed.

## 2026-09-02 14:32 PDT — First split-agent run exposed one missing contract

Fresh Flights run `6dce0c87-81b0-4604-91e5-2e2c94eec400` reused only the four
reviewed candidate boundaries and started all later work fresh. The new split
worked for Location: its researcher rejected one malformed request, repaired it
in the same conversation, and proved a live autocomplete response containing
San Diego and airport records. Only then did the compiler start, and it
finished its parser and tests in about two minutes.

Calendar exposed a prompt defect. Its researcher needed a request transform,
but the new researcher prompt did not state the transform function's exact
name and arguments. It guessed `transformRequest(input)`, while Imprint loads
the named export `transform(method, url, responses, params)`. The host therefore
reported that the module was unavailable. The researcher later exhausted
several static request variants and correctly refused to call the protocol
error response a success, but its conclusion was contaminated by our missing
contract.

The run was stopped rather than resumed. The researcher prompt now includes
the exact TypeScript signature and explains that earlier workflow responses and
public parameters are its only dynamic inputs. It also says to ask the master
for a producer request when the accepted plan lacks one, instead of inventing a
wrapper object with hidden bootstrap or state fields. This is a site-neutral
prompt correction; runtime strategy rules were not added.

## 2026-09-02 14:46 PDT — Calendar was close in diagnosis, not construction

Fresh Flights run `269b06b3-2863-44df-ac2e-12c64177eceb` confirmed that the
transform-contract fix worked. Calendar produced a loadable named `transform`,
rebuilt the route/date body and matching `tfs` Referer, tested both a simplified
request and a closest-recorded request, and rejected both 130-byte protocol
error `[13]` responses. It then correctly concluded that fresh page-produced
session values were missing. Location again proved real results and entered
compilation.

Comparison with the checked-in Calendar example showed that the researcher was
only partly converging. The checked-in tool loads the Flights page as a
top-level bootstrap, extracts fresh `f.sid` and `bl` from the returned HTML,
substitutes them through `${state...}`, generates a fresh `_reqid`, and uses
CDP replay. Its saved backend evidence says fetch lacked state,
fetch-bootstrap was rejected, and warm CDP replay succeeded in 550 ms. The
researcher reached the same need for fresh state, but asked the master to add
the page navigation as an ordinary operation request because its prompt did not
show the workflow bootstrap schema.

The run was stopped rather than resumed. The researcher now receives the exact
parser-free workflow surface for bootstrap captures, state/response/generated
placeholders, and request captures. It is explicitly told that top-level
bootstrap is preparation and does not change the accepted operation-request
count. The researcher may also select one existing API rung for a test. This is
needed when fetch returns HTTP 200 with a semantic protocol error: automatic
transport stops at that HTTP success, but the agent can now test the same
request through CDP without changing the artifact or adding a semantic runtime
classifier. Focused end-to-end tests, type checking, and lint passed.

## 2026-09-02 15:01 PDT — Fresh Calendar research narrowed the problem, then stopped one step early

Fresh Flights run `8e0a3042-d3fd-42e6-8aca-60d705e8699f` reused only the
previously accepted candidate boundaries and started all research and
compilation work fresh. The Calendar researcher now used the intended
top-level bootstrap and tested through CDP. It correctly rejected three HTTP
200 responses because each contained only the same 130-byte Google protocol
error instead of fares. It also corrected an extra nesting level in its first
generated request body and then tested the closest fully recorded request as a
coherent baseline.

The researcher did not reach a proven Calendar request. It concluded that a
fresh `x-goog-batchexecute-bgr` value required a new producer step, but the
checked-in working example does not prove that conclusion. The example instead
combines a route-specific `tfs` bootstrap and Referer, freshly captured
`f.sid`/`bl`, a fresh `_reqid`, the recorded `bgr` header, and the recorded
request shape. The researcher never tested that exact combination: its fresh
state tests used the generic Flights bootstrap and a recorded `_reqid`, while
its closest-recorded test had no fresh state. The research process therefore
converged on the correct session-coherence problem but declared the wrong
missing dependency before exhausting the strongest evidence-backed hybrid.

## 2026-09-02 15:33 PDT — Search repeated the same unsupported blocker

The Search researcher made two genuine attempts. First it tried a small
round-trip `GetShoppingResults` request with fresh `f.sid`/`bl`. Then it restored
the recorded `_reqid`, route Referer, browser headers, and recorded `bgr` value.
It correctly rejected the returned 138- and 140-byte framed protocol errors as
non-results.

It then claimed that a fresh `x-goog-batchexecute-bgr` producer was required and
blocked. The master revised the plan without supplying such a producer, so the
same retained researcher immediately blocked again without another live test.
That conclusion conflicts with the checked-in Search example: the example does
not send a `bgr` header. It uses a route-specific search bootstrap and matching
Referer, fresh `f.sid`/`bl`, a generated request ID, the recorded request shape,
and CDP replay. The researcher never tested that exact combination; its fresh
state tests kept the generic Flights bootstrap and its closest-recorded test
kept a recorded request ID.

The fresh teach ended partial with one ready tool and three explicitly
unresolved operations. It did not reach the 60-minute deadline. Calendar and
Search stopped because their researchers chose `blocked`, not because the host
limited their number of attempts.

## 2026-09-02 15:38 PDT — Fixed premature API-research blockers in the prompt

Calendar and Search exposed the same general reasoning failure. Each retained
researcher remembered its own candidates and results, but treated an opaque
value it could not freshly produce as if the failed requests had proven that
value necessary. The prompt offered `blocked` too readily and did not require
the researcher to compare every changed part of its prior candidates before
making that claim.

The API-research prompt now makes `blocked` exceptional. A researcher must keep
testing while a coherent evidence-backed combination remains, must not infer
that one field caused a failure when several fields changed, and must explain
the factual comparison that isolated any allegedly required unavailable value.
It also tells the researcher to keep navigation and Referer context coherent
when the recording supports that, without naming or special-casing any site.

The prompt had also drifted from the real workflow capabilities: it documented
only the generated millisecond value. It now lists every supported generated
value, including the nonce used for changing request IDs. No runtime rule,
master-side candidate plumbing, transport classifier, or site-specific policy
was added. Prompt schema tests, type checking, and lint all pass.

A fresh Flights teach, `ed84534a-1ade-48aa-95e9-8b807800209d`, was then
started from the previously accepted four candidate boundaries. Planning and
all later work are fresh; no failed research or compilation run was resumed.
Its first validation target is whether the retained Calendar and Search
researchers continue through the strongest untried constructions instead of
repeating the unsupported opaque-header blocker.

At 15:41 PDT the user requested a restart. Run
`ed84534a-1ade-48aa-95e9-8b807800209d` was cancelled during fresh planning with
no ready or unfinished tools. A new fresh run,
`ae5108bd-968b-4caf-8409-d9c601a2d16f`, started from the same accepted candidate
boundaries. It does not reuse the cancelled run's planning, research, or build
state.

## 2026-09-02 16:02 PDT — First prompt fix helped, but Calendar still missed one combination

Fresh run `ae5108bd-968b-4caf-8409-d9c601a2d16f` showed that the stronger
research prompt materially improved persistence. Calendar continued through
roughly eight distinct live tests instead of stopping after three. It found
the route-specific bootstrap, corrected request-body reasoning, tried current
session values, omitted and recorded opaque fields, and finally tried a
generated request ID. Search also continued, found an extra airport-array
wrapper in its own request transform, and tested a corrected body.

Calendar nevertheless proposed `blocked` while one clear combination from its
own history remained untested: current session values plus a generated request
ID plus the recorded opaque header. Its blocker claimed every meaningful
construction had been tried, but its own list showed generated request IDs only
with that header omitted. The run was stopped before accepting this result.

The generic correction remains agent-driven. A researcher's first `blocked`
answer is now returned once to that same retained conversation as a proposed
blocker. The researcher is asked to compare its own candidate history as a
small matrix and look for overlooked coherent combinations. It may continue
with another test or repeat the blocker after its own review. The runtime does
not choose a hypothesis, classify a field, or inspect site semantics. Focused
tests prove that a researcher can recover from its proposed blocker and hand a
subsequent proven candidate to compilation. Prompt tests, type checking, and
lint pass.

Fresh validation run `ea08b54b-992c-4c4c-8517-fd87b2cd042e` then started from
the same accepted candidate boundaries. Planning, research, and compilation
are fresh; the stopped run is diagnostic evidence only.
