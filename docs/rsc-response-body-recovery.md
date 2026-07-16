# RSC response-body recovery

Chromium can emit a successful `text/x-component` response and later make its
body unavailable to `Network.getResponseBody`. This is common around Next.js
App Router navigation and Server Actions, where the load can also finish as a
canceled `net::ERR_ABORTED` after the renderer received the complete React
Flight payload.

Imprint uses `Network.streamResourceContent` as a narrow fallback, not as a
second recorder for all traffic:

- The response must be a 2xx `Fetch` with exact `text/x-component` MIME.
- GET requests need an RSC query/header, router-state header, or RSC `Accept`
  signal. Labeled Next.js prefetches may stream before user intent, but a body
  whose normal read fails stays only in bounded memory and is persisted only if
  a pointer-down/click within 30 seconds matches the same origin, route, and
  query after removing the transient `_rsc` key. Hover/focus alone cannot
  promote it. Ambient failed prefetches expire or are discarded at shutdown.
- POST requests need a nonempty `Next-Action` header. Both observed
  `text/plain` and `multipart/form-data` Server Action request bodies qualify.
- Redirects, telemetry, responses over 2 MiB when declared, and unrelated
  methods/resource types are excluded.
- `Network.getResponseBody` remains authoritative. Streamed data is discarded
  when that normal read succeeds and is written to the session only when it
  fails.
- Retained stream slabs are bounded to 2 MiB per response and 8 MiB in flight;
  final validation temporarily assembles at most one additional response-sized
  buffer. A recording may
  persist at most 4 MiB of recovered stream data. At most 16 CDP streams may be
  issued at once, with four slots reserved for Server Actions and activated
  navigations; a slot remains leased until both the stream command and its
  request settle. Eight stream-start failures disable the fallback for the rest
  of the recording.
- At most eight nonempty failed prefetches may wait for activation. They expire
  after 30 seconds, oldest entries are evicted first, and passive retained/active
  captures may use just under 6 MiB, preserving 2 MiB plus one slab of
  allocation headroom for priority work.
- A normally completed response can use the complete stream. A canceled load
  must additionally have exact Flight framing, a recognized navigation,
  prefetch, or Server Action root, no undefined chunk references, no more than
  16,384 Flight rows, and no more than 32,768 aggregate JSON nodes. Unknown,
  excessively wide/fragmented, or partial encodings remain bodyless.

## GET selection benchmark

The rerunnable July 16, 2026 probe loaded 34 public sites in Chromium, waited
for the page, then hovered and clicked one visible same-origin link. Request
start and intent timestamps are captured separately. A site enters the
coverage denominator only when the interaction produces at least one 2xx GET
Fetch response with exact `text/x-component` MIME that starts after intent and
matches the intended origin, route, and query. Coverage is:

`sites where every eligible response is selected / sites with an eligible response`

Twenty-five sites produced exact-MIME RSC traffic. Seven produced independently
eligible user-flow traffic, and all seven were fully selected: 7/7 sites and
17/17 responses (100%, above the 95% corpus target). This is specifically GET
selection coverage for eligible post-intent same-route flows; it is not a
statistical claim about all RSC websites or proof that every selected body was
recovered.

Across 915 RSC responses, seven body reads failed with Chromium's `No data found`
class and five timed out at the benchmark's five-second body-read limit. There
were zero other body-read errors and zero request- or response-header read
errors. All 12 unavailable bodies met the transport selection policy. The
benchmark exercises policy selection and Playwright body reads, not Imprint
stream reconstruction or the later-intent promotion gate, so those selected
failures are not counted as recoveries.

Run
`bun scripts/benchmark-rsc-response-stream.ts --output docs/benchmarks/rsc-response-body-2026-07-16.json`
to regenerate the checked artifact directly. It records that the run came from
an uncommitted worktree snapshot and includes SHA-256 hashes for the exact
benchmark and policy files, plus the corpus, versions, exclusions, interaction
errors, and privacy-safe per-site action and response counts:
[`benchmarks/rsc-response-body-2026-07-16.json`](benchmarks/rsc-response-body-2026-07-16.json).

## Local recorded validation

Privacy-sensitive recordings cannot be checked into this public repository, so
the following is local operator validation rather than independently
reproducible benchmark evidence. Two recorded Server Action flows exercised
POST variants:

- A `text/plain;charset=UTF-8` movie-search action lost two response bodies.
- A `multipart/form-data` infinite-scroll action lost five response bodies.

In those local runs, all seven POST bodies were recovered, structurally
accepted, and delivered to `imprint teach`; both generated tools compiled.
SunsetHue separately recovered and structurally accepted one 18,042-byte GET
forecast response, and its two generated tools compiled. The operator-observed
result was therefore 8/8 natural missing-body cases across three recordings.
The corresponding audit summaries reported 100%, but the privacy-safe notes do
not preserve the graded, infrastructure, bad-parameter, and untestable
denominators, so those percentages are not used as acceptance evidence here.
This local result is neither repository-reproducible nor a claim that every
future React Flight version is supported.

## Bloat measurement

The 903 normally readable benchmark bodies totaled 80,744,547 bytes. The
transport policy selected all 915 exact-MIME, framework-signaled RSC responses
in this run, so there was no byte reduction within that already narrow traffic
class. Labeled prefetches accounted for 894 responses (97.7%) and 78,240,263
readable bytes (96.9%). This is transient CDP transport/decoding overhead, not
recording or LLM-input growth; the per-response and aggregate memory limits
above still apply.

Speculative bytes stay in bounded memory and never enter the session or LLM
input when normal body capture succeeds. A failed labeled prefetch also stays
memory-only unless a timely exact-route activation promotes it. In the two POST recordings, the
fallback added 29,666 and 67,054 response bytes respectively—the same response
content the compiler would have received if `getResponseBody` had succeeded.
Because a recovered body appears once in both assembled JSON and source JSONL,
that was 3.53% and 2.27% of the two complete recording pairs. Normal body reads
discard their speculative copy and add nothing to disk or LLM input.

CDP does not expose a matching stop command after `streamResourceContent` has
been enabled. Imprint drops an over-limit capture immediately and stops decoding
its base64 chunks, but Chromium may continue delivering that already-selected
response on the protocol transport until the request ends. The active-count,
byte, persistence, and failure limits prevent that residual from growing heap,
disk, or LLM context without bound.
