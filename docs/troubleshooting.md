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

## Running on a headless server (anti-bot sites)

The trusted-browser replay (the `playbook` rung's primary mechanism) launches a real Chrome **headless** — no window, no display required. The one thing a behavioral anti-bot service (Akamai, etc.) edge-detects on a headless Chrome is the `HeadlessChrome` token its User-Agent carries even under `--headless=new`; `imprint` strips that token via a CDP UA override **before** navigating, after which the headless session is indistinguishable from a headed one (verified: the sensor cookie validates and state-changing POSTs return 200). So on a normal server with a GPU, **nothing extra is needed** — it just works headless.

The remaining edge case is a **GPU-less Linux host**: headless WebGL there falls back to the `SwiftShader` software rasterizer, which a sensor *can* fingerprint. If you hit that, run the replay **headed under a virtual framebuffer** instead:

```bash
apt-get install xvfb        # Debian/Ubuntu
export DISPLAY=:0           # or let imprint auto-start Xvfb when headed
```

`launchChromium` auto-starts Xvfb (`Xvfb :NN -screen 0 1920x1080x24`) when a **headed** launch finds no `$DISPLAY`. `imprint doctor` reports this as **"Display (headed replay)"** — advisory only, since the default headless path needs no display and sites that replay on the plain `fetch` rung never launch a browser at all. macOS/Windows need nothing.

## Browser-backed MCP calls time out instead of hanging forever

`fetch-bootstrap` and `cdp-replay` drive Chrome through CDP. The underlying `chrome-remote-interface` calls do not impose command deadlines: a command such as `Runtime.enable`, `Page.loadEventFired`, `Network.getCookies`, or an in-page `Runtime.evaluate(fetch(...))` can stay pending if the renderer, page, or CDP socket stops answering. Imprint bounds each CDP operation and closes the browser instead of leaving an MCP `tools/call` stuck indefinitely. In MCP output this surfaces as a structured `NETWORK` error like `cdp-replay failed: CDP Runtime.enable timed out after 20000ms`, after which the backend ladder can try the next rung.

If you are debugging a long-running Hermes or cron host, check for old browser roots before retrying:

```bash
ps -eo pid,ppid,etime,args | grep -E 'imprint|chrome' | grep -v grep
```

Chrome processes that have lived far longer than the MCP call timeout usually mean the host is still running an older Imprint runtime or a stale helper process. Restart the MCP host after upgrading Imprint so existing MCP server processes reload the patched source and close any inherited browser children.

## Anti-bot returns "empty results" on a cloud/datacenter IP — use `IMPRINT_PROXY`

Distinct from a 403/tarpit: a behavioral anti-bot service (Akamai et al.) can return a **200 with an empty body** (e.g. a search that yields `count: 0` for an obviously-valid query) even though the request succeeded. The dominant cause is the **egress IP reputation** — requests from **AWS / GCP / Azure / VPN datacenter IPs** are heavily penalized and "empty-shelled" regardless of how trusted the browser session is. (Check your egress with `curl -s https://ipinfo.io/json`; an `org` like "Amazon" / "Google Cloud" means datacenter.) The recorded *workflow* is fine — the IP is the problem, and no amount of token-minting overcomes a datacenter IP.

Fix: route imprint's outbound traffic — the trusted cdp-browser bootstrap **and** every plain-fetch replay — through a **residential** proxy, so the egress IP earns trust:

```bash
export IMPRINT_PROXY="http://USER:PASS@residential-proxy.example.com:8000"   # or socks5://host:port
imprint teach <site> …      # bootstrap + replay now egress through the proxy
imprint audit <site> …
imprint mcp-server <site>    # runtime tool calls too
```

`IMPRINT_PROXY` applies uniformly to `launchChromium` (Chrome `--proxy-server`), the cross-origin in-page fallback, the `fetch-bootstrap` replay, and the plain `fetch` rung — so the jar is minted and replayed from the **same** IP (a mismatch makes Akamai drop the jar). Chrome's `--proxy-server` ignores inline credentials; use an IP-authenticated residential proxy, or one that needs no auth. A residential proxy also means you record **once** and replay across runs/IPs without re-recording — the proxy is the stable trusted egress.

## "FORBIDDEN" / 403 from a real site

The site is blocking API replay or needs browser-minted state. Three escalating fixes:

1. **Set `replayBackend: "auto"`** in `cron.json` (or `imprint cron --once` will use it). The ladder can try `fetch-bootstrap` for browser-minted state, `cdp-replay` for multi-step state-changing anti-bot flows (API requests issued inside a live trusted Chrome), and `stealth-fetch` for bot-defense tokens before falling back to DOM replay.

2. **Probe and cache the working backend:**
   ```bash
   imprint probe-backends <site> --tool <toolName>
   imprint probe-backends <site> --all
   ```
   This writes `backends.json`; cron + MCP read it at startup. On a single-tool site, `--tool` is optional; on multi-tool sites, `--all` refreshes every generated tool, and `--out ~/.imprint/<site>/<toolName>/backends.json` also selects one target. Successful probes are ranked by observed runtime, with backends slower than `IMPRINT_BACKEND_PREFERRED_MAX_MS` (default 90000) kept as lower-priority fallbacks.

3. **Compile a playbook fallback:**
   ```bash
   imprint compile-playbook ~/.imprint/<site>/sessions/<ts>.redacted.json
   ```
With a `playbook.yaml` present, the `auto` ladder escalates to a real DOM walk when API replay modes cannot satisfy the workflow.

## Teach stalls or a check fails

The foreground terminal shows which focused tool is being planned, compiled, or
checked. The fresh run directory in the final summary retains the current plan,
artifact history, host errors, and factual check receipts.

Contract, replay, live, and producer-consumer checks are separate facts. A
failure should identify the request or comparison that failed, including what
was not checked afterward. Replay for a browser playbook is not applicable and
does not count as a failure.

`REQUEST COMPLETED` means only that a backend returned a transport response; it
does not mean the response contained the promised records. The researcher or
verifier performs that semantic check separately. During pre-planning research,
`PARTIAL` means the researcher preserved a tested working subset but named a
gap still required by the selected MVP or a producer-consumer edge. Optional
parameter breadth waits for the later best-effort pass. After all tools finish
their first pass, the master can return the required gap to the same researcher
with selected sibling results and other relevant requests.

The master receives those facts and can change the affected tool plan, artifact,
parameters, dependencies, or replay strategy. Only that tool and its consumers
become stale. The run cannot complete until every planned tool has current
passing checks and the independent completion reviewer approves the evidence.

When a normal API replay cannot reproduce a request assembled inside the page,
the agent can keep the operation in `workflow.json` by using an explicit
`mode: "navigate"` request with `navigation.networkResponse`. The matcher
selects a URL substring observed in the recording and can narrow by method,
resource type, and occurrence. Occurrence follows request-start order within
that navigation. It returns the matching live background response
body to the parser. Keep the request origins separate: top-level
`recordingRequestSeq` identifies the outgoing document navigation, while
`networkResponse.recordingResponseRequestSeq` identifies the recorded
background response used for offline parsing and chaining. A request transform
cannot return or change the matcher;
it does not make the runtime decide which response is meaningful. If no match
arrives, the error reports the exact matcher and timeout.

## Auth compile: an expected user action never arrives

Do not infer delivery from the action name or a successful HTTP transport. Inspect the `run_verification` result and the declared evidence. A failed credential or challenge request reports its concrete HTTP status and response preview. A successful pause is accepted only when every capture listed in `outcome.evidence` exists.

Use the recording to revise the action program:

- Add any recorded page navigation needed before the request as an ordinary `mode: "navigate"` step with recording-grounded completion criteria.
- Capture state from the actual producing response and list only state needed by the next action in `outcome.carry`.
- Model repeated status requests with `repeat.until`, an exact recorded terminal capture, and explicit interval/attempt bounds.
- Choose `onError: "continue"` only when the recording proves that request is non-load-bearing.
- Re-run the specific action after changing the artifact. Imprint does not inject a bootstrap page, assume a challenge was delivered, or classify the failure as a particular authentication channel.
## "STATE_MISSING"

The workflow referenced a required `${state.NAME}` or cookie value that was not available yet. The error includes a `capability` that determines the fix:

- `ordinary_http` — an earlier safe/idempotent HTTP request was expected to produce the value. Check `requests[].captures`, request order, and whether the producer request still sets the cookie/header/body field.
- `browser_bootstrap` — add or fix `workflow.bootstrap`; `fetch-bootstrap` should be able to mint this state before API replay.
- `stealth_bootstrap` — `stealth-fetch` supplies bot-defense cookies/headers to API replay and can project supported bootstrap captures (`cookie`, `html_regex`, `response_header`) from the same stealth session. Use `replayBackend: "auto"` so the ladder can still escalate to `fetch-bootstrap`/`cdp-replay` or the `playbook` fallback when the workflow needs unsupported DOM/storage state. If neither resolves the missing state, regenerate the workflow from a recording that includes the state-producing interaction.
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

## Authenticate action programs

Authentication runs through the compiled `workflow.json` action program in one persistent local browser. It never falls back to `playbook.yaml`.

- Call the action named by `authConfig.entry`, or pass another declared action.
- When the result is `ACTION_REQUIRED`, follow `nextAction` and pass the returned opaque `continuation` token back unchanged.
- Supply only the scalar parameters listed by the selected action.
- A request repeats only when its step declares `repeat.until`, `intervalMs`, and `maxAttempts`.
- A failed action replays from its first declared step. Split non-repeatable work into a preceding action and carry only the state the next action needs.
- Authentication is complete only when an action with `outcome.type: "success"` returns `ok: true`.
- If the recording changes, re-teach so the compile agent can derive a new action graph from the new assets.

## "Auth tool was planned but no credentials are available"

Before compiling the auth tool, teach needs the login credentials. It uses, in order: credentials extracted from the recording, then the credential store, then — when interactive — it **prompts you** for exactly the credentials the detection LLM identified for this login (`authTool.credentialNames`), pre-filling the username it saw in the recording. This warning means all of those came up empty.

The recording may legitimately omit a credential because Imprint masks sensitive fields and some browser submissions have no request body available to the recorder. Run interactively and enter the missing value at the prompt, or set it up front and start a fresh teach:

```
imprint credential set <site> username
imprint credential set <site> password
imprint teach <site> --agent codex
```

Inputs requested by a later auth action are not stored credentials; the compile agent requests them at the appropriate verification checkpoint. Already-stored credentials are reused automatically on later runs.

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

**Fix:** re-run `imprint generate`. If it persists, split the recording into smaller workflows (or, for `compile-playbook`, retry with `--no-shrink`).

## "Replay is slow or failing"

Replay is one of the factual checks used by the fresh master run. It is not a
separate resumable phase and cannot be hidden with a skip flag. The terminal
shows the failed comparison; fix the recording, prompt, or compiler and start a
new teach run.

## "Compile is slow or looks stuck"

The timeout covers the foreground teach run and defaults to 12 hours. A large
recording can require many focused planner, compiler, check, advice, and repair
calls; override it only when you intentionally want another run-wide deadline:

~~~bash
imprint teach <site> --timeout 12h
~~~

Provider capacity and overload errors retry automatically with capped
exponential backoff and jitter. They do not become artifact failures. Invalid
requests, authentication errors, schema errors, cancellation, and the run-wide
deadline are terminal instead of being retried forever.

For deeper debugging, enable Phoenix tracing and inspect the focused role or
tool call that is spending time:

~~~bash
IMPRINT_TRACE=1 IMPRINT_TRACE_BATCH=false PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006 imprint teach <site> --from-session ~/.imprint/<site>/sessions/<ts>.json
~~~

Using --from-session still starts a fresh run; it does not resume prior work.

## Re-running `imprint teach`

Every teach is a fresh foreground run. It uses the current recording, prompt,
and code, discovers the complete tool set again, and builds every tool in the
master's dependency-ordered waves. Old failed runs remain diagnostic evidence
but cannot be resumed.

After changing code or prompts, simply start a new run:

```bash
imprint teach <site> --agent codex
```

There are no phase-window, primary-tool, or partial-selection flags.

## Reading a fresh teach run

The command prints the fresh run directory in its terminal summary. Use that
directory, together with the Phoenix trace when enabled, to find the focused
job that is slow or failed.

A run records the master plan and build waves, artifact history, and factual
contract, replay, live, and producer-consumer receipts. A failed receipt should
name the exact request or comparison that failed. A browser playbook has no API
replay check, so replay is reported as not applicable rather than failed.

The foreground command never returns while tools are still active. Its final
status is completed, blocked, failed, cancelled, or provider unavailable. A
non-completed result exits non-zero, and no intended tool is silently treated
as ready.

If the master revises a tool, only that tool and consumers which depend on it
lose their current verification. The next attempt recompiles or rechecks those
tools in the master-authored wave order. Independent verified tools do not need
to be rebuilt.

## `imprint audit` — scoring a site's generated tools

`imprint audit <site>` exercises every generated tool against the site's real MCP server and prints a deterministic score:

```bash
imprint audit <site>                 # gate at the 95% default
imprint audit <site> --min-score 90  # relax the threshold
imprint audit <site> --json          # full machine-readable report to stdout
```

It prints `PASS` / `FAIL` / `INCONCLUSIVE` / `TIMEOUT` and writes the full report (score + the raw auditor verdicts, plus token/cost usage) to `~/.imprint/<site>/.audit-report.json`. **Exit codes distinguish the cases:** `0` pass, `1` fail (genuine logic bugs), `2` inconclusive, `3` timeout. The summary also reports the auditor's approximate cost.

Workflows declared `effect: "irreversible"` are listed under `skippedIrreversible` and are never connected to the audit agent. This is a safety exclusion, not a passing live result; these tools retain `verified:false` with `verifyNote: "waived-safety"` because compilation uses recording and offline evidence only.

**The audit tests functionality, not just "did it return."** For every tool it makes a baseline call (graded `correct`/`tool_broken`), then **differentially tests every advertised parameter**: it re-runs the baseline with only that one parameter changed to a value that should alter the result, and classifies it `works` / `no_op` / `broken` / `untestable`. `works` counts toward the score; **`no_op` (the parameter is accepted but changes nothing) and `broken` (it corrupts/empties the result) count against it** — an inert parameter is a defect, not a free pass. `untestable` (an opaque enum with no constructible value, or a state-changing/bot-defended tool that can't be safely probed) is surfaced but not scored. The summary prints a per-tool `params: X/Y working` line and lists every non-working parameter with the auditor's evidence; the full per-parameter verdicts and an `untestableParams` list are persisted in `.audit-report.json`. Read-type tools get the full differential pass; state-changing/bot-defended tools get the single baseline call and their parameters are marked `untestable`.

Interpreting the verdict:

- **FAIL** — the score is below the threshold. Two things drag it down: `tool_broken` invocations (a tool whose core result is wrong) and `no_op`/`broken` **parameters** (advertised but inert or corrupting). Open `.audit-report.json` and read the `reason` on each `tool_broken` invocation and each non-`works` entry in a tool's `parameters` array, or open the `audit.session` span in Phoenix (`imprint.audit.{score,correct,broken,params_working,params_no_op,params_broken,params_untestable,verdict}`). Fix the tool (regenerate, or correct its parser/workflow so the parameter actually applies) and re-audit.
- **INCONCLUSIVE** — there were **no gradeable invocations**: every call was classified `infra` (anti-bot / rate-limit / 403/429 / network / timeout). This is **not a code failure** — the site blocked the auditor. Re-run (often from a different network), or accept that the site can't be audited automatically. Spot-check the `infra` verdicts in the trace to make sure a real bug wasn't mislabeled.
- **TIMEOUT** — the auditor was killed at the wall-clock deadline before producing a report (`imprint.audit.timed_out=true` on the span). A cut-off run is never a trustworthy pass, so it's flagged distinctly rather than degrading to a silent inconclusive. The auditor's transcript is saved to `~/.imprint/<site>/.audit-transcript.txt` — read it to see where it stalled (e.g. retrying a rate-limited tool). Re-run with a longer `--timeout` (e.g. `--timeout 45m`), or fix whatever is making the run hang.
- **PASS** — `score ≥ min-score` AND at least `max(2, gradeableTools)` gradeable invocations, where `gradeableTools` counts only tools that produced ≥1 gradeable call. The floor ensures the number is backed by enough signal — at least one verified call per gradeable tool. A tool the auditor could never exercise (e.g. it needs an opaque token it cannot synthesize) is listed under `ungradeableTools` in the report and no longer inflates the floor. (The floor is one gradeable call per gradeable tool, not two: the auditor often burns a slot per tool on `bad_params`/`infra`, so demanding two clean reads per tool false-failed otherwise-perfect runs.)

Note `infra` and `bad_params` (the auditor's own parameter mistakes) are excluded from the score denominator, so a blocked or misused tool is never counted as a code bug.

## A compiled tool exposes a parameter flagged `verified:false`

This is expected when the gap is explicit, not a claim that the parameter passed live verification. The compile gate reviews each exposed parameter. A passing `param:<name>` integration test records `verified:true`; when a live differential cannot safely or meaningfully run — the site's anti-bot defense would punish repeated calls (`verifyNote: waived-bot`/`waived-infra`), the recording has no discriminating value to test with (`annotated`), or a producer-sourced token's producer was unavailable (`waived-chain`) — a recording-grounded parameter can ship with `verified:false` and a `verifyNote` in `workflow.json`. The semantic verifier may approve that tool as `approved_with_gaps` only if the core task succeeds and the gap is genuinely untestable. A parameter shown to be a no-op or broken is not such a gap: the compiler must repair it or remove it from the public contract and explain the omission in `workflow.limitations`. Audit is told to probe unverified parameters especially. To see what shipped unverified, grep the tool's `workflow.json` for `"verified": false`.

## Compile blocked: "producer-sourced token param(s) lack a CHAINED `param:<name>` test"

A tool whose parameter is an opaque token/id minted by a *sibling* tool (e.g. `get_hotel_offers(hotel_id)` ← `search_hotels`) must verify that parameter with a **fresh** token from the producer, not the recorded constant. The gate blocks compile when the consumer's `param:<name>` test only reuses the recorded value (it can't prove a real token works). The fix is almost always on the **producer**: make its parser emit the field in the *full shape* the consumer needs (e.g. a `<ftid>|<area>|<name>|<token>` composite) rather than a bare fragment, so the consumer's chained test — which calls `../<sourceTool>/workflow.json`, reads that field, and feeds it back — gets a working value. If the chained test runs but the consumer returns empty, the producer/consumer field contract is genuinely broken; fix the producer's emitted field (or how the consumer unpacks it). If the producer is blocked by anti-bot at compile time, the param waives to `verified:false` reason `waived-chain` instead of blocking.

## The provider is unavailable or refuses a request

Capacity, overload, and temporary provider failures retry automatically with
backoff until the provider recovers, the user cancels, or the run deadline
expires. If the terminal reports provider unavailable, start a fresh teach after
the provider recovers.

A deterministic refusal, authentication failure, authorization failure, schema
error, or invalid request is not retried indefinitely. Inspect the top-level host
error in the terminal and fresh run record, correct the cause, and start a new
teach. Old run state is diagnostic evidence only.

## "MCP tools panel is empty in Claude Desktop"

Start with Imprint's local audit:

```bash
imprint mcp status
```

It reports external registrations, generated tools under `IMPRINT_HOME`, missing
session recordings, and stale MCP entries that point at sites with no complete
generated tool. It never reports or deletes raw recordings or old teach run
records; those remain diagnostic source material.

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

If `imprint mcp status --json` reports `stale-backends` or `invalid-backends`, the MCP registration itself is not the problem. The server can connect and list tools, but runtime will ignore that tool's `backends.json` and fall back to the default ladder until you run the reported `imprint probe-backends ...` command. That is especially visible on bot-protected sites where `fetch-bootstrap` or a cold `cdp-replay` can consume most of an MCP client's tool-call timeout before the known-good backend runs. Fresh CDP probes record both cold and warm timings; cold-too-slow CDP is kept behind cold-safe backends in durable cache order even if its warm pool is fast.

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
