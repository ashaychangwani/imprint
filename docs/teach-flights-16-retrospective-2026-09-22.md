# Flights 16: native delegation validation

**Failed acceptance:** the run ended at 90.02 minutes with one tool published
and two not ready. Booking was excluded. The published location lookup passed
an independent strict audit: one actual invocation and its one parameter, both
correct. This is not a complete Flights pass.

Runtime commit: `e39d560`. Fresh home and private evidence:
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-16/`.
Started September 22 at 12:03:28 UTC; the unchanged hard deadline is 13:33 UTC.
The thirty-minute target was missed. At sixty minutes the decision was to
finish narrowed artifact verification within the original deadline.

## What the live run established

- Semantic researchers used host-executed JSON actions successfully. Their
  retained conversations continued through field-level repairs and observations.
- A two-request booking attempt failed after its first response. That response
  remained inspectable with its own attempt, backend, request index and observation
  identity. The failed execution was not accepted as proof.
- Booking called the current search producer in a separate workspace. The fresh
  response exposed outbound choices, not a complete round-trip selection.
- Five immutable shared findings were published by minute 43. An earlier status
  inspection missed these objects and incorrectly reported the interface unused;
  the corrected count is based on stored finding objects. Publication is proven;
  useful cross-agent reuse and a resulting time saving are not yet established.
- The native coordinator ended a turn early at minute 56 while work remained.
  Cleanup completed in one millisecond. The same family resumed, and the same
  calendar child subsequently tested and proved its narrowed candidate.
- The compatible location draft was reused. Final search and calendar compilation
  started together around minute 71. Only calendar needed renewed research after
  the master's revision, so this run has not exercised parallel repair of multiple
  researchers; the independent/dependent integration regressions cover that fix.

## Why the complete goal is still failing

Research proved a useful first-stage search response, but the early implementation
plan required complete round-trip itineraries. The compiler inspected the recorded
and live bodies and correctly refused to invent the missing return leg. Booking
independently found that the producer contract lacked a way to select an outbound
option and obtain the second-stage return result. A subsequent two-request repair
using fresh producer state failed with an upstream error envelope.

The master resolved this by narrowing search to outbound results and excluding
booking. That makes the contract more honest but does not satisfy the requested
end-to-end capability. This is an agent contract/handoff failure, not evidence of
provider overload, disk exhaustion, shutdown, or a network disconnect.

Calendar's recorded comparison showed that four window-bound inputs had no
effect in the tested page-owned capture. The agent returned a partial handoff,
and the master removed those unsupported inputs. The four remaining route/date
inputs were retested. Independent calendar parameter verification did not finish before the deadline.

The initial master also deferred one-way and multi-city before attempting them.
This does not meet the requested best-effort coverage of distinct recorded
purposes. It prevents a clean coverage comparison with Flights 15's nine tools.

## Two reproduced runtime blockers

The revised search compiler completed its local tests in 512.8 seconds, but the
controller rejected it because its native child identity changed. The adapter
used the revision directory as its conversation key. Keying by public tool name
within the run preserves the compiler across directory changes; the existing
identity check remains strict. A real-MCP synthetic regression fails on old code
and passes with the fix, also checking that another tool gets a separate child.

After final plan acceptance around minute 71, verification waited for all sibling
compilations. Lookup was ready, but its checks started around minute 83 and it
published around minute 86. Calendar obtained 49 live cells, but its recording
evidence review hit the deadline. Verification now starts through the existing
per-tool completion callback. The next dependency wave still waits for verified
producers. A regression reproduces the old barrier; independent and dependent
variants pass after the fix. No extra scheduler or worker pool was introduced.

## Timing and cost

Final sequential wall phases:

| Phase | Minutes | Share of elapsed wall time |
| --- | ---: | ---: |
| Discovery, advice and initial plan | 18.96 | 21.07% |
| First-pass research, overlapping drafts and handoff repair | 27.99 | 31.10% |
| Master revisions, follow-up research, final compilation and verification | 43.06 | 47.84% |

Draft work overlaps research; do not add it again. Native assignment dispatch
medians were 27.33 seconds initially and 27.45 seconds on follow-ups. Their summed
durations overlap and are not additive wall-time waste. There were 51 assignments
and 282 reads for at least 228 unique packet pages. Flights 15 had 887 reads for
297 pages. Scope and work differed; fewer rereads do not establish faster teaching.

Native child-turn intervals peaked at five, briefly. They include tool waits, so
they are not simultaneous provider-request measurements. One resumed child has an
incomplete terminal interval. No capacity error was recorded.

Teach usage reports 34,968,862 input tokens, including 32,910,976 cache reads,
and 216,265 output tokens. Cache writes report zero. At this campaign's rates
($4/M uncached input, $0.40/M cache reads, $20/M output), that is $25.7212344
base API equivalent. Two analysis calls lack usage; interrupted child usage may
be snapshots. This is reported usage, not a complete invoice.

The independent lookup audit took 39.34 seconds: 77,105 input tokens including
66,560 cache reads, 747 output tokens and zero reported cache writes. Its base
equivalent is $0.083744, making $25.8049784 reported for teach plus audit. The
audit's two graded units are one invocation and one parameter, not two invocations.

An isolated cold producer call took 44.1 seconds; a same-session calendar call
took 2.95 seconds. These are separate observations, not a universal cold/warm
speed ratio. Preserve browser isolation when comparing them.

## Next validation

Commit the two reproduced general fixes after affected integration tests, lint
and type checking. Start a fresh isolated teach; never resume Flights 16 under
changed code or supply its generated artifacts to the new agents. The complete
four-operation acceptance and best-effort recorded variants remain required.
Keep recording-dependent tool boundaries with agents. No site-specific strategy
rule, new scheduler, or relaxed evidence check is justified by this run.
