# Flights21 retained-evidence audit

Flights21 failed with zero published tools and seven unfinished tools. However,
the final round-trip and multi-city booking responses contained the exact selected
legs and booking-provider links. The earlier status update understated that
progress. The terminal failure was an unfinished research handoff at the deadline,
not evidence that those final booking API calls failed.

This is an offline audit of retained decisions, workflows and actual responses.
It is not the required independent live audit of generated tools. No new teach,
runtime change, external request, deletion, push or MR was performed for this review.

## Run and evidence

- Implementation: `0894a94`; launch HEAD `3b5c50c` adds documentation only.
- Run: `7e8fbf07-d9e8-4f0b-9f6f-1cad47188eb6`, empty Flights21 home.
- Start/end: September 22, 20:48:47–22:25:19 UTC; 96.53 elapsed minutes.
- Teach deadline: 22:18:48 UTC. Exit 1, no completed booking handoff or audit.
- Private evidence: `~/.imprint/experiments/reteach-systemic-2026-09-21/flights-21/`.
  Native role/research transcripts, retained responses and drafts remain under
  `home/google-flights/.teach-runs/<run-id>/`. Computed reports include
  `native-retrospective.json`, `persistent-research-timing.json` and
  `offline-booking-audit.json`. No raw evidence is included in this document.
- 18 native assignments, 17 completed, 43 assignment reads; nine shared findings.
  No recorded native-family failure. 32 retained response entries: 28 HTTP 200,
  four HTTP 400. HTTP status is not semantic proof.
- Reported input 27,289,736, including 25,099,136 cache reads; output 170,622;
  reported cache writes zero. Estimated base-equivalent cost $22.2144944, using
  $4/M uncached input, $0.40/M cached input and $20/M output. This is not an invoice.

## What went wrong independently of sleep

### 1. A different recorded purpose became the one-way proof

The initial master acknowledged that one-way request 206 lacked a captured response
body. The researcher inspected alternatives, chose request 245 and called it a
successful one-way fixture. Its workflow retained that request's mode.

The recording contradicts that characterization: event 204 selects One way and
request 206 has mode 2; event 243 selects Multi-city and request 245 has mode 3.
Both requests contain one leg. The live response contained plausible flights for
that leg, which the researcher accepted as one-way proof. The planner repeated
the claim and shared memory published it as a discovery.

This does not establish that the two modes always behave differently. It establishes
that equivalence was never demonstrated and that a different recorded purpose was
accepted without reconciling the difference. A matching route and plausible output
were insufficient. The retained six `proven` handoffs must not be described as six
independently verified capabilities.

General correction: agents must reconcile changed execution references against
the intended recorded action and relevant request differences. Keep parser fixtures
distinct from execution proof. A missing recorded body does not itself justify
substituting another operation for a live test of the original request.

### 2. Booking started with an incomplete dependency contract

The advisor and master split search into three trip purposes but grouped booking
as one downstream purpose across all modes, initially exposing only a token.
The first researcher replayed the captured one-way context, then substituted the
other recorded tokens. All three responses still described the same one-way flight.
Those contrasts were useful: the agent correctly returned `partial` rather than
claiming cross-mode success. But the initial replay was not fresh producer proof.

At 21:53:08 UTC booking reported that limitation. Other researchers finished by
21:55:18. Master review ran 21:55:23–22:02:40 and replaced the token with complete
opaque itinerary context. The booking follow-up began at 22:02:45.

The follow-up called fresh round-trip and multi-city producers, assembled each
context from associated selected flights and tokens, and tested booking. An offline
decode of both complete retained booking responses confirmed exact matches for
origin, destination, date, carrier and flight number across both legs, plus a
separate booking-provider frame containing booking links:

- Round-trip observation `b97db54f-455a-4c28-b5ad-220443241b52`, 22:12:04 UTC.
- Multi-city observation `d3f1dba1-20d2-4665-94d6-66d6511e8d09`, 22:17:16 UTC.

The final response reached the research conversation with about 92 seconds of
deadline remaining. Sleep began about six seconds later. No final accepted proof
handoff followed. Fresh one-way producer-to-booking verification under the revised
context contract is also not established by these two successful observations.

General correction: define the consumer's complete required context alongside
producer output, and test one coherent producer-to-consumer chain early. Agents
should revisit combined boundaries when modes require different context construction;
sharing an endpoint or an opaque parameter is not evidence of interchangeable use.
Do not encode trip-mode rules in the runtime.

### 3. Mechanical errors generated avoidable agent turns and browser escalation

