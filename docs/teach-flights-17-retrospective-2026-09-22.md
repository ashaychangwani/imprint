# Flights 17 retrospective

**Failed:** 90.03 minutes, exit 1, zero published tools and nine reported not ready.
Runtime commit `a0a995d`; no code or prompt changes were made during the teach.
There are no public tools to audit. This does not satisfy Flights acceptance.

## What has been established

The master selected nine separate tools for recorded user purposes, including
three search and three booking purposes. Native child turns reached nine without
recorded capacity failures. This measures active turns, including tool waits, not
simultaneous provider requests. More workers did not remove the critical path.

Initial discovery, advice and planning took 21.50 minutes. The tool-selection
advisor received no human scope and spent 7.07 minutes reviewing seven discovered
operations; the master subsequently split trip purposes and excluded unrelated
operations. This is a possible repeated-work source, not a proven speed fix.

The final first-pass researcher returned at 14:53:42 UTC. Master review could not
start until the unrelated one-way draft completed at 15:09:13 UTC. The review
assignment was created immediately afterward: approximately 15.52 minutes behind
this barrier. The compiler itself took 25.49 minutes, including active parser and
test work. It was not a hanging provider stream.

One-way booking correctly called its fresh producer. The producer returned a
3,041,549-character rendered document with itinerary display information, but no
proven complete selection envelope. Repeated 2000-character reads did not supply
the missing consumer contract. Freshness alone is insufficient when a producer
omits required associated state. The master excluded this booking variant with
its actual failed evidence; it did not claim it worked.

Round-trip research eventually demonstrated both initial and selected-outbound
continuation branches. The master retained round-trip booking and requested a
fresh producer retry. Multi-city research proved only its initial branch; the
master excluded its incomplete continuation and booking purposes. These are
coverage limitations even if the remaining required operation groups later pass.
The multi-city researcher also used a changed-date contrast: its relationship
to recorded cases needs review before treating it as required coverage.

Calendar research returned 49 cells, but this does not by itself establish all
advertised date-window parameters. That remains a verification/audit concern.

Failed responses were retained separately by backend and attempt. Shared findings
were published; useful cross-tool reuse and speed benefit remain unproven.
No disk exhaustion, power interruption, network outage or provider-capacity error
has been observed as the cause of these delays. Around eleven GiB remained free.

## Prepared correction, outside the running checkout

Commit `7c4f069` moves native draft settlement after master research review, while
settling owned work before final reuse/replacement and on errors. It adds no new
scheduler. It also reuses the existing offline evidence-projection helper for
full retained-response queries with bounded output. Failed observations remain
failed and exact evidence bindings remain required.

Old-code regressions reproduce both issues; 273 affected tests, lint, typecheck,
website build and desktop/mobile checks pass with the prepared correction. This
is local validation, not fresh-teach acceptance. A new isolated run is required.

Private evidence: `~/.imprint/experiments/reteach-systemic-2026-09-21/flights-17`.
Raw recordings, responses and agent transcripts remain local.

## Terminal result and measurements

The final booking researcher called the fresh round-trip producer; that call
returned after 34.601 seconds at about 15:20:24 UTC. Its next retained assignment
remained unfinished when the run deadline stopped the family at 15:21:01. The
family closed at 15:21:02 and the process group was verified empty. The terminal
ProviderDeadlineError denotes the run deadline, not provider capacity failure.
The fresh producer result is retained; no consumer success is claimed.

| Sequential wall phase | Minutes | Share |
| --- | ---: | ---: |
| Initial discovery, advice and plan | 21.50 | 23.88% |
| First-pass research, overlapping drafts and handoff repair | 56.72 | 63.00% |
| Master revisions and follow-up research until deadline | 11.81 | 13.12% |

Draft time overlaps research; it must not be added to these sequential percentages.
There were 76 assignments and 359 task reads for a minimum of 307 unique pages.
Initial dispatch median was 46.85 seconds; retained follow-up median was 34.59
seconds. Their summed delays overlap and are not an additive waste estimate.
Thirty-one retained responses include failed HTTP 400 responses and HTTP 200
protocol errors; transport status does not establish semantic success.

Reported native usage across twenty family members: 40,465,228 input tokens,
including 37,872,512 cache reads, plus 283,788 output tokens and zero reported
cache writes. Base API equivalent is **$31.1956288** using the campaign rates of
$4/M uncached input, $0.40/M cache reads and $20/M output. All family totals are
reported-usage snapshots; one analysis usage span is missing. This is not an
invoice and excludes unknown usage, service-tier and long-context adjustments.

The campaign trace ledger through this attempt records 259,748,377 input,
214,087,168 cache reads, 2,831,762 output, zero reported cache writes and
$324.9149432 base equivalent, with eighteen missing analysis usage spans.
Separate native smoke experiments remain separately accounted: $3.6264408.
They must not be counted again through provider usage recovery.

No full successful teach, speed improvement, unchanged-code repeatability or
Hotels acceptance has been established. The prepared correction is the third
native-path repair checkpoint after interface/parallel repair and stable compiler
identity/immediate verification. Do not interpret the switch from the former
adaptive scheduler as permission for unlimited repair experiments.
