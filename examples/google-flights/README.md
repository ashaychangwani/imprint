# Google Flights - `imprint-google-flights`

> Generated Google Flights MCP example. This snapshot was refreshed from the
> audited `~/.imprint/google-flights` tools after live verification of one-way,
> round-trip, and staged multi-city booking flows.

A 6-tool MCP server for Google Flights, compiled from recorded browser sessions
and checked in as an example of a generated Imprint integration.

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `lookup_flight_locations` | Resolve a city, airport, or region query to Google Flights location entities | Use before search when a user gives ambiguous locations. |
| `get_flight_location_details` | Return structured details for a Google Flights location token | Helpful for validating selected origins and destinations. |
| `search_flights` | Search one-way, round-trip, and multi-city itineraries with filters | Supports staged selection via `selection_token` and `selected_flights`. |
| `get_flight_booking_options` | Return fares and booking providers for selected flights | Pass the complete ordered `selected_flights` array for round-trip and multi-city bookings. |
| `get_flight_calendar_prices` | Return calendar fare data for a route/date window | Uses Google Flights calendar RPC data. |
| `validate_flight_itinerary` | Validate itinerary details against Google Flights | Useful for checking complete selected itineraries before booking. |

## Multi-City Selection

For round-trip and multi-city booking, Google Flights mints booking state from
the route selections made so far. Agents should use the staged contract:

1. Call `search_flights` with `trip_type="multi_city"` and an ordered
   `itinerary`, for example `BOM,SFO,2026-09-07;BOS,BOM,2026-10-12`.
2. Pick a first-leg result and call `search_flights` again with that result's
   `selection_token` and `selected_flights` to fetch the next leg options.
3. Pass the complete ordered `selected_flights` array from the staged result to
   `get_flight_booking_options`.

Passing only the first selected leg to `get_flight_booking_options` is treated
as a one-way booking. For open-jaw trips, keep the trip as `multi_city`; do not
rewrite it as a round trip.

## How It Was Compiled

- **Protocol**: Google Flights uses the `/_/FlightsFrontendUi` `batchexecute`
  endpoint. Shared parser and transport helpers live in `_shared`, with
  per-tool request transforms and parsers in each tool directory.
- **Anti-bot**: current backend preferences are committed in each
  `backends.json`; booking and search use `cdp-replay` where Google state must
  be minted inside a live browser context.
- **Artifacts per tool**: `workflow.json` (API replay), `playbook.yaml`
  (DOM fallback), `index.ts` (MCP tool), and parser/transform code where needed.

## Install

```bash
imprint install google-flights --source examples --platform claude-desktop
```

Recording-derived defaults such as dates age out, so pass explicit values. See
the repo [README](../../README.md) and [architecture docs](../../docs/architecture.md).
