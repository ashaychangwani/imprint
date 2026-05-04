# Changelog

All notable changes to Imprint. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (Added / Changed / Deprecated / Removed / Fixed / Security).

## [Unreleased] — refactor/de-slop branch

A de-slop pass on the v0.1 codebase: deep audit + rearchitect to make the implementation sleek and the docs adoption-friendly. **No behavioral changes** — every demo still works (live-verified end-to-end against Southwest via stealth-fetch).

### Added
- `docs/architecture.md` — data flow diagram, module map, backend ladder cost table, per-example file taxonomy.
- `docs/glossary.md` — Session, Workflow, Playbook, Backend, Stealth-fetch, Sensor headers, Token TTL refresh, Sentinel, CDP, Credential store, NotifyWhen.
- `docs/decisions.md` — 12 ADR-style entries (D1-D12) covering the load-bearing calls.
- `docs/getting-started.md` — 5-minute walkthrough from clone to MCP tool in Claude Desktop.
- `docs/troubleshooting.md` — predictable failure modes with the same `→ next step:` format the in-code error messages use.
- `docs/notifications.md` — Pushover + ntfy setup, predicate language for `notifyWhen`.
- `examples/discoverandgo/README.md` and `examples/echo/README.md` — tutorial-style READMEs.
- `CHANGELOG.md` — this file.
- Per-verb help: `imprint <verb> --help` shows summary + usage + flags + a concrete example. The verb registry is single-source.
- Actionable `→ next step:` hints in every user-reachable error message (Pushover/ntfy not set, missing playbook, missing param, no requests in workflow, etc.).
- `resolveLadder` helper in `backend-ladder.ts` so cron + mcp-server share the auto-ladder expansion logic.

### Changed
- **Module reshape**: clearer file boundaries.
  - `replay-backend.ts` → `backend-ladder.ts` (clearer name; "replay" was jargon)
  - `workflow-runtime.ts` → `runtime.ts` (the prefix was redundant inside `imprint/`)
  - `discover-tools.ts` → `tool-loader.ts`
  - `playbook-types.ts` → folded into `types.ts`
- **Compiler unification**: `generate.ts` (208 LOC) + `playbook-compiler.ts` (130 LOC) collapsed into `compile.ts` (320 LOC). Skeleton (read session → redact → slim → call LLM → parse → validate → write) shared; per-task differences (slim/prompt/parser/schema) parameterized via a `CompileTask<T>` config.
- **README**: rewritten for adoption — leads with value prop + 60-second quickstart + demo table. Verb table replaced with pointer to `imprint --help`. ~285 → ~109 lines.
- **CLI HELP**: top-level reorganized into CAPTURE / COMPILE / RUN groups with one-liner per verb; pointer to per-verb help.
- **CLAUDE.md**: trimmed from 60 lines of pre-sprint design doc to a slim ~30-line agent-context file. All load-bearing content relocated to `docs/` (per the "don't drop documentation, move it" rule).
- **Comment hygiene**: stripped design-doc preambles, defensive validation for impossible scenarios, `log("starting…")`/`log("done in Yms")` pairs, and over-documented helpers whose docstring just restated the signature. Net `-691` LOC across `src/imprint/` + `src/cli.ts`.
- **Test pruning**: consolidated redundant schema tests, parametrized micro-variations, dropped low-signal tests.

### Removed
- `src/imprint/replay-backend.ts`, `src/imprint/workflow-runtime.ts`, `src/imprint/discover-tools.ts`, `src/imprint/playbook-types.ts` (renamed/folded; see Changed).
- `src/imprint/generate.ts`, `src/imprint/playbook-compiler.ts` (merged into `compile.ts`).
- `test/sanity.test.ts` — its 3 cases tested Zod's `safeParse` on inline schemas, not Imprint logic.
- `scripts/minimal-mcp.ts`, `scripts/minimal-mcp-with-import.ts`, `scripts/min-node-mcp.ts` — superseded MCP scratchpads from v0.1 bring-up.

### Metrics

| | Before | After |
|---|---|---|
| `src/imprint/` + `src/cli.ts` LOC | 5,828 | ~4,800 (-18%) |
| Source files | 26 | 22 |
| Tests | 137 / 13 files | 132 / 12 files |
| README | sprint-changelog flavor (285 lines) | adoption-friendly (109 lines) |
| Docs files | 3 | 9 (+ CHANGELOG.md) |

---

## [0.1.0] — 2026-04 / 2026-05 (sprint)

Initial public release. Two-week sprint to ship the full pipeline + two working demos.

### Added
- `imprint record` — CDP-based browser session capture with stdin narration loop, JSONL streaming, sidecar Session JSON on close.
- `imprint redact` — credential / PII scrub with `[REDACTED:N]` markers preserving shape for the LLM.
- `imprint generate` — Vertex Anthropic compilation of session → `workflow.json`.
- `imprint compile-playbook` — Vertex Anthropic compilation of session → `playbook.yaml` (DOM replay artifact, switched from markdown to YAML mid-sprint).
- `imprint emit` — code generation of `examples/<site>/index.ts` from `workflow.json`.
- `imprint cron` — polling daemon with multi-provider notifications (Pushover + ntfy) and `notifyWhen: price_below` predicate.
- `imprint mcp-server` — MCP server (stdio + Streamable HTTP) on the official `@modelcontextprotocol/sdk`.
- `imprint playbook` — direct Playwright execution of a YAML playbook.
- `imprint probe-backends` — per-site backend probing with cached `backends.json`.
- `imprint login` — credential extraction from a recorded session into a per-site credential store.
- **Backend ladder** — `fetch → stealth-fetch → playbook` with `auto` mode that escalates only on FORBIDDEN.
- **stealth-fetch** — Playwright-bootstrapped sensor token mint + native fetch augmented with those tokens. Defeats Akamai (verified vs. Southwest: 403 → 200 with real flight data).
- Working demo: `examples/southwest` (live fare watcher).
- Working demo: `examples/discoverandgo` (authed museum-pass booking).

### Decisions made
- Approach: Teach + Replay (not Teach + Expand).
- Network-level capture (CDP) over vision-based.
- Two artifacts per recording (workflow.json + playbook.yaml) so the ladder always has a fallback.
- YAML for the playbook format (replaced 425 LOC of hand-rolled markdown parsing with `YAML.parse` + Zod).
- Probe-at-record-time + cached `backends.json` to skip futile rungs.
- MCP stdio default; HTTP opt-in.

See [docs/decisions.md](docs/decisions.md) for the full list with rationale.
