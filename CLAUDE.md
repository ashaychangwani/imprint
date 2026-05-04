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

## Key risks (still open)

1. **Platform risk**: Anthropic / OpenAI could ship native MCP learning as a first-class feature.
2. **Lesson rot**: automations break as websites change. Mitigation: ladder fallback (DOM playbook still works when API moves).
3. **Auth handling**: httpOnly cookies, token expiry, CSRF — the hardest technical problem. Partially solved via per-site credential store + `imprint login`.
4. **Distribution**: needs to be discoverable. v0.1 is CLI-first; future v0.2 may add a Chrome extension UX.
