# Southwest read-only MCP example

> Generated Southwest MCP tools for read-only flight search, fare calendar, flight
> status, and account/trip lookup workflows.

Fresh generation audit on July 18, 2026: **35/35 gradeable public-tool units**.
The two authenticated tools were infrastructure-blocked and excluded from that
denominator; they require a user-supplied authenticated cookie session.

## Tools

| Tool | What it does | Generation probe (rerun for this final snapshot) |
| --- | --- | --- |
| `search_flights` | Searches one-way or round-trip Southwest inventory and USD fares for the recorded one-adult baseline. | `cdp-replay` |
| `get_low_fare_calendar` | Retrieves USD low-fare calendar prices for a route and month anchor date using the one-adult baseline. | `cdp-replay` → `stealth-fetch` |
| `get_flight_status` | Retrieves current-window flight status through the rendered public result page with exact route filtering. | `cdp-replay` |
| `get_account_details` | Reads Rapid Rewards account profile/details for the authenticated account. | Probe after fresh login |
| `list_upcoming_trips` | Lists upcoming trips for the authenticated account. | Probe after fresh login |

All checked-in tools are read-only. State-changing workflows are intentionally
excluded from this example snapshot.

## Install

```bash
imprint install southwest --source examples --platform claude-desktop
```

The account tools consume an authenticated cookie session, not stored
username/password fields. Record a login locally, persist its cookies, then
probe the authenticated tools:

```bash
imprint record southwest --persist-profile --url https://www.southwest.com/
# Sign in in the recording browser, then finish the recording.
imprint login southwest --from-session ~/.imprint/southwest/sessions/<ts>.json
imprint probe-backends southwest --tool get_account_details
imprint probe-backends southwest --tool list_upcoming_trips
```

## Notes

- Passenger-count selection is intentionally user-assisted: discriminating live
  calls returned equivalent adult-only output, so the generated public tools do
  not expose controls the provider was observed to ignore.
- Generation probes established the backend orders shown above, but subsequent
  parser/transform hardening changed the executable contract. No stale
  `backends.json` is shipped; run `imprint probe-backends southwest --all` after
  establishing the user's current session.
- Generated DOM playbooks were omitted because their raw result shapes did not
  match the public API parser contracts. Authenticated tools remain explicitly
  unverified until the user establishes and probes a fresh session.
- Captured Southwest sensor headers were removed from every checked-in workflow;
  browser-backed transports mint current state when needed.
- Local recordings, audit logs, token jars, generated integration tests, and lock
  files are not part of this example snapshot.
- Authentication helpers, reservation mutations, and incomplete reservation or
  check-in candidates are intentionally excluded from this read-only snapshot.
