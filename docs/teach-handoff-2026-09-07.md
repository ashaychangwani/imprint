# Teach rebuild handoff — September 7, 2026

## Current continuation — 12:55 PDT

Worktree `/Users/ashaychangwani/.codex/worktrees/imprint-master-v066-validation`,
branch `codex/imprint-master-v066-validation`, based only on remote
`origin/codex/imprint-master-v066` at `34a6235`. Latest tested runtime is
**`9d50dc4`**, fixing repeated module imports through directory symlinks.
A prompt-only correction now documents the already-supported navigation
transform overrides that the researcher signature omitted. Its 205 focused
tests, lint, website build, and desktop/mobile checks pass. Full runtime suite
last passed 1,930 tests. Commit the prompt correction, then start fresh Flights.
No MR or push has been made.

Flights attempt **9** failed at its 90-minute deadline with two ready/two not
ready. Location and grid are published; search paired flight details with the
wrong continuation values, and its repair was interrupted. The master removed
booking because the full context source remained unproven. Its successful
page-owned option test used a fixed selector; the researcher was not told its
transform could compute that selector. The runtime already supports this.
No malformed handoff exercised the original recovery catch. The symlink module
failure did not recur.

Independent **audit 9** failed **12/13** units (seven correct calls, one failed
call, five working parameters), only two published tools. A SEA–LAX grid probe
returned no payload and its identical paced retry passed; count both. Its
underlying intermittent cause remains unresolved. The audit took 4.883 minutes.
Teach PID 13489 and audit PID 49798 have exited. Evidence remains in
`/tmp/imprint-fresh-inputs-VYbJm1/home-9`, with flights-teach-9/flights-audit-9
logs and manifests. Nothing is currently teaching or auditing.

Earlier Flights **8** passed all four tools and audit **24/24** on `1677b16`,
but Hotels **3** was cancelled after 8.8645 minutes when its guest-count tests
hit the reproduced symlink loader defect. No occupancy support was proven.
These different revisions and failures do not establish repeatability.

Collector PID **54899** writes `spans-validation.jsonl` on port **6438**.
Disk is about 27 GiB free. Update the heartbeat when fresh Flights 10 starts
in new home-10 with the exact recording/four-operation guidance below. Target
30 minutes, assess 60, hard limit 90. Never resume failed runs or feed old
artifacts, examples, or diagnostics to teachers. Keep two-worker concurrency.

Accounting through audit 9: twelve teaches and six audits, including failures;
base API estimate **$157.70**, with cache and interrupted-usage caveats in
`docs/teach-validation-accounting-2026-09-07.md`. No data was deleted.
Next: fresh Flights, independent full-scope audit, then Hotels on unchanged
code and its audit; fresh repeated successes for both remain due. Measure warm
calls separately and check advertised identifier breadth. No MR until requested.

## Previous continuation — 05:53 PDT

Work in `~/.codex/worktrees/imprint-master-v066-validation`, branch
`codex/imprint-master-v066-validation`. Implementation is now **`cdf57eb`**,
which integrates the isolated mechanics fix `fc4ed1a`. Its 1,927 tests, lint,
type checking, website build, and desktop/mobile visual checks passed.
The detached correction checkout remains intact for evidence.

Flights attempt 5 **failed at the 90-minute deadline: zero ready, four not
ready**. Its normal blocked handoff reached the master for retained follow-up,
but the malformed-output error path was not exercised. No published output
exists to audit. Fresh booking-token use was verified; booking offers were not.
Historical accounting now includes this failure.

Fresh attempt 6 started at **12:51:42 UTC**, launch PID **171**, in
`/tmp/imprint-fresh-inputs-VYbJm1/home-6`. Verify process identity from
`flights-teach-6-manifest.json` before acting on the PID. Its log is
`flights-teach-6.log`; it uses the exact combined Flights recording and original
four-operation scope, with no reused candidates, artifacts, or conversations.
Target check: 13:21 UTC; progress assessment: 13:51 UTC; hard deadline: about
14:21 UTC. Trace collector PID 54899 still writes `spans-validation.jsonl` on
port 6438. The existing heartbeat was updated to follow attempt 6.

