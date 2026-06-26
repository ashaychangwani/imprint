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

## Auth compile: no OTP/push arrives, or `verify initiate FAILED (... HTTP 403)`

The credential POST is being **edge-blocked by anti-bot before it reaches the 2FA step**, so the site never sends a code or push. The teach spinner shows this inline, e.g. `Auth compile: turn 30 — verify initiate FAILED (FORBIDDEN HTTP 403); attempt 2/5 — agent retrying`. The cause is almost always that the live verifier (which runs the login inside `cdp-replay`'s real browser) navigated a non-login page, so the login page's anti-bot sensor never ran and its token (e.g. Akamai `_abck`) was never validated for the login Origin.

Fix: the auth `workflow.json` needs a top-level **`bootstrap.url` pointing at the credential-entry page** — the page the recording navigated to right before the credential POST:

```json
{ "toolKind": "authenticate", "bootstrap": { "url": "https://www.example.com/login", "waitUntil": "domcontentloaded", "waitMs": 4000 }, "requests": [ ... ] }
```

The compile agent sets this automatically, and if it doesn't the orchestrator derives it from the recording (the credential POST's `Referer`, the Document hosting the login form, or the last document before the POST). If you're hand-editing a workflow and hit this, add the block yourself. A 403 here is **not** rate-limiting — a cool-off won't clear it.

This failure does **not** consume the user-visible 2FA-challenge budget (`IMPRINT_AUTH_MAX_INITIATE`, default 2 — only initiates that actually deliver a prompt count). A separate attempt cap (`IMPRINT_AUTH_MAX_INITIATE_ATTEMPTS`, default 5) bounds repeated pre-challenge failures; once it's hit the agent gives up so a fresh run with corrected artifacts can try again.

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

## Authenticate tool that logs in through a real browser (`playbook` rung)

Some sites' logins can't be replayed as API requests — the credential POST body is computed by the page's own JS per session (encrypted credential blobs, per-load nonces). For these the compile agent emits a **`playbook.yaml`** alongside `workflow.json`: the recorded login DOM steps (type username/password, submit). The login then runs on the ladder's `playbook` rung — a real stealth browser that lets the page mint a fresh valid request — exactly like any other tool that needs the playbook backend. There is no separate login backend or `loginBackend` field.

