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

### 10. Open-source license audit

**What:** Confirm no transitive deps under copyleft licenses (AGPL/GPL) that would conflict with the MIT license.

**Why:** Hiring managers occasionally ask about this. Bun + chrome-remote-interface + MCP SDK + Anthropic SDK + node-cron + Pushover SDK should all be Apache/MIT.

**Effort:** 30min with `bun pm licenses` (or equivalent).
