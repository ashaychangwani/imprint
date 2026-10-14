# Flights 20 review and fresh restart

Flights 20 ran implementation `0894a94` from 18:48:14 to 20:18:16 UTC on
September 22, 2026. It ended at the 90-minute deadline: zero published tools,
eight not ready, no independent audit. The process group was already empty
when the user requested it be stopped and restarted. No kill was needed.

This was the latest implementation, not the pre-fix code. `3b5c50c` only added
a timeline entry. No runtime or prompt changes followed before Flights 21.
The fresh repeat was explicitly requested; it is not validation of a new fix.

## Findings

- Purpose splitting took effect in this run. The master chose location lookup;
  one-way, round-trip and multi-city search; a round-trip date grid; and separate
  booking tools for the three trip purposes. This is one observation, not proven
  repeatability. The missing one-way recorded response fixture remains a coverage
  limitation even though live research returned useful data.
- Fresh producer calls were available. One-way booking used a fresh one-way search
  value. Multi-city research eventually executed both stages, and its booking
  consumer returned provider offers after synchronizing the selected flight tuple
  with the fresh context. These are research results, not audited public tools.
- Round-trip search was initially marked proven with only outbound choices. The
  booking researcher later called it freshly, inspected the retained response,
  and correctly rejected it as missing a complete two-leg itinerary. The master
  then requested the missing return-selection stage. That correction began after
  minute 72; the first-stage requests subsequently returned small null/code-13
  envelopes across execution backends. The final booking follow-up started with
  about 90 seconds left and expired without completing an action.
- No family/provider-capacity failure was recorded. The deadline is not evidence
  of a model-provider outage. The site returned semantically empty error envelopes;
  the retained evidence does not establish whether the cause was temporary site
  state, request state, or another site-side condition. There is no evidence that
  disk exhaustion, power loss, or network disconnection caused this failure.
- Early success claims still fail to establish consumers' complete required
  inputs. This is the recurring issue to watch next: compare the raw final-stage
  records with the promised consumer context before accepting producer research.
  Existing instructions require this; no site-specific rule was added for the repeat.

## Measurements

| Sequential wall window | Minutes | Share |
|---|---:|---:|
| Discovery, advice, initial plan | 23.56 | 26.17% |
| First research pass and overlapping drafts | 11.29 | 12.54% |
| Master revisions and follow-up work | 55.18 | 61.29% |

There were 25 native assignments, 52 assignment-page reads, and 538 assignment-tool
calls. Context reads inside persistent passes are separate from assignment reads;
these counts alone do not establish a speed improvement. Forty-nine individual
responses were retained: 45 HTTP 200 and four HTTP 400. HTTP 200 includes protocol
errors and does not imply useful output.

Reported input: 33,481,959 tokens, including 30,717,952 cache reads. Output:
228,568 tokens; zero reported cache writes. Base API equivalent: $27.9145688;
zero completed-trace analysis spans missing usage. Not an invoice; unreported
provider usage and pricing differences remain excluded. No audit cost occurred.

Private evidence: `~/.imprint/experiments/reteach-systemic-2026-09-21/flights-20/`,
including the original manifest/log/home, `review-summary.json`,
`native-retrospective.json`, and `persistent-research-timing.json`.
A diagnostic helper initially split JSONL on Unicode separators inside strings;
changing its reader to split only newline recovered all records with zero JSONL
parse errors. No raw evidence was changed.

## Fresh run

Flights 21 started at 20:48:47 UTC on `3b5c50c` (same implementation `0894a94`),
with a new empty home and research memory, original recording, and unchanged
four-operation-group guidance. Target 21:18:47, assess 21:48:47, hard deadline
22:18:47 UTC. Both the recording and existing collector were verified; about
7 GiB free. No old generated tools or findings are supplied. No power gate,
cron, MR, deletion, or code/prompt edits during the run.
