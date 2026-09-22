# Flights 13 retrospective — September 22, 2026

**Summary:** The run exhausted its 90-minute deadline with two of four tools
published. The main failure was expensive rediscovery across agent handoffs:
recording provenance and the exact search-to-booking value were reconciled too
late. There is no evidence that power, disk space or a network disconnect ended
this run. Coordinator repair worked in the observed case, but overall reliability
remains unproven. Another unchanged retry would not address the demonstrated gaps.

## Result and scope

Fresh isolated Flights 13 used runtime `620129d`, the original recording and
unchanged four-operation guidance. It ran from 05:48:40 to 07:18:41 UTC,
90.0126 minutes, exit 1. Location lookup and the date grid published. Search and
booking did not. All four research handoffs reaching proven was an intermediate
result; the generated search-to-booking chain was never verified.

The independent strict partial audit took 1.7413 minutes and exited 2,
inconclusive. Both installed tools returned correct results in their recorded
cases. Three public parameters were graded working; calendar origin and
destination were untestable. Its displayed 100% covers five graded units only.
It is neither a four-tool pass nor proof that the route parameters work.

## What actually consumed the deadline

Elapsed times below come from the retained model spans and execution log.

| Minute | Evidence and consequence |
| --- | --- |
| 8.94 | Initial master chose four operations, including one-way search. Its selected request had no recorded response body; the populated fixture used a different trip mode. |
| 17.32 | Search research was proven after correcting extra nesting in the request. The researcher explicitly distinguished those recording modes. |
| 20.15 | A focused search plan selected the other response fixture. Its provenance no longer matched the proven workflow. Early planning/drafting also held worker slots while calendar and booking research waited. |
| 24.01 | Calendar repaired a missing required candidate field using the new schema feedback in the same conversation. This run did not exercise multiple layered repairs on one decision. |
| 41.41 | Master revised calendar's public parameters and booking's coupled inputs after partial handoffs. Several booking readiness guesses had each consumed roughly 45 seconds. |
| 49.49 | All four research handoffs were accepted, including a booking test using fresh, coherent search values. |
| 55–58 | Final planning completed, but search could not compile because the plan and proven workflow named different recorded response sources. The strict provenance gate correctly refused the mismatch. |
| 62–65 | Location and calendar published after independent parser/MVP checks. |
| 67.98–76.29 | Another search research/planner/master cycle reconciled provenance and explained the limited fixture comparison. Search compilation finally started at minute 76.29. |
| 82.83 | One independent evidence-reader request received a provider prompt-policy rejection. It did not produce verification evidence. |
| 85.39 | Master found a separate parser defect: search emitted a serialized selection object where booking required a different opaque value from the same record. Matching field names and string types had hidden the mismatch. |
| About 88 | The parser correction's live call completed; independent evidence review was still unfinished. |
| 90 | The shared deadline ended the run. Booking compilation and the generated dependency-chain check had not happened. |

The interval from first proven search research to actual search compilation was
about **59 minutes**. Other useful work occurred in that interval; it is not
59 minutes of measured removable waste. Nevertheless, a previously known
recording distinction was resolved through several additional agent cycles.

## Measured time allocation

This is an exclusive wall-clock partition from deduplicated trace spans.
Same-category concurrency is merged. Time with multiple categories active has
its own row, so the percentages add to 100% after rounding. Research here means
agent turns; live execution between turns is not automatically attributed to it.

| Activity active without another listed category | Minutes | Run wall time |
| --- | ---: | ---: |
| Initial discovery and selection | 8.92 | 9.9% |
| API research agent turns | 26.72 | 29.7% |
| Planning and master repairs | 23.72 | 26.4% |
| Code generation and local tests | 8.24 | 9.2% |
| Parser and MVP verification | 8.47 | 9.4% |
| Multiple categories overlapping | 6.45 | 7.2% |
| Outside completed categorized spans | 7.49 | 8.3% |

Counting overlapping activity, research was active for 30.76 minutes (34.2%) and
planning/repair for 29.10 minutes (32.3%). These are non-additive percentages.
Thirty-six completed backend log entries total 11.76 call-minutes, including
setup and failed attempts: CDP 10.49, bootstrap 1.06, stealth 0.17, fetch 0.04.
They overlap the wall-clock categories and exclude interrupted calls without a
completed duration. Ten local test spans total 6.94 seconds, nested in compilation.
Uncovered trace time must not be labeled idle or entirely browser setup.

Browser cost is real, but setup reduction alone does not fix late contract repair.
One search research repeat took 2.045 seconds; later isolated search calls took
about 40–44 seconds. Those are different setup conditions. The earlier 8.885-second
CDP research call already reused a browser, so it is not a cold-start benchmark.

