# Flights 15: native delegation retrospective

**Result:** the fresh teach hit its 90-minute deadline with zero ready tools and
nine not ready. It produced one compiled location-lookup draft, not a published
or audited tool set. Native delegation alone did not make teaching reliable.

## Evidence and timing

Runtime commit: `c4898d587b0e505b69213f23124fec31a503ac78`.
The original Flights recording and a new isolated home were used. Private evidence
is under `~/.imprint/experiments/reteach-systemic-2026-09-21/flights-15/`.
The manifest, run log, native events/usage, retained responses, sixty-minute
assessment and `native-retrospective.json` preserve the attempt.

| Stage | Wall minutes | Share |
| --- | ---: | ---: |
| Initial discovery, advice and plan | 20.18 | 22.4% |
| First-pass research, overlapping draft work and handoff repair | 42.33 | 47.0% |
| Master review and research follow-ups | 27.51 | 30.6% |
| Total | 90.02 | 100% |

These stages partition wall time. The draft compiler overlaps research; its time
must not be added again. Native assignment dispatch had a median 39.75 seconds
for initial tasks and 26.75 seconds for follow-ups. Across 66 assignments there
were 887 page reads; reading each packet once would require 297 pages. Some reads
legitimately recover context, so the difference is not all proven waste.

## What failed

1. Generated requests still changed nested structure or returned protocol-error
   envelopes despite HTTP 200. The retained body comparisons helped identify
   accidental extra array layers. Browser-generated traffic produced useful
   results for some operations, but continuation semantics remained incomplete.
2. Round-trip reporting repeatedly omitted binding/proof/candidate fields or
   changed the tested candidate. Validation correctly rejected these responses.
   Unlike the older fatal path, the final malformed handoff reached the master
   with its actual observations and did not terminate the whole run.
3. After nine researchers ran concurrently, master-directed repairs were forced
   into a serial loop. Six directions were requested; round-trip consumed the
   first turn before one-way could start. The accepted plan already grouped
   independent searches in one wave, but the runtime ignored that grouping here.
4. The generic native instructions described direct MCP execution as every
   child's interface. Semantic researchers instead submit JSON actions for host
   execution. A round-trip follow-up explicitly reported absent execution tools
   as its blocker even though the host action protocol remained available.
5. Shared findings were available but none were published. Reusable browser and
   request-format discoveries therefore reached siblings late through the master.
   Shared-memory savings have not been demonstrated.

The master selected nine purpose-based tools. Location lookup/details and
multi-city booking reported successful research, while multi-city search was
partial. Booking from a fresh, complete search result/context remained unverified.
One-way finally made another live call near the deadline. No independent audit ran.

There was no observed provider-capacity failure, disk exhaustion, sleep or network
disconnection causing the run to end. The terminal ProviderDeadlineError denotes
the configured deadline, not a provider outage. Disk remained around 10 GiB free.
All 36 retained responses remain available, including twelve HTTP 400 responses
across four backends. Failed response retention worked; failed evidence is not proof.

## Small general corrections

- Explicitly distinguish semantic JSON action requests from compiler MCP calls
  in native assignment metadata, instructions and missing-tool feedback.
- Reuse accepted build waves for research repairs, including later build repair.
  Independent work overlaps; later consumers receive updated producer handoffs.
  No extra worker pool, scheduler or site rule is introduced.
- Cache unchanged native task packets and exact candidate objects when possible;
  avoid an extra native wait after each dispatch because the host task call already
  waits for newly available work.
- Remove the obsolete two-worker sentence. Keep native ten-child admission and
  existing non-Codex focused concurrency unchanged.

The independent-repair regression failed on the old serial controller and passed
with wave execution. Its dependent variant still observes the repaired producer
first. A real-provider smoke in `native-action-smoke-1` completed three retained
research turns in 103.13 seconds and preserved exact candidate/observation binding.
These checks establish specific mechanics, not website reliability. A new fresh
teach is required after this checkpoint; Flights 15 must not be resumed.

## Accounting

Sixteen native threads reported 32,987,634 input tokens, including 30,328,576 cache
reads, and 239,935 output tokens. Cache writes were explicitly reported as zero.
The known-usage base API equivalent is **$27.5663624**, using the experiment's
existing rates: $4/M uncached input, $0.40/M cache reads and $20/M output. This is
not a subscription invoice and excludes extra tiers, fees and unreported usage.
The root and interrupted one-way thread lack terminal completion; their usage is
a reported snapshot, and one interrupted analyze call lacks a terminal usage event.

All previous attempts remain in the private accounting ledger. The separate native
smokes, including their failed attempts, are accounted separately to avoid counting
them as Flights 15 usage. No successful speed or repeatability claim is supported.
