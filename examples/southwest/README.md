# Southwest fare-drop watcher

> Watch a Southwest route, push when the lowest fare drops below your threshold. Defeats Akamai bot detection via `stealth-fetch`.

## What this shows off

- **The full backend ladder in action.** `fetch` returns 403 (Akamai), `stealth-fetch` mints sensor tokens via a brief Playwright bootstrap then succeeds in ~10s/call.
- **`probe-backends` skipping the futile rung.** The cached `backends.json` orders the ladder `stealth-fetch → playbook` so cron doesn't burn 200ms on a fetch attempt every tick.
- **`notifyWhen: price_below`** pushing only on real drops, with the `pricePath` extracting from real Southwest response shape.
- **The fresh-UUID header trick** — Southwest rejects stale `X-User-Experience-ID`; stealth-fetch regenerates per call.
- **Public bootstrap config capture.** The workflow fetches Southwest's public bootstrap `data.js` and captures the current `api-keys.prod` value, so installed examples do not require a `SOUTHWEST_API_KEY` environment variable.
- **Multi-path `pricePath`** — `cron.json`'s notifyWhen lists both the raw API shape (when stealth-fetch wins) and the playbook's reshaped output, so the push fires regardless of which backend produced the result.

## Run it

```bash
# One-time setup: registers the example MCP and installs Playwright Chromium if missing
imprint install southwest --source examples --platform claude-desktop

# Run a single tick (verifies everything still works)
imprint cron southwest --once

# Production: foreground daemon
NTFY_URL=https://ntfy.sh/your-secret-topic imprint cron southwest

# Production: OS scheduler (cron / systemd timer / launchd) — wraps --once
NTFY_URL=https://ntfy.sh/your-secret-topic imprint cron southwest --once
```

## What you should see

```
[imprint cron] config: examples/southwest/search_southwest_flights/cron.json
[imprint cron] backends.json: probed 2026-05-03T22:23Z, preferred order: stealth-fetch → playbook
[imprint cron] tool: search_southwest_flights (5 param(s))
[imprint cron] schedule: 0 9 * * *
[imprint cron] notifyWhen: price_below
[imprint cron] replayBackend: auto (ladder: stealth-fetch → playbook)
[imprint backend] trying stealth-fetch…
[imprint stealth] bootstrapping…
[imprint stealth] bootstrapped in ~13s — 21 cookies, 6 sensor headers
[imprint backend] stealth-fetch: OK in ~15s
[imprint cron]   OK in ~15s via stealth-fetch: {"data":{"searchResults":{...,"value":"108.40"}}}
```

Real Southwest data, real $108.40 lowest WGA fare. Bootstrap is one-time per process; subsequent ticks reuse the stealth-fetch session.

## Files

| File | What |
|---|---|
| `~/.imprint/southwest/sessions/<ts>.{jsonl,json}` | Raw recording (local only — may contain cookies) |
| `~/.imprint/southwest/sessions/<ts>.redacted.json` | Scrubbed for LLM analysis |
| `workflow.json` | API workflow used by stealth-fetch backend |
| `index.ts` | Generated tool function (`opts.fetchImpl` is what stealth-fetch injects into) |
| `playbook.yaml` | DOM playbook fallback — single navigate to the URL-prefilled search + XHR result extraction |
| `cron.json` | Daily 9am tick; `replayBackend: "auto"`; `price_below: 99` |
| `backends.json` | Probe artifact — `preferredOrder: ["stealth-fetch", "playbook"]` |

## Tuning

- **Threshold**: currently `$99`. Today's lowest is $108.40 so nothing fires; lower for noisy alerts, raise to wait for a deeper drop.
- **Date**: polls one date (`departure_date: 2026-06-20`). Multiple dates = multiple `cron.json` files for now.
- **Re-probe**: re-run `imprint probe-backends southwest` if the cron starts erroring — Akamai's sensor schema changes occasionally.

## Notes (gotchas this demo handles)

These came up during bring-up; documented so the next person knows they're handled:

- **Hidden duplicate elements.** Southwest renders both a custom dropdown and a hidden native `<select>`. Runner filters to visible.
- **Wrapper intercepts pointer events.** Clickable `<strong>` inside `role=checkbox`. Runner retries with `force: true`.
- **Date input is non-typeable.** URL-prefilled navigation sidesteps the calendar widget.
- **Vanilla Playwright gets a 403.** `navigator.webdriver` is the tell. Stealth plugin patches it.
- **Token GC race.** Playwright GCs response bodies aggressively. Runner reads inside the response handler and drains pending text() promises before extracting.
- **`networkidle` hangs on SPAs.** Persistent connections never go idle. Runner uses `domcontentloaded` + the explicit `wait_for`.
- **Stale `X-User-Experience-ID`.** stealth-fetch regenerates a fresh UUID per call AND auto-injects if the workflow dropped it.

## Not in this demo

- Auto-booking the cheaper flight on a drop (read-only watcher).
- Multi-date sweep (one `cron.json` per date).
- Hosted execution (run foreground or wire to your OS scheduler).
