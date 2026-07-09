# Southwest read-only MCP example

> Generated Southwest MCP tools for read-only flight search, fare calendar, flight
> status, and account/trip lookup workflows.

## Tools

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_flights` | Searches one-way or round-trip Southwest flight options and fares. Supports `USD` and `POINTS` fare types. | `stealth-fetch` |
| `get_low_fare_calendar` | Retrieves low-fare calendar prices for a route and month anchor date. | `stealth-fetch` |
| `get_flight_status` | Retrieves Southwest flight status for a date, route, and flight number. | `stealth-fetch` |
| `get_account_details` | Reads Rapid Rewards account profile/details for the authenticated account. | `cdp-replay` |
| `list_upcoming_trips` | Lists upcoming trips for the authenticated account. | `cdp-replay` |

All checked-in tools are read-only. State-changing workflows are intentionally
excluded from this example snapshot.

## Install

```bash
imprint install southwest --source examples --platform claude-desktop
```

The account tools require local credentials:

```bash
imprint credential set southwest username
imprint credential set southwest password
```

## Notes

- The workflows capture Southwest's public bootstrap API key from
  `landing-home-page-v2/1/data.js`; no static API key or environment variable is
  required.
- `backends.json` is checked in for each tool so runtime replay can start on the
  backend that passed the latest probe instead of re-walking known bad rungs.
- Local recordings, audit logs, token jars, generated integration tests, and lock
  files are not part of this example snapshot.
- Generated but unexposed reservation-detail and seat-map workflows are not
  included because they do not have callable `index.ts` wrappers in the latest
  dump.
