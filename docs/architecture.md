# Imprint architecture

## The core idea

Imprint records a real browser session, then compiles it into TWO deterministic artifacts:

1. **`workflow.json`** — the captured API call chain, replayable via native `fetch()`. Fast (~200ms), with named captures for cookies, headers, body values, browser-minted state, and agent-declared body-placeholder encoding.
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
├── teach.ts             End-to-end pipeline: record → redact → effect-aware triage → [safe-recording replay-and-diff ‖ detect → dependency-aware select] → close replay edges → plan-prereqs → (per-tool: plan-tool → generate) → compile-playbook → emit → register
├── teach-plan.ts        plan-prereqs step: build plan + level-parallel shared-module build before the per-tool fan-out (multi-tool only)
├── tool-plan.ts         plan-tool step: per-tool implementation plan (param→field map, request/parse plan, module imports) injected into the compile agent
├── integrations.ts      Platform registration (Claude Code, Codex, Claude Desktop, OpenClaw, Hermes)
│
│ ── Capture ──
├── record.ts            CDP capture + DOM listener + JSONL stream
├── response-body-stream.ts  Bounded React Flight stream selection, buffering, and recovery
├── response-body-intent.ts  Trusted user-intent correlation for speculative RSC prefetches
├── response-body-lifecycle.ts  Request-generation lifetime tracking during body reads
├── react-flight-limits.ts  Shared Flight row and JSON-node budgets
├── session-writer.ts    JSONL writer + Session assembler
├── inject-listener.ts   Sentinel-prefixed DOM event capture (injected)
├── redact.ts            Credential / PII scrub
├── freeform-redact.ts   Supplemental free-form PII/secret detection (requests plus framing-aware Flight responses; generic catch-alls excluded)
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

**Authenticate-tool execution.** Authentication never uses the DOM playbook rung. The live verifier runs the compiled workflow in one headed `cdp-replay` browser and keeps that browser open across checkpoints. The browser transport supplies ordinary fetch, top-level navigation, cookies, and page-owned state; it does not interpret the site's authentication protocol.

**Auth is an agent-compiled action program.** Candidate detection supplies neutral credential-request and related-auth-request evidence. The auth compile agent reads the recording and defines `authConfig.entry` plus arbitrary named actions. Each action lists its scalar parameters and ordered request steps. A step can declare error handling and a recording-grounded `repeat.until` capture with its own interval and attempt bound. Outcomes may declare required capture evidence and are either `pause` (with the next action, exact carried state names, and a caller message) or `success`. `persist` names non-cookie captures that become durable credentials; cookies persist automatically. There are no runtime push/OTP types, phase boundaries, implicit delivery checks, cookie-based completion guesses, or site-shaped auth heuristics.

**Compile and verification are separate stages.** Claude and Codex use the same recording tools and checkpoint protocol. The compile agent writes artifacts but cannot log in directly. For data tools, a separate semantic verifier prepares the live backend with the existing comprehensive probe, then owns execution of the compiler-written `integration.test.ts`. A valid backend preference is reused across compiler revisions; only a missing/invalid preference or a later transport, network, or browser-infrastructure failure invokes the probe. Semantic failures never trigger backend exploration. Final suite and targeted calls pin that preference rather than silently exploring the runtime ladder. The verifier can run discriminating follow-up calls, and its `changes_required` or `inconclusive` report returns to the compiler revision loop. For auth tools, `run_verification` sends one agent-selected action and its parameters to `AuthVerifier`, which reuses its browser and generic continuation by default and returns observed backend/status/body/next-action facts. When those facts show that the prior session is unusable, the agent can request a fresh verification session without changing runtime policy. The orchestrator resumes the same CLI session after each checkpoint. The agent decides from those facts whether to revise the program, prompt the user, wait, reset verification state, run another action, finish, or give up. `done` is accepted only after a live success action, and the verification receipt is bound to the canonical workflow hash so later edits invalidate it.

