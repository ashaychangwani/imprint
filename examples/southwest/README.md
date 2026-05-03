# Southwest fare-drop watcher

Recorded session: `sessions/2026-05-03T09-30-16-437Z.{jsonl,json}`
(SJC → SAN one-way for 2026-06-23, captured via `imprint record southwest`).

The recording, redaction, generation, and emission steps all worked
cleanly. The generated workflow contains exactly one load-bearing API
call — `POST /api/air-booking/v1/air-booking/page/air/booking/shopping` —
parameterized with origin, destination, depart date, passenger count,
and fare type, with all Akamai bot-detection headers correctly stripped
by the LLM.

## Status: blocked by Akamai (2026-05-03)

`bun src/cli.ts cron southwest --once` fails with:

```
[FORBIDDEN] Request 0 returned 403: { "code": 403050700 }
```

Southwest's API sits behind Akamai Bot Manager. The 403 fires regardless
of whether we send the captured `_abck` cookie — Akamai validates a
sensor token bound to live JS execution + TLS fingerprint, neither of
which a Node `fetch` client can satisfy. Replaying captured headers /
cookies isn't enough.

This is the canonical anti-bot scenario the README warns about under
the Claude Desktop env-stripping note and that `docs/capture-protocol.md`
documents under "If something goes wrong → bot-detection".

## Why it's still in-tree

The pipeline ran end-to-end, so this directory documents:

- A recorded session that survives `check` cleanly (813 requests, 261
  POST/PUT/DELETE, 53 cookies — a typical SPA capture)
- That `imprint redact --keep-header x-api-key` correctly preserves the
  public Apigee key while still scrubbing per-user secrets
- That the intent-detection prompt's bot-header rules work in practice
  (the generated `workflow.json` has zero `EE30zvQLWf-*` headers despite
  them being everywhere in the capture)
- That the `notifyWhen` predicate is correctly configured for Southwest's
  response shape (string-typed `airProducts[].lowestFare.value` — the
  path walker handles the string→number coercion as of the same commit)
- That the new `FORBIDDEN` error class surfaces the body so the operator
  isn't sent down the wrong remediation path

## What to do for an actual demo

Pivot to a less-protected airline. JetBlue, Frontier, Spirit, and Alaska
all have public flight-search APIs that respond to non-browser clients.
The capture/codegen process is identical — just record there instead.
The only thing that changes per-airline is the `pricePath` (each API
nests prices differently).
