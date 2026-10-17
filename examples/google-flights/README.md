# Google Flights - `imprint-google-flights`

> Generated Google Flights MCP example. This snapshot was refreshed from the
> audited `~/.imprint/google-flights` tools after live differential verification
> of location lookup, one-way search, round-trip calendar pricing, and booking.

A 5-tool MCP server for Google Flights, compiled from a fresh replay of a combined
recording corpus. The generated suite scored **46/46 gradeable audit units** before
the PR review added stricter malformed-response and postcondition regression guards.

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `search_flight_locations` | Resolve a city, airport, or region query to ranked Google Flights location entities | Use before search when a user gives ambiguous locations. |
| `get_flight_location_details` | Return structured details for a Google Flights location token | Helpful for validating selected origins and destinations. |
| `search_flights` | Search complete one-way itineraries with passenger, carrier/alliance, stop, price, time, duration, and sort controls | Returns reusable `selection_data`; round-trip and multi-city staged selection remain user-assisted. |
| `get_flight_booking_options` | Return fare details and booking providers for selected flights | Pass a chosen result's `selection_data` into this tool's `selected_flights` argument. |
| `get_flight_calendar_prices` | Return round-trip date-pair fares over a requested date range | Supports route, range, trip length, and passenger-count changes. |

## Search And Booking Flow

Agents should use the generated producer-consumer contract:

1. Resolve ambiguous place input with `search_flight_locations`, then optionally
   confirm a chosen entity with `get_flight_location_details`.
2. Call `search_flights` with exactly one `legs` entry such as
   `SFO,LAX,2026-09-15` and `trip_type=one_way`.
3. Pass the selected result's `selection_data` value to
   `get_flight_booking_options` as its `selected_flights` argument.
4. For round-trip price discovery, use `get_flight_calendar_prices`. Producing
   later-leg selection state for round-trip or multi-city booking remains the
   explicit user-assisted portion of this recording.

The generated workflows deliberately omit unsupported trip modes and cabin
classes instead of silently accepting no-op parameters.

## How It Was Compiled

- **Protocol**: Google Flights uses the `/_/FlightsFrontendUi` `batchexecute`
  endpoint. Shared envelope and service parsers live in `_shared`, with
  per-tool request transforms and parsers in each tool directory.
- **Anti-bot**: generation probes found browser-backed replay necessary for
  several routes. The final parser/transform hardening happened after those
  probes, so no stale `backends.json` preference is shipped; run
  `imprint probe-backends google-flights --all` for the user's current route.
- **Artifacts per tool**: `workflow.json` (API replay), `index.ts` (MCP tool),
  and parser/transform code where needed. The generated DOM playbooks were
  omitted because their raw fallback results did not match these public tool
  schemas.

## Install

```bash
imprint install google-flights --source examples --platform claude-desktop
```

Recording-derived defaults such as dates age out, so pass explicit values. See
the repo [README](../../README.md) and [architecture docs](../../docs/architecture.md).
