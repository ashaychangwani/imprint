---
name: pr-review-convergence
description: Prepare a code branch and pull/merge request for human review through safe rebasing, repository-specific validation, multiple independent subagent review rounds, evidence-based fixes, conventional commits, pushing, PR creation, and CI babysitting. Use when asked to prepare, polish, or finalize a PR/MR; obtain several reviews; iterate until clean; or make a branch ready for human review.
---

# PR Review Convergence

Drive the branch to a genuinely reviewable state. Treat “open the PR” as an
intermediate step; completion requires green checks and no unresolved
actionable review findings.

## 1. Establish scope and guardrails

1. Read repository instructions such as `AGENTS.md`, `CLAUDE.md`, contributing
   guidance, and relevant local skills completely.
2. Inspect `git status`, the current branch, remotes, upstream, source branch,
   complete diff, and recent history. Preserve unrelated user changes.
3. Never use destructive resets or force-push without explicit authorization.
   Never bypass hooks. Stop if the diff contains credentials, recordings,
   personal data, or another public-repository violation.
4. Match mutations to the user's authority. A review-only request permits
   inspection and local validation, not commits, pushes, or PR creation. Only
   proceed through remote steps when the user explicitly asked to prepare,
   create, push, or update the PR/MR; otherwise stop after the review handoff.
5. Create a short plan covering rebase, validation, review rounds, commit,
   push, PR creation, and check monitoring.

## 2. Rebase safely before review

Skip this section for review-only requests: inspect the branch against its
declared source without stashing, rebasing, committing, or otherwise mutating
the user's worktree.

Fetch the source branch, normally `origin/main`. If the worktree is dirty,
stash tracked and untracked changes under a descriptive name, rebase, restore
the stash, and verify every change returned. Resolve straightforward conflicts
without discarding either side; ask only when resolution changes product
intent.

Record the rebased commit so later source-branch movement can be detected.

## 3. Validate the implementation

Run repository-prescribed checks before asking reviewers to inspect avoidable
failures. At minimum for Imprint:

```text
bun run lint
bun run typecheck
bun test
git diff --check
```

Run focused tests for changed behavior. If the website changed, build it and
visually inspect desktop and mobile layouts. Exercise important behavior live
when safe and proportionate. Distinguish an unrelated flaky test from a real
failure by reproducing it in isolation, then rerun the full gate; do not simply
dismiss it.

## 4. Run independent review rounds

Use two or three read-only subagents in parallel with non-overlapping scopes.
Give them the raw diff, files, tests, or artifacts and the review objective;
do not seed them with expected findings.

Recommended first-round scopes:

- correctness, security, privacy, and failure behavior;
- concurrency, lifecycle, memory bounds, and test gaps;
- public API, documentation, benchmark methodology, and provenance.

Personally verify every finding against code or a reproduction. Fix all valid
issues in the main worktree, add regression tests, and rerun focused checks.
Explain rejected findings with concrete evidence.

After fixes, start a fresh convergence round. Ask reviewers to inspect the
current state rather than confirm a described fix. Iterate until every reviewer
reports clean or only explicitly documented, non-blocking residual risks
remain. Do not declare convergence while an actionable medium-or-higher issue
is open.

## 5. Review and commit the final diff

Re-read the full diff and status. Ensure intended new files are included and
temporary artifacts are absent. Stage only in-scope files, inspect both
`git diff --cached --stat` and `git diff --cached`, then create a conventional
commit whose message describes the branch’s primary user-facing outcome.

Before pushing, fetch the source branch again. If it moved, rebase the commit
and rerun the relevant checks. This second fetch closes the race between the
initial rebase and a long review cycle.

## 6. Push and open the PR/MR

Push the current branch with an upstream. Use a conventional PR title and a
description containing:

- a concise summary and rationale;
- key design and safety bounds;
- benchmark or live-validation evidence with an honest denominator;
- tests run and known residual limitations;
- reviewer attention areas.

Do not include sensitive local paths, recordings, trace payloads, credentials,
or private data in commits or the PR body.

## 7. Babysit checks to green

Monitor all PR checks to completion. Inspect logs for every failure, reproduce
it locally, fix it, rerun relevant checks, commit conventionally, rebase from
the latest source branch as required by repository policy, push, and continue
monitoring. Also inspect automated review comments and resolve valid findings.

Finish only when:

- the worktree and commit contain exactly the intended change;
- local required checks pass;
- independent reviews have converged;
- the PR exists with an accurate description;
- all required remote checks are green; and
- the final handoff states the PR URL, commit, checks, review outcome, and any
  residual risk a human reviewer should know.