Next: monitor fresh producer-to-booking execution and actual researcher/master
recovery, then independently audit published tools. Check date-grid widths
against the actual advertised contract; the previous candidate only encoded
range midpoints. Once Flights passes, repeat Hotels on unchanged code and
audit it. Keep all failures and interrupted usage in the accounting.
Disk was about 28 GiB free at launch. No MR has been opened or requested.

The continuation notes below are historical snapshots, superseded by this
current section and later timeline entries.

## Previous continuation — 04:39 PDT

The current validation worktree is
`~/.codex/worktrees/imprint-master-v066-validation`, on
`codex/imprint-master-v066-validation`, created from a fresh fetch of
`origin/codex/imprint-master-v066` at `34a6235`. Implementation is still
`60392ef`; subsequent continuation commits are documentation only. The original
handoff below remains historical evidence, not current process state.

- Fresh Flights attempt 5 is running, started **11:19:07 UTC**. PID 54983; run
  `745495f5-6efa-42e4-be6c-3125cbc88f40`; home `home-5`, log
  `flights-teach-5.log`, launch record `flights-teach-5-manifest.json`, all in
  `/tmp/imprint-fresh-inputs-VYbJm1`. Do not launch a duplicate or resume an old run.
- Same exact recording and four-operation guidance; two workers; 90-minute
  deadline. Target check at 11:49 UTC, progress decision at 12:19 UTC, hard
  deadline approximately 12:49 UTC.
- Location research is proven via fetch (433 ms); search research is proven
  via CDP API (first call including setup: 45.4 s). Search first repaired
  missing-state failures, then escalated after a fetch response. Date-grid
  research is inspecting evidence. Booking has not yet demonstrated fresh
  producer-consumer execution. No independent audit or repeatability claim yet.
- Trace collector PID 54899 deliberately uses port 6438 and writes
  `spans-validation.jsonl`; its script/log/PID files use `collector-validation`
  or `collect-validation` names. Old `spans.jsonl` is intact.
- New task heartbeat `imprint-fresh-validation` monitors every five minutes.
  Keep it active while this work continues, and stop it at actual handoff or
  cancellation. Do not restart the original deleted monitor.
- Disk recovered from 339 MiB to roughly 30 GiB without deletion by this task.
  Both exact recordings and prior evidence paths were verified.
- Latest full baseline: **1,917 tests passed, zero failed**, 6,064 assertions
  across 96 files; lint and type checking also passed. Test log:
  `validation-full-tests.log` in the experiment directory.
- Historical timing/token accounting is in
  [teach-validation-accounting-2026-09-07.md](teach-validation-accounting-2026-09-07.md).
  Include new traces and audits as they complete; retain the cost caveats.

A separate synthetic reproduction confirmed that MCP idle and timeout cleanup
look up CDP sessions by site, although the ladder stores them by site, tool,
and bootstrap URL. Successful pooled calls arm no idle timer, and timeout
cleanup closes no browser; shutdown does close it. Reproduction source is
`/tmp/imprint-fresh-inputs-VYbJm1/reproduce-mcp-pool-cleanup.ts`, run with Bun
and the new worktree path as its argument. It executes the actual extracted
`buildServer` body with synthetic dependencies and no live network. Runtime
code has not been changed midway through the controlled teach. Follow up
with a small general correction and regression coverage after completing the
unchanged-code validation, then validate any implementation change freshly.

## Prepared correction checkpoint — 05:44 PDT

`fc4ed1a` is committed in the separate detached checkout
`~/.codex/worktrees/imprint-v066-mechanics-fixes`. It is **not yet integrated**
into the validation branch, so Flights attempt 5 still runs implementation
`60392ef` unchanged. Preserve this commit and checkout.

The correction honors an explicit bootstrap URL before resolving later
state-dependent request URLs; the live booking researcher hit this host
limitation in both fetch-bootstrap and CDP replay. It also fixes MCP idle and
timeout cleanup to use tool/context pool keys, and propagates cancellation
without starting another API rung or evicting a replacement CDP session.
The general fixes have 1,927 passing tests, 110 focused checks, clean lint and
type checking, a successful website build, and inspected desktop/mobile views.
The synthetic reproductions now succeed. Private validation logs and screenshots
use `mechanics-*` in the experiment directory; the preview was stopped.

