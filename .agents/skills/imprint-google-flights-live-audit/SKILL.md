---
name: imprint-google-flights-live-audit
description: Audit and repair generated Google Flights Imprint tools. Use when validating Google Flights search, calendar, booking, airline/bag filters, one-way, round-trip, multi-city, or open-jaw behavior; when investigating `selection_token` or `selected_flights` producer-consumer contracts; or when live audit results are slow, bot-sensitive, under-tested, or incorrectly waived as infrastructure.
---

# Google Flights Live Audit

Use this for generated tools under `~/.imprint/google-flights`, especially when search
and booking need to prove one-way, round-trip, and multi-city behavior end to end.

## Core Checks

Start from the actual generated tool files, not assumptions:

```bash
find ~/.imprint/google-flights -maxdepth 2 -type f | sort
bun test ~/.imprint/google-flights/search_flights/integration.test.ts
bun test ~/.imprint/google-flights/get_flight_booking_options/integration.test.ts
```

Check these contracts explicitly:

- `search_flights` emits `selection_token` and `selected_flights`.
- staged `search_flights` accepts both `selection_token` and prior `selected_flights`.
- `get_flight_booking_options` receives the complete ordered `selected_flights` array.
- one-way uses a single selected route group.
- round-trip and multi-city group connecting segments into logical route legs.
- open-jaw stays `trip_type=multi_city`; do not rewrite it as round trip.
- airline filters and bag filters alter the rendered Google request, not only result parsing.

## Live Flow

For multi-city/open-jaw, verify the real staged flow:

1. Call `search_flights` with `trip_type=multi_city` and an ordered itinerary like
   `BOM,SFO,2026-09-07;BOS,BOM,2026-10-12`.
2. Pick a first-leg result and call `search_flights` again with that result's
   `selection_token` and `selected_flights`.
3. Pass the staged result's complete `selected_flights` array to
   `get_flight_booking_options`.
4. Confirm booking options include all selected route legs, not just the first leg.

Use exact user-requested dates, airports, and carriers. If the user asks about an
Emirates/Qatar/etc. option, test that carrier with `airlines=<code>` instead of relying
on the default sorted subset.

## Backend Timing

Google Flights usually needs `cdp-replay` for stateful booking/search flows. Treat cold
CDP startup separately from warm calls:

- first same-site CDP call can cost tens of seconds;
- subsequent pooled calls should be cheap, often a few seconds or less;
- audit budgets should not under-test parameters just because the first call was expensive.

Refresh backend preferences after material tool fixes:

```bash
bun run src/cli.ts probe-backends google-flights --tool search_flights --param trip_type=multi_city --param itinerary='SFO,LAX,2026-09-01;LAX,JFK,2026-09-04'
bun run src/cli.ts probe-backends google-flights --tool get_flight_booking_options --param selected_flights='<complete selected_flights JSON>'
```

## Manual Repair Rules

Keep fixes in generated artifacts tight and contract-driven:

- group connecting segments by origin/destination continuity and same/next-day dates;
- stop grouping when a later segment returns to the route group origin;
- mint booking state through staged shopping calls before `GetBookingResults`;
- use structured parsing for `selected_flights`; avoid string slicing;
- keep wording generic: producer-sourced values, selected route groups, booking state.

After manual edits, run focused live tests and a full audit:

```bash
bun test ~/.imprint/google-flights/search_flights/integration.test.ts
bun test ~/.imprint/google-flights/get_flight_booking_options/integration.test.ts
bun run src/cli.ts audit google-flights --provider codex-cli --timeout 45m --out ~/.imprint/google-flights/.audit-report.json
```

Report concrete counts from the audit: graded units, invocations, parameters, broken,
no-op, infra, bad params, and untestable. Do not summarize "works" without these numbers.
