# Troubleshooting

The predictable failure modes. Most error messages in Imprint already include a `→ next step:` hint — this doc is the longer form of those hints.

## Before anything else: `imprint doctor`

```bash
imprint doctor
```

Checks every prerequisite (Bun, Chromium binary, Playwright Chromium install, Vertex project ID, region, push providers). Catches ~80% of "I just installed and nothing works" cases in one command. If a check fails the output includes the exact fix command.

For any command, set `IMPRINT_DEBUG=1` to see full stack traces and verbose logging:

```bash
IMPRINT_DEBUG=1 imprint mcp-server mysite
```

## "command not found: imprint"

You ran `bun link` from inside the imprint directory but the binary isn't on PATH. Two fixes:

1. **Add `~/.bun/bin` to PATH.** Bun's installer does this by default in `~/.zshrc` / `~/.bashrc`; if you skipped that step or installed via a non-standard route:
   ```bash
   echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   imprint --help    # should now work
   ```

2. **Skip linking entirely.** Run every verb via `bun src/cli.ts` from the imprint repo:
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

## "Vertex Anthropic call failed: ..."

The new error message will tell you which of the four common cases hit:

- **404 / publisher model not found** — the model isn't enabled on your project in the configured region. Open https://console.cloud.google.com/vertex-ai/model-garden, find Claude, click "Enable". Or set `CLOUD_ML_REGION` to a region that already has it (`us-east5` is the default).
- **401 / not authenticated** — `gcloud auth application-default login` hasn't been run, or your active account doesn't have credentials. The fix command is in the error.
- **403 / permission denied** — auth worked but your account is missing `roles/aiplatform.user` on the project. Add it via IAM console.
- **429 / quota exceeded** — you hit a quota limit (per-minute or per-day). Retry, or request more quota.

The raw SDK error is preserved as the JS `cause` chain — set `IMPRINT_DEBUG=1` to see it.

## "LLM response did not contain a JSON object"

The Vertex Anthropic call returned text instead of JSON. This happens occasionally when:
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

Each tool compiles with a **10-minute timeout** by default. If a tool hits the timeout, it fails gracefully and other tools continue compiling. Simple tools (2-3 API requests) typically compile in 2-5 minutes. Complex multi-request workflows (e.g. a full checkout flow with 10+ chained requests) may approach the timeout — increase it for those:

```bash
imprint teach <site> --timeout 15m
```

If a tool consistently fails to compile within the timeout (e.g. due to bot defense on verification), try a faster model:

```bash
imprint teach <site> --model claude-sonnet-4-6 --timeout 10m
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

4. **Vertex env not set.** MCP server starts fine without it, but tool calls fail. Set `ANTHROPIC_VERTEX_PROJECT_ID`.

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
