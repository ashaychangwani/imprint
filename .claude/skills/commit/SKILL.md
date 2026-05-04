---
name: commit
version: 1.0.0
description: Create a conventional commit from staged changes — picks type, scope, and writes the message.
triggers:
  - commit
  - conventional commit
allowed-tools:
  - Bash
  - Read
---

# Commit Skill

Create a well-formed conventional commit from the currently staged changes.

## Step 1 — Check staged changes

Run `git diff --cached --stat` to see what's staged. If nothing is staged, tell the user and stop.

Run `git diff --cached` to read the actual diff.

## Step 2 — Determine commit type

Pick the type based on the nature of the change:

| Type       | When to use                                    |
|------------|------------------------------------------------|
| `feat`     | New user-facing feature or capability          |
| `fix`      | Bug fix                                        |
| `refactor` | Code restructuring without behavior change     |
| `perf`     | Performance improvement                        |
| `test`     | Adding or updating tests                       |
| `docs`     | Documentation only                             |
| `ci`       | CI/CD configuration                            |
| `chore`    | Maintenance, dependencies, tooling             |
| `build`    | Build system or external dependency changes    |
| `style`    | Formatting, whitespace, linting (no logic)     |

## Step 3 — Determine scope

Pick a scope from the file paths changed. Established scopes in this repo:

`cli`, `probe`, `backend`, `playbook`, `stealth-fetch`, `cron`, `notify`, `utils`, `types`, `replay-backend`, `mcp`, `record`, `redact`, `session-writer`

If the change spans multiple areas, omit the scope. If it's a new area, derive the scope from the directory name.

## Step 4 — Write the commit message

Format: `<type>(<scope>): <subject>`

Rules:
- Subject line: imperative mood, lowercase, no period, under 72 chars
- Body (optional): explain WHY, not WHAT. Wrap at 100 chars.
- Footer (optional): `BREAKING CHANGE: <description>` if applicable

## Step 5 — Show and confirm

Show the proposed commit message to the user. Ask if they want to proceed, edit, or cancel.

## Step 6 — Execute

Run the commit using a heredoc:
```
git commit -m "$(cat <<'EOF'
<commit message here>
EOF
)"
```
