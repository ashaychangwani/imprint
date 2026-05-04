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

**Decided.** `fetch → stealth-fetch → playbook`. Walks in order; escalates only on FORBIDDEN. The principle: as long as some backend would have worked, the call succeeds. Eliminate "Imprint can't help here" as a failure mode.

**Alternative:** One backend per site, configured manually. Cleaner mental model, worse UX — every Akamai migration becomes a config edit.

## D5 — Stealth-fetch as middle rung (not as the only mode)

**Decided.** Mint Akamai/Cloudflare sensor tokens via brief Playwright bootstrap, then use native `fetch()` augmented with those tokens. ~12s bootstrap one-time per process, ~1s per call after.

**Alternative:** Always full Playwright. ~9s every call. Stealth-fetch is the cost-per-call sweet spot for sites whose APIs are token-validated rather than payload-validated.

## D6 — Probe backends at record time, cache the working order

**Decided.** `imprint probe-backends <site>` runs each backend once and writes `backends.json`. cron / MCP read it at startup so they don't burn a fetch attempt every tick on known-blocked sites.

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