At about 84 minutes, booking has returned a **normal** blocked handoff, and
the master requested retained follow-up research. This does not exercise the
malformed-output catch in `60392ef`. No independent audit has run yet.
Keep the existing hard deadline at about 12:49 UTC. After this attempt ends,
record its exact result and usage. Audit any published output on unchanged
code. If Flights passes, repeat Hotels on unchanged code as requested.
When ready to validate the corrections, cherry-pick `fc4ed1a` into the validation
branch, preserving any intervening timeline entries, and start a **fresh**
Flights teach in a new isolated home. Do not resume attempt 5 after applying it.

## Start here

Continue on `codex/imprint-master-v066`. The implementation worktree on the
current machine is `~/.codex/worktrees/imprint-master-v066`, not the older
`dc45/imprint` task directory. Latest implementation checkpoint: `60392ef`.
Subsequent handoff commits are documentation only. This branch started from
shipped v0.6.6; do not merge the old vNext implementation into it.

The user ended the long conversation and requested that the next task pick up
this branch. The monitoring automation was deleted. Its trace collector and
website preview were stopped. No teach is running. No MR was created by this
handoff and no push was requested. Before any future push, follow the branch's
lint and source-branch rebase instructions.

## What is actually proven

| Validation | Result | Scope / limitation |
| --- | --- | --- |
| Flights attempt 3, `6b7d30c` | Teach: 4 ready; independent audit: 100%, 13 calls + 9 parameter checks | Location, search, date grid, booking; fresh search-to-booking selections worked. Narrow public parameters, not all flight modes. |
| Hotels attempt 1, `6b7d30c` | Teach: 1 ready; audit: 33.3%, 3 correct / 9 graded | Guest count was confused with stay duration. This is a real failed output, not a transport waiver. |
| Hotels attempt 2, `0f07a5d` | Teach: 1 ready; audit: 100%, 4 calls + 3 parameter checks | Destination/check-in/check-out; correct 1/2/3-night results. Guest-count support was removed by the master as unproven. CDP API, not playbook. |
| Flights attempt 4, `0f07a5d` | Failed: 0 published, 4 not ready | Booking research returned an invalid partial handoff after network timeouts; an uncaught typed output error ended pre-plan research. |
| Latest fix, `60392ef` | 186 focused tests, typecheck, lint pass | Fresh live teach has **not** validated this fix yet. |

Do not claim repeatability. Successful earlier runs and failed repeats are all
part of the result. Flights attempt 3 took about 70 minutes; Hotels attempt 2
finished within about 31 minutes. Exact times and full token/cost totals still
need extraction from the saved traces. Some timeline times are rounded check
times rather than exact process completion timestamps.

## Focused changes and why

- `2b93cc7`: researchers can call a working sibling API for fresh upstream
  values before the sibling's generated parser is published. Reviewers receive
  checked request/parser code and larger real-result previews. Browser-cache
  eligibility no longer depends on particular cookie names.
- `8a9603a`: removed a second cookie-marker gate that still refused to send the
  actual bootstrap request. Actual responses decide escalation; state remains
  isolated by tool and rung.
- `6b7d30c`: saved actual research inputs, results, and inspected excerpts and
  delivered bounded same-request comparisons to MVP review. Previously only a
  researcher's summary reached the reviewer, causing repeated missing-proof
  rejection despite earlier useful experiments.
- `0f07a5d`: generic instructions distinguish coincidentally equal numbers
  before assigning meanings. A carton-count/item-count example illustrates the
  problem without a Hotels rule. The next researcher noticed occupancy was
  unproven, and the master narrowed the MVP rather than shipping the false field.
- `60392ef`: catches only `SemanticAgentOutputError` from the researcher step,
  retaining observations in the existing blocked handoff for master review.
  Invalid proof is still rejected; unexpected errors, provider errors, and
  cancellation still propagate. Clarifies exact tested candidate reuse in the
  researcher prompt and reporting-error handling in the master prompt.

The latest change fixes the fatal handoff path, **not** the underlying booking
network timeouts. It does not prove the master will repair the handoff properly.

## Local evidence (not tracked)

Experiment directory: `/tmp/imprint-fresh-inputs-VYbJm1`. Keep it intact while
diagnosing. It contains private live data and must not be added to an MR.

