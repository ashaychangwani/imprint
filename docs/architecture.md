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
   │                          │      cdp-replay ─→            │
   │                          │      stealth-fetch ─→         │
   │                          │      playbook                 │
   └──────────────────────────┴───────────────────────────────┘
```

## Module map

```
src/imprint/
│ ── Orchestration ──
├── teach.ts             End-to-end pipeline: record → redact → [replay-and-diff ‖ triage → detect → select] → plan-prereqs → (per-tool: plan-tool → generate) → compile-playbook → emit → register
├── teach-plan.ts        plan-prereqs step: build plan + level-parallel shared-module build before the per-tool fan-out (multi-tool only)
├── tool-plan.ts         plan-tool step: per-tool implementation plan (param→field map, request/parse plan, module imports) injected into the compile agent
├── integrations.ts      Platform registration (Claude Code, Codex, Claude Desktop, OpenClaw, Hermes)
│
│ ── Capture ──
├── record.ts            CDP capture + DOM listener + JSONL stream
├── session-writer.ts    JSONL writer + Session assembler
├── inject-listener.ts   Sentinel-prefixed DOM event capture (injected)
├── redact.ts            Credential / PII scrub
├── freeform-redact.ts   Supplemental free-form PII/secret detection (105 patterns; request-side only, generic catch-alls excluded)
├── sensitive-keys.ts    Sensitive credential key lists for extraction + redaction
├── credential-extract.ts  Automatic login-pair detection + redaction mapping from sessions
├── check.ts             Sanity-check captured sessions
│
│ ── Dual-pass replay ──
├── replay-capture.ts    Raw DOM event replay in fresh browser for dual-pass analysis
├── session-diff.ts      Request alignment + value classification (constant/server_derived/browser_minted)
│
│ ── Compile ──
├── compile.ts           LLM compiler entry points: generate() + compilePlaybook()
├── build-plan.ts        Multi-tool build plan: BuildPlan schema + planner (shared modules, per-tool guidance, auth recipe)
├── prereq-builder.ts    Builds + verifies shared `_shared/*.ts` modules (single-shot LLM → verifySharedModule loop)
├── compile-agent.ts     Agentic compile orchestrator (session → workflow.json + parser.ts)
├── compile-agent-types.ts  Shared types for compile agent (progress, result)
├── agent.ts             General-purpose tool-using agent loop + per-turn/per-tool tracing
├── claude-cli-compile.ts  Claude CLI compile driver with stream-json per-turn tracing
├── codex-cli-compile.ts   Codex CLI compile driver with JSONL per-turn tracing
├── compile-tools.ts     Compile-agent read/write/test tools + state hints
├── request-context.ts   Shared request metadata compaction for LLM context
├── tool-candidates.ts   Multi-tool detection from a single recording session
├── tool-selection.ts    Tool selection helpers for cron + probe
├── llm.ts               Provider wrappers + JSON extraction + trace spans
├── tracing.ts           OpenInference/Phoenix tracing helpers
├── playbook-parser.ts   YAML → Playbook (Zod-validated)
│
│ ── Emit + Runtime ──
├── emit.ts              workflow.json → ~/.imprint/<site>/<toolName>/index.ts
├── mcp-compile-server.ts  MCP server for compile operations (claude-cli integration)
├── runtime.ts           executeWorkflow — substitutions + state captures + classification
├── cookie-jar.ts        Runtime cookie jar + Set-Cookie ingestion
├── tool-loader.ts       Discover ~/.imprint/<site>/<toolName>/index.ts modules
│
│ ── Backend ladder ──
├── backend-ladder.ts    runWithLadder + resolveLadder
├── stealth-fetch.ts     Bootstrap Chromium → capture sensor tokens + live UA/client-hints → native fetch
├── stealth-token-cache.ts  Per-site stealth token shared across compile-time bun-test processes
├── cdp-browser-fetch.ts  Record-faithful transport: real HEADED Chrome (launchChromium+CDP) runs each request in-page
├── playbook-runner.ts   Playwright + stealth + locator priority + DOM walk
│
│ ── Services ──
├── cron.ts              Polling daemon
├── mcp-server.ts        MCP stdio + Streamable HTTP
├── audit.ts             Acceptance gate: headless-claude exercises every tool, imprint scores it deterministically
├── install.ts           Register/remove emitted local or example tools with MCP clients
├── probe-backends.ts    Probe each backend sequentially → backends.json
├── notify.ts            evaluateNotifyWhen + Pushover/ntfy delivery
├── login.ts             Session.json → credentials store
│
│ ── Credentials ──
├── credential-store.ts  Credential storage abstraction (keyring → encrypted file → legacy JSON)
├── credential-bundle.ts Import/export encrypted credential bundles
├── cli-credential.ts    `imprint credential` CLI commands (list/get/set/delete/export/import)
│
│ ── Utilities ──
├── chromium.ts          Locate + launch Chromium for CDP
├── doctor.ts            Environment health check (Bun, Chromium, LLM providers)
├── etld.ts              eTLD+1 domain parsing (registrable domains)
├── json-path.ts         Dot-path walker (a[].b.c)
├── load-json.ts         Shared file/JSON/schema-validation helper
├── log.ts               createLog factory + isDebug/isQuiet env helpers
├── paths.ts             IMPRINT_HOME path resolution + site/tool directory helpers
├── progress.ts          Compile-agent progress formatting
├── sites.ts             availableSitesHint — "did you mean?" for site typos
├── types.ts             Zod schemas (Session, Workflow, Playbook, Cron, etc.)
└── version.ts           Single source for VERSION (read from package.json)
```

## Backend ladder

| Backend | Per-call cost | Defeats |
|---|---|---|
| `fetch` | ~200ms | Plain APIs, persisted cookies, in-flight HTTP captures |
| `fetch-bootstrap` | Chromium bootstrap (cached jar, ~90 min) + native API replay | Workflows where the page only needs to mint cookies, CSRF, storage, or DOM-derived state, then replay via plain fetch (handles a **single** anti-bot POST) |
| `cdp-replay` | Real Chrome held open for the workflow | Multi-step state-changing anti-bot flows (a sequence of `*.act` POSTs) where each protected POST self-invalidates `_abck` |
| `stealth-fetch` | ~12s bootstrap (one-time) + ~1s | Akamai, Cloudflare, DataDome (token tier) |
| `playbook` | ~9.4s | Universal — also handles form-fills, autocompletes, multi-page |

`auto` mode walks the ladder. `fetch-bootstrap` is always spliced after `fetch` (it only **runs** when `fetch` escalates, so a healthy plain-API site never pays for it); `cdp-replay` is spliced after `fetch-bootstrap`. `stealth-fetch` supplies bot-defense cookies/headers to API replay, applies workflow parameter defaults before resolving its bootstrap URL, and can project supported bootstrap captures (`cookie`, `html_regex`, `response_header`) from the same stealth session.

The **`cdp-replay`** rung is the record-faithful trusted-browser transport for the API path (`cdp-browser-fetch.ts`): a real Chrome launched as `imprint record` does (`launchChromium` + raw CDP, no automation flags) stays **open** for the whole workflow and runs each **same-origin** request *in-page* via `fetch(..., {credentials:'include'})`, while cross-origin requests (e.g. an `api.*` subdomain, which CORS would block in-page and which usually aren't behind the same wall) fall through to a plain fetch. This is the only transport that **sustains a sequence** of behavioral-anti-bot-protected POSTs: a sensitive `*.act` POST invalidates Akamai's `_abck` (`~0~`→`~0~-1~-1~`), and only the live page's bmak sensor re-posts the telemetry that re-validates it before the next call — so `fetch-bootstrap`'s plain-fetch replay dies after ~1–2 POSTs while cdp-replay carries the full search→agency→details chain. It runs **headless by default** — the only headless edge-tell, the `HeadlessChrome` UA token, is stripped via a CDP UA override before navigating — and validates the sensor cookie via synthetic mouse/scroll before replaying. Because the doomed cheaper rungs' tarpitted attempts themselves burn the per-IP rate budget, for workflows with **≥2 mutating requests behind an anti-bot signal** (a `bootstrap` block or `${state.X}`-referencing requests) `cdp-replay` is reordered to run **first** (`prefersCdpReplayFirst`). Headless needs no display; the `headed`+Xvfb path is a fallback for GPU-less Linux hosts where headless WebGL would report SwiftShader (see [troubleshooting](troubleshooting.md#running-on-a-headless-server-anti-bot-sites)). The same rung is also in the **compile-time** verification ladder, so anti-bot multi-step state-changing tools (whose live baseline `fetch`/`fetch-bootstrap`/`stealth-fetch` can't sustain) verify and ship instead of failing compile. The `playbook` rung is the DOM-walk last resort (needs a compiled `playbook.yaml`). The probe-backends cache (`~/.imprint/<site>/<toolName>/backends.json`) reorders the ladder so cron + MCP start with the cheapest known-working backend; v2 caches include canonical workflow and capability hashes so stale caches are ignored by runtime but reported by `imprint mcp status`. For multi-tool sites, `cron` requires `--tool <toolName>` unless the provided `--config` path is inside the target tool directory; `probe-backends` can target one tool with `--tool` / `--out` or refresh every generated tool with `--all`. `probe-backends` probes each applicable backend individually (single-rung ladders) to build the full matrix of working/failed backends and ranks working rungs by observed runtime, keeping unusually slow successes behind faster working backends. CDP replay gets one extra warm-pool measurement after a successful cold run; `backends.json` records `coldDurationMs`, `warmDurationMs`, and `rankingDurationMs` so a timeout-safe cold CDP start can still rank by its fast warm runtime, while cold-too-slow CDP stays behind cold-safe backends in the durable order for the next process. MCP and cron persist the backend that actually succeeds at runtime so the next process starts from that known-good rung instead of rediscovering blocked earlier rungs, but they do not durable-frontload a cold-too-slow CDP success ahead of a known cold-safe backend. For workflows that need bootstrap, the probe includes `cdp-replay` alongside `fetch-bootstrap` so it appears in `preferredOrder` when it works — without probing it, runtime would always fall through `fetch-bootstrap` (~30–60s) before reaching `cdp-replay`, wasting time on every call. The stealth-fetch bootstrap state is shared across probe runs via a per-site cache to avoid re-bootstrapping per backend.

**CDP pool.** At runtime, the `cdp-replay` backend supports a per-site `cdpPool` option that reuses a live Chrome instance across multiple tool calls instead of launching a fresh browser each time. This cuts per-call overhead from ~33–35s (cold launch + navigate + sensor validation) to ~2–5s (reuse existing page context). The pool is keyed by site and managed by the MCP server (`mcp-server.ts`); idle sessions are closed after 5 minutes (`CDP_IDLE_TIMEOUT_MS`). `probe-backends` also uses a temporary pool only to measure CDP warm reuse after a successful cold probe, then closes it before exiting. Compile uses its own process-global verification pool.

**Authenticate-tool backends.** An `authenticate` tool is an ordinary tool — it rides the **same backend ladder** as data tools (`fetch` → `fetch-bootstrap` → `cdp-replay` → `stealth-fetch` → `playbook`); there is no bespoke login backend. `executeAuthWorkflow` (`runtime.ts`) only adds auth phasing: it splits the recorded `requests` into `initiate` / `complete` / `submit_otp` by `initiateRequestCount`, polls `pollEndpoint` for push approval, and returns `AWAITING_2FA` for 2FA types.

**Auth compile is an agent-orchestrated, segmented loop** (`auth-compile-agent.ts`, `auth-verifier.ts`). The compile agent is the *brain*: it shapes `workflow.json` (+ `playbook.yaml` for browser-minted logins) **from the recording only — it never logs in itself**. A separate **verification stage** is the only thing that fires a live login. The agent pauses at **checkpoint tools** (`run_verification` / `prompt_user` / `wait_for_cooldown`); each writes a sentinel and ends the agent's turn (claude-cli segment), and the orchestrator (`teach`) performs the action and **resumes the same claude session via `--resume`** with the result. `AuthVerifier` holds one **persistent `cdpPool`** so the live session is reused across 2FA phase 1 (send the OTP/push → `AWAITING_2FA`) → the user's input (`prompt_user` renders an agent-generated message in the teach TUI) → phase 2 (submit the code / poll) — never a fresh browser, which would reset the challenge. Live `initiate` logins are budget-capped (`IMPRINT_AUTH_MAX_INITIATE`, default 2) so the user sees at most two prompts; on a rate-flag the agent calls `wait_for_cooldown` (5–10 min, no login) instead of hammering. A completed login persists a **durable session token** — cookies plus any `authConfig.sessionCapture` values (a bearer/CSRF token from the completion response, stored as `${credential.NAME}`) — so data tools reuse it and re-auth only on `AUTH_EXPIRED`.

**2FA is modeled structurally, not by channel.** `authConfig.twoFactorType` is one of `none`, `otp`, or `push` — derived from the *shape* of the recorded flow, never the delivery channel. SMS, email, and authenticator-app (TOTP) codes are all `otp`: a short code the user supplies out-of-band that a second request consumes via `${param.otp_code}`. `push` is the only structurally distinct case: poll one endpoint until a **recording-grounded** terminal resolves. The terminal is `authConfig.pollTerminal` — a capture (the same kind `requests` use) that resolves only on the approved poll response; absent it, the runtime falls back to "a fresh session `Set-Cookie` appeared". There is no hardcoded "approved/success" string matching.

The two-call OTP chain is **stateless**: a token the initiate response returns in its body (e.g. a reauth `mfaId`) is captured on the initiate request, its names listed in `authConfig.twoFactorContext`, and echoed back to the caller in the `AWAITING_2FA` result. The caller passes that `twoFactorContext` object back on the `submit_otp` call, where it is seeded as `${state.X}` so the completion request resolves it — no server-side session state, no TTL. Cookie-bound tokens need nothing extra; they round-trip through `saveSiteCookies`. The compile agent decides how the login reproduces:

- **Replayable login** — the credential POST is a plain form/JSON body. The API rungs replay it; success = the recorded login response is reproduced. Only `workflow.json` is emitted.
- **Browser-minted login** — the POST body is computed by the page's own JS per session (encrypted credential blobs, per-load nonces), so replaying the recorded body sends a stale value. The agent also emits a **`playbook.yaml`** of the recorded login DOM steps (type username/password, submit) with credentials as `${credential.*}`; the `playbook` rung runs them in a real stealth browser so the page mints a fresh valid body. The playbook's `result` extracts a recording-grounded success marker, so a login routed to an enrollment/setup page (not the recorded authenticated landing) fails honestly. For a 2FA site that marker is the **2FA-challenge** state (the OTP screen / push-pending), and the ladder **reshapes that `ok: true` into `AWAITING_2FA`** so playbook- and API-reached 2FA look identical to callers.

**Serialized browser session across the two calls.** A login that runs on the `playbook` rung mints its session in a real browser, but `submit_otp`/`complete` are separate stateless MCP calls. After a login playbook reaches the 2FA challenge, the runner harvests both the browser's session **cookies** (`saveSiteCookies`) **and per-origin `localStorage`** (`context.storageState()` → `saveSiteStorage`, gated on `toolKind === 'authenticate'`); the next call rehydrates them (cookies into the jar, `localStorage` via an origin-guarded `addInitScript`). A single-use chain token minted *during* the playbook (e.g. an OTP-send `SecurityCode`) is pulled out best-effort via the playbook's optional `captures` (each `name` matching a `twoFactorContext` entry) and carried the same way. The API path persists cookies identically. `otp` spans two calls (`initiate` → `submit_otp` with `otp_code`, plus the echoed `twoFactorContext`); `push`/`none` complete in one `initiate` (`push` blocks on `complete`). `imprint teach` will **attempt** the completion unattended — a placeholder `otp_code` (`000000`) for `otp`, a bounded poll (`IMPRINT_AUTH_POLL_ATTEMPTS`) for `push` — and report the outcome honestly (it usually fails without a live second factor; reaching *and* attempting 2FA is the bar, not completing it).

The one case still not supported: a browser-minted login whose OTP must be typed into that **same live page** holding **non-serializable in-page JS state** — cookies + `localStorage` round-trip, but live WebCrypto handles / closures in the original page do not. Such a login is still *attempted* (and fails honestly); the compile agent does not `give_up` over it, since reaching the 2FA challenge is the compile-time goal.

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
├── request-transform.ts        optional — URL signing / request mutation (may import ../_shared/*)
├── playbook.yaml               output of `imprint compile-playbook`
├── index.ts                    output of `imprint emit` (consumed by cron + MCP)
├── cron.json                   schedule + params + replayBackend + notifyWhen
└── backends.json               output of `imprint probe-backends`

~/.imprint/<site>/_shared/       (multi-tool only — shared modules reused across the site's tools)
├── <name>.ts                   request-transform / parser-helper / types, imported via ../_shared/<name>.ts
└── package.json + node_modules  toolchain for verifying the shared modules

~/.imprint/<site>/.build-plan.json   plan sidecar (shared modules + per-tool guidance + auth recipe)

~/.imprint/<site>/sessions/      (local only — auth tokens / PII)
├── <ts>.jsonl                  raw streaming capture
├── <ts>.json                   assembled session
└── <ts>.redacted.json          after `imprint redact`
```

