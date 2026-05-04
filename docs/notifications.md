# Notifications

Imprint's `cron` daemon pushes on every failure (always) and on every successful tick where a `notifyWhen` predicate matches. Two providers are supported, both off by default.

## Pushover

Native iOS / Android / desktop apps. $5 one-time per platform.

**Setup:**
1. Create an account at https://pushover.net
2. Create an "Application/API token" for Imprint
3. Set both env vars:

```bash
export PUSHOVER_TOKEN=<application-token>
export PUSHOVER_USER=<your-user-key>
```

## ntfy

Free, open-source, self-hostable. Public ntfy.sh works for low-traffic alerts; for production, self-host or use a paid plan.

**Setup (public ntfy.sh):**
1. Pick a hard-to-guess topic name. ntfy topics are unauthenticated by default — anyone who knows the topic can read your messages.

```bash
export NTFY_URL=https://ntfy.sh/your-secret-topic-name-zx7q9
```

2. Subscribe via the [ntfy iOS / Android app](https://ntfy.sh) or via curl:

```bash
curl -s https://ntfy.sh/your-secret-topic-name-zx7q9/json
```

**Setup (self-hosted with auth):**

```bash
export NTFY_URL=https://ntfy.your-domain.com/your-topic
export NTFY_TOKEN=<bearer-token>
```

## Both at once

If you set both, every notification fires on both providers. Useful as a redundancy / migration setup.

## notifyWhen predicates

Configure in `cron.json`:

```json
{
  "schedule": "*/15 * * * *",
  "params": { "origin": "SJC", "destination": "SAN" },
  "replayBackend": "auto",
  "notifyWhen": {
    "type": "price_below",
    "threshold": 99,
    "pricePath": "data.searchResults.airProducts[].lowestFare.value"
  }
}
```

Currently supported:

- `price_below` — pushes when `min(extracted prices) < threshold`. The `pricePath` uses the dot-path-with-`[]` syntax from `src/imprint/json-path.ts` (see [docs/glossary.md](glossary.md#NotifyWhen)).

  `pricePath` accepts either a single string or an array. Use an array when a tool returns different shapes from different backends — e.g. Southwest's stealth-fetch path returns the raw API JSON (`data.searchResults.airProducts[].lowestFare.value`) while the playbook path returns a reshaped envelope (`prices[]`):

  ```json
  "notifyWhen": {
    "type": "price_below",
    "threshold": 99,
    "pricePath": [
      "data.searchResults.airProducts[].lowestFare.value",
      "prices[]"
    ]
  }
  ```

  The first path that matches the data shape wins; values from every matching path are unioned.

Without a `notifyWhen`, the daemon only pushes on tool failures (with the error class + remediation).

## Quiet failures

If a provider is configured but fails to deliver (network issue, bad token, ntfy rate-limit), the daemon logs the failure to stderr but continues — a flaky push provider must never crash the cron loop.

## What a notification looks like

```
imprint: search_southwest_flights failed
[FORBIDDEN] Request 0 returned 403: <body excerpt>
→ remediation: bot detection — try replayBackend: auto
```

```
imprint: price drop on search_southwest_flights
Lowest price $89 (under your $99 threshold) — 12 options found.
```