- `home`, `home-2`: cancelled Flights attempts 1 and 2, retained as diagnostics.
- `home-3`: successful Flights run
  `9cfdf837-8178-4027-b953-f3175423d1a7`; `flights-teach-3.log`,
  `flights-audit-3.log`.
- `home-4`: failed Flights repeat
  `886fea4d-6dcd-4f64-a7bd-0cebfbcacdd6`; `flights-teach-4.log`.
- `hotels-home-1`: failed-audit Hotels run
  `187e68da-1cad-4683-8758-f253c389c655`; `hotels-audit-1.log`.
- `hotels-home-2`: successful narrow Hotels run
  `09dff4f3-0298-40b4-96d7-2a4fb8e1039f`; `hotels-teach-2.log`,
  `hotels-audit-2.log`.
- `spans.jsonl` and `collect.cjs`: local trace capture and collector source.
  Collector formerly listened on port 6438; it is now stopped.

Within each home, inspect `<site>/.audit-report.json` and `.audit-transcript.txt`.
Within `<site>/.teach-runs/<run-id>`, research lives under
`staging/api-research/<public-tool-name>/api-research.json`, compiled drafts
under `staging/research-drafts`, and MVP reviews under `mvp-reviews`.

Exact controlled recordings, relative to the user's home directory:

- `.imprint/google-flights/sessions/combined-2026-09-04T05-29-11-607Z.json`
- `.imprint/google-hotels/sessions/2026-06-04T21-20-20-173Z.json`

The Flights combined recording was explicitly chosen. Do not auto-combine or
silently substitute a different recording. Never feed shipped examples or
previous generated tools to teaching agents as a shortcut.

## Next work

1. Check free disk and the branch before launching anything. Last reading was
   about 414 MiB free; the planned fresh repeat was paused for storage. Nothing
   was deleted. Free space or use an approved volume; do not discard evidence.
2. Validate `60392ef` with a fresh Flights teach in a new isolated home. Resume
   neither failed attempt 4 nor its candidates. Use the same recording and
   four-operation scope for a fair comparison.
3. Watch whether booking uses fresh producer output, whether invalid handoffs
   reach the master, and whether the master repairs them without discarding
   other successful research. Investigate actual failures, not just status labels.
4. Independently audit the published output. If Flights passes, repeat Hotels
   on unchanged code and audit it. Do not keep rerolling to conceal failures.
5. Finish timing/token/cost accounting, including cache reads/writes and failed
   attempts. Update the timeline and prepare the MR only when requested.

Example next teach (verify paths and space first; Bun may require
`$HOME/.bun/bin` on PATH):

```sh
IMPRINT_HOME=/tmp/imprint-fresh-inputs-VYbJm1/home-5 \
bun run src/cli.ts teach google-flights --agent codex \
  --from-session "$HOME/.imprint/google-flights/sessions/combined-2026-09-04T05-29-11-607Z.json" \
  --guidance "Focus on location lookup, flight search, calendar date grid, and booking options. Drop unrelated operations." \
  --timeout 90m --no-interactive
```

Restart trace capture intentionally if desired; do not point tracing at a
stopped collector. The user permits 30 minutes for these teaches, with a
reasoned progress decision at 60 minutes and a hard 90-minute run limit.
Those are experiment settings, not universal runtime policy.

## Validation caveats and lessons

- The latest focused suite covers research, agents, and controller (186 tests).
  Full suite was last run at `6b7d30c`: 1914 passed, one external example.com
  recorder timeout; isolated retry passed. A full latest-HEAD run remains due.
- Prompt substring tests check instruction packaging, not model reasoning.
  Only fresh behavioral runs establish whether the guidance helps.
- An agent's summary miscounted the Flights audit as 14 calls/23 units; actual
  arrays and deterministic totals were 13/22. Report the latter.
- The generated parser, research claim, and reviewer can repeat the same wrong
  assumption. Reading real data and using a distinguishing contrast matters.
- Narrowing an unproven feature is honest MVP shipping, not proof it was fixed.
- Fresh producer calls, cached CDP reuse, HTTP success, and final semantic
  correctness are different facts. Warm CDP timing must be measured separately
  from setup, and state must not be shared across tools or rungs.