The tracked `examples/` directory remains as source fixtures and demos, but runtime discovery and generated assets live under `IMPRINT_HOME` (`~/.imprint` by default).

## Compile context and tracing

LLM-facing overview payloads are intentionally compact. Candidate detection, request triage, and compile-agent `read_session_summary` all collapse repeated identical request metadata into one representative row with `repeatCount`, `repeatedSeqs`, and `lastTimestamp`. Candidate-selected requests and auth/setup dependencies stay as separate rows so a tool-specific request cannot disappear inside a shared representative.

**Inline data.** For candidate-scoped requests (`requestSeqs ∪ dependencySeqs`), the session summary includes `inlineData` — full request headers, request body, response headers, and a smart-truncated response body (full for JSON ≤16 KB, structure summary + first 8 KB for JSON >50 KB, first 4 KB for HTML). This eliminates 20-30 serial `read_request` / `read_response_body` tool calls the agent would otherwise need, keeping context growth linear instead of quadratic. A budget-aware reduction strategy (`SUMMARY_SIZE_BUDGET = 30 KB`) progressively strips response bodies, then request bodies, then all inline data to stay within `claude-cli`'s tool-result size limit. Full bodies are still available via `read_request`, `read_response_body`, and `search_response_body` for requests outside the candidate scope or when the inline preview is truncated.

