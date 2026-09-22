# Measured fresh-teach timing — September 21, 2026

Scope: the eleven completed September 21 campaign attempts, including natural failures, operator stops and deadline failures. Active Flights 12 is excluded. The completed-attempt window ran from September 20 at 22:38 PDT to September 21 at 11:44 PDT.

The window spans 785.4 minutes (13 hours 5 minutes): 701.2 minutes inside teaches and 84.2 minutes between runs. Between-run work includes diagnosis, edits, tests and checkpoint preparation; its internal breakdown was not instrumented.

## Non-overlapping run wall time

Each wall-clock instant is counted once. When different categories overlap, that interval appears in the concurrent row rather than either category. Overlapping workers in the same category count once. Percentages use the 701.2-minute run-time denominator.

| Stage active alone | Minutes | Share |
| --- | ---: | ---: |
| Initial contract discovery | 72.5 | 10.3% |
| API research agent analysis | 285.9 | 40.8% |
| Focused planning and master repairs | 151.2 | 21.6% |
| Code generation and local tests | 46.5 | 6.6% |
| Parser fidelity and MVP verification | 46.6 | 6.6% |
| Different stages running concurrently | 29.4 | 4.2% |
| Outside recorded stage spans | 69.3 | 9.9% |
| Separate independent audit | 0.0 | 0.0% |

Research-agent time is time inside model calls for request investigation and candidate repair. It includes provider response latency; it is not measured CPU reasoning time or the API execution itself. Planning includes parameter/contract changes, focused planners, master decisions and repairs. Parser verification includes recorded/live raw-evidence analysis and MVP review, not the separate final audit.

## Stage activity including overlap

These union durations include a category while other categories are active. They remove nesting and same-category overlap, but cannot be added across categories.

| Stage | Active minutes | Share of run wall time |
| --- | ---: | ---: |
| Initial contract discovery | 72.5 | 10.3% |
| API research agent analysis | 315.2 | 44.9% |
| Focused planning and master repairs | 163.2 | 23.3% |
| Code generation and local tests | 63.8 | 9.1% |
| Parser fidelity and MVP verification | 46.6 | 6.6% |

## Live execution and test measurements

330 duration-bearing completed backend-attempt messages total 96.7 minutes, equivalent to 13.8% of run wall time. This includes failed attempts, browser/bootstrap setup and request execution. These calls can overlap model work, so this is a separate measurement, not an extra row in the 100% table. Interrupted calls without a duration are missing.

| Backend | Reported minutes |
| --- | ---: |
| fetch | 0.44 |
| fetch-bootstrap | 14.28 |
| cdp-replay | 80.49 |
| stealth-fetch | 1.49 |

The traces contain 68 completed `mcp.run_tests` spans totaling 42.2 seconds. This measures those tool executions only, excluding the compiler agent’s time writing tests, uninstrumented shell tests, external repository checks, and parser/MVP review above. It is nested in code-generation time and must not be added again.

Setup, pacing, network wait and site execution do not have sufficiently complete separate timestamps for a defensible campaign-wide percentage split. The 69.3-minute uncovered row includes live execution, host work, missing interrupted spans and gaps. It is not evidence of idle time.

## Per-attempt measurements

Stage columns below include overlap and are non-additive. All values are minutes.

| Attempt | Wall | Discovery | Research agent | Planning/repair | Code/local tests | Parser/MVP review | Logged live backends |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| flights-1 | 14.8 | 5.1 | 7.9 | 1.5 | 2.4 | 0.0 | 2.6 |
| flights-2 | 79.6 | 7.4 | 29.5 | 15.3 | 12.1 | 10.9 | 9.4 |
| flights-3 | 78.9 | 6.3 | 30.8 | 23.9 | 5.9 | 8.0 | 8.3 |
| flights-4 | 60.1 | 5.9 | 26.9 | 10.7 | 5.6 | 8.1 | 6.6 |
| flights-5 | 48.1 | 5.1 | 31.1 | 5.2 | 2.0 | 0.0 | 12.6 |
| flights-6 | 44.1 | 7.7 | 24.6 | 5.2 | 1.8 | 0.0 | 9.6 |
| flights-7 | 90.0 | 6.3 | 30.0 | 28.7 | 14.6 | 10.5 | 8.0 |
| flights-8 | 46.1 | 5.8 | 24.7 | 11.7 | 0.0 | 0.0 | 8.0 |
| flights-9 | 79.0 | 6.7 | 28.0 | 21.1 | 10.7 | 9.0 | 7.0 |
| flights-10 | 90.0 | 6.5 | 44.6 | 28.9 | 5.7 | 0.0 | 13.2 |
| flights-11 | 70.4 | 9.8 | 37.0 | 11.0 | 2.9 | 0.0 | 11.4 |

Classification correction during the deeper analysis: truncated initial master prompts sometimes hid the discovery phase. Their returned binding has no plan revision, identifying an initial decision. Using that field moves 5.4 minutes from planning/repair to initial discovery in this eleven-run table. Combined discovery/research/planning time and total wall time are unchanged.

## Source and calculation

Private source: `~/.imprint/experiments/reteach-systemic-2026-09-21/spans.jsonl`, run manifests and each run.log. Reproducible calculation: `stage-timing.py`; numeric output: `stage-timing.json` in the same private directory. OTLP spans are deduplicated by trace/span ID. Role classification uses span names, prompt role, input phase and output schema; no completed analysis span in the selected data was left unclassified. Incomplete/unflushed spans remain uncovered. Raw requests, live selection values and transcripts are not included here.

The data shows most elapsed time is consumed by research and repeated agent planning before final artifact validation. It does not establish which portion of those model calls is avoidable.
