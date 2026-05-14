# Imprint architecture

## The core idea

Imprint records a real browser session, then compiles it into TWO deterministic artifacts:

1. **`workflow.json`** — the captured API call chain, replayable via native `fetch()`. Fast (~200ms), with named captures for cookies, headers, body values, and browser-minted state.
2. **`playbook.yaml`** — the captured DOM script, replayable via Playwright. Slow (~9s), works everywhere a real browser does.

Both are auto-discovered by the cron daemon and the MCP server, which dispatch through a **backend ladder** that escalates through cheaper-to-costlier replay strategies on `FORBIDDEN` and satisfiable `STATE_MISSING` errors.

## Data flow

```
                       ┌──────────────────┐
                       │  imprint record  │   ← user drives a real Chrome,
                       └─────────┬────────┘     narrates what they're doing
                                 ▼
                       session.json + .jsonl
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   ┌─────────────────────┐               ┌──────────────────────┐
   │ imprint generate    │               │ imprint compile-     │
   │  (LLM → workflow)   │               │   playbook (LLM)     │
   └──────────┬──────────┘               └──────────┬───────────┘
              ▼                                     ▼
       workflow.json                          playbook.yaml
              │                                     │
       imprint emit                                 │
              │                                     │
              ▼                                     │
   ~/.imprint/<site>/<toolName>/index.ts            │
              │                                     │
              ▼                                     ▼
   ┌─────────────────────────────────────────────────────────┐
   │  imprint cron <site>     ┌─►  backend ladder            │
   │  imprint mcp-server      │      fetch ─STATE_MISSING→    │
   │  imprint playbook        │      fetch-bootstrap ─→       │
   │                          │      stealth-fetch ─→         │
   │                          │      playbook                 │
   └──────────────────────────┴───────────────────────────────┘
```

## Module map

```
src/imprint/
├── record.ts            CDP capture + DOM listener + JSONL stream
├── session-writer.ts    JSONL writer + Session assembler
├── inject-listener.ts   Sentinel-prefixed DOM event capture (injected)
├── redact.ts            Credential / PII scrub
├── check.ts             Sanity-check captured sessions
│
├── compile.ts           One LLM compiler, two configs:
│                          - generate (Workflow)
│                          - compilePlaybook (Playbook)
├── compile-agent.ts     Agentic compile orchestrator (session → workflow.json + parser.ts)
├── agent.ts             General-purpose tool-using agent loop + per-turn/per-tool tracing
├── claude-cli-compile.ts  Claude CLI compile driver with stream-json per-turn tracing
├── codex-cli-compile.ts   Codex CLI compile driver with JSONL per-turn tracing
├── compile-tools.ts     Compile-agent read/write/test tools + state hints
├── request-context.ts   Shared request metadata compaction for LLM context
├── llm.ts               Provider wrappers + JSON extraction + trace spans
├── tracing.ts           OpenInference/Phoenix tracing helpers
├── playbook-parser.ts   YAML → Playbook (Zod-validated)
│
├── emit.ts              workflow.json → ~/.imprint/<site>/<toolName>/index.ts
├── runtime.ts           executeWorkflow — substitutions + state captures + classification
├── cookie-jar.ts        Runtime cookie jar + Set-Cookie ingestion
├── tool-loader.ts       Discover ~/.imprint/<site>/<toolName>/index.ts modules
│
├── backend-ladder.ts    runWithLadder + resolveLadder
├── stealth-fetch.ts     Headless Chromium → mint sensor tokens → native fetch
├── playbook-runner.ts   Playwright + stealth + locator priority + DOM walk
│
├── cron.ts              Polling daemon
├── mcp-server.ts        MCP stdio + Streamable HTTP
├── probe-backends.ts    Try each backend at record time → backends.json
├── notify.ts            evaluateNotifyWhen + Pushover/ntfy delivery
├── login.ts             Session.json → credentials store
│
├── chromium.ts          Locate + launch Chromium for CDP
├── doctor.ts            Environment health check (Bun, Chromium, Vertex env)
├── json-path.ts         Dot-path walker (a[].b.c)
├── load-json.ts         Shared file/JSON/schema-validation helper
├── log.ts               createLog factory + isDebug/isQuiet env helpers
├── sites.ts             availableSitesHint — "did you mean?" for site typos
├── types.ts             Zod schemas (Session, Workflow, Playbook, Cron, etc.)
└── version.ts           Single source for VERSION (read from package.json)
```

