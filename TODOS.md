# Imprint TODOS

Items deferred from the v0.1 design + eng review. Not blocking the 2-week sprint. Address these between launch (day 14) and "v0.2" if/when interest justifies it.

## v0.2 candidates (post-sprint, in priority order)

### 1. Auth refresh: detect cookie expiry and re-prompt without manual intervention

**What:** When the cron detects `AUTH_EXPIRED`, currently it just Pushover-notifies the user to run `imprint login <site>`. v0.2: detect via background process and trigger an auth refresh flow that emails or push-notifies the user with a one-click link that opens Chromium for re-login.

**Why:** Cookie expiry is the #1 reason the cron will silently degrade over 30+ days. For portfolio purposes, manual reauth is fine; for any path-to-product, this is table stakes.

**Effort:** human ~1 week / CC ~1 day. Pros: turns "demo bot" into "product." Cons: every site has different login flows, this is a long tail of work.

### 2. Multi-leg flight handling for Southwest

**What:** Southwest seat modification works for one-leg flights in v0.1. Multi-leg requires looping the seat-modification request per segment.

**Why:** The viral demo will get questions about multi-leg. Users will try it.

**Effort:** human ~4hr / CC ~30min. Pros: covers the obvious follow-up. Cons: scope creep within a portfolio piece.

### 3. WebSocket / Server-Sent Events capture

**What:** v0.1 captures HTTP requests via CDP `Network.*` events. SPAs increasingly rely on WebSocket / SSE / GraphQL subscriptions. Imprint should capture these via `Network.webSocketFrameSent`, `Network.webSocketFrameReceived`, and `Network.eventSourceMessageReceived`.

**Why:** Without this, modern apps that push state via WebSocket will appear "broken" — recorder captures nothing useful.

**Effort:** human ~1 week / CC ~1 day. Pros: dramatically expands site coverage. Cons: codegen for stateful protocols is genuinely hard.

### 4. Lesson health monitoring

**What:** Periodic background replay of recorded workflows against the live site, detect breakage, flag in dashboard. Original Imprint design doc had this as a core feature; v0.1 cuts it for scope.

**Why:** Without health monitoring, users discover their automations are broken when they need them most.

**Effort:** human ~2 weeks / CC ~3 days. Pros: trust-building feature for any product path. Cons: requires dashboard, requires hosting, requires alert infra.

### 5. Whisper-based audio narration

**What:** v0.1 uses text narration during recording. Whisper would let users speak narration ("I'm changing my seat to a window") instead of typing.

**Why:** "Watch me speak to it" is the magical demo moment the second-opinion subagent flagged.

**Effort:** human ~3 days / CC ~4hr. Pros: stronger demo. Cons: Whisper API latency + accuracy tuning.

### 6. Tax prep showdown (separate February 2027 sprint)

**What:** The "AI vs CPA on FreeTaxUSA" demo. Captured here so it's not lost.

**Why:** Highest viral hook of all the demo ideas. Wrong timing for April 2026 sprint (tax season just ended). Right timing: February 2027.

**Effort:** human ~2 weeks / CC ~1 week. Pros: career-defining viral moment if it works. Cons: legal/financial liability if anyone takes the output seriously.

### 7. Replay verification UI

**What:** Original Imprint thesis: Replay mode where the agent shows you what it learned by executing the workflow while you watch, before going autonomous. v0.1 cuts this for scope.

**Why:** The "trust through verification" loop was the wedge in the original startup-mode design. Useful if Imprint ever pivots back to product.

**Effort:** human ~2 weeks / CC ~3 days.

## Ops / housekeeping

### 8. Hetzner cron host setup (day 15+)

**What:** Move Southwest cron from local laptop to a Hetzner CX22 ($5/mo).

**Why:** During the 60-day hiring window, the cron must keep running so it remains a live demo. Laptop sleeps, network changes break it.

**Effort:** human ~1hr / CC ~30min. Pre-budget: $30 for 6 months prepay.

### 9. Repo archive note (day 90)

**What:** Add a banner to the README on day 90 if no actively-being-considered job offer requires the demo to remain live: "This is an archived showcase from a 2-week sprint in April 2026. The cron has been retired."

**Why:** Honest. Avoids someone discovering the repo in 2027 expecting a maintained project.

### 10. Discover & Go as a 4th demo (post-launch)

**What:** Ship a Discover & Go bot as a post-v0.1 demo. Captures the user's real personal pain: California library free passes that open at midnight and sell out in seconds. Polls at midnight, books the configured pass type, Pushover-notifies on success.

**Why:** Used as the dev test target during the v0.1 sprint (days 2-7), so by launch we already have a working capture/generate/emit pipeline against D&G's real auth and traffic. Shipping it as a 4th demo would only require the cron + Pushover wiring (~3-4 hours) since codegen is already validated. Tweet hook: "I taught Claude to use my library card. Got us into the Exploratorium tomorrow at 12:00:03 AM."

**Why not in v0.1:** User chose conservative scope. D&G is a stretch goal post-launch.