**Body encoding is an agent-owned compile decision.** A newly compiled request body containing runtime placeholders must declare `bodyPlaceholderEncoding` as `raw`, `json-string`, or `form-urlencoded`. `Content-Type` is evidence for the compiler, not a runtime classifier. The compiler also writes `request.test.ts`, renders the actual workflow without network access, chooses synthetic edge cases appropriate to the recorded format, and proves round-trip equality. Mixed or nested encodings belong in an agent-authored `request-transform.ts`. The runtime retains its former inference only as a compatibility path for workflows emitted before this contract; re-teaching migrates them to explicit declarations.

`executeAuthWorkflow` is a small interpreter for that artifact: substitute ordinary workflow templates, execute or navigate the referenced request, collect declared captures, repeat only when the step says to, check declared evidence by key existence, project only declared carry names, and persist declared session values after success.

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

Captured values enter the per-execution `${state.NAME}` namespace. That namespace is the compiler's canonical output for ephemeral values like CSRF tokens, session nonces, and cookies copied into later headers. Direct `${cookie["NAME"]}` lookup remains an expert escape hatch and resolves against the current request URL; ambiguous lookups fail with `STATE_MISSING`. For a per-call value the client mints fresh each request (no producer to capture), `${generated.KIND}` (`uuid` / `epoch_ms` / `epoch_s` / `iso8601` / `nonce`) is resolved anew on every substitution — the contract's `generated` source lowers to this.

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
└─ audit.session (AGENT)        ← imprint.audit.{score, correct, broken, infra, bad_params, graded, params_working, params_no_op, params_broken, params_untestable, verdict, timed_out, turns, cost_usd}
    └─ audit.llm_usage (LLM)    ← aggregate CLI model/token usage, absent when no usage exists