**Capture hints.** When dual-pass replay classifications are available, the session summary also includes `captureHints` — ready-to-use capture block suggestions translated from `server_derived` classifications. Each hint specifies the producer request index, a capture definition (`source`, `name`, `path`/`header`/`cookie`), and which downstream requests consume the captured value. The compile agent can copy these directly into `workflow.json` instead of manually discovering value provenance.

**Differential parameter grounding.** For each UI event in the candidate's `eventSeqs` (filter toggle, sort change, button click), `param-grounding.ts` finds the first candidate-scoped request it triggered (within a 12-request window), diffs its decoded body against the most recent prior request of the same endpoint, and reports the changed paths. This is deterministic and site-agnostic: JSON bodies, Google `batchexecute` `f.req=` envelopes, and plain form fields are all decoded transparently. The resulting `EventGrounding[]` array — each entry carrying `eventSeq`, `triggeredSeq`, `priorSeq`, `endpoint`, and `changes` (path/before/after) — is surfaced in the session summary so the compile agent maps each diff to a `likelyParam` (the semantic step the model is good at) instead of guessing at an encoding. Session-churn paths (positions that change across most events — rotating tokens, pagination flags) are automatically filtered so only the param-specific signal remains. The diff is scoped to the candidate's own request endpoints (`endpointsForSeqs`) to avoid mistaking telemetry POSTs for the trigger.