Seven rejected structured replies recovered within their conversations: six in
research and one in planning. Errors included omitted binding/reason/parameter
fields, workflow fields at the wrong nesting level, an incorrect site identifier,
wrong evidence-reference types, and a verification-case origin mismatch.
Rejection-to-next-reply intervals total 253.77 seconds across overlapping agents;
that total must not be added to wall time. Recovery worked; these were not fatal.

Round-trip's initial request had incorrect array nesting and received HTTP 400
through all four backends. After correcting that structure it worked through
direct fetch. Multi-city first attempted to mutate read-only parsed data, then
failed to extract continuation state. The latter failure repeated across all four
backends before the transform was repaired. Those two backend sweeps took about
68 seconds each, overlapping each other, including browser setup.

General correction: make action schemas easier to follow and identify local
construction/extraction failures distinctly in feedback. For local deterministic
failures, let agents repair or explicitly choose another backend rather than
automatically treating all post-send errors as transport problems. An HTTP 400 by
itself is not a universal rule to stop escalation.

### 4. Response-decoding discoveries were not effectively reused

Round-trip research repaired a length-framed response parser, explicitly noting
byte lengths versus JavaScript character lengths. Later booking tried parsing the
whole response tail as JSON, then used the frame length as a character count; both
failed. Its third bounded inspection succeeded. Booking's first failed inspection
to successful inspection took 2 minutes 52 seconds while awake.

Shared memory was functioning: nine findings were published and delivered as
deltas. However, the round-trip finding explained token/flight paths, not the
framing failure and working decode approach. There were no explicit notebook queries
in the shared-research journal. Booking still reconstructed low-level parsing.
Retention was useful: these inspections read stored bodies without another request.

General correction: publish reusable decoding methods and failed approaches with
evidence, and have related agents check those findings before rediscovering them.
Do not add another memory framework or site-specific runtime decoder on this evidence.

### 5. Research completion still gates normal verification and publication

The controller awaited pre-plan research and master follow-ups before creating the
normal build journal and entering compilation/verification. A deadline in the sole
booking follow-up therefore ended the entire teach before that phase.

Early overlap produced four tool-planner conversations and one compiled location
lookup draft. That draft recorded eight offline tests/70 assertions and strict
type checking, but explicitly `liveVerified: false` and semantic verification
`not_run`. No generated tool was published. Other useful research remained on disk.

This is a remaining coarse stage barrier, not the removed research-wide file lock.
General correction to consider: allow approved independent tools to proceed through
their own verification while dependent research continues, retaining master plan
revision/invalidation and all evidence checks. Partial output must still count as
an incomplete teach. This scheduling change needs focused regression coverage;
the audit did not implement it or revive deferred draft recovery.

## Time after accounting for sleep

macOS power logs show sleep intervals of 4, 974, 784 and 475 seconds within the run:
37.28 minutes total. The last sleep crossed the deadline, explaining the delayed
exit. Subtracting those intervals leaves 59.25 minutes of non-sleep elapsed time,
not CPU time or an estimate of provider computation.

| Sequential interval | Wall minutes | Non-sleep minutes | Share of non-sleep time |
| --- | ---: | ---: | ---: |
| Discovery, selection advice, initial master decision | 17.73 | 17.73 | 29.9% |
| First research pass, overlapping plans/draft and repairs | 48.87 | 19.51 | 32.9% |
| Master revision and booking follow-up | 29.93 | 22.02 | 37.2% |

The first interval included about 6.8 minutes before selection advice, 6.6 minutes
of advice and 3.6 minutes of master decision, plus transition time. The revision
master took another 7.3 minutes. Normal final verification and the independent audit
never started. These intervals should not be mislabeled as time spent compiling
or testing published tools.

There is no evidence here of provider overload, disk exhaustion, a shared-lock
deadlock or missing retained booking responses. One location request timed out
across a sleep interval, so it is not evidence of a separate internet outage.
Removing sleep would provide more working time; this failed run cannot prove that
the remaining compilation, semantic checks and audit would have succeeded.

## Recommended order

1. Reproduce and fix purpose/reference comparability with synthetic regressions.
2. Improve complete dependency-context handoffs and reuse of decoding findings.
3. Reduce schema friction and unnecessary escalation for local execution failures.
4. Evaluate the remaining global research barrier as a separate scheduling change.
5. Validate any implementation correction in a fresh isolated teach, then audit
   generated tools. Retain all failures; repeated Flights and Hotels acceptance
   remains outstanding.
