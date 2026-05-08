# Imprint — agent context

Imprint is a CLI tool: record a real browser session once, get back two deterministic replay artifacts (an API workflow + a DOM playbook) plus a generated MCP tool an AI agent can call. "Postman for AI agents."

## Status

v0.1 shipped. Working demos: `examples/southwest` (live, defeats Akamai via stealth-fetch) and `examples/discoverandgo` (authed museum-pass booking). `examples/echo` is the MCP smoke-test fixture. Future demos (Luma SF event finder, internal canteen ordering) live in [TODOS.md](TODOS.md), not yet committed.

## Where to look

- **Architecture + module map**: [docs/architecture.md](docs/architecture.md)
- **Glossary** (Workflow, Playbook, Backend, Stealth-fetch, etc.): [docs/glossary.md](docs/glossary.md)
- **Decisions log** (why YAML, why ladder, why MCP-stdio default): [docs/decisions.md](docs/decisions.md)
- **Getting started** (60-second quickstart): [docs/getting-started.md](docs/getting-started.md)
- **Troubleshooting**: [docs/troubleshooting.md](docs/troubleshooting.md)
- **Original design doc** (April 2026 office-hours approval): [docs/design.md](docs/design.md)
- **Capture protocol** (CDP details): [docs/capture-protocol.md](docs/capture-protocol.md)
- **Playbook debugging**: [docs/playbook-debugging.md](docs/playbook-debugging.md)
- **Notification setup**: [docs/notifications.md](docs/notifications.md)
- **Security model + redaction guarantees**: [docs/security.md](docs/security.md)

## Project layout

```
src/
├── cli.ts                  # 13 verbs (run `imprint --help`)
├── imprint/                # core modules — see docs/architecture.md for the map
examples/
├── <site>/{sessions, workflow.json, playbook.yaml, index.ts, cron.json, backends.json}
prompts/
├── intent-detection.md     # generate (workflow.json) system prompt
├── playbook-compilation.md # compile-playbook (playbook.yaml) system prompt
docs/                       # human-facing documentation
test/                       # bun test, ~130 tests
scripts/                    # smoke tests + one-off dev helpers
```

## CI/CD & releases

Three GitHub Actions workflows:
- **test** (`test.yml`): lint + typecheck + test on push to `main` and all PRs
- **commitlint** (`commitlint.yml`): validates PR title + commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) on PRs
- **release** (`release.yml`): tag-triggered (`v*`) — generates changelog via git-cliff and creates a GitHub Release

Changelog config lives in `cliff.toml`. Preview unreleased changelog: `bun run changelog`.

### Claude skills

- `/release` — bump version, tag, push, trigger release workflow
- `/commit` — create a conventional commit from staged changes
- `/pr` — open a PR with conventional title and pre-flight checks

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and release process.

When a user asks you to create a PR, commit changes, or push a branch, you must babysit the resulting CI until all relevant checks are green. If any check fails, inspect the logs, fix the issue, push the update, and keep watching until CI is green.

## Test data hygiene

This is a **public** repo. Real credentials, session tokens, cookie values, personal data, and recordings that contain any of the above MUST NEVER be checked in — not in `examples/`, not in `test/`, not in fixture JSON, not in commit messages, not in screenshots.

- Test fixtures must be **constructed manually** with synthetic values (`fixture-user`, `fixture-pass-9472`, `bob@example.com`, `hunter2`, etc.). Do NOT copy a real recording's body and rename one field — adjacent fields (cookies, IP, geo, account IDs) leak too.
- Do NOT pin tests to absolute paths under any user's home directory (e.g., `/Users/<name>/...`). Tests must run on a clean clone.
- A real recording you collected for end-to-end verification stays on your laptop only. The contents of `~/.config/imprint/`, the `imprint teach` output for any account you actually log into, and `*.imprintbundle` files are all sensitive — keep them out of the repo and out of PR comments.
- The pre-commit hook (`.githooks/pre-commit`) runs `gitleaks` and a tight regex pass. It is **fail-closed**: if gitleaks isn't installed it blocks the commit and tells you how to install it. Do not bypass with `--no-verify`. Install: `brew install gitleaks` (or see `https://github.com/gitleaks/gitleaks#installing`). Enable hooks once per clone: `git config core.hooksPath .githooks`.
- If you discover a leak that already shipped to a remote: stop, tell the user, and rotate the credential. Force-pushing a rewrite over remote history doesn't undo a public exposure.

## Key risks (still open)

1. **Platform risk**: Anthropic / OpenAI could ship native MCP learning as a first-class feature.
2. **Lesson rot**: automations break as websites change. Mitigation: ladder fallback (DOM playbook still works when API moves).
3. **Auth handling**: httpOnly cookies, token expiry, CSRF — the hardest technical problem. Partially solved via per-site credential store + `imprint login`.
4. **Distribution**: needs to be discoverable. v0.1 is CLI-first; future v0.2 may add a Chrome extension UX.