**Input-value provenance hints.** Some parameters carry an opaque id (entity handle, place id, category token) minted by an earlier response, not the user's text. The compile agent historically shipped these as the raw param text, which the backend silently ignored. `param-grounding.ts`'s `inputProvenance()` detects these by walking each candidate request's decoded body for id-like leaf values (no whitespace, ≥6 chars, mixes character classes or is a delimited handle) and searching prior responses for the same value. Each match produces an `InputProvenance` record (`path`, `valueSample`, `requestSeq`, `sourceSeq`, `sourceEndpoint`, `selfChain`). `selfChain: true` indicates a resolve-then-refine pattern: the tool's own endpoint minted the id (e.g. a text search returns a place id, which a refined search sends back). These hints are surfaced as `inputProvenanceHints` in the compile agent's session summary, so the compiler chains the minting request and captures the id rather than hardcoding or substituting raw text.

Set `IMPRINT_TRACE=1` with `PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006` to emit OpenInference spans to a local Phoenix server. See [tracing.md](tracing.md) for the full setup and environment variable reference. The trace hierarchy drills into every stage of the compile pipeline:

```
cli.teach (AGENT)
├─ teach.combine_sessions (CHAIN)          ← from-scratch: merge sibling recordings (session/request/narration counts)
├─ teach.record (CHAIN)                    ← live capture (event count)
├─ teach.redact (CHAIN)                    ← credential/PII scrub (redaction stats)
├─ compile.triage_requests (RETRIEVER)
│   └─ llm.analyze (LLM)
├─ teach.detect_tool_candidates (AGENT)
│   └─ llm.analyze (LLM)
├─ teach.plan_prereqs (AGENT)              ← multi-tool: build plan + shared modules
│   ├─ llm.analyze (LLM)                       (planner)
│   └─ teach.build_shared_module (AGENT)       (plan-first + verify cycles; independent modules concurrent)
│       └─ llm.analyze (LLM)
├─ teach.plan_tool (AGENT)                 ← per-tool implementation plan (sibling of that tool's compile.generate)
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

The `audit` verb traces its own tree, so a failing acceptance run is debuggable in isolation:

```
cli.audit (AGENT)
└─ audit.session (AGENT)        ← imprint.audit.{score, correct, broken, infra, bad_params, graded, params_working, params_no_op, params_broken, params_untestable, verdict, timed_out, turns, cost_usd} + llm.cost.*
    └─ (headless claude drives the site's real mcp-server tools)
```

The `audit.session` span also carries the auditor's token/cost usage (parsed from the headless claude stream): `imprint.audit.cost_usd` is the CLI-reported figure and `llm.cost.*` is the token-based estimate. When the deadline guard kills the run, `imprint.audit.timed_out=true` and the verdict is `timeout` (see [troubleshooting](troubleshooting.md#audit)); the auditor's transcript is written next to the report for diagnosis.

Each `agent.turn.N` span records per-turn input/output tokens and stop reason. Each `llm.message_with_tools` span records model, provider, token counts, and which tools the model called. Each `agent.tool.X` span records tool execution time, result size, and (when `IMPRINT_TRACE_TOOL_IO=1`) the input arguments and output.

Stage spans carry their own end-attributes for fast triage: `teach.record` (`imprint.record.event_count`), `teach.redact` (`imprint.redact.*` counts), `teach.combine_sessions` (`imprint.combine.{session,request,narration}_count`), and `teach.plan_tool` (`imprint.tool_plan.chars` / `.skipped`). Opening the `cli.teach` trace lets you locate the failing stage by span status/attrs — a `teach.plan_prereqs` timeout, a `teach.build_shared_module` with `ok=false`, an empty `teach.plan_tool`, or a `compile.generate` that gave up.

Add `IMPRINT_TRACE_LLM_IO=1` and `IMPRINT_TRACE_TOOL_IO=1` when you need prompts, responses, tool arguments, and tool results in the trace UI. Token counts come from the provider when available and fall back to estimates otherwise — including the prompt-cache split (`cache_read`/`cache_creation`), so cost reflects the discounted cache-read rate (0.1×) and the cache-write premium (1.25×) rather than billing the whole prompt at the full input rate. Cost attributes are added whenever the model's rates are known — from the built-in rate table (`DEFAULT_MODEL_RATES` in `tracing.ts`) or from `IMPRINT_TRACE_INPUT_USD_PER_1M` / `IMPRINT_TRACE_OUTPUT_USD_PER_1M` overrides. `scripts/analyze-phoenix.ts` reads these emitted `llm.cost.*` attributes (it does not recompute), so its per-stage and trace totals always match the app's pricing.

**Cost rollup.** Root spans (`cli.teach`, `cli.audit`) use `tracedWithCostRollup` to accumulate `llm.cost.*` and `llm.token_count.*` from every descendant LLM span via an `AsyncLocalStorage`-based accumulator. Every child `llmCostAttributes` call adds its tokens and cost to the running total; when the root span completes, the accumulated totals are set as span attributes. This means a single `cli.teach` span carries the total cost across all planning, compilation, and verification LLM calls — including the cache-aware breakdown (uncached input, cache reads at 0.1×, cache writes at 1.25×, completion). See [tracing.md](tracing.md) for the full attribute reference and cost breakdown tables.

**Ephemeral artifacts** the compile-agent writes during a run but does not persist:

- `parser.test.ts` — `bun:test` suite that exercises `parser.extract()` against the load-bearing response body. Reads the redacted session via `process.env.IMPRINT_SESSION_PATH` set by the harness. Must include a `synthetic:empty-result` test — `extract()` must return a clean empty collection for a no-match/empty response, never a single all-null placeholder record; the verifier requires that test to be present and to pass. Deleted after verification passes; pass `--keep-test` to `teach` / `generate` (or set `IMPRINT_KEEP_TEST=1`) to retain it for local debugging.
- `integration.test.ts` — live API test that calls the workflow through the backend ladder (`runWorkflowWithLadder`: fetch → fetch-bootstrap → cdp-replay → stealth-fetch). A **baseline** test verifies the workflow produces real data (catches expired hardcoded tokens, missing URL signing), and one **`param:<name>`** test per exposed parameter overrides it with a discriminating value and asserts the response is actually constrained. The verifier identifies coverage by which `param:<name>` tests *ran green* (parsed from a JUnit report) — not a static source scan — so a suite waived by anti-bot can't be counted as covered. A parameter with no passing `param:` test that the agent annotates `// exposed-but-not-verified` ships flagged `verified:false` in `workflow.json` rather than being dropped (keep + mark). A parameter that is an **opaque token minted by a sibling tool** (e.g. a `get_*_details` tool's id that a `search_*` tool emits) is held to a stricter bar: its `param:<name>` test must mint a *fresh* value by calling the producer's `../<sourceTool>/workflow.json` and feed that (not the recorded constant) — reusing the recorded token is rejected as `unchained` (it can't prove the producer/consumer field contract). On success the param is stamped `sourcedFrom: {tool, field}`, which the MCP schema turns into a description telling the orchestrating LLM where to mint the value; if the producer is anti-bot-blocked at compile the param waives to `verified:false` reason `waived-chain`. To keep these live tests from re-bootstrapping headless Chromium per process (a burst that trips anti-bot), the compile-time stealth token is shared across the site's test processes via `stealth-token-cache.ts`. During `imprint teach`, the harness sets `IMPRINT_TEACH_CREDENTIALS` in the test subprocess so credentials extracted during redaction are available without requiring a separate `imprint credential set`. Also deleted after verification unless `--keep-test` or `IMPRINT_KEEP_TEST=1`.
- `.compile-log.json`, `.compile-done.json`, `.compile-give-up.json` — agent loop transcript + sentinels (gitignored).

## Multi-tool shared modules (plan-prereqs)

When one recording compiles into **two or more** tools, `imprint teach` inserts a `plan-prereqs` step between candidate selection and the per-tool compile fan-out. Single-tool recordings skip it entirely (the path is unchanged). Set `IMPRINT_NO_BUILD_PLAN=1` to disable it and compile every tool independently.

The step does two things, once per teach, before the fan-out:

1. **Plan** (`build-plan.ts`, single-shot `llm.analyze` against `prompts/build-planning.md`) — produces a `BuildPlan`: the shared modules to create (`request-transform` signing, `parser-helper` decoders, shared `types`), per-tool guidance (load-bearing seqs, parser guidance, parameter checklist), an `authRecipe` each tool replicates inline, and the cross-tool **opaque-token contract** (consumer `tokenParams` ⇄ producer `emitsTokens`). The contract is not left to the planner's discretion: `deriveTokenContractHints` first walks the dual-pass classifications **deterministically** — any value with recovered producer provenance sent by one tool but produced in a *different* tool's response (matched by `producerSeq`/`originalSeq` → owning tool via `requestSeqs`; `header:` session tokens and shared/ambiguous seqs skipped) — and feeds those grounded edges into the planner payload. Provenance covers two cases: a `server_derived` value (it *varied* across the two replay passes and was found in a prior response) and a stable `constant` whose **opaque** value also appears in a prior response. The latter matters because the dual-pass replays the *same* flow, so a per-entity token (same hotel → same id) is identical across passes and classified `constant` — its provenance is recovered by searching the recorded responses, since variance alone can't reveal it. (`producerSeq` is normalized to original-seq space: `searchPriorResponses` over the replay returns a replay seq, which is translated back via the alignment pairs so capture hints and token detection resolve the owning tool correctly.) After the planner returns, `reconcileTokenContracts` re-applies the same edges to the parsed plan: it injects any contract the planner dropped and repairs half-declared ones (a `tokenParam` whose producer forgot the matching `emitsTokens`, which `superRefine` would otherwise reject), so a planner shortcut can't silently lose a chain. The plan is persisted to `~/.imprint/<site>/.build-plan.json`.
2. **Build prereqs** (`prereq-builder.ts`) — each shared module is built in two phases. First a **planning pass** (`prompts/prereq-planner.md`, one `llm.analyze`) decodes the recorded sources into a Markdown implementation plan — data shape, per-export algorithm, the exact `noUncheckedIndexedAccess` guards, test plan, risks — persisted to `_shared/<name>.plan.md`. That plan is then injected into an **implement → `verifySharedModule` → feedback loop** (up to 5 cycles, the same shape `compilePlaybook` uses, so it works on every provider) that writes `~/.imprint/<site>/_shared/<name>.ts` plus a test. Planning is best-effort (any failure degrades to implementing without a plan), skipped for `types` modules, and disabled by `IMPRINT_NO_PREREQ_PLAN=1`. Modules build **level-by-level**: those in the same dependency level (no `dependsOn` edge between them) build concurrently under a small cap, while a dependent waits for its dependency's level. `verifySharedModule` is the anti-cheat gate: the module must export what the plan declared, its test must pass with non-trivial assertions, it must typecheck (`tsc` under `strict` + `noUncheckedIndexedAccess`, a gate separate from the test), and a kind-specific ground-truth anchor must reproduce recorded behavior (e.g. a `request-transform` must re-sign a recorded URL to the captured value). Each failed cycle logs which gate blocked it (typecheck / test / anchor).

Each per-tool compile agent then receives its plan slice via a new `read_build_plan` tool (threaded by file path through all three compile drivers — in-process, claude-cli, codex-cli) and **must import the assigned shared modules** rather than re-implementing them: `request-transform` → `workflow.json`'s `requestTransformModule: "../_shared/<name>.ts"`; `parser-helper`/`types` → an import in `parser.ts`. `externalVerification` enforces this — a tool that ignores an assigned (verified) module fails the gate. The same slice carries the opaque-token contract: a **producer** sees its `emitsTokens` (fields its parser must emit for siblings, in the exact consumable shape) and a **consumer** sees its `tokenParams` (`{param, sourceTool, sourceField}`) so it writes the chained `param:<param>` test up front. Both sides are enforced: `externalVerification` fails a producer whose `parser.ts` does not emit a declared `emitsTokens` field (so the contracted name can't silently diverge — e.g. the plan says `hotel_id` but the parser emits `propertyToken`), and fails a consumer whose token param lacks a chained test (`unchained`). The contract is surfaced to the agents, not just validated in the plan — without it the producer would emit its own field name and the chain would break at the consumer's gate where it can't be fixed.