```

The `audit.session` span carries the audit result and, when supplied by the provider, `imprint.audit.cost_usd`. Aggregate CLI token usage lives on its `audit.llm_usage` child so Phoenix can price it without classifying discovery, tool-driving, grading, and persistence as LLM latency. When the deadline guard kills the run, `imprint.audit.timed_out=true` and the verdict is `timeout` (see [troubleshooting](troubleshooting.md#audit)); the auditor's transcript is written next to the report for diagnosis.

Each `agent.turn.N` span records per-turn input/output tokens and stop reason. Each `llm.message_with_tools` span records model, provider, token counts, and which tools the model called. Each `agent.tool.X` span records tool execution time, result size, and (when `IMPRINT_TRACE_TOOL_IO=1`) the input arguments and output.

Stage spans carry their own end-attributes for fast triage: `teach.record` (`imprint.record.event_count`), `teach.redact` (`imprint.redact.*` counts), `teach.combine_sessions` (`imprint.combine.{session,request,narration}_count`), and `teach.plan_tool` (`imprint.tool_plan.chars` / `.skipped`). Opening the `cli.teach` trace lets you locate the failing stage by span status/attrs — a `teach.plan_prereqs` timeout, a `teach.build_shared_module` with `ok=false`, an empty `teach.plan_tool`, or a `compile.generate` that gave up.

Add `IMPRINT_TRACE_LLM_IO=1` and `IMPRINT_TRACE_TOOL_IO=1` when you need prompts, responses, tool arguments, and tool results in the trace UI. Token counts come from the provider when available and fall back to estimates otherwise. Imprint emits the prompt-cache split (`cache_read`/`cache_creation`) using OpenInference attributes; Phoenix owns model pricing and rolls span costs up to trace and project levels. `scripts/analyze-phoenix.ts` requires Phoenix 11.4+, reads GraphQL `costSummary`, paginates complete traces, and distinguishes pending calculations from unpriced or partial costs rather than showing any of them as zero. See [tracing.md](tracing.md) for the full attribute reference.

**Ephemeral artifacts** the compile-agent writes during a run but does not persist:

- `parser.test.ts` — `bun:test` suite that exercises `parser.extract()` against the load-bearing response body. Reads the redacted session via `process.env.IMPRINT_SESSION_PATH` set by the harness. Must include a `synthetic:empty-result` test — `extract()` must return a clean empty collection for a no-match/empty response, never a single all-null placeholder record; the verifier requires that test to be present and to pass. Deleted after verification passes; pass `--keep-test` to `teach` / `generate` (or set `IMPRINT_KEEP_TEST=1`) to retain it for local debugging.
- `request.test.ts` — agent-authored offline request-construction suite required when a body contains runtime placeholders. It renders `workflow.json` with adversarial synthetic values, decodes the declared wire format, and asserts exact round-trip equality. The agent chooses the test structure and names; the harness executes it before live verification. It must not contact the site; irreversible workflows run it inside a network-isolated process.
- `integration.test.ts` — live API test whose final execution belongs to the independent semantic verifier. A **baseline** test verifies the workflow produces real data (catches expired hardcoded tokens, missing URL signing), and one **`param:<name>`** test per exposed parameter overrides it with a discriminating value and asserts the response is actually constrained. Before launching Bun, the verifier checks or creates `backends.json` with the existing probe; the suite then runs fail-fast against only the preferred backend, so probe latency is outside the test timeout and a failed backend becomes explicit reprobe feedback. The verifier identifies coverage by which `param:<name>` tests *ran green* (parsed from a JUnit report), not a static source scan. A grounded parameter whose effect remains untestable can carry `// exposed-but-not-verified` and ship as `verified:false`. A secondary candidate input with no grounded encoding, or one proven broken without a recording-grounded repair, is instead removed from the public parameter list and recorded in `workflow.limitations`; those agent-authored reasons are surfaced in MCP descriptions and teach output. Limitations cannot excuse a broken core intent. A parameter that is an **opaque token minted by a sibling tool** must mint a fresh value from the producer tool in its `param:<name>` test; reusing the recorded token is rejected as `unchained`. During `imprint teach`, the harness sets `IMPRINT_TEACH_CREDENTIALS` in the test subprocess so credentials extracted during redaction are available without requiring a separate `imprint credential set`. Also deleted after verification unless `--keep-test` or `IMPRINT_KEEP_TEST=1`.
- `.compile-log.json`, `.compile-done.json`, `.compile-give-up.json` — compile-agent transcript + sentinels (gitignored).
- `.live-verifier-log.jsonl`, `.live-verification-evidence.json`, `.live-verification.json` — crash-safe verifier events, sanitized backend/suite/call receipts, and the final semantic report. A suite receipt is created before Bun starts and survives failure, timeout, or abort even when no individual call completes. Labels are diagnostic only; semantic reports do not cite evidence IDs.

## Multi-tool shared modules (plan-prereqs)

Candidate selection is graph-aware. The candidate agent declares direct
callable prerequisites as `dependsOnTools`; unambiguous `dependencySeqs` add
recording-grounded structural edges without inventing dependencies for shared,
unowned, or self-owned request seqs. After replay finishes,
`deriveTokenContractHints` runs against the full detected candidate set and adds
grounded producer-token edges before candidate checkpoints are written. Every
selection is then closed transitively over those dependencies. All candidates
start selected, including non-interactive runs; `--primary-tool` selects the
primary candidate plus its prerequisites. Dependency cycles are retained once
and reported instead of recursing indefinitely.

When the resulting selection contains **two or more** tools, `imprint teach` inserts a `plan-prereqs` step between candidate selection and the per-tool compile fan-out. Single-tool recordings skip it entirely (the path is unchanged). Set `IMPRINT_NO_BUILD_PLAN=1` to disable it and compile every tool independently.

The step does two things, once per teach, before the fan-out:

1. **Plan** (`build-plan.ts`, single-shot `llm.analyze` against `prompts/build-planning.md`) — produces a `BuildPlan`: the shared modules to create (`request-transform` signing, `parser-helper` decoders, shared `types`), per-tool guidance (load-bearing seqs, parser guidance, parameter checklist), an `authRecipe` each tool replicates inline, and the cross-tool **opaque-token contract** (consumer `tokenParams` ⇄ producer `emitsTokens`). The contract is not left to the planner's discretion: `deriveTokenContractHints` first walks the dual-pass classifications **deterministically** — any value with recovered producer provenance sent by one tool but produced in a *different* tool's response (matched by `producerSeq`/`originalSeq` → owning tool via `requestSeqs`; `header:` session tokens and shared/ambiguous seqs skipped) — and feeds those grounded edges into the planner payload. Provenance covers two cases: a `server_derived` value (it *varied* across the two replay passes and was found in a prior response) and a stable `constant` whose **opaque** value also appears in a prior response. The latter matters because the dual-pass replays the *same* flow, so a per-entity token (same hotel → same id) is identical across passes and classified `constant` — its provenance is recovered by searching the recorded responses, since variance alone can't reveal it. (`producerSeq` is normalized to original-seq space: `searchPriorResponses` over the replay returns a replay seq, which is translated back via the alignment pairs so capture hints and token detection resolve the owning tool correctly.) After the planner returns, `reconcileTokenContracts` re-applies the same edges to the parsed plan: it injects any contract the planner dropped and repairs half-declared ones (a `tokenParam` whose producer forgot the matching `emitsTokens`, which `superRefine` would otherwise reject), so a planner shortcut can't silently lose a chain. The plan is persisted to `~/.imprint/<site>/.build-plan.json`.

**General dependency contract (`requiredInputs`).** Cross-tool tokens are one of *several* input classes a tool's request needs, and the header-blind "keep headers minimal" heuristic used to drop the others (auth tokens, gateway/session headers, the page a request was issued from) and ship tools that fail at runtime. `deriveRequiredInputHints` generalizes the token detector to surface **every** non-param input deterministically, attributing each by source — purely from structural signals (the dual-pass taxonomy, `loginRequestSeqs`, producer ownership, value shape, page-minted detection), never a header name or URL literal:
  - **`auth`** — a value minted by the login flow's response (`producerSeq ∈ loginRequestSeqs`) → wired `${credential.X}`; the deriver also seeds the matching `authTool.captures` entry, and `authExternalVerification` requires the auth workflow to name it in `authConfig.persist` so the data tool's header resolves at runtime.
  - **`producer_tool`** — the same cross-tool edge as `tokenParams`/`emitsTokens` (kept in sync by `validateBuildPlan`), wired as a param.
  - **`browser_state`** — a value an earlier response or the originating page mints; a reused-in-session value is captured as `${state.X}`, and a request that runs **cross-origin** from its originating page (`findOriginatingPage` = `Referer` or the last Document navigation) emits a `referer` input carrying a `bootstrap.url`.
  - **`generated`** — a per-call value with no producer, its kind inferred by SHAPE (`uuid`/`epoch_ms`/`epoch_s`/`iso8601`/`nonce`) → wired `${generated.KIND}`, which `runtime.ts` mints fresh on every substitution.
  - **`static`** — a high-entropy constant / page-minted app key → emitted as a verbatim literal (not a per-user secret).
`reconcileRequiredInputs` re-injects any grounded input the planner dropped (mirroring `reconcileTokenContracts`). At compile time `externalVerification` **deterministically injects** a dropped contracted input (`injectContractedInputs` — credential/static/generated headers, plus `bootstrap.url` for a referer input), then **blocks** if a non-producer contracted input is still unwired (`contractedInputGate`); a live failure that coincides with an unresolved contracted input is classified `contract-gap` (a workflow-correctness error to fix), NOT `waived-bot`. Fan-out ordering (`topoLevelsForTools`) adds the producer→consumer and data→auth edges from the contract.

