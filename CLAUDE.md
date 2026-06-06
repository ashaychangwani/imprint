# Imprint — agent context

Imprint is a CLI tool: record a real browser session once, get back two deterministic replay artifacts (an API workflow + a DOM playbook) plus a generated MCP tool an AI agent can call. "Postman for AI agents."

## Status

v0.1 shipped. Star demos: `examples/google-flights` (4 tools, audit 92.6%) and `examples/google-hotels` (4 tools, audit 91.7%) — each one-shot compiled from a single real browser-session recording via `imprint teach`, decoding Google's `batchexecute` nested-array wire format with producer→consumer token chaining (search → booking/reviews). Other working demos: `examples/southwest` (live, defeats Akamai via stealth-fetch) and `examples/discoverandgo` (authed museum-pass booking). `examples/echo` is the MCP smoke-test fixture. Deferred work lives in [TODOS.md](TODOS.md).

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
- **Website**: [web/](web/) — standalone Vite/React landing page deployed with Vercel using `web` as project root

## Project layout

```
src/
├── cli.ts                  # 19 verbs (run `imprint --help`)
├── imprint/                # core modules — see docs/architecture.md for the map
examples/
├── <site>/<toolName>/{workflow.json, playbook.yaml, index.ts, cron.json, backends.json}
prompts/
├── compile-agent.md        # generate (workflow.json/parser.ts) system prompt
├── request-triage.md       # compile-playbook request filtering prompt
├── playbook-compilation.md # compile-playbook (playbook.yaml) system prompt
docs/                       # human-facing documentation
web/                        # standalone Vite/React landing page; run web commands from web/
test/                       # bun test, ~977 tests across ~56 files
scripts/                    # smoke tests + one-off dev helpers
```

## User-facing change rule

Whenever you change user-facing implementation behavior, update every matching user-facing surface in the same branch:

- `README.md` for the top-level product promise and quickstart.
- Relevant files under `docs/` for architecture, setup, security, troubleshooting, examples, or operator guidance.
- `web/src/App.jsx` and, when visual system guidance changes, `web/DESIGN.md` for the landing page.
- Generated/help text or prompts when the behavior changes what users or compile agents see.

After website changes, run `bun install` only from `web/` if dependencies are missing, then run `bun run build` from `web/` and visually inspect the page at mobile and desktop widths. Keep root package installs separate from `web/`.

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
- `/debug-teach` — diagnose a stuck, failing, or broken teach run (env vars, log files, recipes)
- `/imprint-teach-deepdive` — analyze where a teach run spent its time (Phoenix traces + compile logs)
- `/imprint-reteach-audit` — re-teach from existing recordings and verify with audit

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and release process.

When a user says to create a PR, commit changes, or push a branch, you must babysit the resulting PR until it is fully green. Watch all relevant checks to completion; if any check fails, inspect the logs, fix the issue, push the update, and keep watching until CI is green.

When you change user-facing implementation behavior, update the user-facing collateral in the same change: `README.md`, relevant files under `docs/`, and the website under `web/`. If the behavior affects CLI output, workflow paths, setup commands, runtime behavior, tracing, or generated artifacts, treat it as user-facing.

## Test data hygiene

This is a **public** repo. Real credentials, session tokens, cookie values, personal data, and recordings that contain any of the above MUST NEVER be checked in — not in `examples/`, not in `test/`, not in fixture JSON, not in commit messages, not in screenshots.

- Test fixtures must be **constructed manually** with synthetic values (`fixture-user`, `fixture-pass-9472`, `bob@example.com`, `hunter2`, etc.). Do NOT copy a real recording's body and rename one field — adjacent fields (cookies, IP, geo, account IDs) leak too.
- Do NOT pin tests to absolute paths under any user's home directory (e.g., `/Users/<name>/...`). Tests must run on a clean clone.
- A real recording you collected for end-to-end verification stays on your laptop only. The contents of `~/.imprint/`, credential store files under `~/.config/imprint/`, the `imprint teach` output for any account you actually log into, and `*.imprintbundle` files are all sensitive — keep them out of the repo and out of PR comments.
- The pre-commit hook (`.githooks/pre-commit`) runs `gitleaks` and a tight regex pass. It is **fail-closed**: if gitleaks isn't installed it blocks the commit and tells you how to install it. Do not bypass with `--no-verify`. Install: `brew install gitleaks` (or see `https://github.com/gitleaks/gitleaks#installing`). Enable hooks once per clone: `git config core.hooksPath .githooks`.
- If you discover a leak that already shipped to a remote: stop, tell the user, and rotate the credential. Force-pushing a rewrite over remote history doesn't undo a public exposure.

## Debugging teach runs

Use `/debug-teach` for guided diagnosis. Quick reference below.

### Environment variables

| Variable | Effect |
|---|---|
| `IMPRINT_DEBUG=1` | Verbose stderr: HTTP requests, cookie snapshots, Chromium stderr, stack traces |
| `IMPRINT_REPLAY_DEBUG=1` | Write replay events to `/tmp/imprint-replay-debug-<ts>.log` |
| `IMPRINT_TRACE=1` | OpenTelemetry tracing to Phoenix (see [docs/tracing.md](docs/tracing.md)) |
| `IMPRINT_TRACE_LLM_IO=1` | Capture prompt/response text in trace spans |
| `IMPRINT_KEEP_TEST=1` | Retain generated `parser.test.ts` after compile |
| `IMPRINT_NO_BUILD_PLAN=1` | Skip shared-module planning |
| `IMPRINT_COMPILE_ACT_SPACING_MS=0` | Fast compile-time replay (default 25s) |

### Artifacts written during teach

| Path | Contents |
|---|---|
| `~/.imprint/<site>/<tool>/.compile-log.json` | Full compile-agent conversation |
| `~/.imprint/<site>/<tool>/.tool-plan.md` | LLM-generated tool implementation plan |
| `~/.imprint/<site>/.audit-report.json` | Audit results (after `imprint audit`) |
| `~/.imprint/<site>/.audit-transcript.txt` | Audit session transcript |
| `/tmp/imprint-replay-debug-<ts>.log` | Replay debug log (`IMPRINT_REPLAY_DEBUG=1`) |
| `/tmp/imprint-playbook-*-step*.png` | Per-step screenshots (`imprint playbook --trace`) |

### Diagnostic commands

```
imprint doctor                              # check environment
imprint check <session.json>                # validate a captured session
imprint playbook <site> --headed --trace    # interactive playbook test with screenshots
imprint audit <site> --json                 # score all tools
imprint mcp status                          # audit MCP registrations
```

## Key risks (still open)

1. **Platform risk**: Anthropic / OpenAI could ship native MCP learning as a first-class feature.
2. **Lesson rot**: automations break as websites change. Mitigation: ladder fallback (DOM playbook still works when API moves).
3. **Auth handling**: httpOnly cookies, token expiry, CSRF — still hard, but now handled through per-site credential storage, state-aware captures, `fetch-bootstrap`, and `imprint login` where possible.
4. **Distribution**: needs to be discoverable. v0.1 is CLI-first; future v0.2 may add a Chrome extension UX.
