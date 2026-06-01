# Decisions

A running log of the load-bearing calls made for Imprint. Each entry: the decision, the alternative considered, and the reason.

## D1 — Approach: Teach + Replay (not Teach + Expand)

**Decided.** User teaches by demonstrating; agent replays for verification; user approves before autonomous execution.

**Alternative:** Approach C (Teach + Expand) — agent learns related workflows autonomously from one demo. Promising but research-stage; would gate the v0.1 launch on an unsolved problem.

## D2 — Network-level capture, not vision-based

**Decided.** Capture API calls + DOM events at the protocol level (CDP). Compile both an API replay (workflow.json) and a DOM replay (playbook.yaml).

**Alternative:** Screenshot/CSS-selector automation. More durable in theory (you see what the user sees) but more fragile in practice (selectors rot every release; LLM vision is expensive per call).

## D3 — Two-artifact output per recording

**Decided.** Every recording compiles to BOTH `workflow.json` (API replay) and `playbook.yaml` (DOM replay). Cron / MCP pick at runtime via the backend ladder.

**Alternative:** Pick one per recording. Forces the user to know in advance whether the site has Akamai-class bot detection. We don't know until we try.

## D4 — Backend ladder with auto-escalation

**Decided.** `fetch → conditional fetch-bootstrap → stealth-fetch → playbook`. Walks in order; escalates on `FORBIDDEN` and on structured `STATE_MISSING` only when the next backend can satisfy every required missing item. The principle: as long as some backend would have worked, the call succeeds, but missing credentials or unsupported workflow gaps should fail with actionable errors instead of blindly launching a browser.

**Alternative:** One backend per site, configured manually. Cleaner mental model, worse UX — every Akamai migration becomes a config edit.

`fetch-bootstrap` is deliberately conditional rather than a permanent rung. It only runs when the workflow declares bootstrap metadata/captures or when `fetch` discovers state that browser bootstrap can mint. Plain API workflows keep the fast path.

## D5 — Stealth-fetch as middle rung (not as the only mode)

**Decided.** Mint Akamai/Cloudflare sensor tokens via brief Playwright bootstrap, then use native `fetch()` augmented with those tokens. ~12s bootstrap one-time per process, ~1s per call after.

**Alternative:** Always full Playwright. ~9s every call. Stealth-fetch is the cost-per-call sweet spot for sites whose APIs are token-validated rather than payload-validated.

## D5a — Browser bootstrap for state minting, not DOM replay

**Decided.** If a page exists only to mint cookies, CSRF tokens, local/session storage values, or DOM-exposed nonces, use `fetch-bootstrap`: launch Chromium briefly, harvest state, close it, and execute API replay through the normal runtime. Reserve `playbook` for workflows where UI behavior itself is load-bearing.

**Alternative:** Escalate from `fetch` directly to full DOM replay whenever state is missing. That works, but it loses the main performance win for stateful APIs.

## D6 — Probe backends at record time, cache the working order

**Decided.** `imprint probe-backends <site> --tool <toolName>` runs each applicable backend once and writes `backends.json`. cron / MCP read it at startup so they don't burn a fetch attempt every tick on known-blocked sites. v2 probe caches include canonical workflow and capability hashes; stale caches are ignored. Single-tool sites can omit `--tool`; multi-tool sites must select explicitly or point `--out` inside the target tool directory.

**Alternative:** Probe at runtime on every cron tick. Wastes ~200ms per tick + log noise on bot-protected sites.

## D7 — YAML for the playbook format (not markdown)

**Decided.** Playbook on disk is YAML. Parser is `YAML.parse` + Zod validation; ~30 LOC.

**Alternative:** Hand-rolled markdown state machine (H3 step blocks, bullet attribute parsing, comma-separated locator syntax). Originally tried; ~425 LOC of fragile parsing. YAML lets humans + LLM compiler write either format equally well.

## D8 — Single LLM compiler with two configs (compile.ts)

**Decided.** `generate.ts` and `playbook-compiler.ts` collapsed into `compile.ts`. Common skeleton (read session → redact → slim → call LLM → parse → validate → write) shared; differences (slim/prompt/parser/schema) parameterized.

**Alternative:** Keep them separate. They share the EXACT same shape — the next "how compilers handle X" change should be a one-file edit.

## D9 — MCP stdio default, Streamable HTTP optional

**Decided.** Stdio is the canonical transport for desktop MCP clients (Claude Desktop, Continue.dev, Cursor). HTTP is opt-in via `--http --port`.

**Alternative:** HTTP-only. Loses Claude Desktop compatibility.

## D10 — Don't drop documentation, relocate it

**Decided.** When trimming verbose comments out of code, move load-bearing context into `docs/`. Comments are sparse; docs are findable.

