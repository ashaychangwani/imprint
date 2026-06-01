# Troubleshooting

The predictable failure modes. Most error messages in Imprint already include a `→ next step:` hint — this doc is the longer form of those hints.

## Before anything else: `imprint doctor`

```bash
imprint doctor
```

Checks every prerequisite (Bun, Chromium binary, Playwright Chromium install, LLM providers, push providers). Catches ~80% of "I just installed and nothing works" cases in one command. If a check fails the output includes the exact fix command.

For any command, set `IMPRINT_DEBUG=1` to see full stack traces and verbose logging:

```bash
IMPRINT_DEBUG=1 imprint mcp-server mysite
```

## "command not found: imprint"

The `imprint` binary isn't on PATH. Fixes depending on how you installed:

1. **npm install** — ensure `~/.bun/bin` is on PATH (Bun's installer adds it by default):
   ```bash
   echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   imprint --help    # should now work
   ```

2. **Standalone binary** — ensure `~/.local/bin` (or wherever you installed) is on PATH.

3. **From source** — run `bun link` in the repo, or skip linking and call via `bun src/cli.ts`:
   ```bash
   bun src/cli.ts doctor
   bun src/cli.ts record mysite --url https://...
   bun src/cli.ts cron mysite --once
   ```
   Same behavior, no PATH dance.

## "Could not locate Chromium"

Imprint prefers Playwright's bundled Chromium over the system Chrome (corporate-managed Chrome installs often disallow `--remote-debugging-port`).

**Fix:**
```bash
bunx playwright install chromium
```

Or set `CHROMIUM_PATH` to an explicit binary path.

## "Playwright not available" (when running playbook backend)

**Fix:**
```bash
bunx playwright install chromium
```

Same as above — ensure Playwright's Chromium is installed.

## "FORBIDDEN" / 403 from a real site

The site is blocking API replay or needs browser-minted state. Three escalating fixes:

1. **Set `replayBackend: "auto"`** in `cron.json` (or `imprint cron --once` will use it). The ladder can try `fetch-bootstrap` for browser-minted state and `stealth-fetch` for bot-defense tokens before falling back to DOM replay.

2. **Probe and cache the working backend:**
   ```bash
   imprint probe-backends <site> --tool <toolName>
   ```
   This writes `backends.json`; cron + MCP read it at startup. On a single-tool site, `--tool` is optional; on multi-tool sites, `--out ~/.imprint/<site>/<toolName>/backends.json` also selects the target.

3. **Compile a playbook fallback:**
   ```bash
   imprint compile-playbook ~/.imprint/<site>/sessions/<ts>.redacted.json
   ```
   With a `playbook.yaml` present, the `auto` ladder escalates to a real DOM walk when API replay modes cannot satisfy the workflow.

## "STATE_MISSING"

The workflow referenced a required `${state.NAME}` or cookie value that was not available yet. The error includes a `capability` that determines the fix:

- `ordinary_http` — an earlier safe/idempotent HTTP request was expected to produce the value. Check `requests[].captures`, request order, and whether the producer request still sets the cookie/header/body field.
- `browser_bootstrap` — add or fix `workflow.bootstrap`; `fetch-bootstrap` should be able to mint this state before API replay.
- `stealth_bootstrap` — `stealth-fetch` supplies bot-defense cookies/headers to API replay but does not fill `${state.NAME}` placeholders by itself. Use `replayBackend: "auto"` so the ladder escalates to `fetch-bootstrap` (if the workflow has bootstrap metadata) or the `playbook` fallback. If neither resolves the missing state, regenerate the workflow from a recording that includes the state-producing interaction.
- `credential_required` — provision secrets/cookies/storage with `imprint login`, `imprint credential set`, or `imprint credential import`.
- `unsupported` — the workflow references state no backend knows how to produce; regenerate or edit `workflow.json`.

For direct cookie placeholders like `${cookie["sid"]}`, ambiguity is terminal. Prefer a named cookie capture with URL/domain/path constraints, then reference it as `${state.sid}`.

## "AUTH_EXPIRED" / 401

Cookies have aged out.

**Fix:**
```bash
imprint record <site> --persist-profile    # record while logged in
imprint login <site> --from-session ~/.imprint/<site>/sessions/<ts>.json
```

This refreshes the site's credential backend entry. Modern credential backends store cookies, named secrets, and declared durable storage values in the OS keychain when available, with an encrypted fallback for headless systems. The legacy JSON path is still read for migration, but new credentials should be managed with `imprint login` and `imprint credential *`.

## "RATE_LIMITED" / 429

Back off. The cron schedule is probably too aggressive — every 5 minutes is fine for most sites; every 30 seconds is not.

## "PUSHOVER_TOKEN / PUSHOVER_USER not set"

You configured `notifyWhen` in `cron.json` but no push provider is set up.

**Fix (free):**
```bash
export NTFY_URL=https://ntfy.sh/your-secret-topic-name
```

See [docs/notifications.md](notifications.md) for setup.

## "LLM response did not contain a JSON object"

The LLM call returned text instead of JSON. This happens occasionally when:
- The prompt is being clipped (very large session)
- The model returned an apology / refusal (rare)

**Fix:** re-run `imprint generate`. If it persists, try `--no-shrink` or split the recording into smaller workflows.

## "Replay-and-diff is slow or failing"

The replay-and-diff stage re-runs your recorded actions in a fresh browser to classify which request values are ephemeral (timestamps, CSRF tokens) vs constant. If the automated replay fails or the site blocks it, `teach` falls back to asking you to manually re-record the same flow.

To skip this stage entirely:

```bash
imprint teach <site> --skip-replay
```

This is faster but means the compile agent won't be able to distinguish browser-minted values from constants, which may reduce workflow accuracy for sites with dynamic request parameters. For simple sites with mostly static API calls, this is usually fine.

## "Compile is slow or looks stuck"

Each tool compiles with a **20-minute timeout** by default. The compile agent writes the MCP server and runs thorough verification tests, so most complex tools take 10-15 minutes — be patient. If a tool hits the timeout, it fails gracefully and other tools continue compiling. Simple tools (2-3 API requests) typically compile in 2-5 minutes. Complex multi-request workflows (e.g. a full checkout flow with 10+ chained requests) may take longer — increase the timeout for those:

```bash
imprint teach <site> --timeout 30m
```

Tools with a **large filter surface** (a search tool exposing 10+ optional filters) take the longest: before finishing, the compile agent verifies that *every* exposed parameter actually reproduces its recorded effect (parameter fidelity), so it never ships a filter it can't apply. That verification is thorough but slow — such tools routinely run 20-30 minutes. Give heavy-search sites more headroom with `--timeout 30m`. When running the from-scratch helper, set the same cap via its passthrough:

```bash
IMPRINT_TEACH_TIMEOUT=30m scripts/teach-from-scratch.sh <site>
```

If a tool consistently fails to compile within the timeout (e.g. due to bot defense on verification), try a faster model:

```bash
imprint teach <site> --model claude-sonnet-4-6 --timeout 20m
```

For deeper debugging, turn on local Phoenix tracing and inspect which stage or tool call is spending time:

```bash
uv tool install arize-phoenix
phoenix serve

IMPRINT_TRACE=1 \
IMPRINT_TRACE_BATCH=false \
IMPRINT_TRACE_LLM_IO=1 \
IMPRINT_TRACE_TOOL_IO=1 \
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 \
imprint teach <site> --from-session ~/.imprint/<site>/sessions/<ts>.json --provider codex-cli
```

If Phoenix is open at `http://localhost:6006` but empty, check that `PHOENIX_COLLECTOR_ENDPOINT` points at that URL and use `IMPRINT_TRACE_BATCH=false` for immediate local export. Drill into individual `agent.turn.N` spans to see per-turn token counts, and into `agent.tool.X` spans to find which tool call is slow. `IMPRINT_TRACE_LLM_IO=1` records prompts/responses; `IMPRINT_TRACE_TOOL_IO=1` records compile-agent tool arguments/results; `IMPRINT_TRACE_IO_MAX_CHARS=200000` raises the per-payload capture cap when the default is too small.

## "Build plan skipped" — the shared-module planner timed out

In a multi-tool run you may see `Planning shared modules…` followed by `build planning failed or timed out (build planner exceeded 600s timeout) — proceeding with independent per-tool compilation (no shared modules)`. This is **non-fatal**: every tool still compiles, just without shared `_shared/*` modules (each inlines the logic). The planner is a single LLM call bounded at 600s (10 minutes) — it analyzes the whole merged recording across all tools, so it gets the longer cap; the per-tool plan (below) is the 5-minute one.

The planner logs what it sent, so you can see *why* it was slow — look for:

```
[imprint build-plan] planning 3 tool(s): 30 request(s), 1657 ephemeral value(s), 4 narration line(s); 412 KB payload + 9 KB prompt → claude-cli/claude-opus-4-8 (timeout 600s)
[imprint build-plan] calling planner LLM…
[imprint build-plan] planner LLM timed out after 600s: build planner exceeded 600s timeout
```

A large **ephemeral value count** or **payload KB** is the usual cause. Under Phoenix tracing (above), the `teach.plan_prereqs` span carries `imprint.plan.payload_chars`, `imprint.plan.ephemeral_count`, `imprint.plan.request_count`, and — on timeout — `imprint.plan.timed_out=true` with `imprint.plan.llm_elapsed_ms`; these are set *before* the call, so even a timed-out session exports a useful (errored) span. To skip shared-module planning entirely and compile every tool independently, set `IMPRINT_NO_BUILD_PLAN=1`.

## A tool compiled but seems to ignore the per-tool plan

Before each tool compiles, Imprint runs a short **per-tool planning pass** (`teach.plan_tool`) that maps every parameter to its recorded field and fixes the request/parse plan, then injects that Markdown plan into the compile agent. The plan is persisted to `~/.imprint/<site>/<toolName>/.tool-plan.md` — open it to see exactly what the planner told the compiler.

The pass is **best-effort**: a 5-minute timeout, a missing `prompts/tool-planning.md`, or any error yields no plan and the tool compiles without one (today's behavior). Under Phoenix tracing, the `teach.plan_tool` span sits as a sibling of that tool's `compile.generate` and carries `imprint.tool_plan.chars` (plan length) or `imprint.tool_plan.skipped=true` — if it's skipped, no plan reached the compiler. To disable per-tool planning entirely, set `IMPRINT_NO_TOOL_PLAN=1`.

## Reading a teach trace stage-by-stage in Phoenix

With tracing on (see "Compile is slow or looks stuck" above), the `cli.teach` root span fans out into one child span per stage, so any part of a run is debuggable in isolation. Open the root trace and locate the failing stage by span status + attributes:

| Stage span | What it covers | Key attributes |
|---|---|---|
| `teach.combine_sessions` | from-scratch: merging sibling recordings | `imprint.combine.{session,request,narration}_count` |
| `teach.record` | the live browser capture | `imprint.record.event_count` |
| `teach.redact` | credential/PII scrub | `imprint.redact.{totalRedactions,requestsRedacted,cookiesRedacted,placeholdersInjected,freeformRedactions}` |
| `compile.triage_requests` | LLM request filtering | `imprint.requests_selected` |
| `teach.detect_tool_candidates` | tool detection | — |
| `teach.plan_prereqs` | build plan + shared modules (multi-tool) | `imprint.plan.*` (see above) |
| `teach.build_shared_module` | one `_shared/*.ts` build | `imprint.shared_module.{cycles,ok}` |
| `teach.plan_tool` | per-tool implementation plan | `imprint.tool_plan.{chars,skipped}` |
| `compile.generate` | the per-tool compile agent | `imprint.compile.{outcome,turns}` |

A red span tells you where the run broke: a `teach.plan_prereqs` timeout, a `teach.build_shared_module` with `imprint.shared_module.ok=false`, an empty `teach.plan_tool`, or a `compile.generate` with `outcome=give_up`/`timeout`.

## `imprint audit` — scoring a site's generated tools

`imprint audit <site>` exercises every generated tool against the site's real MCP server and prints a deterministic score:

```bash
imprint audit <site>                 # gate at the 95% default
imprint audit <site> --min-score 90  # relax the threshold
imprint audit <site> --json          # full machine-readable report to stdout
```

It prints `PASS` / `FAIL` / `INCONCLUSIVE` and writes the full report (score + the raw auditor verdicts) to `~/.imprint/<site>/.audit-report.json`. **Exit codes distinguish the cases:** `0` pass, `1` fail (genuine logic bugs), `2` inconclusive.

Interpreting the verdict:

- **FAIL** — the score is below the threshold (`tool_broken` invocations the auditor judged as not behaving as advertised). Open `.audit-report.json` and read the `reason` on each `tool_broken` invocation, or open the `audit.session` span in Phoenix (`imprint.audit.{score,correct,broken,infra,bad_params,graded,verdict}`) and inspect the tool calls. Fix the tool (regenerate, or correct its parser/workflow) and re-audit.
- **INCONCLUSIVE** — there were **no gradeable invocations**: every call was classified `infra` (anti-bot / rate-limit / 403/429 / network / timeout). This is **not a code failure** — the site blocked the auditor. Re-run (often from a different network), or accept that the site can't be audited automatically. Spot-check the `infra` verdicts in the trace to make sure a real bug wasn't mislabeled.
- **PASS** — `score ≥ min-score` AND at least `max(2, gradeableTools)` gradeable invocations, where `gradeableTools` counts only tools that produced ≥1 gradeable call. The floor ensures the number is backed by enough signal — at least one verified call per gradeable tool. A tool the auditor could never exercise (e.g. it needs an opaque token it cannot synthesize) is listed under `ungradeableTools` in the report and no longer inflates the floor. (The floor is one gradeable call per gradeable tool, not two: the auditor often burns a slot per tool on `bad_params`/`infra`, so demanding two clean reads per tool false-failed otherwise-perfect runs.)

Note `infra` and `bad_params` (the auditor's own parameter mistakes) are excluded from the score denominator, so a blocked or misused tool is never counted as a code bug.

## A compiled tool exposes a parameter flagged `verified:false`

This is expected, not a bug. The compile gate confirms each exposed parameter actually affects the response via a `param:<name>` integration test that runs against the live API. When that test can't run — the site's anti-bot defense waived the live suite at compile time (`verifyNote: waived-bot`/`waived-infra`), the recording had no discriminating value to test with (`annotated`), or the param is a producer-sourced token whose producer tool was unavailable at compile (`waived-chain`) — the parameter still ships (Imprint keeps it and **marks** it rather than silently dropping it) with `verified:false` and a `verifyNote` in `workflow.json`. Such params are exercised at runtime through the backend ladder (stealth-fetch / playbook), and `imprint audit` is told to probe them especially. If audit then classes one `tool_broken` (e.g. the param has no effect), regenerate or fix the tool. To see what shipped unverified, grep the tool's `workflow.json` for `"verified": false`.

## Compile blocked: "producer-sourced token param(s) lack a CHAINED `param:<name>` test"

A tool whose parameter is an opaque token/id minted by a *sibling* tool (e.g. `get_hotel_offers(hotel_id)` ← `search_hotels`) must verify that parameter with a **fresh** token from the producer, not the recorded constant. The gate blocks compile when the consumer's `param:<name>` test only reuses the recorded value (it can't prove a real token works). The fix is almost always on the **producer**: make its parser emit the field in the *full shape* the consumer needs (e.g. a `<ftid>|<area>|<name>|<token>` composite) rather than a bare fragment, so the consumer's chained test — which calls `../<sourceTool>/workflow.json`, reads that field, and feeds it back — gets a working value. If the chained test runs but the consumer returns empty, the producer/consumer field contract is genuinely broken; fix the producer's emitted field (or how the consumer unpacks it). If the producer is blocked by anti-bot at compile time, the param waives to `verified:false` reason `waived-chain` instead of blocking.

## "Compile agent did not produce a verified workflow" — usage-policy / safety refusal

A tool can fail compilation with a message mentioning the model's **usage policy** (e.g. `claude-cli exited with code 1 … unable to respond to this request, which appears to violate our Usage Policy`). This is a **transient false positive** from the model's safety filter, not a problem with your recording: reverse-engineering an API trips the classifier probabilistically, and the rate rises with the volume of reasoning the model generates. It's most likely to hit the single most complex tool in a multi-tool run.

Imprint mitigates this automatically:

- The compile agent runs at **`high`** thinking effort (not `max`), which generates fewer reasoning tokens and measurably lowers the trip rate. This overrides any `CLAUDE_EFFORT` set in your environment.
- A refusal is **retried in a fresh session up to 3 times** with backoff before the tool is marked failed. A re-roll almost always succeeds.
- Multi-tool runs compile at **concurrency 2** (down from 3) to avoid bursts of near-identical requests, which raise the trip rate.

If a tool still fails after the automatic retries:

```bash
# Re-run just the teach flow; the earlier stages are cached.
imprint teach <site>

# Or compile that tool with a different provider (different safety stack).
imprint teach <site> --provider codex-cli
```

## "MCP tools panel is empty in Claude Desktop"

Start with Imprint's local audit:

```bash
imprint mcp status
```

It reports external registrations, generated tools under `IMPRINT_HOME`, incomplete `teach` checkpoints, missing session recordings, orphan sessions, and stale MCP entries that point at sites with no complete generated tool.

Common causes:

1. **Wrong path in claude_desktop_config.json.** Run `imprint install <site> --platform claude-desktop` to write the config. If editing by hand, use an absolute Bun command plus the repo CLI path, for example `"command": "/abs/path/to/bun"` with `"args": ["run", "/abs/path/to/imprint/src/cli.ts", "mcp-server", "mysite"]`. GUI-launched apps may not inherit your shell PATH, and linked shims can fail under Bun.

2. **Restart required.** Claude Desktop reads config only at startup.

3. **No `~/.imprint/<site>/<toolName>/index.ts`.** Imprint discovers tools by scanning nested tool directories under `IMPRINT_HOME` (`~/.imprint` by default). If you haven't run `imprint teach` or `imprint emit`, there's nothing to expose.

Verify with mcp-inspector instead — it's faster to iterate on:
```bash
npx @modelcontextprotocol/inspector imprint mcp-server
```

To clean up stale entries:

```bash
imprint mcp                    # interactive cleanup
imprint mcp disable imprint-mysite --yes
imprint mcp delete imprint-mysite --yes
imprint mcp prune-state --site mysite --missing-session --yes
```

`delete` only removes external MCP registrations by default. It does not remove generated tools or raw recordings unless you explicitly pass `--local tool` or `--local site`; recordings may contain sensitive cookies or browser state. Restart Claude Desktop, OpenClaw, or Hermes after direct config edits.

For the complete cleanup command reference, see [MCP Maintenance](mcp-maintenance.md).

## "No backend succeeded for <site>"

`probe-backends` failed every rung. Either:

- The recording is broken (check with `imprint check <session>`)
- The site is genuinely uncrawlable from your network (corporate proxy, geo-block, anti-VPN)
- Your `params` are wrong (a search with no results returns 200 OK with empty data — that's fine; if it returns 4xx, it's the params)

Try the playbook backend manually:
```bash
imprint playbook <site> --headed --param key=value
```

Headed mode opens a visible Chromium so you can watch it run.

## "Workflow placeholder ${param.X} but no param "X" provided"

The generated workflow expects a `param.X`, but you didn't pass it. The error message lists which params *were* passed (or, if none, the exact `--param X=<value>` to add).

For `imprint cron`, the params live in `~/.imprint/<site>/<toolName>/cron.json` under the `params` key. For `imprint mcp-server`, the agent passes them in the tool call.

If the param name in the workflow looks wrong (e.g. `q` instead of `query`), edit `~/.imprint/<site>/<toolName>/workflow.json`'s `parameters` array — the runtime substitutes by name.

## "Invalid cron expression in cron.json"

The `schedule` field must be a 5-field cron expression (`minute hour day-of-month month day-of-week`). Test new expressions at https://crontab.guru. Examples:

```
"0 9 * * *"       # 9am every day
"*/15 * * * *"    # every 15 minutes
"0 9 * * 1-5"     # 9am weekdays only
```

## "Playbook failed at step N: ..." (playbook runner errors)

The playbook runner reports failures as `Playbook failed at step N: <underlying error>`. Common underlying errors include locator timeouts (DOM changed since recording), navigation failures, and element not visible/clickable. Locators are tried in priority order: `role+name → aria_label → text → id → css`. Roles and aria-labels are most stable; CSS selectors break first.

**Fix:** re-record the session, then `imprint compile-playbook` again. Locators are LLM-generated from the recorded DOM, so a fresh recording captures the current shape.

For deeper debugging, see [docs/playbook-debugging.md](playbook-debugging.md).

## "No generated tool found for site X"

The MCP server can't find any emitted tool directories under `~/.imprint/<site>/`.

**Fix:** run `imprint teach <site>` first (which handles the full pipeline), or if you have a compiled workflow, run `imprint emit <site>`.

If `~/.imprint/<site>/<tool>/` directories *do* exist but every tool was skipped at startup with `Cannot find module 'imprint/runtime'`, the `~/.imprint/node_modules/imprint` symlink is dangling — the repo it pointed to has moved or been deleted (common with Conductor / git-worktree workflows). Imprint self-heals this on the next `mcp-server` / `cron` / `probe-backends` invocation, so just re-run the same command. If it still fails, check that the directory containing the symlink is writable.

## "site X has N workflows — specify which with --path"

A site has multiple tools (e.g., `search_flights` and `book_flight`) and you didn't specify which one to use.

**Fix:** add `--path ~/.imprint/<site>/<toolName>` to your command.

## Crashed recording left a `.jsonl` instead of `.json`

If a recording crashes or is interrupted before clean shutdown, the session is left as a raw `.jsonl` stream rather than a finalized `.json` file.

**Fix:** run `imprint assemble <path-to-file.jsonl>` to reconstruct the session from the stream.
