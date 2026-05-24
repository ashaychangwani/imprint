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
