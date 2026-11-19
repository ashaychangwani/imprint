# Google Hotels - `imprint-google-hotels`

> Generated Google Hotels MCP example. Every tool directory here was produced
> from a combined Google Hotels recording corpus and refreshed from the verified
> generated artifacts under `~/.imprint/google-hotels`.

This fresh 4-tool MCP server covers destination suggestions, dated hotel search,
consolidated selected-hotel details, and booking offers.

Generation differential audit on July 18, 2026:

```bash
imprint audit google-hotels --min-score 95
```

Result: **25/25 gradeable units** across all four emitted tools. The audit's
booking calls returned no available offers, so PR review additionally hardened
the booking and detail parsers to reject challenge/garbage responses rather
than treating caller-echoed fields as success.

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `suggest_hotel_destinations` | Return destination and lodging autocomplete suggestions for a query. | Replacement for the older autocomplete example. |
| `search_hotels` | Search lodging results by destination and stay dates. | Emits reusable `hotel_id` values; unproven filters are deliberately omitted. |
| `get_hotel_details` | Fetch selected-property details, reviews, photos, and related links. | Consumes `hotel_id` from search; `hotel_name` refines related links. |
| `get_hotel_booking_options` | List booking providers and prices for a selected property and stay. | Consumes `hotel_id` plus dates, adults, and currency. |

## How It Was Compiled

- **Protocol**: Google's `batchexecute` endpoint returns nested-array payloads.
  Each tool includes its generated request transform and parser.
- **Producer to consumer flow**: `search_hotels` emits `hotel_id` values that
  the booking and consolidated-detail tools consume.
- **Backend reliability**: generation probes preferred `stealth-fetch` for
  search and `cdp-replay` for destination suggestions. Final parser/transform
  hardening occurred afterward, so the snapshot ships without stale
  `backends.json` preferences; run `imprint probe-backends google-hotels --all`
  against the user's current route/session.
- **Artifacts per tool**: `workflow.json` (API replay), `index.ts` (MCP tool),
  `parser.ts`, optional `request-transform.ts`, and `package.json`. Generated
  DOM playbooks were omitted because their raw fallback results did not match
  the public parser contracts.

## Install

```bash
imprint install google-hotels --source examples --platform claude-desktop
```

Recording-derived defaults such as dates and locations age out. Pass explicit
dates, destinations, and selected-result tokens when using the tools. See the
repo [README](../../README.md) and [docs](../../docs/architecture.md).
