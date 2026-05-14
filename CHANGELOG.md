# Changelog

All notable changes to Imprint. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (Added / Changed / Deprecated / Removed / Fixed / Security).

## [0.2.0] — 2026-05-14

v0.2 overhauls the teach-to-tool pipeline, adds full observability tracing, and introduces state-aware API replay. 12 new features, 7 bug fixes across 24 commits.

### Added
- **Multi-tool teach** — `imprint teach` captures multiple tools in a single session with shared request triage across tools for optimized token usage (#23, #29).
- **Deterministic MCP tools** — teach produces functional, deterministic tool definitions that agents can call reliably (#28).
- **Full-depth tracing** — LLM calls and agent loop iterations are traced end-to-end for debugging and observability (#31).
- **Dotenv support** — `.env` file with tracing defaults, auto-loaded by the CLI via dotenv (#32).
- **State-aware API replay** — replay engine tracks API state across requests for more reliable automation (#24).
- **Credential manager** — catch login secrets during teach, store in OS keychain, replay via `${credential.X}` placeholders (#14).
- **Interactive compile provider picker** — choose your LLM provider interactively when compiling (#17).
- **Claude CLI + MCP compilation** — drive compile-agent via claude-cli and stdio MCP server (#11).
- **Landing page** — Imprint website at `web/` (#22).
- **Improved session redaction** — broader PII and credential coverage across content types (#20).
- **Gitleaks pre-commit hook** — automated secret scanning before commits; fail-closed when gitleaks is not installed.
- **Teach UX improvements** — keybinding hints in multi-tool select prompt (#26), auto-prompt for missing site and starting URL (#10).

### Changed
- **Examples layout** — tools now require nested directory structure per tool (#16).
- **README** — added google-flights and google-hotels examples, removed southwest-seats.
- **README** — polished for GitHub discoverability and conversion.

### Fixed
- Wire parserModule and preserve query params in compile-agent (#27).
- Dispatch tool_use blocks in max_tokens responses (#30).
- Fix credential/PII leaks in sessions with non-JSON content-types (#13).
- Use correct field name `stopCount` in parser test (#18).
- Store recordings outside examples directory (#19).
- Replace hardcoded API key with env var.

### Documentation
- State-aware replay guide (#25).
- CI test count badge.

---

## [0.1.0] — 2026-05-05 (post-sprint polish)

A de-slop pass on the v0.1 codebase: deep audit + rearchitect to make the implementation sleek and the docs adoption-friendly. **No behavioral changes to existing verbs** — every demo still works (live-verified end-to-end against Southwest via stealth-fetch). One new verb (`imprint doctor`) added.

### Added
- **`imprint doctor` verb** — one-shot environment health check (Bun, Chromium binary, Playwright Chromium, Vertex env vars, push providers). Exits 0 on all-pass / 1 on any required failure (CI-friendly). Each failure includes a `→ next step:` hint. Surfaced in README quickstart + docs/troubleshooting.md as the first thing to try.
- `docs/architecture.md` — data flow diagram, module map, backend ladder cost table, per-example file taxonomy.
- `docs/glossary.md` — Session, Workflow, Playbook, Backend, Stealth-fetch, Sensor headers, Token TTL refresh, Sentinel, CDP, Credential store, NotifyWhen.
- `docs/decisions.md` — 12 ADR-style entries (D1-D12) covering the load-bearing calls.
- `docs/getting-started.md` — 5-minute walkthrough from clone to MCP tool in Claude Desktop.
- `docs/troubleshooting.md` — predictable failure modes with the same `→ next step:` format the in-code error messages use.
- `docs/notifications.md` — Pushover + ntfy setup, predicate language for `notifyWhen`.
- `docs/security.md` — what Imprint stores, redaction guarantees, credential handling, vuln reporting flow.
- `examples/discoverandgo/README.md` and `examples/echo/README.md` — tutorial-style READMEs (each: what / why interesting / run / what you should see / notes).
- `CHANGELOG.md` — this file.
- `CONTRIBUTING.md` — table-stakes contributor guide.
- Per-verb help: `imprint <verb> --help` shows summary + usage + flags + a concrete example. The verb registry is single-source.
- Actionable `→ next step:` hints in every user-reachable error message (Pushover/ntfy not set, missing playbook, missing param, no requests in workflow, etc.).
- `resolveLadder` helper in `backend-ladder.ts` so cron + mcp-server share the auto-ladder expansion logic.
- MCP tool descriptions now include the operator's recorded narration (`intent.userSaid`) — gives the LLM real context for picking the right tool.
- Test coverage: `test/compile.test.ts` (+15 tests for shrinkSession + error paths), `test/cli-help.test.ts` (+26 drift-guard tests for VERB_HELP / dispatcher sync), `test/backend-ladder.test.ts` (+5 resolveLadder tests), `test/doctor.test.ts` (+7), additional `test/notify.test.ts` cases for multi-path pricePath. 132 → 193 tests.
- `bun run check` package.json script — combined typecheck + lint + tests. CI now runs this directly.
- `bun run imprint <verb>` and `bun run doctor` package.json shortcuts (alternatives to `bun link`).
- `imprint emit` prints "next steps" after generating, removing the "I have a tool, now what?" friction point.
- `imprint cron <unknown-site>` now lists the configured sites in the error message ("available sites: a, b, c").
- "command not found" troubleshooting section explicitly covering the bun-link / PATH failure mode.
- **Typo suggestions** for unknown verbs: `imprint recrod` → "did you mean `imprint record`?" via Levenshtein distance (≤ 3 edits AND ≤ half-length). Same UX pattern as git/bun. Tested.
- **Capped cron success-log preview** at 500 chars (full payload still available via IMPRINT_DEBUG=1) so long-running daemons don't flood stderr. Southwest's ~100KB shopping response went from log-flooding to one-line.
- **`--quiet` flag for `imprint cron`** (and `IMPRINT_QUIET=1` env var) — suppresses info logs on success so OS schedulers (cron, systemd, launchd) only mail/alert when something's actually broken. Failures still surface to stderr (separate code path).
- **`isDebug()` / `isQuiet()` env helpers** — internal `=== '1'` semantics. Fixes a subtle bug where `if (process.env.IMPRINT_DEBUG)` was truthy for the string `"0"` (non-empty string coerces to true), so `IMPRINT_DEBUG=0` would actually enable debug mode.
- **Per-verb missing-arg errors point to `--help`**: `imprint record` (no site) → "→ run `imprint record --help` for usage." Shared via the `requirePositional` helper so all 11 positional-taking verbs benefit.
- **`--param k=v` malformed input** now shows a concrete example (`→ example: --param origin_airport_code=SJC`) instead of just "requires k=v form".
- **Pipeline next-step hints**: `record` → `redact` → `generate` → `emit` → `cron`. Every successful verb now ends with the exact command for the next step, including the file path produced. A first-time user can chain the entire pipeline by following the printed commands.
- **MCP no-tools error** suggests the bundled `echo` fixture so first-time users can verify the MCP wire-up before they've recorded anything.
- **Cron expression error** now shows the format and links crontab.guru.
- **Vertex project ID error** shows the exact `export ANTHROPIC_VERTEX_PROJECT_ID=…` command and points at `imprint doctor` for the rest of the env-var checklist.
- **Workflow placeholder error** lists the params that *were* passed (or, if none, shows the exact `--param X=<value>` to add).
- **`loadJsonFile()` helper** — `src/imprint/load-json.ts`. Single-source for the file-not-found / invalid-JSON / schema-mismatch error pipeline used by cron.ts, emit.ts, compile.ts, and the cli.ts redact case. -44 LOC across the four callers, plus user-friendly messages everywhere ZodError used to spill raw to stderr (cron.json `{badkey:1}` → "  - schedule: Required" + minimum example + docs link, instead of `[{code:'invalid_type',...}]`).
- **Pipeline next-step hints** — `imprint redact`, `generate`, `compile-playbook`, `record`, `check`, `login`, `probe-backends`, `mcp-server` (no-tools path) all now print "next step: imprint <verb> ..." after a successful run or hint-worthy error, so the full pipeline can be chained without alt-tabbing to docs.
- **isDebug() / isQuiet() env helpers** — `=== '1'` semantics (not truthy coercion), so `IMPRINT_DEBUG=0` actually disables. Replaces 8 raw `process.env.IMPRINT_DEBUG` checks across record.ts, chromium.ts, cron.ts, cli.ts.
- **`tryParseParamKV()` helper** in cli.ts — return-null-on-error pattern eliminates the duplicated try/catch for the two `--param` callers.
- **Test coverage gap-fills**: `test/check.test.ts` (+8 tests pinning warning heuristics), `test/load-json.test.ts` (+7 tests pinning the shared error shape), `test/sites.test.ts` (+5 tests pinning availableSitesHint branches).
- **`availableSitesHint()` shared across cron / probe-backends / mcp-server** — extracted from cron.ts to `src/imprint/sites.ts`. Now `imprint probe-backends <typo>` and `imprint mcp-server --site <typo>` also list the actual sites under examples/ so users can spot a one-character typo.
- **MCP server version single-sourced** — was hard-coded `'0.1.0'`; now reads from the same `VERSION` constant the CLI uses, eliminating a future drift hazard on package.json bumps.
- **Vertex SDK error enrichment** — `llm.ts` wraps `messages.create` and translates the four common SDK errors (404 model not enabled in region, 401 not authenticated, 403 permission denied, 429 quota) into actionable messages with the exact `gcloud` / IAM / Model Garden link to fix. The raw SDK error is preserved as the JS `cause` chain (visible under `IMPRINT_DEBUG=1`). Documented in docs/troubleshooting.md.
- **Credential store malformed-file error** — `loadCredentialStore` now throws with the file path + "→ delete and re-run \`imprint login <site>\`" hint instead of letting `JSON.parse` throw bare.
- **Test coverage for the JSON extractor** — `test/llm.test.ts` (+9 tests for `extractJsonObject`'s fenced-block / nested-brace / escaped-quote branches).
- **`assemble` next-step hint** — points users to `imprint check` after recovering a session.json from a partial .jsonl. Closes the last verb that was missing a next-step pointer.
- **Credential placeholder error** matches the param error style — lists available credential keys and suggests re-running `imprint login` if the named key is missing. Helps when the credential store has a partial set (e.g. session_id captured but patron_id wasn't).
- **`notifyWhen` decision logging** — every cron tick now logs `notifyWhen X: matched → pushing` or `notifyWhen X: no match (predicate ran, threshold not crossed)`. Silent no-match used to confuse users. Suppressed by `--quiet`.
- **Vertex error troubleshooting docs** — `docs/troubleshooting.md` covers the four Vertex SDK error buckets (404 / 401 / 403 / 429) with the exact gcloud / IAM / Model Garden remediation for each.
- **D13 + D14 added to `docs/decisions.md`** — three-tool dead-code defense (knip + tsc-strict + madge) and "user-friendly errors are worth the LOC" become ADR entries.
- **`scripts/mcp-smoke-test.ts` fixed** — was using positional `discoverandgo` (wrong syntax for the `--site=<name>` flag) AND requiring a generated demo. Now defaults to the bundled `echo` fixture so it actually works on a clean checkout. Override via `IMPRINT_SMOKE_SITE=<other>`.
- **Single source of truth for the backend enum** — `BackendsCacheSchema` previously duplicated `['fetch', 'stealth-fetch', 'playbook']` literally. Now derives from `ReplayBackendSchema.exclude(['auto'])`. Adding a new backend updates one place.
- **Tighter type narrowing** — `runWithLadder` parameter changed from `ReplayBackend[]` to `ConcreteBackend[]` (= `Exclude<ReplayBackend, 'auto'>`); the unreachable `case 'auto'` defensive throw deleted.
- **Zero dead code, enforced** — three-tool defense:
  - `knip` (unused exports/files/types/deps)
  - `tsc` (`noUnusedLocals` + `noUnusedParameters` enabled — unused locals/params/imports)
  - `madge` (circular dependencies)
  All three are part of `bun run check` and CI. Removed 19 unused value exports, 35 unused type exports, plus a duplicate alias. Internal-only Options/Result interfaces are no longer exported (TypeScript structural typing means callers don't need a named import). Adding new dead exports / circular deps / unused symbols now fails CI.

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
- **Single source of truth for VERSION**: `src/imprint/version.ts` reads the version once from `package.json`. cli.ts, record.ts, probe-backends.ts all import from there — no more drift on bumps.
- **`pricePath` accepts an array of fallback paths** (backward-compatible with single-string). Fixes a real bug in the southwest cron where `notifyWhen` silently never fired on the stealth-fetch backend (raw API shape) but worked on the playbook backend (reshaped output). Now both shapes are accepted.
- **package.json description** rewritten to match the README tagline (was a technical surface description).

### Removed
- `src/imprint/replay-backend.ts`, `src/imprint/workflow-runtime.ts`, `src/imprint/discover-tools.ts`, `src/imprint/playbook-types.ts` (renamed/folded; see Changed).
- `src/imprint/generate.ts`, `src/imprint/playbook-compiler.ts` (merged into `compile.ts`).
- `test/sanity.test.ts` — its 3 cases tested Zod's `safeParse` on inline schemas, not Imprint logic.
- `scripts/minimal-mcp.ts`, `scripts/minimal-mcp-with-import.ts`, `scripts/min-node-mcp.ts` — superseded MCP scratchpads from v0.1 bring-up.
- `scripts/zoo-sniper.py` — standalone Python script for a personal use case (Zoo Pass automation), unrelated to imprint's pipeline. Pre-pivot artifact.

### Metrics

| | Before | After |
|---|---|---|
| `src/imprint/` + `src/cli.ts` LOC | 5,828 | 5,714 (-2%, includes +137 LOC for new doctor verb + 5 new shared helpers: compile/doctor/version/load-json/sites) |
| Source files | 26 | 25 (− 4 renames/folds + 5 new) |
| Tests | 137 / 13 files | 238 / 20 files (more user-path coverage) |
| README | sprint-changelog flavor (285 lines) | adoption-friendly (110 lines) |
| Docs files | 3 | 10 (+ CHANGELOG, CONTRIBUTING, scripts/README) |
| CLI verbs | 12 | 13 (+ doctor) |
| ADR entries | — | 14 (D1-D14, including D13 dead-code defense + D14 errors-over-LOC) |

---

## [0.1.0] — 2026-04 / 2026-05 (sprint)

Initial public release. Two-week sprint to ship the full pipeline + two working demos.

### Added
- `imprint record` — CDP-based browser session capture with stdin narration loop, JSONL streaming, sidecar Session JSON on close.
- `imprint redact` — credential / PII scrub with `[REDACTED:N]` markers preserving shape for the LLM.
- `imprint generate` — Vertex Anthropic compilation of session → `workflow.json`.
- `imprint compile-playbook` — Vertex Anthropic compilation of session → `playbook.yaml` (DOM replay artifact, switched from markdown to YAML mid-sprint).
- `imprint emit` — code generation of `examples/<site>/<toolName>/index.ts` from `workflow.json`.
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
