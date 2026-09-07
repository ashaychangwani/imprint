# Teach rebuild handoff — September 7, 2026

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
