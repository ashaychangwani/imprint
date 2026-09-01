# Imprint architecture

## The core idea

Imprint records a real browser session and turns every credible recorded
operation into a deterministic tool. The preferred artifact is
**`workflow.json`**, an API request chain that can use the fast replay backends.
When the agent finds those paths incompatible with an operation, it can build a
**`playbook.yaml`** DOM fallback instead.

Generated tools are discovered by the cron daemon and MCP server. At runtime,
they use a **backend ladder** that escalates through the applicable replay
strategies. The teaching agents choose the tool design; the runtime only
executes and checks the artifacts.

## Data flow

```
recording
   │
   ▼
redact + summarize + discover the complete operation set
   │
   ▼
tool-boundary advice ──► master-owned editable plan + dependency waves
   │
   ▼
focused plan ──► focused compile ──► factual checks
   │                                      │
   │                        failed ────────┘
   │                          master revises affected tools
   ▼
parameter advice ──► independent completion review
   │
   ▼
verified tool directories ──► cron / MCP ──► runtime backend ladder
```

`imprint teach` owns this entire teaching flow. It always creates a fresh run,
stays in the foreground, and returns only after a terminal result. It never
resumes an old run or exposes phase, primary-tool, or partial-selection modes.

## Module map

```
src/imprint/
│ ── Orchestration ──
├── teach.ts             Thin public entry for the one fresh master-led flow
├── master-teach-controller.ts  Foreground sequencing, waves, repair loop, checks, and terminal result
├── master-teach-plan.ts        Editable full tool plan, dependencies, and master-authored build waves
├── master-teach-agents.ts      Focused advisor, planner, master, and completion-review calls
├── master-teach-agent-contracts.ts  Exact inputs and outputs for those focused roles
├── master-teach-store.ts       Fresh run record, plan history, artifacts, and factual receipts
├── master-teach-checks.ts      Contract, replay, live, and producer-consumer facts
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
├── compile-agent.ts     Agentic compile orchestrator (session → workflow.json + parser.ts)
├── compile-agent-types.ts  Shared types for compile agent (progress, result)
├── agent.ts             General-purpose tool-using agent loop + per-turn/per-tool tracing
├── claude-cli-compile.ts  Claude CLI compile driver with stream-json per-turn tracing
├── codex-cli-compile.ts   Codex CLI compile driver with JSONL per-turn tracing
├── compile-tools.ts     Compile-agent read/write/test tools + state hints
├── request-context.ts   Shared request metadata compaction for LLM context
├── tool-candidates.ts   Operation evidence and initial candidate discovery from one recording
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

The **`cdp-replay`** rung is the record-faithful trusted-browser transport for the API path (`cdp-browser-fetch.ts`): a real Chrome launched as `imprint record` does (`launchChromium` + raw CDP, no automation flags) stays **open** for the whole workflow and runs each **same-origin** request *in-page* via `fetch(..., {credentials:'include'})`, while cross-origin requests (e.g. an `api.*` subdomain, which CORS would block in-page and which usually aren't behind the same wall) fall through to a plain fetch. It can sustain sequences of protected requests that cheaper transports cannot, but the runtime does not inspect workflow semantics to move it ahead of those transports. A new `auto` run starts from the fixed ladder order above; later runs may start from a backend that factual probe or execution history already showed to work. It runs **headless by default** — the `HeadlessChrome` UA token is stripped via a CDP UA override before navigating — with a `headed`+Xvfb fallback for GPU-less Linux hosts (see [troubleshooting](troubleshooting.md#running-on-a-headless-server-anti-bot-sites)). The same rung is also available during compile-time verification. The `playbook` rung is the DOM-walk last resort and needs a compiled `playbook.yaml`. The probe-backends cache (`~/.imprint/<site>/<toolName>/backends.json`) reorders later cron and MCP calls from observed results; v2 caches include canonical workflow and capability hashes so stale caches are ignored by runtime but reported by `imprint mcp status`. For multi-tool sites, `cron` requires `--tool <toolName>` unless the provided `--config` path is inside the target tool directory; `probe-backends` can target one tool with `--tool` / `--out` or refresh every generated tool with `--all`. `probe-backends` tests each applicable backend individually, ranks working rungs by observed runtime, and keeps unusually slow successes behind faster working backends. CDP replay gets one extra warm-pool measurement after a successful cold run; `backends.json` records `coldDurationMs`, `warmDurationMs`, and `rankingDurationMs` so warm speed is visible without hiding cold-start cost. MCP and cron persist the backend that actually succeeds so the next process can start from that observed result. The stealth-fetch bootstrap state is shared across probe runs via a per-site cache to avoid re-bootstrapping per backend.

**CDP pool.** At runtime, the `cdp-replay` backend supports a per-site `cdpPool` option that reuses a live Chrome instance across multiple tool calls instead of launching a fresh browser each time. This cuts per-call overhead from ~33–35s (cold launch + navigate + sensor validation) to ~2–5s (reuse existing page context). The pool is keyed by site and managed by the MCP server (`mcp-server.ts`); idle sessions are closed after 5 minutes (`CDP_IDLE_TIMEOUT_MS`). `probe-backends` also uses a temporary pool only to measure CDP warm reuse after a successful cold probe, then closes it before exiting. Compile uses its own process-global verification pool.

**Authenticate-tool execution.** Authentication never uses the DOM playbook rung. The live verifier runs the compiled workflow in one headed `cdp-replay` browser and keeps that browser open across checkpoints. The browser transport supplies ordinary fetch, top-level navigation, cookies, and page-owned state; it does not interpret the site's authentication protocol.

**Auth is an agent-compiled action program.** Candidate detection supplies neutral credential-request and related-auth-request evidence. The auth compile agent reads the recording and defines `authConfig.entry` plus arbitrary named actions. Each action lists its scalar parameters and ordered request steps. A step can declare error handling and a recording-grounded `repeat.until` capture with its own interval and attempt bound. Outcomes may declare required capture evidence and are either `pause` (with the next action, exact carried state names, and a caller message) or `success`. `persist` names non-cookie captures that become durable credentials; cookies persist automatically. There are no runtime push/OTP types, phase boundaries, implicit delivery checks, cookie-based completion guesses, or site-shaped auth heuristics.

**Compile and verification are separate jobs.** A focused compiler writes the
artifacts for one tool. The foreground controller then runs the applicable
contract, replay, live, and producer-consumer checks and records observed facts.
The master decides whether those facts require a change to the tool,
parameters, dependencies, or replay strategy. Receipts are tied to the exact
plan and artifact, so an edit makes only the affected proof stale. The final
reviewer cannot approve a tool without current passing receipts.

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
├── playbook.yaml               optional DOM fallback chosen during teaching
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

LLM-facing overview payloads are intentionally compact. Candidate detection, request triage, and compile-agent `read_session_summary` all collapse repeated identical request metadata into one representative row with `repeatCount`, `repeatedSeqs`, and `lastTimestamp`. Candidate-selected requests and auth/setup dependencies stay as separate rows so a tool-specific request cannot disappear inside a shared representative.

**Inline data.** For candidate-scoped requests (`requestSeqs ∪ dependencySeqs`), the session summary includes `inlineData` — full request headers, request body, response headers, and a smart-truncated response body (full for JSON ≤16 KB, structure summary + first 8 KB for JSON >50 KB, first 4 KB for HTML). This eliminates 20-30 serial `read_request` / `read_response_body` tool calls the agent would otherwise need, keeping context growth linear instead of quadratic. A budget-aware reduction strategy (`SUMMARY_SIZE_BUDGET = 30 KB`) progressively strips response bodies, then request bodies, then all inline data to stay within `claude-cli`'s tool-result size limit. Full bodies are still available via `read_request`, `read_response_body`, and `search_response_body` for requests outside the candidate scope or when the inline preview is truncated.

**Capture hints.** When dual-pass replay classifications are available, the session summary also includes `captureHints` — ready-to-use capture block suggestions translated from `server_derived` classifications. Each hint specifies the producer request index, a capture definition (`source`, `name`, `path`/`header`/`cookie`), and which downstream requests consume the captured value. The compile agent can copy these directly into `workflow.json` instead of manually discovering value provenance.

**Differential parameter grounding.** For each UI event in the candidate's `eventSeqs` (filter toggle, sort change, button click), `param-grounding.ts` finds the first candidate-scoped request it triggered (within a 12-request window), diffs its decoded body against the most recent prior request of the same endpoint, and reports the changed paths. This is deterministic and site-agnostic: JSON bodies, Google `batchexecute` `f.req=` envelopes, and plain form fields are all decoded transparently. The resulting `EventGrounding[]` array — each entry carrying `eventSeq`, `triggeredSeq`, `priorSeq`, `endpoint`, and `changes` (path/before/after) — is surfaced in the session summary so the compile agent maps each diff to a `likelyParam` (the semantic step the model is good at) instead of guessing at an encoding. Session-churn paths (positions that change across most events — rotating tokens, pagination flags) are automatically filtered so only the param-specific signal remains. The diff is scoped to the candidate's own request endpoints (`endpointsForSeqs`) to avoid mistaking telemetry POSTs for the trigger.

**Input-value provenance hints.** Some parameters carry an opaque id (entity handle, place id, category token) minted by an earlier response, not the user's text. The compile agent historically shipped these as the raw param text, which the backend silently ignored. `param-grounding.ts`'s `inputProvenance()` detects these by walking each candidate request's decoded body for id-like leaf values (no whitespace, ≥6 chars, mixes character classes or is a delimited handle) and searching prior responses for the same value. Each match produces an `InputProvenance` record (`path`, `valueSample`, `requestSeq`, `sourceSeq`, `sourceEndpoint`, `selfChain`). `selfChain: true` indicates a resolve-then-refine pattern: the tool's own endpoint minted the id (e.g. a text search returns a place id, which a refined search sends back). These hints are surfaced as `inputProvenanceHints` in the compile agent's session summary, so the compiler chains the minting request and captures the id rather than hardcoding or substituting raw text.

Set `IMPRINT_TRACE=1` with `PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006` to emit OpenInference spans to a local Phoenix server. See [tracing.md](tracing.md) for the full setup and environment variable reference. The trace shows the foreground teach and its focused jobs; exact children depend on the provider and any repairs the master requests:

```
cli.teach (AGENT)
├─ recording, redaction, triage, and candidate discovery
├─ focused advisor and master decisions
├─ focused planning and compilation for each planned tool
│   ├─ agent.turn.N
│   │   ├─ llm.message_with_tools
│   │   └─ agent.tool.X
│   └─ contract, replay, live, and chain checks
├─ focused repairs and parameter advice when needed
└─ independent completion review
```

The `audit` verb traces its own tree, so a failing acceptance run is debuggable in isolation:

```
cli.audit (AGENT)
└─ audit.session (AGENT)        ← imprint.audit.{score, correct, broken, infra, bad_params, graded, params_working, params_no_op, params_broken, params_untestable, verdict, timed_out, turns, cost_usd}
    └─ audit.llm_usage (LLM)    ← aggregate CLI model/token usage, absent when no usage exists
