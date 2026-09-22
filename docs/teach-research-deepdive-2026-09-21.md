# Research-agent timing and improvement candidates — September 21, 2026

This report covers all twelve completed fresh Flights attempts. It supersedes the attempt count in the earlier timing snapshot, but does not rewrite that historical eleven-attempt measurement. No complete teach or final independent audit passed.

## Measured research work

715 retained model/compiler spans contain 457 research-agent calls. Research accumulated 417.2 worker-minutes, with at least one research call active for 351.1 elapsed minutes. Worker minutes sum overlapping calls; they are not user wait time.

| Decision returned at the end of the model call | Turns | Worker minutes | Share of research |
| --- | ---: | ---: | ---: |
| test | 243 | 289.3 | 69.3% |
| proven | 45 | 40.8 | 9.8% |
| partial | 28 | 32.2 | 7.7% |
| inspect_result | 76 | 29.2 | 7.0% |
| blocked | 24 | 10.0 | 2.4% |
| inspect | 20 | 9.5 | 2.3% |
| call_producer | 13 | 4.2 | 1.0% |
| decision | 8 | 2.0 | 0.5% |

The test row measures investigation and construction of a proposed test, not live execution. A proven/partial row includes evidence assessment and serializing the final candidate. Model-call duration includes provider latency; token prefill, internal reasoning, output generation and capacity waiting are not independently instrumented.

| Operation (analyst grouping) | Turns | Worker minutes | Share |
| --- | ---: | ---: | ---: |
| Search | 165 | 133.4 | 32.0% |
| Calendar | 115 | 131.2 | 31.4% |
| Booking / selection | 130 | 118.6 | 28.4% |
| Location | 41 | 30.2 | 7.2% |
| Coordination / unknown | 6 | 3.8 | 0.9% |

## Smallest changes worth testing

1. **Reference retained candidates instead of returning unchanged source.** 112 turns returned an earlier workflow/transform definition in the same run and tool, ignoring only parameterValues and testBackend. These turns consumed 111.7 worker-minutes and re-emitted about 433,000 definition characters. Some are useful warm repeats, backend contrasts or final reports; the measured turn duration is not all waste. Return an exact candidate reference for parameter/backend-only tests and final reports, while preserving hashes, observations and proof checks. This could reduce output latency and accidental reconstruction without moving strategy into the runtime. The current research loop requires a candidate even for proven/partial reports (api-research-agent.ts around 670).

2. **Prevent and recover malformed handoffs.** 26 research output-repair turns consumed 12.3 worker-minutes. Independent review refined the Flights 12 failure: the first master response nested decision fields under an invalid wrapper, and feedback reported six outer-shape errors. Repair corrected those, then exposed previously unreported nested follow-ups using suggestedExperiments instead of required instruction. The single repair allowance was exhausted. The master prompt already declares the correct strict shape; this is layered validation feedback, not evidence that the agent ignored the same reported errors twice. Keep prompt examples consistent, return complete actionable validation errors, and retain the coordinator conversation through repair. Invalid proof must remain rejected.

3. **Retain failed-chain intermediate responses.** Flights 12 booking could not inspect the complete earlier response after a later extraction failed. runtime.ts only invokes onRawResponses after its request loop; failed research writes neither the successful first body nor full result text. Preserve attempt/request identity and expose diagnostic inspection without turning a partial chain into success. SF-29 has a direct reproducer; isolated time savings remain unmeasured.

4. **Provide request evidence before committing dependency contracts.** Flights 12 initially paired a round-trip search contract with multi-city booking. Later, the chosen producer value omitted itinerary context, so the booking transform retained recorded route/date literals. Correcting that required more research at minutes 40.4 and 67.4. Initial retained master discovery omits request bodies; bounded, agent-selected representative evidence may prevent these late revisions. Avoid site-specific mode rules. This cause is plausible and recurrent, not an isolated savings measurement.

5. **Skip speculative drafts when there is no research left to overlap.** In Flights 12, all first-pass research returned around minute 28.55, but last-tool planning/compilation delayed master review until around minute 36.25. Preserve genuinely overlapping early drafting; skip only the non-overlapping launch. The roughly 7.7 minutes is delayed review, not guaranteed net savings, because the draft may be reused.

6. **Make retained-result inspection more efficient.** 72 turns receiving result-inspection slices consumed 46.1 worker-minutes. Their reasoning remains useful. Consider bounded structured projections or batched agent-selected searches over the same full response, with source offsets and provenance. Measure before changing the 2,000-character per-query limit; bigger excerpts can also increase latency.

## What the evidence does not support

- Do not label all repeated tests wasted. Exact warm repeats and fresh dependent calls are required evidence.
- Do not equate large prompts with the full cause of latency. The 95 research turns with at least 100,000 new-input characters had a 62.6-second median versus 43.2 seconds for smaller inputs, but their median output was also larger (2,400 versus 1,732 tokens). Task complexity and output size confound this comparison.
- Research usage reports 78,349,249 input tokens, including 64,494,592 cache-read tokens (82.3%), and 901,502 output tokens. Retained history explains why input tokens can greatly exceed the newest message. Missing usage is not treated as zero in cost claims.
- Removing browser sleeps is not the first demonstrated research optimization. Backend execution has a separate clock; the largest research bucket is generating the next test, not waiting for the live request.
- The dashboard flags format repair, repeated definitions, large inputs and long calls for inspection. A flag is not a verdict that every affected second is avoidable.

## Verification for the next implementation checkpoint

Make one small correction at a time. Use synthetic regressions to verify preserved candidate identity, parameter values, backend selection, history, failure classification and proof binding. For failed-chain evidence, reproduce a successful first response followed by a second-request failure across multiple rungs; verify that bodies cannot be mixed across attempts. For scheduling, test both genuine overlap and no remaining research.

Then run a fresh isolated teach on the same original recordings and fixed operation scope. Compare research turn count, output tokens, time to first useful live result, time to accepted contracts and total wall time. Track all failed attempts and do not infer savings from a single lucky pass. Require complete publication, strict independent audit, an unchanged-code repeat and Hotels validation before claiming reliability. No implementation change or new teach was started for this analysis.

The deeper trace check also corrected five minutes of stage attribution in the earlier eleven-run report: truncated initial master prompts hid their phase, but the returned bindings identify discovery. Discovery versus planning percentages were adjusted; research totals and the combined discovery/research/planning share did not change.

## Local dashboard and reproducibility

Open http://localhost:4193/ while the retained local server is running. The dashboard includes twelve attempts, 715 model/compiler intervals, 457 research turns and 247 complete observation objects recovered from trace inputs. Observation recovery is incomplete when tracing truncated a payload; backend log totals cover 358 completed duration-bearing attempts and are reported separately.

Private files remain under ~/.imprint/experiments/reteach-systemic-2026-09-21/:

- dashboard/: local-only website and on-demand source evidence.
- build-dashboard-data.py: reproducible extraction and candidate-definition comparison.
- stage-timing.py: deduplicated span classification and interval union.
- verify-dashboard-data.py: numerical and evidence-reference consistency checks.
- research-deepdive-summary.json and dashboard/public/data.json: numeric results.

2,683 data consistency assertions pass, including disjoint wall-time totals, category sums, duration bounds, complete evidence references and exact repeated-definition comparisons. The dashboard build, TypeScript check and lint for authored app files plus the used Button component pass. The generated starter has unrelated lint failures in unused components. No browser interaction/visual QA was requested or performed; WebMCP support is feature-detected but not browser-verified.
