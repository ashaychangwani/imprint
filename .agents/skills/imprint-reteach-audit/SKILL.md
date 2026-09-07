---
name: imprint-reteach-audit
description: Re-teach Imprint sites from existing recordings and independently audit generated tools, including fresh-run repeatability checks and failed-run diagnosis.
metadata:
  version: "1.1.0"
allowed-tools:
  - Bash
  - Read
---

# Re-teach + audit imprint sites

Use this to rebuild a site's tools from its existing recording and confirm they work.

## Fresh master-flow validation

Check the branch and `timeline.md` first. For continuing the September 2026
experiment, read [the handoff](../../../docs/teach-handoff-2026-09-07.md). Its local
paths and process state are historical facts to verify, not instructions to
resume old processes or assumptions that the data exists on another machine.

Use a new isolated `IMPRINT_HOME` and an explicit recording. Do not use a
cleanup script that erases earlier output during a repeatability experiment.
After code or prompt changes, start fresh, never resume a failed teach.
Do not feed shipped examples or prior generated artifacts to the teaching agent.

## Commands

```bash
# Replace placeholders with verified paths; do not reuse a prior run home.
IMPRINT_HOME=<new-isolated-home> bun run src/cli.ts teach <site> \
  --agent codex --from-session <recording.json> --timeout 90m --no-interactive

# Audit (spawns a headless Codex that calls every compiled tool live and grades
# correct/broken; exit 0 = PASS, default threshold 95%):
IMPRINT_HOME=<same-isolated-home> bun run src/cli.ts audit <site> \
  --provider codex-cli --timeout 45m --json
```

## Hard rules

- Keep the configured two-worker concurrency. Run validation teaches and audits
  sequentially to avoid changing provider/browser load between comparisons.
- Respect the user's deadline. In this experiment the target is about 30 minutes,
  a reasoned progress decision at 60 minutes, and a 90-minute hard deadline.
  These are not universal defaults or permission to extend a run silently.
- Use the product's monitoring mechanism for long runs; stop task-owned monitors
  at handoff. A quiet agent is not by itself stuck. Check current facts before
  killing a run. No fixed repair-attempt limit is implied.
- To re-teach several sites + audit each as one hands-off job, loop them sequentially in a single background driver script (teach → audit → next).

## Monitoring a background teach (the log is spinner-heavy)

```bash
# strip ANSI + collapse \r redraws + drop spinner frames
sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g' LOG | tr '\r' '\n' \
  | grep -aviE '◐|◓|◑|◒|◇|◆|●|Triaging|Replaying|Compiling •|cycle [0-9]/5|^\s*$|^│|^├'
```
Watch for: shared modules `built + verified` vs `pruning`; per-tool `index.ts` appearing under `~/.imprint/<site>/<tool>/`; final `Done! N tools ready`. Avoid grepping `cycle`/`Compiling •` lines raw — they are giant `\r`-concatenated blobs.

## Known failure modes

- **Teach passed but audit failed:** baseline verification is narrower than
  parameter coverage. Read the generated parser, checked request, actual research
  observations, MVP review, and audit results. Equal unlabeled numbers can have
  different meanings; do not turn one site's inference into a runtime classifier.
- **Partial/proven handoff rejected:** check `basedOnObservationId` against the
  exact tested candidate, including input values and backend selection. A
  malformed agent report is not proof that an API failed. Preserve observations
  and let the master direct repair; do not accept untested changes as proof.
- **Missing upstream values:** inspect `call_producer` observations and the
  consumer's actual test. Recorded opaque values are diagnostic evidence, not
  replacements for fresh producer output. Do not mix values from unrelated rows.
- **Slow browser setup:** compare cold startup with warm same-tool/same-rung
  invocations. Do not share browser state across tools/rungs to improve a number.
  Cookie names and HTTP 200 alone establish neither usability nor semantics.

The following older shipped-path notes are diagnostic background, not a reason
to invoke removed legacy teaching entrypoints:

- **Valid shared module pruned for "must export a transform function"** — was a bun stale-`.ts`-import-cache bug; fixed in `src/imprint/prereq-builder.ts` (`importModuleFresh` copies the module to a unique sibling path before re-importing, defeating the cache). If it recurs, the fix is there.
- **Audit grader non-determinism on a no-op param.** A param that legitimately has no observable effect (e.g. a `brand` filter where two brands share the same data) can be graded `correct` one run and `tool_broken` the next, flipping a site between PASS and ~85%. The tools still return correct data — **re-audit once to confirm it's variance before treating it as a defect** (and report honest numbers, don't re-roll just to pass).
- **A network outage during the replay/capture stage corrupts the session** — events time out with 0 requests captured (the captured-count plateaus). Replay normally takes ~3 min; if it's dragging for many minutes with a flat capture count, the network dropped. Re-teach when the connection is stable. Diagnose via the per-event capture trajectory in the teach log (`Replaying event N/M (K requests captured)`).

## Verify + expose for live testing

- Read deterministic totals and actual invocation/parameter arrays; agent prose
  may miscount. Report failures, excluded bad inputs, unsupported parameters,
  and the selected scope alongside a percentage.
- A narrower public contract may be a valid MVP, but dropping an unproven
  parameter does not prove that feature was repaired. Keep all failed attempts
  in the comparison. Do not reroll audits merely to hide failures.
- Record run duration, input/output tokens, cache-read/cache-write tokens, and
  pricing assumptions. Do not sum aggregate and child trace usage twice; use
  provider-reported usage semantics. Interrupted usage may be incomplete.
- Check available disk before another large run. Never remove recordings,
  evidence, or caches without authorization. Keep private raw evidence local.

- PASS = audit exit 0 and score ≥ 95% (`graded N of N invocations`).
- The MCP registration `imprint mcp-server <site>` is a **command pointer** — it re-reads `~/.imprint/<site>/` on every spawn, so it always serves the latest teach. After a re-teach, a *running* Codex session must reconnect (`/mcp`) or start fresh to pick up new tools; a new session needs nothing.
- Confirm what's served: `Codex mcp list` (look for `imprint-<site>` ✓ Connected) and `Codex mcp get imprint-<site>`.