**Why auth is plan-carried, not a shared file.** Login is request data (request[0] + captures) embedded inline by `emit`, and the runtime has no sub-workflow include primitive, so a shared `_shared/auth.ts` cannot be composed. Instead the plan's `authRecipe` describes the exact login + `${state.X}` capture chain, and every tool replicates it inline identically.

**Graceful degrade.** A shared module the builder cannot verify within its cycle budget is marked `verified: false` and pruned from every tool's `usesSharedModules` for that run; the import-assertion never fires on it, and those tools fall back to inlining the logic (today's behavior). A module's relative-path import (`../_shared/<name>.ts`) resolves at runtime because the runtime resolves `parserModule`/`requestTransformModule` relative to each tool's `workflow.json`, and the whole site directory (including `_shared/`) travels together on install/bundle.

## Per-tool plan → execute (plan-tool)

The overall shape is **plan + build shared modules once → for each tool, plan then execute**. After the global `plan-prereqs` step, each tool's compile is preceded by its own short planning pass (`tool-plan.ts`, one `llm.analyze` against `prompts/tool-planning.md`). Tools compile concurrently, but **producer-before-consumer**: when the build plan declares a token contract (a consumer's `tokenParams` sourced from a producer's `emitsTokens`), the producer compiles in an earlier level so the consumer's chained verification test can mint a fresh token from the producer's live `workflow.json` (`topoLevelsForTools`; with no contracts every tool lands in one level — unchanged). The plan→execute is sequential *within* a single tool.