- **It needs the credentials in the store.** The playbook fills the `${credential.*}` fields it references (typically `username` + `password`). Set them with `imprint credential set <site>`.
- **Wrong landing fails honestly.** The playbook's success marker is grounded in the recording; if a site routes an automated login to an account-setup/enrollment page instead of the recorded authenticated page, the tool reports failure rather than a false success.
- **2FA is one of two structural shapes** (`twoFactorType` = `push` or `otp` — the delivery channel doesn't matter; SMS, email, and authenticator-app codes are all `otp`).
- **Push.** `authenticate_<site>` with `action: initiate` performs the login, then `action: complete` (after you approve the push) finishes; polling is bounded by `maxPollAttempts × pollIntervalMs` and ends on a recording-grounded marker (or a fresh session cookie). Set `IMPRINT_AUTH_POLL_ATTEMPTS=<n>` to cap the poll (e.g. an unattended `imprint teach` attempt uses a short bound so it fails fast).
- **OTP (any out-of-band code) is two calls.** `action: initiate` reaches the code step and returns `AWAITING_2FA` (with a `twoFactorContext` object if the login returned a token to chain); call again with `action: submit_otp`, `otp_code: "123456"`, **and** that same `twoFactorContext` passed back verbatim. A login that reaches the OTP screen on the **playbook** rung surfaces as `AWAITING_2FA` too (the ladder reshapes the playbook's 2FA-challenge success into the same signal).
- **Session reuse across the two calls.** After the login the browser's session cookies **and per-origin `localStorage`** are persisted to the credential store; the `submit_otp`/`complete` call rehydrates them so the second stateless call resumes the session.
- **Unattended `imprint teach` *attempts* the 2FA.** Even with `--no-interactive` (no human to supply a code), teach drives the completion: a placeholder `otp_code` (`000000`) for `otp`, a bounded poll for `push`. It almost always fails without a live second factor — that's expected and reported honestly. Reaching *and* attempting the 2FA is the bar, not completing it.
- **Still not supported:** a browser-minted login whose OTP must be typed into the *same live page* holding **non-serializable in-page JS state** (live WebCrypto handles, closures) — cookies + `localStorage` round-trip, but the original page's JS heap does not. Such a tool is still *attempted* (and fails honestly); the compile agent does not give up over it, because reaching the 2FA challenge is the compile-time goal.
- **Orphan Chrome?** Playbook browsers close at the end of each run. If a run was killed mid-flight, check `pgrep -fl "Chrome.*--headless"` and kill leftovers.
- If a site moves its login form, re-teach so the agent re-records the steps.

## "Auth tool was planned but no credentials are available — skipping auth compile"

Before compiling the auth tool, teach needs the login credentials. It uses, in order: credentials extracted from the recording, then the credential store, then — when interactive — it **prompts you** for exactly the credentials the detection LLM identified for this login (`authTool.credentialNames`), pre-filling the username it saw in the recording. This warning means all of those came up empty.

The usual cause is a **hosted/redirect login (Auth0, Okta, …)**: the password is submitted as a full-page navigation (no XHR body to extract) and Imprint masks password fields at capture time, so the recording legitimately has no password to recover — only the username. Run interactively and enter the password at the prompt, or set it up front and resume:

```
imprint credential set <site> username
imprint credential set <site> password
imprint teach <site> --from-step generate
```

The live one-time **2FA code is never prompted for here** — it's deliberately excluded from `credentialNames` and entered during verification (see the playbook-rung section above). Already-stored credentials are reused automatically on later runs.

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

## Re-running only specific phases of `imprint teach`

A teach run is a chain of phases, persisted as checkpoints in `~/.imprint/<site>/.teach-state.json`:

```
record → redact → replay-and-diff → triage → detect-candidates → plan-prereqs → generate → compile-playbook → emit → register
```

To iterate on one phase without re-running the whole chain, use the phase-window flags:

```bash
imprint teach <site> --from-step <step>     # start at <step>, run to the end (reuses earlier phases' outputs)
imprint teach <site> --to-step <step>        # stop after <step>
imprint teach <site> --only <step>           # run exactly one phase (= --from-step X --to-step X)
```

Examples:

```bash
imprint teach google-flights --only detect-candidates    # just re-detect candidate tools
imprint teach google-flights --only plan-prereqs          # just rebuild shared modules (multi-tool sites)
imprint teach google-flights --to-step triage             # process up to triage, then stop
imprint teach google-flights --from-step generate          # recompile the tools from the persisted plan
```

Guard: `--from-step <step>` is **only allowed if a prior run reached or crossed that point** — every earlier phase must already be complete in `.teach-state.json`, otherwise the run errors with the furthest step it actually reached (starting mid-chain without the earlier outputs would be missing dependencies like the redacted/triaged session, classifications, or build plan). It's not combinable with `--from-session` (a separate fresh-input entry mode); use `--to-step` (which must be `redact` or later, since `--from-session` enters the chain at `redact`) with `--from-session` to cap phases on a fresh recording.

Notes: the `replay-and-diff → triage → detect-candidates` analysis runs as one atomic block (its sub-steps share a parallel run), so stopping at any of them completes through detect-candidates. Because that block is atomic, `--only replay-and-diff` (and `--only triage` / `--only detect-candidates`) always run through detect-candidates; pairing one with `--skip-replay` reuses the prior `.classifications.json` instead of re-replaying, rather than being a no-op. The per-tool compile (`generate → compile-playbook → emit`) likewise runs as one atomic unit per tool: a `--to-step`/`--only` landing inside it runs the **whole** compile (its summary reports `→ emit`) and stops before `register` (platform integration) rather than mid-tool. `--from-step` *can* still resume mid-compile — each phase loads the prior phase's artifact from disk, so `--from-step compile-playbook` is valid.

## "Build plan skipped" — the shared-module planner timed out

In a multi-tool run the planning spinner steps through `Planning shared modules` → `calling planner LLM` as it works. If the single planner call can't finish in time, the spinner stops with `Build plan skipped.` followed by a warning line:

```
▲  Build planning failed or timed out (build planner exceeded 600s timeout) — compiling tools independently (no shared modules).
```

This is **non-fatal**: every tool still compiles, just without shared `_shared/*` modules (each inlines the logic). The planner is a single LLM call bounded at 600s (10 minutes) — it analyzes the whole merged recording across all tools, so it gets the longer cap; the per-tool plan (below) is the 5-minute one.

To see *why* it was slow, turn on Phoenix tracing (above): the `teach.plan_prereqs` span carries `imprint.plan.payload_chars`, `imprint.plan.ephemeral_count`, `imprint.plan.request_count`, and — on timeout — `imprint.plan.timed_out=true` with `imprint.plan.llm_elapsed_ms`. These are set *before* the call, so even a timed-out session exports a useful (errored) span; a large **ephemeral value count** or **payload KB** is the usual cause. (The same input-size summary also flashes in the spinner as `planning N tool(s): … KB payload …` while the planner runs.) To skip shared-module planning entirely and compile every tool independently, set `IMPRINT_NO_BUILD_PLAN=1`.

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

It prints `PASS` / `FAIL` / `INCONCLUSIVE` / `TIMEOUT` and writes the full report (score + the raw auditor verdicts, plus token/cost usage) to `~/.imprint/<site>/.audit-report.json`. **Exit codes distinguish the cases:** `0` pass, `1` fail (genuine logic bugs), `2` inconclusive, `3` timeout. The summary also reports the auditor's approximate cost.

**The audit tests functionality, not just "did it return."** For every tool it makes a baseline call (graded `correct`/`tool_broken`), then **differentially tests every advertised parameter**: it re-runs the baseline with only that one parameter changed to a value that should alter the result, and classifies it `works` / `no_op` / `broken` / `untestable`. `works` counts toward the score; **`no_op` (the parameter is accepted but changes nothing) and `broken` (it corrupts/empties the result) count against it** — an inert parameter is a defect, not a free pass. `untestable` (an opaque enum with no constructible value, or a state-changing/bot-defended tool that can't be safely probed) is surfaced but not scored. The summary prints a per-tool `params: X/Y working` line and lists every non-working parameter with the auditor's evidence; the full per-parameter verdicts and an `untestableParams` list are persisted in `.audit-report.json`. Read-type tools get the full differential pass; state-changing/bot-defended tools get the single baseline call and their parameters are marked `untestable`.

Interpreting the verdict:

- **FAIL** — the score is below the threshold. Two things drag it down: `tool_broken` invocations (a tool whose core result is wrong) and `no_op`/`broken` **parameters** (advertised but inert or corrupting). Open `.audit-report.json` and read the `reason` on each `tool_broken` invocation and each non-`works` entry in a tool's `parameters` array, or open the `audit.session` span in Phoenix (`imprint.audit.{score,correct,broken,params_working,params_no_op,params_broken,params_untestable,verdict}`). Fix the tool (regenerate, or correct its parser/workflow so the parameter actually applies) and re-audit.
- **INCONCLUSIVE** — there were **no gradeable invocations**: every call was classified `infra` (anti-bot / rate-limit / 403/429 / network / timeout). This is **not a code failure** — the site blocked the auditor. Re-run (often from a different network), or accept that the site can't be audited automatically. Spot-check the `infra` verdicts in the trace to make sure a real bug wasn't mislabeled.
- **TIMEOUT** — the auditor was killed at the wall-clock deadline before producing a report (`imprint.audit.timed_out=true` on the span). A cut-off run is never a trustworthy pass, so it's flagged distinctly rather than degrading to a silent inconclusive. The auditor's transcript is saved to `~/.imprint/<site>/.audit-transcript.txt` — read it to see where it stalled (e.g. retrying a rate-limited tool). Re-run with a longer `--timeout` (e.g. `--timeout 45m`), or fix whatever is making the run hang.
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

It reports external registrations, generated tools under `IMPRINT_HOME`, incomplete `teach` checkpoints, missing session recordings, and stale MCP entries that point at sites with no complete generated tool. It never reports or deletes raw recordings — those are your source of truth.

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