**Redaction policy + emit-time secret guard.** To wire an auth/session/gateway header the compile agent must be able to *read* its value — so the compile-path redaction no longer scrubs sensitive-header values by default (credential placeholdering and free-form PII redaction still run; re-enable the legacy blanket scrub with `IMPRINT_REDACT_SENSITIVE_HEADERS=1`, and `imprint redact`'s shareable output always applies it). The agent reads real values on demand via the **`reveal_request`** tool (unredacted request+response straight from the recording). Two guards keep secrets out of shipped artifacts: `reveal_request`'s contract tells the agent to emit placeholders, and **`assertNoRawSecrets`** (run after injection) scans `workflow.json`/`parser.ts` for the recording's own sensitive-header + credential values — auto-rewriting a value that maps to a contracted placeholder, blocking any other. (See [security.md](security.md).)
2. **Build prereqs** (`prereq-builder.ts`) — each shared module is built in two phases. First a **planning pass** (`prompts/prereq-planner.md`, one `llm.analyze`) decodes the recorded sources into a Markdown implementation plan — data shape, per-export algorithm, the exact `noUncheckedIndexedAccess` guards, test plan, risks — persisted to `_shared/<name>.plan.md`. That plan is then injected into an **implement → `verifySharedModule` → feedback loop** (up to 5 cycles, the same shape `compilePlaybook` uses, so it works on every provider) that writes `~/.imprint/<site>/_shared/<name>.ts` plus a test. Planning is best-effort (any failure degrades to implementing without a plan), skipped for `types` modules, and disabled by `IMPRINT_NO_PREREQ_PLAN=1`. Modules build **level-by-level**: those in the same dependency level (no `dependsOn` edge between them) build concurrently under a small cap, while a dependent waits for its dependency's level. `verifySharedModule` is the anti-cheat gate: the module must export what the plan declared, its test must pass with non-trivial assertions, it must typecheck (`tsc` under `strict` + `noUncheckedIndexedAccess`, a gate separate from the test), and a kind-specific ground-truth anchor must reproduce recorded behavior (e.g. a `request-transform` must re-sign a recorded URL to the captured value). Each failed cycle logs which gate blocked it (typecheck / test / anchor).

Each per-tool compile agent then receives its plan slice via a new `read_build_plan` tool (threaded by file path through all three compile drivers — in-process, claude-cli, codex-cli) and **must import the assigned shared modules** rather than re-implementing them: `request-transform` → `workflow.json`'s `requestTransformModule: "../_shared/<name>.ts"`; `parser-helper`/`types` → an import in `parser.ts`. `externalVerification` enforces this — a tool that ignores an assigned (verified) module fails the gate. The same slice carries the opaque-token contract: a **producer** sees its `emitsTokens` (fields its parser must emit for siblings, in the exact consumable shape) and a **consumer** sees its `tokenParams` (`{param, sourceTool, sourceField}`) so it writes the chained `param:<param>` test up front. Both sides are enforced: `externalVerification` fails a producer whose `parser.ts` does not emit a declared `emitsTokens` field (so the contracted name can't silently diverge — e.g. the plan says `hotel_id` but the parser emits `propertyToken`), and fails a consumer whose token param lacks a chained test (`unchained`). The contract is surfaced to the agents, not just validated in the plan — without it the producer would emit its own field name and the chain would break at the consumer's gate where it can't be fixed.

**Why auth is plan-carried, not a shared file.** Login is request data (request[0] + captures) embedded inline by `emit`, and the runtime has no sub-workflow include primitive, so a shared `_shared/auth.ts` cannot be composed. Instead the plan's `authRecipe` describes the exact login + `${state.X}` capture chain.

