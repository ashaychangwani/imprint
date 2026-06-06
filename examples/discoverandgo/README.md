# Discover & Go museum-pass booking

> Reserve a museum pass on the San Diego Public Library's Discover & Go service. Authenticated workflow; uses the per-site credential store populated by `imprint login`.

## What this shows off

- **The `imprint login` flow.** Library cards are persistent; you log in once during recording and `imprint login` extracts the patron ID + cookies into `~/.config/imprint/credentials/discoverandgo.json`. Subsequent runs use those credentials without re-recording.
- **`${credential.X}` substitutions.** Workflow templates reference `${credential.patron_id}` directly; the runtime fills it from the credential store.
- **Plain `fetch` backend works** — Discover & Go has no bot detection, so this demo runs in ~200ms per call (no Playwright bootstrap, no DOM walk).

## Run it

```bash
# One-time: log in once via record, then mine credentials
imprint record discoverandgo --persist-profile --url https://sandiego.discoverandgo.net
# (drive a real reservation; narrate; /done when finished)

imprint login discoverandgo --from-session ~/.imprint/discoverandgo/sessions/<ts>.json

# Then any time you want to book:
imprint cron discoverandgo --once
```

## What you should see

```
[imprint cron] config: examples/discoverandgo/book_discoverandgo_museum_pass/cron.json
[imprint cron] tool: book_discoverandgo_museum_pass (3 param(s))
[imprint cron] schedule: 0 0 * * *
[imprint cron] replayBackend: fetch
[imprint backend] trying fetch…
[imprint backend] fetch: OK in ~250ms
[imprint cron]   OK in ~250ms via fetch: {"reservationID":...,"status":"confirmed",...}
```

## Files

| File | What |
|---|---|
| `workflow.json` | API workflow with `${credential.patron_id}` and `${param.offer_id}` substitutions |
| `index.ts` | Generated tool function |
| `cron.json` | Daily 0am tick (placeholder offer + date — edit to your real reservation) |

## Tuning

- **Edit `cron.json`** with the actual `offer_id` (numeric attraction ID), `offer_date` (YYYY-MM-DD), and your `notification_email`.
- **Schedule** is daily; if you want to grab a pass the moment it opens (D&G releases new dates at midnight Pacific), tighten to `*/5 0 * * *` for 5-minute polling around midnight.

## Notes

- Discover & Go's auth model is patron-ID + session cookies. The session cookie expires; re-run `imprint login` if you start seeing AUTH_EXPIRED.
- `imprint login` parses the `patronID` out of the recorded `epass_server.php?method=Login` POST and stores it in the credential store as `patron_id`. The booking `workflow.json` then references it via `${credential.patron_id}` — no Login call is replayed at runtime.

## Not in this demo

- Multi-attraction booking in one tick (one `cron.json` per attraction).
- Auto-renewal (passes are calendar-bound; renewal would mean picking the next available date).