**Alternative:** Trim and forget. Loses the WHY behind decisions; future maintainers re-derive (or re-introduce the bug).

## D11 — Internal tools first as GTM

**Decided.** Companies automating their own admin panels / dashboards. Zero legal/ToS risk.

**Alternative:** Direct-to-consumer scraping of public sites. Higher addressable market, much higher legal exposure.

## D12 — Positioning: "Postman for AI agents"

**Decided.** Turn any internal tool into an MCP server in 5 minutes by showing an AI how to use it.

**Alternative:** "Browser automation framework", "headless RPA", etc. These map onto known categories with known incumbents (Playwright, UiPath). The Postman framing puts Imprint in a different mental category — one that's currently empty.

## D13 — Three-tool dead-code defense (knip + tsc-strict + madge)

**Decided.** `bun run check` includes three orthogonal dead-code detectors:
- `knip` — unused exports / unused files / unused dependencies / unused types
- `tsc` with `noUnusedLocals` + `noUnusedParameters` — unused locals, parameters, imports
- `madge --circular` — circular dependencies

All three are part of CI. Adding new dead exports / unused symbols / circular deps fails the build.

**Alternative:** Just `knip`. Catches most of it but misses the in-file unused-locals + circular-dep cases. The three together overlap a little but cover everything; the combined cost is ~3 seconds per `bun run check`.

## D14 — User-friendly errors over compact code

**Decided.** Every user-reachable `throw` should either (a) include a `→ next step:` hint pointing at the exact fix command, or (b) be a "shouldn't happen" assertion the user will never see. Verbose error messages are worth the extra LOC because the alternative is a docs round-trip every time someone hits a rough edge.

This shows up everywhere: `requirePositional` → "→ run \`imprint <verb> --help\`"; `loadJsonFile` → multi-line "noun not found / not JSON / schema mismatch + remediation"; `availableSitesHint` → "→ available sites: a, b, c"; LLM errors → "→ run \`gcloud auth application-default login\`"; etc.

**Alternative:** Terse errors that defer to docs. Forces users to grep docs for every error, which most won't do — they'll just give up.

## D15 — Named state captures over direct secret replay

**Decided.** The compiler should prefer named captures plus `${state.NAME}` for ephemeral values. Direct `${cookie["NAME"]}` lookup remains an expert escape hatch, but named captures can pin URL/domain/path constraints and avoid ambiguity.

**Alternative:** Let generated workflows rely on `${cookie.NAME}` and raw response aliases everywhere. That is shorter, but it breaks on duplicate cookie names, misses storage-derived state, and makes redacted equality hints harder for the compiler to use safely.

## D16 — requestTransformModule for site-specific request mutations

**Decided.** Allow `workflow.json` to declare an optional `requestTransformModule` path. The module exports `transform(method, url, responses) → url`. The runtime calls it before each request, enabling per-request URL signing, header injection, or dynamic query param construction.

The compile-agent writes this module when `stateHints` flag per-call query params (`query_param_changes_across_calls`). It uses `search_response_body` to find the signing function in the session's JavaScript responses and replicates the computation. Example: Namecheap's CRC32 + XOR + base64 URL signing.

**Alternative:** Bake signing logic into the workflow JSON URL template syntax (e.g. a `${sign(...)}` function). Too rigid — signing schemes vary widely (HMAC, CRC32, OAuth, custom XOR). A JS module is testable, composable, and doesn't pollute the workflow schema with execution semantics.

## D17 — Agentic workflow compilation with verification loop

**Decided.** Workflow compilation uses a multi-turn agent loop (`compile-agent.ts`) that writes `workflow.json` + `parser.ts` + `parser.test.ts`, runs external verification via a test-runner tool, and iterates on failures until tests pass. Candidate-scoped requests get inline data (headers, bodies, truncated responses) directly in the session summary so the agent can start writing immediately. On-demand read tools (`read_request`, `read_response_body`, `search_response_body`) remain available for requests outside the candidate scope or when inline previews are truncated.

**Alternative:** Single-shot LLM call with a "generate the perfect workflow" prompt. Produces unverified code — high risk of subtle bugs (incorrect JSONPath, wrong header substitution, off-by-one request indexing). Playbook compilation (D3) still uses the simpler single-shot path since playbooks are less error-prone (DOM locators, not API schemas).

**Rationale:** Verification-driven iteration catches the majority of codegen bugs before the user sees them. Inline data for candidate-scoped requests eliminates 20-30 serial read tool calls that previously inflated context from ~20 K to ~130 K tokens. On-demand access for the remaining requests still solves token budget blowouts on complex sites — e.g., Southwest fires 800+ requests, and the agent only needs full bodies for 5-10 of them. A budget-aware reduction strategy progressively strips inline response bodies to stay within `claude-cli`'s tool-result size limit (~40 K chars).

