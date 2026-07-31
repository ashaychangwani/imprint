# Google Hotels - `imprint-google-hotels`

> Generated Google Hotels MCP example. Every tool directory here was produced
> from a recorded Google Hotels session and refreshed from the verified
> generated artifacts under `~/.imprint/google-hotels`.

An 8-tool MCP server for Google Hotels search, selected-hotel details,
booking options, reviews, photos, area boundaries, and related web links.

Selective re-teach and live verification on July 31, 2026 refreshed the
suggestion and boundary workflows. They passed five live behavior checks and
16 deterministic tests with 69 assertions, including their shared
`batchexecute` decoder. The other six tools remain at their previously verified
versions because their fresh generations were narrower, incorrect, or did not
meet the same reliability bar.

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `suggest_hotel_destinations` | Return destination and lodging autocomplete suggestions for a query. | Replacement for the older autocomplete example. |
| `search_hotels` | Search lodging results by destination, dates, minimum price, hotel class, and property type. | Emits reusable `hotel_token` / `result_token` values. |
| `list_hotel_booking_options` | List booking providers and prices for a selected hotel stay. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_reviews` | Fetch review data for a selected hotel. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_photos` | Fetch photo thumbnail URLs for a selected hotel. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_details` | Fetch detailed information for a selected hotel or vacation rental. | Consumes a `hotel_token`. |
| `get_travel_area_boundaries` | Fetch map boundary or area geometry data for a destination. | Accepts a destination id or the legacy place-id input. |
| `search_hotel_web_links` | Search web links for a selected hotel name. | Useful for official site and related links. |

## How It Was Compiled

- **Protocol**: Google's `batchexecute` endpoint returns nested-array payloads.
  Each tool includes its generated request transform and parser.
- **Producer to consumer flow**: `search_hotels` emits selected-result tokens
  that booking, reviews, photos, and detail tools can consume.
- **Backend reliability**: each checked-in `backends.json` records the
  successfully probed order for that workflow. The refreshed batchexecute
  tools currently prefer browser-backed replay with stealth fetch as fallback.
- **Artifacts per tool**: `workflow.json` (API replay), `index.ts` (MCP tool),
  `parser.ts`, optional `request-transform.ts`, optional `playbook.yaml` (DOM
  fallback), `package.json`, and `backends.json`.

## Install

```bash
imprint install google-hotels --source examples --platform claude-desktop
```

Recording-derived defaults such as dates and locations age out. Pass explicit
dates, destinations, and selected-result tokens when using the tools. See the
repo [README](../../README.md) and [docs](../../docs/architecture.md).