## Backend ladder

| Backend | Per-call cost | Defeats |
|---|---|---|
| `fetch` | ~200ms | Plain APIs, persisted cookies, in-flight HTTP captures |
| `fetch-bootstrap` | Chromium bootstrap + native API replay | Workflows where the page only needs to mint cookies, CSRF, storage, or DOM-derived state |
| `stealth-fetch` | ~12s bootstrap (one-time) + ~1s | Akamai, Cloudflare, DataDome (token tier) |
| `playbook` | ~9.4s | Universal — also handles form-fills, autocompletes, multi-page |

`auto` mode walks the ladder. `fetch-bootstrap` is gated: it is inserted only when `workflow.bootstrap` exists, when a capture declares `browser_bootstrap` / `stealth_bootstrap`, or when `fetch` returns a `STATE_MISSING` result that the browser backend can satisfy. `stealth-fetch` supplies bot-defense cookies/headers to API replay; it does not fill `${state.NAME}` placeholders by itself. The probe-backends cache (`~/.imprint/<site>/<toolName>/backends.json`) reorders the ladder so cron + MCP start with the cheapest known-working backend; v2 caches include canonical workflow and capability hashes so stale caches are ignored. For multi-tool sites, `cron` and `probe-backends` require `--tool <toolName>` unless the provided `--config` / `--out` path is inside the target tool directory.

## State-aware API replay

Workflows can now define named captures:

- Request captures: `json`, `response_header`, `text_regex`, `cookie`
- Bootstrap captures: `cookie`, `local_storage`, `session_storage`, `html_regex`, `dom_attribute`, `dom_text`

The workflow surface is explicit:

```ts
type StateCapability =
  | 'ordinary_http'
  | 'browser_bootstrap'
  | 'stealth_bootstrap'
  | 'credential_required'
  | 'unsupported';

type RequestEffect = 'safe' | 'idempotent' | 'unsafe';

type WorkflowRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  extract?: Record<string, string>; // legacy ${response[N].name}
  captures?: RequestCapture[];
  effect?: RequestEffect;
};

type WorkflowBootstrap = {
  url: string;
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
  waitMs?: number;
  timeoutMs?: number;
  captures?: BootstrapCapture[];
};
```

Captured values enter the per-execution `${state.NAME}` namespace. That namespace is the compiler's canonical output for ephemeral values like CSRF tokens, session nonces, and cookies copied into later headers. Direct `${cookie["NAME"]}` lookup remains an expert escape hatch and resolves against the current request URL; ambiguous lookups fail with `STATE_MISSING`.

`response_header` captures must choose `mode: "first" | "last" | "all"` for duplicate headers. `Set-Cookie` is intentionally not a normal response-header capture: the runtime ingests it into the cookie jar first, then workflows capture cookies from the jar. Cookie captures can constrain `url`, `domain`, `path`, and `sameSite`; projecting an `HttpOnly` cookie into a custom header/body requires explicit `allowHttpOnlyProjection: true`.

Each execution gets an isolated mutable state object and `RuntimeCookieJar`. The runtime executes requests in order, substitutes known placeholders, ingests `Set-Cookie`, evaluates captures, and makes later requests see the new `${state.*}` and cookie values. `rawResponses[]` remains separate from `responseSlots[]` so parser modules still receive the original response shape while legacy `extract` aliases continue to work.