Whenever neutral candidate evidence contains credential requests, related auth requests, or credential names, the planner emits one standalone **`authTool`** (`authenticate_<site>`). The plan carries only request-sequence evidence and durable credential names; it does not classify the protocol. The auth compile agent derives the action graph from the recording. Data tools set `dependsOnAuth: true` and reuse the stored session instead of replaying login inline. This is why the build planner (`plan-prereqs`) runs whenever auth evidence exists, not only for ≥2 selected tools. `authRecipe` remains the inline fallback for tools when no auth tool was built (for example, credentials unavailable).

**Graceful degrade.** A shared module the builder cannot verify within its cycle budget is marked `verified: false` and pruned from every tool's `usesSharedModules` for that run; the import-assertion never fires on it, and those tools fall back to inlining the logic (today's behavior). A module's relative-path import (`../_shared/<name>.ts`) resolves at runtime because the runtime resolves `parserModule`/`requestTransformModule` relative to each tool's `workflow.json`, and the whole site directory (including `_shared/`) travels together on install/bundle.

## Per-tool plan → execute (plan-tool)

The overall shape is **plan + build shared modules once → for each tool, plan then execute**. After the global `plan-prereqs` step, each tool's compile is preceded by its own short planning pass (`tool-plan.ts`, one `llm.analyze` against `prompts/tool-planning.md`). Tools compile concurrently, but **producer-before-consumer**: when the build plan declares a token contract (a consumer's `tokenParams` sourced from a producer's `emitsTokens`), the producer compiles in an earlier level so the consumer's chained verification test can mint a fresh token from the producer's live `workflow.json` (`topoLevelsForTools`; with no contracts every tool lands in one level — unchanged). The plan→execute is sequential *within* a single tool.

The per-tool plan is grounded in the recording for **that tool only**: the candidate (its parameters, request seqs, dependency seqs), its slice of the global build plan (`parserGuidance` / `paramChecklist` / `authRecipe` / assigned shared modules), and the compacted request/response context for the tool's seqs. The planner returns a concise Markdown plan covering param→recorded-field mapping, request construction (referencing the assigned `request-transform` module by import path), response parsing (exact JSON paths, referencing the assigned `parser-helper`), the shared modules to import, and edge cases. The plan is persisted to `~/.imprint/<site>/<toolName>/.tool-plan.md` and injected into the compile agent's initial message (via `formatToolPlan`, shared verbatim by all three drivers) so the compile follows it instead of re-deriving structure.

It is **best-effort**: a 5-minute timeout, a missing prompt, or any error yields no plan and the compile proceeds exactly as before. Disable it with `IMPRINT_NO_TOOL_PLAN=1`. (The shared-module plan cap is the longer one — 10 minutes — since it analyzes the whole merged recording across all tools.)

This replaced an earlier per-tool **contract-test feedback loop** (compile → run generated contract tests → feed `tool_broken` findings back → recompile). That loop did not measurably raise accuracy and added significant complexity, so it was removed in favor of the single plan→execute pass plus the post-hoc `imprint audit` gate (below). See [decisions.md](decisions.md).

## Acceptance gate (`imprint audit`)

`imprint audit <site>` exercises every generated tool against the site's **real** MCP server and scores it, so a from-scratch teach can be held to a hard accuracy bar (≥95% by default). `audit.ts`:

1. Discovers the site's tools + schemas (the same `discoverTools` the MCP server uses), excludes workflows declared `effect: "irreversible"`, and points a **headless `claude` session** at `imprint mcp-server <site>` over stdio, with only the remaining tools allowed. Irreversible workflows are reported as safety-skipped rather than invoked or scored.
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
export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: Record<string, string | number | boolean>,
): string | { url?: string; body?: string; headers?: Record<string, string>; skip?: boolean }
```

The runtime calls `transform` before each outgoing request. The `responses` array contains previous response bodies from the workflow chain, enabling dynamic URL construction (e.g. building a domain list from search results for a batch status check). Return `{ skip: true }` to skip a conditional follow-up request, such as a pagination/detail call that is only needed for some parameter values.

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