**Effort:** human ~1 day / CC ~3hr post-sprint. Pros: heartwarming narrative, daily content stream ("got us into the SF Zoo today"), real personal value. Cons: slight social-cost question (free scarce resource). User should set their own moral cadence: 1-2 outings/month is fine, aggressive nightly sniping changes the vibe.

### 12. ~~Finish MCP stdio server~~ ✅ done (Day 8)

**Resolution:** Built directly on the official `@modelcontextprotocol/sdk` (stdio + Streamable HTTP transports). Both transports verified end-to-end with `scripts/mcp-client-test.ts` and `scripts/mcp-http-client-test.ts`: initialize → tools/list → tools/call against a network-free echo fixture, and tool registration confirmed against the real `book_discoverandgo_museum_pass`.

**Two real bugs, neither was stdin framing:**
1. The skeleton imported `bun-stdin-park.ts`, which called `Bun.stdin.stream()` at module-load. That mutates `process.stdin` such that the SDK's `'data'` listener never fires. Removing the file restored the handshake.
2. After the handshake worked, `cli.ts` was calling `process.exit(0)` immediately when `runMcpServer` resolved — the SDK's `transport.start()` only attaches stdin listeners and returns, so the process exited before any client request arrived. Fixed by blocking on `transport.onclose` / SIGINT inside `runStdio`.

**Pivot away from fastmcp:** First attempt used `fastmcp` for the convenience surface, but under Bun (a) `tools/call` crashed with "Connection closed" on any `await` in the handler and (b) HTTP transport silently failed to bind a port. Raw SDK is more reliable and arguably more standard.

Claude Desktop wire-up is documented in the README.

### 13. ~~Open-source license audit~~ ✅ done (Day 9)

**Result:** 128 production deps, all permissive. Distribution: MIT 108, ISC 8, Apache-2.0 7, BSD-3-Clause 3, BSD-2-Clause 2. Zero AGPL/GPL/LGPL/MPL/EPL. Compatible with the MIT license on this repo.

**Reproduce:** `npx --yes license-checker --production --summary`

### 14. ~~Multi-backend ladder + record-time probe~~ ✅ done (Day 9)

**Resolution:** Replay backends in increasing cost, walked by the ladder: `fetch` (~200ms, plain Node fetch) → `fetch-bootstrap` (Chromium bootstrap mints cookies/CSRF/state, then native fetch replay) → `cdp-replay` (workflow's API requests run inside a live trusted Chrome so a protected POST re-validates its `_abck` between calls — the only rung that sustains a sequence of multi-step state-changing anti-bot POSTs; warm CDP pool reuses one Chrome at ~2–5s vs ~33s cold) → `stealth-fetch` (~12s bootstrap + ~1s/call, Playwright-minted Akamai sensor tokens used by native fetch — derived from PR #1) → `playbook` (~9.4s/call, full Playwright + stealth + DOM walk). `replayBackend: "auto"` walks them in order, escalating only on FORBIDDEN. (Day 9 shipped fetch → stealth-fetch → playbook; `fetch-bootstrap` and `cdp-replay` were spliced in later.)

`imprint probe-backends <site>` runs the ladder once at record time and writes `examples/<site>/<toolName>/backends.json` with the ranked order. cron + MCP read this and skip futile rungs every tick — without the probe, an "auto" Southwest tick wastes ~200ms on the fetch attempt that always 403s. Runtime ladder remains the fallback if the cached preferred backend stops working between probes.

Verified end-to-end against Southwest: probe identifies `stealth-fetch → playbook` as preferred; cron tick now logs `trying stealth-fetch…` directly (no fetch attempt); returns real fare data in ~10s.

### 15. Future stealth options if Akamai ratchets up

**What:** If `stealth-fetch` starts getting blocked too (Akamai updates sensor JS / TLS-fingerprint detection / device-fingerprint-based heuristics), the ladder's playbook rung still works (real Chromium runs the live JS). Beyond that, we'd need:

1. **`rebrowser-patches`** — patches Chrome itself to defeat the deeper headless-detection markers. ~70% success against modern Akamai per public reports.
2. **Residential-IP proxy rotation** — Akamai also weighs IP reputation. Datacenter IPs flagged faster than residential.
3. **A paid stealth API** — Bright Data Web Unlocker, ScrapingBee, ZenRows. $30-300/mo. Would slot in as an additional backend in the ladder via the existing `BackendContext` + `runWithLadder` extension point.

**Why not now:** Current ladder works. The probe writes empirical results, so when a backend stops working, the operator sees it in the next probe + can pick the next-cheapest known-working option. v0.2 work, only if launch reveals real demand.

**Why NOT a long-lived StealthFetch daemon:** Sensor tokens have a TTL (minutes to hours) regardless of process lifetime. Sharing a StealthFetch instance across cron processes via IPC adds significant complexity (daemon lifecycle, token serialization, IPC protocol) without solving expiry — every process would still need re-bootstrap on token refresh. The current per-process cache is the right tradeoff for the cron use case (one process per schedule, tokens last across many ticks).