The per-tool plan is grounded in the recording for **that tool only**: the candidate (its parameters, request seqs, dependency seqs), its slice of the global build plan (`parserGuidance` / `paramChecklist` / `authRecipe` / assigned shared modules), and the compacted request/response context for the tool's seqs. The planner returns a concise Markdown plan covering param→recorded-field mapping, request construction (referencing the assigned `request-transform` module by import path), response parsing (exact JSON paths, referencing the assigned `parser-helper`), the shared modules to import, and edge cases. The plan is persisted to `~/.imprint/<site>/<toolName>/.tool-plan.md` and injected into the compile agent's initial message (via `formatToolPlan`, shared verbatim by all three drivers) so the compile follows it instead of re-deriving structure.

It is **best-effort**: a 5-minute timeout, a missing prompt, or any error yields no plan and the compile proceeds exactly as before. Disable it with `IMPRINT_NO_TOOL_PLAN=1`. (The shared-module plan cap is the longer one — 10 minutes — since it analyzes the whole merged recording across all tools.)

This replaced an earlier per-tool **contract-test feedback loop** (compile → run generated contract tests → feed `tool_broken` findings back → recompile). That loop did not measurably raise accuracy and added significant complexity, so it was removed in favor of the single plan→execute pass plus the post-hoc `imprint audit` gate (below). See [decisions.md](decisions.md).

