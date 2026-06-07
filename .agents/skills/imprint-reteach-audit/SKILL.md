---
name: imprint-reteach-audit
version: 1.0.0
description: Re-teach one or more imprint sites from their existing recordings and verify them with `imprint audit`, including the concurrency rules, background-monitoring recipe, and the known failure modes.
triggers:
  - reteach site
  - re-teach
  - teach from scratch
  - audit site
  - rebuild tools
  - verify site
allowed-tools:
  - Bash
  - Read
---

# Re-teach + audit imprint sites

Use this to rebuild a site's tools from its existing recording and confirm they work.

## Commands

```bash
# Re-teach (wipes compiled artifacts, PRESERVES sessions/, recompiles from the
# newest raw recording, tracing on, compile concurrency 2):
IMPRINT_TEACH_TIMEOUT=30m bash scripts/teach-from-scratch.sh <site>

# Audit (spawns a headless Codex that calls every compiled tool live and grades
# correct/broken; exit 0 = PASS, default threshold 95%):
bun run src/cli.ts audit <site>
```

## Hard rules

- **Compile concurrency is 2 — never raise it, and never run two teaches at once.** Each teach already runs 2 compile agents; two parallel teaches = 4 concurrent Opus agents → trips rate limits. **Re-teach sites strictly sequentially.** Avoid overlapping a teach with an audit for the same reason.
- **Heavy search tools need `IMPRINT_TEACH_TIMEOUT=30m`+** (batchexecute / multi-filter search; the default is too tight once param-fidelity verification runs).
- Teach is long: **~40–75 min per site**, dominated by the heavy tools' `compile.generate`. Run it in the background and monitor.
- To re-teach several sites + audit each as one hands-off job, loop them sequentially in a single background driver script (teach → audit → next).

## Monitoring a background teach (the log is spinner-heavy)

```bash
# strip ANSI + collapse \r redraws + drop spinner frames
sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g' LOG | tr '\r' '\n' \
  | grep -aviE '◐|◓|◑|◒|◇|◆|●|Triaging|Replaying|Compiling •|cycle [0-9]/5|^\s*$|^│|^├'
```
Watch for: shared modules `built + verified` vs `pruning`; per-tool `index.ts` appearing under `~/.imprint/<site>/<tool>/`; final `Done! N tools ready`. Avoid grepping `cycle`/`Compiling •` lines raw — they are giant `\r`-concatenated blobs.

## Known failure modes

- **Valid shared module pruned for "must export a transform function"** — was a bun stale-`.ts`-import-cache bug; fixed in `src/imprint/prereq-builder.ts` (`importModuleFresh` copies the module to a unique sibling path before re-importing, defeating the cache). If it recurs, the fix is there.
- **Audit grader non-determinism on a no-op param.** A param that legitimately has no observable effect (e.g. a `brand` filter where two brands share the same data) can be graded `correct` one run and `tool_broken` the next, flipping a site between PASS and ~85%. The tools still return correct data — **re-audit once to confirm it's variance before treating it as a defect** (and report honest numbers, don't re-roll just to pass).
- **A network outage during the replay/capture stage corrupts the session** — events time out with 0 requests captured (the captured-count plateaus). Replay normally takes ~3 min; if it's dragging for many minutes with a flat capture count, the network dropped. Re-teach when the connection is stable. Diagnose via the per-event capture trajectory in the teach log (`Replaying event N/M (K requests captured)`).

## Verify + expose for live testing

- PASS = audit exit 0 and score ≥ 95% (`graded N of N invocations`).
- The MCP registration `imprint mcp-server <site>` is a **command pointer** — it re-reads `~/.imprint/<site>/` on every spawn, so it always serves the latest teach. After a re-teach, a *running* Codex session must reconnect (`/mcp`) or start fresh to pick up new tools; a new session needs nothing.
- Confirm what's served: `Codex mcp list` (look for `imprint-<site>` ✓ Connected) and `Codex mcp get imprint-<site>`.
