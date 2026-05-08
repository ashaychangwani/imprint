# Troubleshooting

The predictable failure modes. Most error messages in Imprint already include a `→ next step:` hint — this doc is the longer form of those hints.

## Before anything else: `imprint doctor`

```bash
imprint doctor
```

Checks every prerequisite (Bun, Chromium binary, Playwright Chromium install, Vertex project ID, region, push providers). Catches ~80% of "I just installed and nothing works" cases in one command. If a check fails the output includes the exact fix command.

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

The site has bot detection. Three escalating fixes:

1. **Set `replayBackend: "auto"`** in `cron.json` (or `imprint cron --once` will use it). The ladder will try `stealth-fetch` next, which mints sensor tokens via a brief Playwright bootstrap.

2. **Probe and cache the working backend:**
   ```bash
   imprint probe-backends <site>
   ```
   This writes `backends.json`; cron + MCP read it at startup.

3. **Compile a playbook fallback:**
   ```bash
   imprint compile-playbook examples/<site>/sessions/<ts>.redacted.json
   ```
   With a `playbook.yaml` present, the `auto` ladder escalates to a real DOM walk when fetch + stealth-fetch both fail.

## "AUTH_EXPIRED" / 401

Cookies have aged out.

**Fix:**
```bash
imprint record <site> --persist-profile    # record while logged in
imprint login <site> --from-session examples/<site>/sessions/<ts>.json
```

This rebuilds `~/.config/imprint/credentials/<site>.json`.

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

## "MCP tools panel is empty in Claude Desktop"

Common causes:

1. **Wrong path in claude_desktop_config.json.** If you didn't `bun link`, the entry needs to be `bun run /abs/path/to/imprint/src/cli.ts mcp-server`.

2. **Restart required.** Claude Desktop reads config only at startup.

3. **No examples/<site>/<toolName>/index.ts.** Imprint discovers tools by scanning nested tool directories under `examples/`. If you haven't run `imprint emit`, there's nothing to expose.

4. **Vertex env not set.** MCP server starts fine without it, but tool calls fail. Set `ANTHROPIC_VERTEX_PROJECT_ID`.

Verify with mcp-inspector instead — it's faster to iterate on:
```bash
npx @modelcontextprotocol/inspector imprint mcp-server
```

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

For `imprint cron`, the params live in `examples/<site>/<toolName>/cron.json` under the `params` key. For `imprint mcp-server`, the agent passes them in the tool call.

If the param name in the workflow looks wrong (e.g. `q` instead of `query`), edit `examples/<site>/<toolName>/workflow.json`'s `parameters` array — the runtime substitutes by name.

## "Invalid cron expression in cron.json"

The `schedule` field must be a 5-field cron expression (`minute hour day-of-month month day-of-week`). Test new expressions at https://crontab.guru. Examples:

```
"0 9 * * *"       # 9am every day
"*/15 * * * *"    # every 15 minutes
"0 9 * * 1-5"     # 9am weekdays only
```

## "No locator matched" (in playbook runner)

The site's DOM changed since the recording. Locators are tried in priority order: `role+name → aria_label → text → id → css`. Roles and aria-labels are most stable; CSS selectors break first.

**Fix:** re-record the session, then `imprint compile-playbook` again. Locators are LLM-generated from the recorded DOM, so a fresh recording captures the current shape.

For deeper debugging, see [docs/playbook-debugging.md](playbook-debugging.md).
