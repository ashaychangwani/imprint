---
name: pr
version: 1.0.0
description: Open a pull request with conventional title, structured description, and pre-flight checks.
triggers:
  - pr
  - pull request
  - open pr
allowed-tools:
  - Bash
  - Read
---

# PR Skill

Open a pull request for the current branch with proper conventions.

## Step 1 — Pre-flight checks

Run these in parallel and report results:
```
bun run lint
bun run typecheck
bun test
```

If any fail, show the errors and ask the user whether to proceed or fix first.

## Step 2 — Gather context

Run these to understand the branch:
- `git branch --show-current` — current branch name
- `git log main..HEAD --oneline` — commits on this branch
- `git diff main..HEAD --stat` — files changed

## Step 3 — Determine PR title

The PR title must be a conventional commit format: `<type>(<scope>): <description>`

Pick type and scope the same way as the `/commit` skill, but based on the overall branch intent (not individual commits).

## Step 4 — Write PR description

Use this structure:
```markdown
## Summary
- Bullet 1: what changed and why
- Bullet 2: key design decisions
- Bullet 3: anything reviewers should pay attention to

## Test plan
- [ ] Tests pass locally
- [ ] Specific scenario tested
```

## Step 5 — Check remote

Run `git remote -v` and `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null` to check if the branch is pushed.

If not pushed, run `git push -u origin <branch>`.

## Step 6 — Create PR

```
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

Show the PR URL to the user when done.
