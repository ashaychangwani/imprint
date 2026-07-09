# Google Hotels - `imprint-google-hotels`

> Generated Google Hotels MCP example. Every tool directory here was produced
> from a recorded Google Hotels session and refreshed from the verified
> generated artifacts under `~/.imprint/google-hotels`.

An 8-tool MCP server for Google Hotels search, selected-hotel details,
booking options, reviews, photos, area boundaries, and related web links.

Fresh live verification on July 9, 2026:

```bash
bun test ~/.imprint/google-hotels/*/integration.test.ts --timeout 180000
```

Result: `14 pass`, `0 fail`, `66 expect() calls` across `8` generated
workflow integration suites. All generated `backends.json` files prefer
`fetch`, with browser-backed rungs available as fallbacks.

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `suggest_hotel_destinations` | Return destination and lodging autocomplete suggestions for a query. | Replacement for the older autocomplete example. |
| `search_hotels` | Search lodging results by destination, dates, minimum price, hotel class, and property type. | Emits reusable `hotel_token` / `result_token` values. |
| `list_hotel_booking_options` | List booking providers and prices for a selected hotel stay. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_reviews` | Fetch review data for a selected hotel. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_photos` | Fetch photo thumbnail URLs for a selected hotel. | Consumes a `hotel_token`, typically from `search_hotels`. |
| `get_hotel_details` | Fetch detailed information for a selected hotel or vacation rental. | Consumes a `hotel_token`. |
| `get_travel_area_boundaries` | Fetch map boundary or area geometry data for a destination. | Uses place id and coordinates. |
| `search_hotel_web_links` | Search web links for a selected hotel name. | Useful for official site and related links. |

## How It Was Compiled

- **Protocol**: Google's `batchexecute` endpoint returns nested-array payloads.
  Each tool includes its generated request transform and parser.
- **Producer to consumer flow**: `search_hotels` emits selected-result tokens
  that booking, reviews, photos, and detail tools can consume.
- **Backend reliability**: checked-in `backends.json` files record `fetch` as
  the working preferred backend for every tool. Runtime can still fall back to
  browser-backed rungs when needed.
- **Artifacts per tool**: `workflow.json` (API replay), `index.ts` (MCP tool),
  `parser.ts`, optional `request-transform.ts`, `playbook.yaml` (DOM fallback),
  `package.json`, and `backends.json`.

## Install

```bash
imprint install google-hotels --source examples --platform claude-desktop
```

Recording-derived defaults such as dates and locations age out. Pass explicit
dates, destinations, and selected-result tokens when using the tools. See the
repo [README](../../README.md) and [docs](../../docs/architecture.md).
