# Southwest fare-drop watcher ✓ working

Recorded session: `sessions/2026-05-03T09-30-16-437Z.{jsonl,json}`
(SJC → SAN one-way for 2026-06-20, captured via `imprint record southwest`).

## Status: end-to-end working

```bash
bun src/cli.ts cron southwest --once
# [imprint cron] OK in 9438ms: {"prices":[108.4],"source_url":"https://www.southwest.com/api/air-booking/v1/air-booking/page/air/booking/shopping"}
```

Real Southwest data, real price ($108.40 lowest), all the way through.

The cron uses `replayBackend: "playbook"` because the API replay path
returns a 403 from Akamai's Bot Manager — sensor-token validation that
no headers-only HTTP client can defeat. The playbook drives Playwright
(with the stealth plugin baked into the runner by default) which patches
the JS-detectable bot markers and sails through.

## How we got here

The first compile produced a 12-step playbook that walked through the
form (autocompletes, date picker, trip-type dropdown, search, drill into
the Low Fare Calendar). Six iterations revealed the real architecture
of Southwest's form:

1. **Hidden duplicate elements.** Custom autocomplete + hidden native
   `<select>` for accessibility. Runner now filters to visible.
2. **Wrapper intercepts pointer events.** `<strong>SJC</strong>` wrapped
   in a `role=checkbox` div. Runner now retries with `force: true`.
3. **LLM hallucinated extract path.** Compiler now sends truncated
   response bodies so the LLM can read the actual JSON shape.
4. **Date picker overlays trip-type dropdown.** Added the `press`
   action; an Escape step dismisses the overlay.
5. **Date input rejects keyboard input entirely.** Captured event log
   shows zero `input` events on `#departureDate` — the user clicked
   the input, then clicked a calendar cell. We can't replay typed
   dates.
6. **Vanilla Playwright headless gets a 403** from Akamai's sensor-
   token validator regardless of TLS spoofing or `_abck` cookie reuse.
   Even `--headed` gets blocked because the navigator.webdriver and
   plugin-enumeration tells are still there.

The fix that took us from "blocked" to "working":

- **URL-prefilled navigation.** Southwest's `/air/booking/select-depart.html`
  accepts the entire search state as query params and triggers the
  shopping XHR automatically. Sidesteps every form-fill quirk in one
  step.
- **playwright-extra + puppeteer-extra-plugin-stealth.** Patches the JS-
  detectable bot markers (navigator.webdriver, plugin enumeration,
  languages, permissions, WebGL vendor strings, audio fingerprint) so
  Akamai's sensor JS can't tell us apart from a real browser. **Verified:
  vanilla Chromium → 403, stealth Chromium → 200 with real flight data.**
- **Eager body capture + drain.** Playwright/CDP garbage-collects
  response bodies aggressively, so `resp.text()` must run inside the
  response handler, and the runner must drain the pending text-promises
  before extracting.
- **`domcontentloaded` not `load`** for SPAs with persistent connections.
- **30s default step timeout** so Akamai's sensor JS has room to settle.

All of these are runner-level improvements that benefit any site, not
just Southwest.

## Reproduce

```bash
# One-time browser install
bunx playwright install chromium

# Verify against the live API
bun src/cli.ts playbook southwest --param origin=SJC --param destination=SAN \
                                  --param depart_date=2026-06-20

# Run as a daily cron with push notification when fare drops below $99
NTFY_URL=https://ntfy.sh/your-secret-topic bun src/cli.ts cron southwest
```

## What still doesn't work / future work

- **The original 12-step DOM-walking playbook.** Southwest's date input
  is fundamentally non-typeable; the only deterministic path is the
  URL-param shortcut. Other airlines without that shortcut would need
  the actual click-through (probably feasible for sites without a
  React-controlled date picker).
- **Multi-day fare scanning.** The current playbook polls one specific
  date. A true Low Fare Calendar drilldown would need 30+ XHR
  extractions or a sweep across dates.
- **Auth-required workflows.** This recording is read-only. Booking the
  cheaper flight when a price drop fires would need authenticated
  session replay — solvable but out of scope for the watcher demo.

## Files

| File | What |
|---|---|
| `sessions/<ts>.jsonl` / `.json` | Raw recording (gitignored — may contain cookies) |
| `sessions/<ts>.redacted.json` | Scrubbed for LLM analysis |
| `workflow.json` | API workflow spec (currently unused — Akamai blocks the API path) |
| `index.ts` | API tool generated from workflow.json (kept for reference) |
| `playbook.md` | The actual working spec — 1 navigate step + result extraction |
| `cron.json` | Daily 9am check; `replayBackend: "playbook"`; threshold $99 |