## D18 — OpenTelemetry tracing with Phoenix for LLM observability

**Decided.** All LLM calls, agent turns, tool invocations, and compile stages emit OpenTelemetry spans in OpenInference format. Tracing is opt-in via `IMPRINT_TRACE=1` or `PHOENIX_COLLECTOR_ENDPOINT=<url>`. Span attributes include token counts, prompt/completion text (when `IMPRINT_TRACE_LLM_IO=1`), and error details.

**Alternative:** Structured logging to stderr. Harder to correlate multi-step compile failures; no visualization of parallel tool calls or nested agent loops.

**Rationale:** Phoenix's trace UI makes it trivial to spot which LLM call is slow, which tool call failed, and what the exact prompt/response was. Essential for debugging multi-turn compile-agent failures where the error surfaces many turns deep.

## D19 — LLM-based request triage before compilation

**Decided.** Before compiling, send request metadata (method/URL/resourceType/status/mimeType, with bodies truncated to 4 KB) to the LLM and ask it to return the seq numbers relevant to the user's intent. Only the selected requests pass to the compile agent.

**Alternative:** Heuristic filtering (e.g., same-origin + XHR/Fetch only). Misses cross-origin SSO flows and over-filters on sites with unconventional API patterns.

**Rationale:** Modern SPAs fire 500-1000 requests; sending all of them blows the compile-agent's context window. The triage call costs ~$0.02 and reduces the agent's input from millions of tokens to hundreds of thousands on complex sites. The agent still has read-access to filtered-out requests if it discovers it needs them.

## D20 — Redaction scope: key-based responses, envelope-safe, real-secret policy set

**Decided.** Three narrowings of redaction: (1) response bodies are redacted by sensitive **field name** only — no value-pattern (free-form) scan; (2) the free-form fallback never flat-scans a structured RPC envelope (a body led by the `)]}'` anti-XSSI guard or a `<len>\n[…]` length-prefixed frame), detected by `looksLikeRpcEnvelope` in `redact.ts`; (3) the `redactum` policy set drops the four `GENERIC_*` catch-alls (PASSWORD/TOKEN/CREDENTIAL/SECRET), keeping core PII, private keys, JWT, and keyword-anchored cloud/service-token policies.

**Alternative:** Keep full free-form scanning on every body with the generic policies. Rejected: scanning the whole response as flat text injected `[REDACTED]` into bare numeric IDs/coordinates **inside** doubly-encoded `batchexecute` payloads (15/28 payloads corrupted in a real google-hotels recording → un-parseable inner JSON, which then failed the shared-module verifier and pruned a correct decoder), and the `GENERIC_*` policies fire on benign `id=1234567890`-style data.

**Rationale:** Only the structured `[REDACTED:v3:id=N:len=L]` markers on headers/cookies/storage and `${credential.X}` placeholders are consumed downstream (compile-tools `buildStateHints`, app-api-hosts `hasAuthSignals`) — free-form **body** scrubbing is never consumed by compile logic, so reducing it is safe for compilation. The real secrets in a recording are post-login cookies (kept, structure-aware) and user-entered PII (kept on the request/URL/event side); server response bodies are not where a user's secrets live. Narrowing to keyword-anchored, real-secret patterns preserves the security floor while eliminating both the corruption and false-positive classes.

## D21 — Shared-module build: plan-first, level-parallel, gate-visible

**Decided.** Three changes to how `prereq-builder.ts` builds each `_shared/*.ts` module: (1) **plan-first** — a planning pass (`prompts/prereq-planner.md`) decodes the recorded sources into a Markdown implementation plan (data shape, per-export algorithm, exact `noUncheckedIndexedAccess` guards, test plan, risks) that is injected into every implement→verify cycle and persisted to `_shared/<name>.plan.md`; (2) **level-parallel** — modules build in topological levels (`topoLevels` in `build-plan.ts`) with independent modules in a level built concurrently under a small cap (`mapLimit`, the shared helper extracted to `concurrency.ts`), instead of strictly one-at-a-time; (3) **gate-visible** — each failed cycle reports which gate blocked it (`summarizeFailures`: typecheck / test / anchor / …) in the progress line and log instead of a bare "verify failed".

**Alternative:** Keep the single-shot generate→verify loop, serial across modules, with opaque failures. Rejected: gnarly modules (e.g. a Google `batchexecute` decoder — anti-XSSI guard, length-prefixed frames, doubly-encoded JSON, deep positional arrays) routinely burned all 5 cycles and got pruned, because each cycle re-derived the envelope shape from scratch and tripped the strict-typing gate on dense indexed access; serial builds wasted wall-clock on independent modules; and an opaque "verify failed" gave no signal about whether the blocker was structure or types.