## Acceptance gate (`imprint audit`)

`imprint audit <site>` exercises every generated tool against the site's **real** MCP server and scores it, so a from-scratch teach can be held to a hard accuracy bar (≥95% by default). `audit.ts`:

1. Discovers the site's tools + schemas (the same `discoverTools` the MCP server uses) and points a **headless `claude` session** at `imprint mcp-server <site>` over stdio, with only that site's tools allowed.
2. The auditor (system prompt `prompts/audit-agent.md`, fully site-agnostic) reads each tool's description + schema, invokes it with a realistic param set plus 1–2 edge cases (all derived only from the schema/description), judges each result, and classifies each invocation `correct` | `tool_broken` | `infra` | `bad_params`. It calls tools **strictly sequentially** — a parallel burst trips a site-wide anti-bot 429 that poisons the rest of the session — and is told which parameters shipped `verified:false` so it probes them especially.
3. It returns a single structured JSON report (zod-validated). **It never reports a score** — imprint recomputes the score deterministically (`computeAuditScore`) so a generous auditor can't talk the gate up.

Beyond a per-tool baseline call, the auditor **differentially tests every advertised parameter** — re-running the baseline with only that parameter changed and classifying it `works` / `no_op` / `broken` / `untestable`. Scoring: `score = 100 × correct / (correct + broken)`, where `correct` = `correct` invocations + `works` parameters and `broken` = `tool_broken` invocations + `no_op`/`broken` parameters (an advertised-but-inert parameter is a defect, not a free pass). `infra` / `bad_params` / `untestable` are excluded from the denominator, so a blocked or misused tool — or a parameter that genuinely can't be probed — isn't counted as a code bug; `untestableParams` are listed in the report for visibility. **Pass** requires both `score ≥ minScore` and at least `max(2, gradeableTools)` gradeable invocations, where `gradeableTools` is the number of tools that produced ≥1 gradeable invocation. Scaling the signal floor to *gradeable* tools (not all tools) means a tool the auditor can never exercise — e.g. one that needs an opaque token it cannot synthesize — no longer inflates the bar and sinks an otherwise-perfect run; such tools are listed as `ungradeableTools` in the report. The floor is one gradeable call per gradeable tool (not two): the auditor often spends a slot per tool on `bad_params`/`infra`, so demanding two clean reads per tool false-failed otherwise-perfect runs. Real defects still fail on `score`, not on this count. No gradeable invocations → **inconclusive** (re-run / the site blocked us, not a code failure). Exit codes distinguish the cases: `0` pass, `1` fail (logic bugs), `2` inconclusive. The full result (deterministic score + the raw model report) is persisted to `~/.imprint/<site>/.audit-report.json` and traced under `cli.audit` → `audit.session`.

The harness is fully general — no per-site special-casing — and the no-overfit guardrail applies to every change: a fix must improve a *category* (e.g. RPC-envelope parsing), never a single site/URL/tool/field.

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

Example: a site that signs each request URL with a scheme computed in its `.js` (CRC32, HMAC, etc.) — the compile agent reads the signing function out of the bundle and replicates it in `request-transform.ts`.

### Parser context

The parser's `extract()` function receives an optional second argument:

```ts
extract(rawResponse: unknown, context?: { params: Record<string, string | number | boolean>; responses: unknown[] }): unknown
```

- `context.params` — the tool parameters the caller provided.
- `context.responses` — all response bodies from the workflow chain (index 0 = first request).

Use `params` when the parser needs a value the API doesn't echo back (e.g. the search term for constructing domain names from a TLD catalog). Use `responses` when the parser merges data from multiple chained requests.