```

The `audit.session` span carries the audit result and, when supplied by the provider, `imprint.audit.cost_usd`. Aggregate CLI token usage lives on its `audit.llm_usage` child so Phoenix can price it without classifying discovery, tool-driving, grading, and persistence as LLM latency. When the deadline guard kills the run, `imprint.audit.timed_out=true` and the verdict is `timeout` (see [troubleshooting](troubleshooting.md#audit)); the auditor's transcript is written next to the report for diagnosis.

Each `agent.turn.N` span records per-turn input/output tokens and stop reason. Each `llm.message_with_tools` span records model, provider, token counts, and which tools the model called. Each `agent.tool.X` span records tool execution time, result size, and (when `IMPRINT_TRACE_TOOL_IO=1`) the input arguments and output.

Open the `cli.teach` trace to find a slow or failing focused job. The fresh run
directory remains the source of truth for the current plan, artifact history,
factual receipts, and terminal result.

Add `IMPRINT_TRACE_LLM_IO=1` and `IMPRINT_TRACE_TOOL_IO=1` when you need prompts, responses, tool arguments, and tool results in the trace UI. Token counts come from the provider when available and fall back to estimates otherwise. Imprint emits the prompt-cache split (`cache_read`/`cache_creation`) using OpenInference attributes; Phoenix owns model pricing and rolls span costs up to trace and project levels. `scripts/analyze-phoenix.ts` requires Phoenix 11.4+, reads GraphQL `costSummary`, paginates complete traces, and distinguishes pending calculations from unpriced or partial costs rather than showing any of them as zero. See [tracing.md](tracing.md) for the full attribute reference.

**Ephemeral artifacts** the compile-agent writes during a run but does not persist:

- `parser.test.ts` — `bun:test` suite that exercises `parser.extract()` against the load-bearing response body. Reads the redacted session via `process.env.IMPRINT_SESSION_PATH` set by the harness. Must include a `synthetic:empty-result` test — `extract()` must return a clean empty collection for a no-match/empty response, never a single all-null placeholder record; the verifier requires that test to be present and to pass. Deleted after verification passes; pass `--keep-test` to `teach` / `generate` (or set `IMPRINT_KEEP_TEST=1`) to retain it for local debugging.
- `request.test.ts` — agent-authored offline request-construction suite required when a body contains runtime placeholders. It renders `workflow.json` with adversarial synthetic values, decodes the declared wire format, and asserts exact round-trip equality. The agent chooses the test structure and names; the harness executes it before live verification. It must not contact the site; irreversible workflows run it inside a network-isolated process.
- `integration.test.ts` — live API test whose final execution belongs to the independent semantic verifier. A **baseline** test verifies the workflow produces real data (catches expired hardcoded tokens, missing URL signing), and one **`param:<name>`** test per exposed parameter overrides it with a discriminating value and asserts the response is actually constrained. Before launching Bun, the verifier checks or creates `backends.json` with the existing probe; the suite then runs fail-fast against only the preferred backend, so probe latency is outside the test timeout and a failed backend becomes explicit reprobe feedback. The verifier identifies coverage by which `param:<name>` tests *ran green* (parsed from a JUnit report), not a static source scan. A grounded parameter whose effect remains untestable can carry `// exposed-but-not-verified` and ship as `verified:false`. A secondary candidate input with no grounded encoding, or one proven broken without a recording-grounded repair, is instead removed from the public parameter list and recorded in `workflow.limitations`; those agent-authored reasons are surfaced in MCP descriptions and teach output. Limitations cannot excuse a broken core intent. A parameter that is an **opaque token minted by a sibling tool** must mint a fresh value from the producer tool in its `param:<name>` test; reusing the recorded token is rejected as `unchained`. During `imprint teach`, the harness sets `IMPRINT_TEACH_CREDENTIALS` in the test subprocess so credentials extracted during redaction are available without requiring a separate `imprint credential set`. Also deleted after verification unless `--keep-test` or `IMPRINT_KEEP_TEST=1`.
- `.compile-log.json`, `.compile-done.json`, `.compile-give-up.json` — compile-agent transcript + sentinels (gitignored).
- `.live-verifier-log.jsonl`, `.live-verification-evidence.json`, `.live-verification.json` — crash-safe verifier events, sanitized backend/suite/call receipts, and the final semantic report. A suite receipt is created before Bun starts and survives failure, timeout, or abort even when no individual call completes. Labels are diagnostic only; semantic reports do not cite evidence IDs.