`STATE_MISSING` is structured with a capability:

- `ordinary_http` — an earlier safe/idempotent HTTP request was expected to produce it.
- `browser_bootstrap` — a short browser bootstrap may produce it.
- `stealth_bootstrap` — stealth/browser bot-defense bootstrap may produce it.
- `credential_required` — the user must provision credentials or rerun `imprint login`.
- `unsupported` — the workflow references state no backend can produce.

The ladder escalates only when every required missing item is satisfiable by the next backend. It never blindly escalates missing credentials or unsupported workflow gaps to DOM replay.

## File taxonomy

```
~/.imprint/<site>/<toolName>/
├── workflow.json               output of `imprint generate`
├── parser.ts                   API-response → structured output
├── request-transform.ts        optional — URL signing / request mutation
├── playbook.yaml               output of `imprint compile-playbook`
├── index.ts                    output of `imprint emit` (consumed by cron + MCP)
├── cron.json                   schedule + params + replayBackend + notifyWhen
└── backends.json               output of `imprint probe-backends`

~/.imprint/<site>/sessions/      (local only — auth tokens / PII)
├── <ts>.jsonl                  raw streaming capture
├── <ts>.json                   assembled session
└── <ts>.redacted.json          after `imprint redact`
```

The tracked `examples/` directory remains as source fixtures and demos, but runtime discovery and generated assets live under `IMPRINT_HOME` (`~/.imprint` by default).

## Compile context and tracing

LLM-facing overview payloads are intentionally compact. Candidate detection, request triage, and compile-agent `read_session_summary` all collapse repeated identical request metadata into one representative row with `repeatCount`, `repeatedSeqs`, and `lastTimestamp`. Candidate-selected requests and auth/setup dependencies stay as separate rows so a tool-specific request cannot disappear inside a shared representative. Full request and response bodies are still available through the explicit compile-agent tools (`read_request`, `read_response_body`, `search_response_body`).

Set `IMPRINT_TRACE=1` with `PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006` to emit OpenInference spans to a local Phoenix server. The trace hierarchy drills into every stage of the compile pipeline:

```
cli.teach (AGENT)
├─ compile.triage_requests (RETRIEVER)
│   └─ llm.analyze (LLM)
├─ teach.detect_tool_candidates (AGENT)
│   └─ llm.analyze (LLM)
├─ compile.generate (AGENT)
│   ├─ agent.turn.1 (CHAIN)           ← per-turn token counts
│   │   ├─ llm.message_with_tools (LLM)  ← model, tokens, stop reason
│   │   ├─ agent.tool.read_session_summary (TOOL)
│   │   └─ agent.tool.write_file (TOOL)
│   ├─ agent.turn.2 (CHAIN)
│   │   └─ ...
│   └─ ...
└─ compile.playbook (CHAIN)
    ├─ compile.triage_requests (RETRIEVER)
    └─ llm.analyze (LLM)
```

Each `agent.turn.N` span records per-turn input/output tokens and stop reason. Each `llm.message_with_tools` span records model, provider, token counts, and which tools the model called. Each `agent.tool.X` span records tool execution time, result size, and (when `IMPRINT_TRACE_TOOL_IO=1`) the input arguments and output.

Add `IMPRINT_TRACE_LLM_IO=1` and `IMPRINT_TRACE_TOOL_IO=1` when you need prompts, responses, tool arguments, and tool results in the trace UI. Token counts come from the provider when available and fall back to estimates otherwise; cost attributes are added when `IMPRINT_TRACE_INPUT_USD_PER_1M` and `IMPRINT_TRACE_OUTPUT_USD_PER_1M` are set.

**Ephemeral artifacts** the compile-agent writes during a run but does not persist:

- `parser.test.ts` — `bun:test` suite that exercises `parser.extract()` against the load-bearing response body. Reads the redacted session via `process.env.IMPRINT_SESSION_PATH` set by the harness. Deleted after verification passes; pass `--keep-test` to `teach` / `generate` to retain it for local debugging.
- `integration.test.ts` — live API test that imports the generated tool and calls `executeWorkflow` with default params. Verifies the workflow produces real data (catches expired hardcoded tokens, missing URL signing). Also deleted after verification unless `--keep-test`.
- `.compile-log.json`, `.compile-done.json`, `.compile-give-up.json` — agent loop transcript + sentinels (gitignored).

## Extending Imprint

Three load-bearing extension points if you fork or contribute upstream:

### Add a new `notifyWhen` predicate type

`src/imprint/types.ts` — add a new variant to `NotifyWhenSchema` (z.discriminatedUnion). Then in `src/imprint/notify.ts`'s `evaluateNotifyWhen` add the matching switch case. The dispatcher pattern (single discriminator + exhaustive switch) means TypeScript will fail to compile if you forget to handle the new type.

Example: `volume_above` (push when an array's length exceeds N) would be ~15 LOC across the schema + the case.

### Add a per-site auth extractor (for `imprint login`)

`src/imprint/login.ts` — the `EXTRACTORS` array is an ordered list of `{ name, match }`. Each `match` takes a Session and returns either a values map or `null`. Add a new entry for the auth pattern of your site (URL shape + response body shape that yields the named credential value). The runtime substitutes those values into workflow templates as `${credential.NAME}`.

Pattern in v0.1: 1 extractor (Discover & Go's `Login` POST → `patron_id` / `session_id` / `patron_email`). Adding another is purely additive.

### Add a new replay backend

Less common, but if you build e.g. `paid-stealth-fetch` (an external stealth API) or `playwright-cdp-pool` (long-lived browser):

1. Add the backend name to `ReplayBackendSchema` in `types.ts`.
2. Add a switch case in `runWithLadder()` (`src/imprint/backend-ladder.ts`) — the case body invokes your backend and returns a `ToolResult`.
3. Update `DEFAULT_LADDER` and `resolveLadder` if the new backend should be in the auto cascade.
4. Add a probe entry in `probe-backends.ts`'s `allBackends` list.
5. Define which `StateCapability` values the backend can satisfy if it should participate in `STATE_MISSING` escalation.

The ladder's escalation logic is shape-preserving: your backend returns a `ToolResult`, and the ladder routes `FORBIDDEN` plus satisfiable `STATE_MISSING` to the next backend while returning terminal errors directly.

### Add a request transform (URL signing, header injection)

Some APIs require per-request URL signing (HMAC, CRC32, OAuth). The signing keys are public app-level constants in client-side JavaScript. The compile-agent can reverse-engineer these from captured JS bundles.

Set `workflow.requestTransformModule` to the relative path of a sibling TypeScript module (e.g. `"./request-transform.ts"`). The module exports:

```ts
export function transform(method: string, url: string, responses: unknown[]): string
```

The runtime calls `transform` before each outgoing request. The `responses` array contains previous response bodies from the workflow chain, enabling dynamic URL construction (e.g. building a domain list from search results for a batch status check).

The compile-agent writes this module when `stateHints` flag `query_param_changes_across_calls` — high-entropy query params that vary per call. It uses `search_response_body` to find the signing function in `.js` responses and replicates it.

Example: `examples/namecheap-domains/search_namecheap_domains/request-transform.ts` implements Namecheap's CRC32 + XOR + base64 URL signing scheme.

### Parser context

The parser's `extract()` function receives an optional second argument:

```ts
extract(rawResponse: unknown, context?: { params: Record<string, string | number | boolean>; responses: unknown[] }): unknown
```

- `context.params` — the tool parameters the caller provided.
- `context.responses` — all response bodies from the workflow chain (index 0 = first request).

Use `params` when the parser needs a value the API doesn't echo back (e.g. the search term for constructing domain names from a TLD catalog). Use `responses` when the parser merges data from multiple chained requests.
