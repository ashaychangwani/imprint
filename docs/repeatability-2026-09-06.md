# Fresh teach repeatability — September 6, 2026

Both runs used unchanged runtime and prompts from `2f277b7`, fresh discovery,
and isolated output directories. No previous candidate plans or example
implementations were supplied. Later commits only recorded this experiment.

| Run | Teach time | Outcome | Independent audit |
| --- | --- | --- | --- |
| Flights | 90m 0.4s | Failed: calendar ready, four intended operations unready | Calendar only: 91.7%, five successful calls and one failed call, six parameters demonstrated |
| Hotels | 22m 1.0s | Completed: one destination/date search tool | 100%, four calls and three parameters passed |

Flights did not reproduce the earlier complete success. Its research and
planning took about 67 minutes; booking remained unresolved, and later search
and location repairs reached the deadline. Calendar's audit cannot substitute
for the missing operations. An identical retry succeeded after the calendar
audit's failed call, but the failure remains in the score.

Hotels repeated the narrow MVP, not broad Hotels coverage. It returned 22
Seattle and 19 Portland properties. Independent date changes affected returned
stay records and prices. Parser inspection confirmed the returned stay fields
come from response records, separately from its caller-input summary. Adults
and rooms remain unsupported. Four calls do not establish universal reliability.

## Token accounting and API-equivalent cost

All observed calls used GPT-5.6 Sol. Counts include teaching agents and retries,
not the supervising conversation. Cache reads are a subset of total input,
not additional tokens. Provider-reported cache writes were zero.

| Tokens / estimated cost | Flights teach | Hotels teach |
| --- | ---: | ---: |
| Uncached input | 3,618,458 | 693,937 |
| Cache-read input | 18,428,544 | 4,971,776 |
| Cache-write input | 0 reported | 0 reported |
| Total input | 22,047,002 | 5,665,713 |
| Output | 250,321 | 40,267 |
| Total input + output | 22,297,323 | 5,705,980 |
| Estimated cost | At least $34.83 | $6.94 |

Pricing checked against the [official GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol):
per million tokens, $4 uncached input, $0.40 cache reads, $5 cache writes,
and $20 output. Requests exceeding 272,000 input tokens receive the documented
long-input adjustments. Retained request usage identified 24 such requests
in Flights and five in Hotels; their added estimated cost is $7.98 and $1.37.
These are API-equivalent estimates, not Codex subscription invoices.

Unique usage spans were counted without parent totals. Flights' interrupted
search repair did not emit its final usage span: its retained conversation
supplied another 905,948 input tokens (866,048 cached) and 4,651 output tokens.
Those are included above. A final in-flight request may have no usage receipt;
therefore Flights counts and cost are recorded-usage lower bounds, not a claim
of exact billed totals. Output reasoning is not added twice to output tokens.

Audits are separate:

| Audit | Time | Uncached input | Cache reads | Cache writes | Output | Estimated cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Flights calendar | 4m 37.2s | 20,653 | 237,312 | 0 | 3,393 | $0.25 |
| Hotels | 2m 21.4s | 32,914 | 180,608 | 0 | 1,565 | $0.24 |

Teach execution total: **1h 52m 1.4s**, at least **28,003,303 tokens** and
**$41.77**. Including audit execution: **1h 59m 0.0s** and at least **$42.25**.
These summed execution times exclude the monitoring gaps between stages.

Local evidence stays outside the repository under
`/tmp/imprint-repeatability-P2oX4B`: original teach/audit logs, original audit
reports, decoded usage spans, and accounting scripts. Installed working tools
were not overwritten. No generated artifact was manually patched for this test.