## Fresh master teach flow

The public teaching path is one fresh foreground controller:

1. It resolves the requested recording, or records a new one, then redacts it.
   The complete redacted recording remains authoritative for the master,
   focused planning, compilation, replay checks, and independent execution.
2. The relevance pass from shipped semantic triage gives only the candidate
   detector a narrower advisory view; the discarded effect-classification
   passes are not run here. An ordinary relevance-triage failure falls back to
   the complete view; cancellation and provider deadlines still stop the run.
   The master receives a separate compact boundary index of every valid
   XHR/Fetch across hosts, even when a telemetry heuristic would hide it. The
   index keeps request identity, URL, timing, status, types, exact digests, and
   lengths; full redacted request evidence is
   supplied to focused planning after the master chooses a boundary. The
   master may merge, split, rename, add, or remove detector proposals.
3. A focused tool-boundary advisor reviews that complete proposal.
4. The master writes the editable final tool plan. It may merge, split, rename,
   add, or remove an unsupported duplicate, but it must account for every
   credible discovered operation and explain its decisions.
5. The master writes explicit build waves. Every planned tool appears exactly
   once, and every producer is in an earlier wave than its consumers.
6. A focused planner receives only one tool, its relevant recording evidence,
   its dependencies, and the exact artifact contract.
7. A fresh focused compiler builds that tool. Independent tools in the same
   master-authored wave may compile in parallel.
8. The controller records contract, replay, live, and producer-consumer results
   as factual receipts. A playbook replay check is not applicable, not a
   failure.
9. After a tool passes, a focused parameter advisor reviews the public parameter
   choices. Its advice is not authoritative.
10. A failed check or useful advisor suggestion returns to the master. A changed
    tool invalidates only itself and the consumers that depend on it. Unrelated
    verified tools stay current.
11. A fresh independent reviewer sees the current plan, result evidence, and
    immutable check history. Completion is rejected while any planned tool is
    missing a current verified build.

The agents own semantic decisions: tool boundaries, parameters, request
sequences, dependencies, authentication, and API-versus-playbook strategy. The
controller only performs mechanical work: validates the plan and wave ordering,
runs focused jobs and checks, tracks what became stale after a revision, and
reports the terminal outcome.

A teach command never resumes an earlier run. Old run directories are
diagnostic evidence only. The command stays in the foreground until it reports
completed, blocked, failed, cancelled, or provider unavailable. Only completed
exits successfully.

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
