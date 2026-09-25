# Flights43 unbounded teach retrospective

Flights43 ran from a fresh recording on `d97b398` for 121.2 minutes. It was
stopped deliberately before publishing a misleading search result. The run
published `search_flight_locations` and `get_date_grid`; four tools remained
unfinished. It did not hit a teach deadline, disk limit, machine sleep, or a
provider outage. All evidence remains under
`~/.imprint/experiments/reteach-systemic-2026-09-21/flights-43-unbounded`.

The master planned six tools: location lookup, one-way, round-trip, and
multi-city search, date grid, and one-way booking. API research proved each
selected search and the parameterized date grid. Booking research initially
blocked because first-leg shopping did not expose the complete later-leg
selection state, and a bare one-way selection token did not control the
recorded booking request. The master redirected one-way booking research to
match a fresh result by its complete visible flight identity. Browser-owned
clicks for two different Southwest flights then returned distinct substantive
booking responses. Round-trip and multi-city booking were excluded from the
narrow plan because their dependent selection chains were not proven.

The first search-parser verification rejected all three search tools on fare
fidelity. Multi-city and round-trip also had distinct continuation or grouping
issues. The master correctly returned those failures to the retained compiler
conversations, which wrote and tested a second revision. The second revision
revealed a more serious verification risk: a reviewer called an unlabeled raw
integer `109000` a fare, while the earlier review of the same recorded
multi-city option expected a displayed price of `238`. Other options have
raw values such as `90000` and `80000` paired with a repeated `100000`.
The one-way compiler changed `price_amount` to those large values in order to
satisfy the frozen reviewer facts. The recorded page code also contains a
carbon-emissions display conversion that divides a raw value by 1,000; the
paired high-number structure is consistent with emissions, although its exact
protocol field meaning is not proven here. Neither response position nor
magnitude alone justifies labeling a number as a price in USD.

Because this could publish a materially wrong tool, the run was interrupted
gracefully at 121.2 minutes while the second revision was being reviewed.
The smallest general correction is to require semantic corroboration before
the evidence reviewer freezes a numeric field as a price or other unit-bearing
value. Ambiguous values must be marked unverified rather than made into
contradictory facts. The next fresh teach tests whether this prevents false
fare failures while retaining real parser errors.

The trace reports 55,010,670 input tokens, including 51,183,872 cache reads,
358,114 output tokens, zero reported cache writes, and a $42.9430208 base
API-equivalent lower bound. Seven analysis spans have missing usage, and the
root span was interrupted, so the accounting is incomplete. The deliberate
stop and the unsuccessful revisions count as failed attempt cost.

Validation for the general verifier-prompt correction: all 14 focused
recording-verification tests, lint, type checking, and the serial full suite
(2,068 tests) pass. An initial concurrent full-suite run had one unrelated
process-cleanup stress-test failure; that test passed alone and in the serial
full-suite rerun.
