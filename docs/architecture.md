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
├── stealth-fetch.ts     Headless Chromium → mint sensor tokens → native fetch
├── stealth-token-cache.ts  Per-site stealth token shared across compile-time bun-test processes
├── playbook-runner.ts   Playwright + stealth + locator priority + DOM walk
│
│ ── Services ──
├── cron.ts              Polling daemon
├── mcp-server.ts        MCP stdio + Streamable HTTP
├── audit.ts             Acceptance gate: headless-claude exercises every tool, imprint scores it deterministically
├── install.ts           Register/remove emitted local or example tools with MCP clients
├── probe-backends.ts    Try each backend at record time → backends.json
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

Set `IMPRINT_TRACE=1` with `PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006` to emit OpenInference spans to a local Phoenix server. The trace hierarchy drills into every stage of the compile pipeline:

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
└─ audit.session (AGENT)        ← imprint.audit.{score, correct, broken, infra, bad_params, graded, verdict}
    └─ (headless claude drives the site's real mcp-server tools)
```

Each `agent.turn.N` span records per-turn input/output tokens and stop reason. Each `llm.message_with_tools` span records model, provider, token counts, and which tools the model called. Each `agent.tool.X` span records tool execution time, result size, and (when `IMPRINT_TRACE_TOOL_IO=1`) the input arguments and output.

Stage spans carry their own end-attributes for fast triage: `teach.record` (`imprint.record.event_count`), `teach.redact` (`imprint.redact.*` counts), `teach.combine_sessions` (`imprint.combine.{session,request,narration}_count`), and `teach.plan_tool` (`imprint.tool_plan.chars` / `.skipped`). Opening the `cli.teach` trace lets you locate the failing stage by span status/attrs — a `teach.plan_prereqs` timeout, a `teach.build_shared_module` with `ok=false`, an empty `teach.plan_tool`, or a `compile.generate` that gave up.

Add `IMPRINT_TRACE_LLM_IO=1` and `IMPRINT_TRACE_TOOL_IO=1` when you need prompts, responses, tool arguments, and tool results in the trace UI. Token counts come from the provider when available and fall back to estimates otherwise; cost attributes are added when `IMPRINT_TRACE_INPUT_USD_PER_1M` and `IMPRINT_TRACE_OUTPUT_USD_PER_1M` are set.

**Ephemeral artifacts** the compile-agent writes during a run but does not persist:

- `parser.test.ts` — `bun:test` suite that exercises `parser.extract()` against the load-bearing response body. Reads the redacted session via `process.env.IMPRINT_SESSION_PATH` set by the harness. Must include a `synthetic:empty-result` test — `extract()` must return a clean empty collection for a no-match/empty response, never a single all-null placeholder record; the verifier requires that test to be present and to pass. Deleted after verification passes; pass `--keep-test` to `teach` / `generate` (or set `IMPRINT_KEEP_TEST=1`) to retain it for local debugging.
- `integration.test.ts` — live API test that calls the workflow through the backend ladder (`runWorkflowWithLadder`: fetch → stealth-fetch). A **baseline** test verifies the workflow produces real data (catches expired hardcoded tokens, missing URL signing), and one **`param:<name>`** test per exposed parameter overrides it with a discriminating value and asserts the response is actually constrained. The verifier identifies coverage by which `param:<name>` tests *ran green* (parsed from a JUnit report) — not a static source scan — so a suite waived by anti-bot can't be counted as covered. A parameter with no passing `param:` test that the agent annotates `// exposed-but-not-verified` ships flagged `verified:false` in `workflow.json` rather than being dropped (keep + mark). A parameter that is an **opaque token minted by a sibling tool** (e.g. a `get_*_details` tool's id that a `search_*` tool emits) is held to a stricter bar: its `param:<name>` test must mint a *fresh* value by calling the producer's `../<sourceTool>/workflow.json` and feed that (not the recorded constant) — reusing the recorded token is rejected as `unchained` (it can't prove the producer/consumer field contract). On success the param is stamped `sourcedFrom: {tool, field}`, which the MCP schema turns into a description telling the orchestrating LLM where to mint the value; if the producer is anti-bot-blocked at compile the param waives to `verified:false` reason `waived-chain`. To keep these live tests from re-bootstrapping headless Chromium per process (a burst that trips anti-bot), the compile-time stealth token is shared across the site's test processes via `stealth-token-cache.ts`. During `imprint teach`, the harness sets `IMPRINT_TEACH_CREDENTIALS` in the test subprocess so credentials extracted during redaction are available without requiring a separate `imprint credential set`. Also deleted after verification unless `--keep-test` or `IMPRINT_KEEP_TEST=1`.
- `.compile-log.json`, `.compile-done.json`, `.compile-give-up.json` — agent loop transcript + sentinels (gitignored).

## Multi-tool shared modules (plan-prereqs)

When one recording compiles into **two or more** tools, `imprint teach` inserts a `plan-prereqs` step between candidate selection and the per-tool compile fan-out. Single-tool recordings skip it entirely (the path is unchanged). Set `IMPRINT_NO_BUILD_PLAN=1` to disable it and compile every tool independently.

The step does two things, once per teach, before the fan-out:

1. **Plan** (`build-plan.ts`, single-shot `llm.analyze` against `prompts/build-planning.md`) — produces a `BuildPlan`: the shared modules to create (`request-transform` signing, `parser-helper` decoders, shared `types`), per-tool guidance (load-bearing seqs, parser guidance, parameter checklist), an `authRecipe` each tool replicates inline, and the cross-tool **opaque-token contract** (consumer `tokenParams` ⇄ producer `emitsTokens`). The contract is not left to the planner's discretion: `deriveTokenContractHints` first walks the dual-pass classifications **deterministically** — a `server_derived` value sent by one tool but produced in a *different* tool's response (matched by `producerSeq`/`originalSeq` → owning tool via `requestSeqs`; `header:` session tokens and shared/ambiguous seqs skipped) — and feeds those grounded edges into the planner payload. After the planner returns, `reconcileTokenContracts` re-applies the same edges to the parsed plan: it injects any contract the planner dropped and repairs half-declared ones (a `tokenParam` whose producer forgot the matching `emitsTokens`, which `superRefine` would otherwise reject), so a planner shortcut can't silently lose a chain. The plan is persisted to `~/.imprint/<site>/.build-plan.json`.
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

Scoring: `score = 100 × correct / (correct + broken)`. Only `correct` and `tool_broken` are graded; `infra` (anti-bot / rate-limit / 403/429 / network / timeout) and `bad_params` (the auditor's own mistake) are excluded from the denominator, so a blocked or misused tool isn't counted as a code bug. **Pass** requires both `score ≥ minScore` and at least `max(2, gradeableTools)` gradeable invocations, where `gradeableTools` is the number of tools that produced ≥1 gradeable invocation. Scaling the signal floor to *gradeable* tools (not all tools) means a tool the auditor can never exercise — e.g. one that needs an opaque token it cannot synthesize — no longer inflates the bar and sinks an otherwise-perfect run; such tools are listed as `ungradeableTools` in the report. The floor is one gradeable call per gradeable tool (not two): the auditor often spends a slot per tool on `bad_params`/`infra`, so demanding two clean reads per tool false-failed otherwise-perfect runs. Real defects still fail on `score`, not on this count. No gradeable invocations → **inconclusive** (re-run / the site blocked us, not a code failure). Exit codes distinguish the cases: `0` pass, `1` fail (logic bugs), `2` inconclusive. The full result (deterministic score + the raw model report) is persisted to `~/.imprint/<site>/.audit-report.json` and traced under `cli.audit` → `audit.session`.

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

Example: `examples/namecheap-domains/search_namecheap_domains/request-transform.ts` implements Namecheap's CRC32 + XOR + base64 URL signing scheme.

### Parser context

The parser's `extract()` function receives an optional second argument:

```ts
extract(rawResponse: unknown, context?: { params: Record<string, string | number | boolean>; responses: unknown[] }): unknown
```

- `context.params` — the tool parameters the caller provided.
- `context.responses` — all response bodies from the workflow chain (index 0 = first request).

Use `params` when the parser needs a value the API doesn't echo back (e.g. the search term for constructing domain names from a TLD catalog). Use `responses` when the parser merges data from multiple chained requests.