## Causes and the smallest useful corrections

1. **Recording evidence reached decisions unevenly.** The advisor and focused
   researcher saw distinctions that the initial master input only summarized.
   `masterDecisionConversationInput` sends coverage counts, while
   `discoveryEvidenceDocuments` omits request bodies and response previews.
   Forward the advisor-selected bounded wire examples before initial decisions,
   as planned. Agents should distinguish request-shape evidence, parser fixtures
   and live proof, including changes needed to make an old recording current.
   Do not weaken `apiResearchMatchesPlan`: surface its exact mismatch to the
   retained planner before another compile cycle rather than silently accepting it.

2. **A successful consumer test did not sufficiently constrain producer output.**
   Fresh upstream data was used correctly during booking research. The later
   producer parser nevertheless chose another same-record value. Carry the exact
   tested consumer input together with its source observation, path/representation
   and associated context into producer planning and verification. Agents still
   decide what the value means. A synthetic producer with two distinct strings in
   the same record should reproduce this failure; successful independent
   producer-to-consumer execution must verify the correction. No token-prefix or
   site-specific runtime rules are justified.

3. **Failed execution loses evidence needed for efficient repair.** A separate
   synthetic reproduction confirms that the current complete-chain callback
   loses earlier bodies after a downstream HTTP/capture failure or cancellation.
   This is a demonstrated architecture defect, but this run does not quantify its
   contribution to the deadline. The next approved checkpoint remains incremental
   per-request retention and bounded inspection. Keep attempt/backend/request
   identities distinct and failures classified as failures.

4. **Draft work competes with research it is intended to overlap.** The awaited
   `onProven` callback runs planning/compilation inside a research worker slot.
   Prioritize queued research and recheck whether useful research overlap remains
   before compilation. Preserve reusable drafts and two workers. The location
   draft was reused; treating all early drafting as wasted would be incorrect.

5. **Advertised parameters lack sufficient audit evidence.** The grid returned
   correct date/price data but no independently usable route evidence. Agents must
   use relevant recorded route evidence or narrow the contract. Echoing an input
   in output does not prove it affected the request. Do not invent extra challenge
   calls or lower strict audit requirements.

6. **Provider rejection interrupted one review.** Keep that result separate from
   parser/API failures. It was a deterministic prompt-policy error, not a transient
   capacity event; no automatic capacity retry or workaround is appropriate.
   Its exact offending input is not identified by the response. Do not claim
   that a smaller prompt would necessarily avoid it or that it alone caused the
   entire 90-minute failure.

Request-construction and readiness mistakes also occurred: extra array layers,
an incorrect encoded trip mode, and selectors that did not establish the needed
page state. Existing factual comparisons helped agents correct them. Retain
those comparisons and bounded failed-response evidence; do not add a site-specific
execution ladder or universal semantic classification of HTTP errors.

## What changes in the next experiment

Continue the approved checkpoint order: response retention, early selected
evidence, SDK terminal handling, candidate references, then draft scheduling.
Use the exact consumer-value mismatch as a focused systemic regression when
improving evidence delivery. Reproduce any additional blocker before its smallest
general correction. SDK terminal handling remains a separately reproduced defect;
this run does not establish it as a cause.

After each checkpoint, run a fresh isolated teach and independent audit, preserving
the original scope, recording-backed cases and deadline. Measure when all contracts
stabilize, provenance repairs, when search compilation begins, and whether the
generated booking chain consumes the exact fresh producer values. Retain strict
audit failures and failed attempts. No old run is resumed under changed code.
Stop optional optimizations if audited repeatability succeeds without them.

This is a tractable set of observed failures, not evidence that the task is
impossible. It also does not establish that the remaining fixes will guarantee a
pass. Completion still requires two fresh, independently audited Flights runs
and two Hotels runs on unchanged code.

## Evidence and accounting

Private evidence remains under
`~/.imprint/experiments/reteach-systemic-2026-09-21/`: `spans.jsonl`,
`flights-13/manifest.json`, `flights-13/run.log`,
`flights-13/model-progress.json`, the run's retained journal and research files,
and `flights-13/home/google-flights/.audit-report.json`.
`flights-13-stages.py` produces `flights-13/retrospective-stages.json` without
changing the dashboard or previous timing reports. Raw response data stays local.

Teach: 14,980,857 reported input tokens, including 11,431,552 cache reads;
200,868 output; zero reported cache writes. Audit: 126,198 input, including
108,672 cache reads; 1,646 output; zero reported cache writes. Combined base API
equivalent is **$22.9336936**, using the campaign's existing rates, not an invoice.
Two teach calls lack usage; their costs are unknown. No missing usage is treated
as zero and no successful speed improvement is claimed.
