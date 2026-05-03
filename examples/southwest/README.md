# Southwest fare-drop watcher ✓ working

Recorded session: `sessions/2026-05-03T09-30-16-437Z.{jsonl,json}`
(SJC → SAN one-way for 2026-06-20, captured via `imprint record southwest`).

## Status: end-to-end working via the auto ladder

```bash
imprint cron southwest --once
# [imprint cron] backends.json: probed 2026-05-03T22:23Z, preferred order: stealth-fetch → playbook
# [imprint cron] replayBackend: auto (ladder: stealth-fetch → playbook)
# [imprint backend] trying stealth-fetch…
# [imprint stealth] bootstrapping…
# [imprint stealth] bootstrapped in ~5s — 19 cookies, 6 sensor headers
# [imprint backend] stealth-fetch: OK in ~10s
# [imprint cron]   OK in ~14s via stealth-fetch: {…fareSummary…WGA $108.40…}
```

Real Southwest data, real $108.40 lowest WGA fare. Bootstrap pays a one-time ~5s; subsequent ticks within the same process reuse the StealthFetch session.

## How it works (current architecture)

1. **Probe at record time** — `imprint probe-backends southwest` ran the full ladder and wrote `backends.json` with the empirically-cheapest known-working order: `stealth-fetch → playbook`. The fetch rung is skipped at runtime because the probe established it always 403s.
2. **stealth-fetch backend** — bootstraps Chromium via `playwright-extra` + `puppeteer-extra-plugin-stealth` to mint Akamai's `_abck` cookie + the `EE30zvQLWf-*` sensor headers, then makes the captured workflow's POST to `/api/air-booking/v1/.../shopping` via native `fetch` augmented with those tokens. The wrapper auto-injects a fresh `X-User-Experience-ID` UUID per call (Southwest rejects stale ones).
3. **`notifyWhen: price_below`** — extracts `prices[]` from the playbook-shaped result OR `data.searchResults.airProducts[].lowestFare.value` from the API-shaped result; pushes via Pushover/ntfy when the lowest is under the threshold.
4. **Playbook is the fallback** — if stealth-fetch ever stops working (token-validator changes, Akamai update), the auto ladder falls through to the playbook (real Chromium + DOM walk via the URL-prefilled-search shortcut).

## Files

| File | What |
|---|---|
| `sessions/<ts>.{jsonl,json}` | Raw recording (gitignored — may contain cookies) |
| `sessions/<ts>.redacted.json` | Scrubbed for LLM analysis |
| `workflow.json` | API workflow spec — used by stealth-fetch backend (substitutes `${param.X}` into the captured request) |
| `index.ts` | Generated tool function — what cron + MCP call (`opts.fetchImpl` injection seam is what stealth-fetch uses) |
| `playbook.yaml` | DOM playbook — 1 navigate step (URL-prefilled search) + XHR result extraction. Used by the playbook backend. |
| `cron.json` | Daily 9am check; `replayBackend: "auto"`; price_below $99 |
| `backends.json` | Probe artifact — `preferredOrder: ["stealth-fetch", "playbook"]` (fetch always FORBIDDEN here) |

## Running it for real

```bash
# One-time setup
bunx playwright install chromium     # for stealth-fetch + playbook backends
bun install                          # if you haven't

# Verify everything still works after a code change
imprint cron southwest --once

# Production (foreground)
NTFY_URL=https://ntfy.sh/your-secret-topic imprint cron southwest

# Production (OS scheduler — wraps --once for cron / systemd timer / launchd)
NTFY_URL=https://ntfy.sh/your-secret-topic imprint cron southwest --once
```

The `cron.json` schedule (`0 9 * * *` = daily at 9am local) is conservative to avoid hammering the API. Crank it up to hourly for a tighter watch but be aware Akamai may flag the IP at high frequency.

## Tuning

- **Threshold** — currently `$99`. Today's lowest is $108.40, so no push will fire until a real drop. Lower the threshold for noisier "any day below $X" alerts; raise it to wait for a deeper drop.
- **Date** — `cron.json` polls a single date (`departure_date: 2026-06-20`). Polling multiple dates means N copies of `cron.json` (or a future v0.2 multi-date sweep — see the project TODOS).
- **Re-probe** — re-run `imprint probe-backends southwest` if the cron starts erroring (e.g., Southwest changes its API path; Akamai changes its sensor schema). The probe re-tests every backend and updates `backends.json`.

## Edge cases the runner handles

These came up during bring-up; documented so the next person knows they're handled:

- **Hidden duplicate elements.** Southwest's autocomplete renders both a custom dropdown AND a hidden native `<select>`. Runner filters to visible.
- **Wrapper intercepts pointer events.** Clickable `<strong>` text inside a styled `role=checkbox` parent. Runner retries with `force: true`.
- **Date input is non-typeable.** Captured event log shows zero `input` events on `#departureDate` — user clicks the input + a calendar cell. URL-prefilled navigation sidesteps this.
- **Vanilla Playwright headless gets a 403.** `navigator.webdriver` is the tell. Stealth plugin patches it.
- **Token GC race.** Playwright/CDP garbage-collects response bodies aggressively. Runner reads bodies inside the response handler and drains pending text-promises before extracting.
- **`networkidle` hangs on SPAs.** Persistent connections never go idle. Runner uses `domcontentloaded` + the wait_for hint instead.
- **`X-User-Experience-ID` is captured stale + Southwest rejects it.** stealth-fetch wrapper regenerates a fresh UUID per call AND auto-injects if missing entirely (LLM compiler dropped it from the workflow).

## What's NOT in this demo (deferred to v0.2)

- **Booking the cheaper flight automatically when a drop fires.** Read-only watcher only. Booking would need authenticated session replay — solvable but out of scope.
- **Multi-day calendar sweep.** Current playbook polls one date. Either spin up multiple `cron.json` files or wait for v0.2 sweep support.
- **Persistent runtime.** Currently you run `imprint cron southwest` foreground or wire it to your OS scheduler. v0.2 plan: Hetzner CX22 ($5/mo) hosting (TODOS #8).