**Rationale:** Separating "understand the format + decide the approach" (plan) from "write `tsc`-clean code" (implement) makes the first implementation attempt far more likely to pass, so retries fix mechanics rather than re-litigating structure — the highest-leverage fix for the per-module difficulty. Level-parallelism cuts wall-clock for the common multi-module case while still respecting `dependsOn` (a dependent only builds after its dependency's level, and only verified dependencies are made importable). Surfacing the failing gate makes a slow build debuggable. Planning is best-effort and gated (`IMPRINT_NO_PREREQ_PLAN=1`), so the path degrades to prior behavior on any planner failure; the per-module cost is one extra `llm.analyze` call, amortized by the cycles it saves on hard modules.

## D22 — Per-tool plan → execute, replacing the contract-test feedback loop

**Decided.** The overall compile shape is **plan + build shared modules once → for each tool, plan then execute** (tools concurrent; plan→execute sequential within a tool). Each tool's compile is preceded by a short per-tool planning pass (`tool-plan.ts`, one `llm.analyze` against `prompts/tool-planning.md`) that maps each parameter to its recorded field, fixes request construction + response parsing, and names the shared modules to import. The Markdown plan is persisted to `~/.imprint/<site>/<toolName>/.tool-plan.md` and injected into the compile agent's initial message (`formatToolPlan`, shared verbatim by the in-process loop and both CLI drivers). It is best-effort — a 5-minute timeout, missing prompt, or any error yields no plan and the compile proceeds as before; disable with `IMPRINT_NO_TOOL_PLAN=1`. This **removed** the earlier TDD / contract-test layer (`contract-test-*.ts` + a `priorFindings` compile-feedback loop): compile → generate per-tool contract tests → run them → feed `tool_broken` findings back → recompile (bounded). The single `priorFindings: string[]` feedback channel was repurposed into the `toolPlan?: string` channel along the same path.

**Alternative:** Keep the contract-test feedback loop (generate + run per-tool tests, recompile on `tool_broken`). Rejected: it did not measurably raise per-tool accuracy, and it added ~1300 LOC of contract-spec generation, an LLM adjudicator, and a bounded recompile loop — significant complexity and extra LLM calls per tool for little benefit.

**Rationale:** Front-loading the analysis (decode the recording, decide the param→field mapping and parse paths *before* writing code) lands the same "does it behave as advertised?" property the contract loop was chasing, but at compile time and for one cheap planning call instead of a generate-test-adjudicate-recompile cycle. Correctness is then confirmed post-hoc by the `imprint audit` gate (D23) against the live API, which is a truer signal than synthetic contract assertions. The plan rides the existing initial-prompt path used by all three drivers, so there is no new sidecar threading or MCP arg change.

## D23 — Headless-claude audit harness as the acceptance gate

**Decided.** `imprint audit <site>` is the acceptance gate for a site's generated tools. It discovers the site's tools via the same `discoverTools` the MCP server uses, points a **headless `claude` session** at the site's real `imprint mcp-server` over stdio (only that site's tools allowed), and asks it — via a fully site-agnostic system prompt (`prompts/audit-agent.md`) — to invoke each tool with a realistic param set plus 1–2 edge cases derived only from the schema/description, judge each result, and classify each invocation `correct` | `tool_broken` | `infra` | `bad_params`. The auditor returns a single zod-validated JSON report; **imprint computes the score deterministically** (`computeAuditScore`), never trusting a number from the model. Score = `100 × correct / (correct + broken)`; `infra` (anti-bot / rate-limit / 403/429 / network / timeout) and `bad_params` are excluded from the denominator. **Pass** = `score ≥ minScore` (default 95) AND `≥ 2 × toolCount` gradeable invocations; no gradeable invocations → **inconclusive**. Exit codes: `0` pass, `1` fail, `2` inconclusive.

**Alternative:** Trust a score the auditor reports, or assert against fixed expected outputs per tool. Rejected: a model-reported score can be talked up by a generous auditor; fixed expected outputs are brittle for live search APIs whose results change every call, and would require per-site fixtures (a no-overfit violation).

**Rationale:** Exercising the tool against the live API through the real MCP path is the truest test of "works as advertised", and recomputing the score from per-invocation verdicts keeps the gate honest. Excluding `infra`/`bad_params` from the denominator prevents anti-bot blocks or auditor mistakes from masquerading as code bugs, and the `inconclusive` verdict (distinct exit code `2`) separates "fix the code" from "the site blocked us — re-run". The whole harness is general, and the no-overfit guardrail (a grep gate forbidding site/URL/tool names in the prompts + generation logic) keeps any fix improving a *category* rather than one site's number.
