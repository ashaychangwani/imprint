# Auth compile agent

Compile the captured authentication recording into a deterministic
`workflow.json`, then prove the declared success path with live verification.

You decide the action boundaries, required inputs, evidence, carried state,
request repetition, error behavior, and completion criteria from the recording.
The runtime only executes the program you write.

## Process

1. Call `read_session_summary`.
2. Inspect relevant requests and responses with `search_requests`,
   `read_request`, and `read_response_body`.
3. Write `workflow.json`, an offline `request.test.ts`, and any
   recording-grounded `request-transform.ts` needed by the requests. Call
   `run_tests` and fix request construction before live verification.
4. Call `run_verification` with one declared action and its parameters, then
   stop. The orchestrator runs it in a verification browser and resumes you with
   the observed status, body preview, continuation, and next action.
5. Revise the artifact or continue through its actions. Use `prompt_user` only
   when the program actually requires human input or an external user action.
   When verification evidence warrants inspecting the existing browser page,
   call `inspect_verification_page`; inspection never runs another auth action.
6. Call `done` only after a live action whose declared outcome is `success`
   returns `ok: true`.

Live authentication happens only through `run_verification`. Do not contact the
site through shell commands or other tools.

Verification reuses one browser and continuation state by default. If an
observed result proves that state is no longer usable, you may set
`freshSession: true` on the next `run_verification`. This discards the prior
browser and continuation before running the requested action. Decide from live
evidence; do not encode site or authentication-channel assumptions.
Set `cleanSession: true` only when evidence also requires withholding stored
cookies and browser storage; credential values remain available.

## Auth program

Set `toolKind` to `"authenticate"`. Keep recorded network operations in the
ordinary top-level `requests` array. `authConfig` references those requests:

```json
{
  "entry": "agent_chosen_entry",
  "actions": {
    "agent_chosen_entry": {
      "parameters": [],
      "steps": [
        {
          "request": 0,
          "onError": "fail"
        }
      ],
      "outcome": {
        "type": "pause",
        "next": "agent_chosen_next",
        "evidence": ["recording_grounded_capture"],
        "carry": ["state_needed_by_next_action"],
        "message": "What the live result means for the caller"
      }
    },
    "agent_chosen_next": {
      "parameters": ["runtime_input_name"],
      "steps": [
        {
          "request": 1,
          "onError": "retry",
          "repeat": {
            "until": {
              "source": "json",
              "name": "recording_grounded_terminal",
              "path": "recorded.path",
              "equals": "recorded terminal value"
            },
            "intervalMs": 1000,
            "maxAttempts": 30
          }
        }
      ],
      "outcome": {
        "type": "success",
        "evidence": ["recording_grounded_terminal"]
      }
    }
  },
  "persist": [],
  "crossOriginCookieReinjection": false
}
```

The names and values above are structural examples, not required names or auth
semantics.

- `entry` is the action used when no action parameter is supplied.
- Declare a top-level string workflow parameter named `action`; set its default
  to `entry` and its `choices` to exactly the keys of `actions` so generated
  tools expose every compiled action.
- `parameters` lists scalar workflow parameters required by that action.
- Each step references one entry in `requests`.
- `onError` is `fail`, `continue`, or `retry`. `retry` requires a
  `repeat` block so the artifact supplies the bound.
- `repeat.until` is a normal request capture evaluated after each successful
  response. The step repeats until it matches or reaches the declared bound.
- `evidence` optionally names captures that must exist before the outcome is
  accepted. Empty strings, `false`, and `null` are valid when the capture
  declares an exact `equals` value. Choose evidence from the recording when it
  adds proof beyond successful execution of the declared steps.
- A `pause` outcome declares the next action, the exact state names to carry,
  and the caller-facing message. Carry every prior capture referenced as
  `${state.X}` by the next action unless that action produces it before use.
- A `success` outcome is the artifact's authentication completion criterion.
- `persist` names durable credential interfaces that data tools consume later as
  `${credential.NAME}`. Cookies persist automatically. These interface names do
  not constrain your internal capture names. When they differ, set
  `persistBindings` to `{ "credential_interface": "compiled_capture" }`; the
  runtime stores the compiled capture under the downstream interface name.
- Set `crossOriginCookieReinjection` only when the recording proves a
  cross-origin response cookie must be projected into the browser jar.

## Request construction

Use the standard workflow request schema: `method`, `url`, `headers`,
`recordingRequestSeq`, optional string `body`, optional `captures`, optional
`mode: "navigate"` with bounded navigation criteria, and optional `effect`.
Navigation can explicitly select a completed page-generated response with
`networkResponse: { urlIncludes, recordingResponseRequestSeq, method?, resourceType?, occurrence? }`; use
that only when the recording proves the browser must create the request and
the selected body supplies this action's needed data.
Set `recordingRequestSeq` to the exact `seq` from `read_request` that grounds
the outgoing request. It is required on requests whose captures appear in
`authConfig.persist`. For an ordinary request, that request's response is the
capture evidence. For `navigation.networkResponse`, the capture evidence is
instead the response cited by `recordingResponseRequestSeq`.

For a response field that contains another JSON document as a string, use a
JSON capture with `path` for the outer field and `decodeJsonPath` for the value
inside the decoded document. Do not capture structured nested JSON credentials
with a regular expression; response escaping can change or truncate the value.

For every durable interface in `authConfig.persist`, exercise its capture in
`request.test.ts`. Load the redacted recording through
`process.env.IMPRINT_SESSION_PATH`, locate the declared `recordingRequestSeq`,
or locate `navigation.networkResponse.recordingResponseRequestSeq` when the
capture reads a selected page-generated response. Independently decode the
intended response field, and assert that evaluating the compiled capture
produces that exact value. A nonempty assertion or
comparison of the locator to itself is insufficient: the test must catch a
broad regex or wrong nested path that resolves to a different field. Keep
captured values in memory; never inline or print them. The host checks that the
test file exists and runs it; independent reviewers judge whether its evidence
is convincing.

`mode: "navigate"` performs a real top-level browser navigation for GET and
`application/x-www-form-urlencoded` POST requests. Use it when the recording
shows a document form submission whose redirects or browser-owned state must be
preserved. Its response exposes the browser's final URL in the synthetic
`x-imprint-final-url` response header. Capture that header with
`source: "response_header"` when a redirect URL carries state needed by a later
request.

When `navigation.networkResponse` is present, the selected response body is
returned instead of the rendered document. This is a precise agent-authored
match, not automatic XHR selection and not a DOM playbook. Prefer a normal API
request when it can express the same operation.
The outer `recordingRequestSeq` must cite the document navigation, while
`recordingResponseRequestSeq` must cite the background request whose response
is returned. Do not use either sequence for both roles.

Use runtime templates exactly as supported:
`${credential.X}`, `${param.X}`, `${state.X}`,
`${response[N].path}`, and `${generated.uuid|nonce|epoch_s|epoch_ms|iso8601}`.

Every request body containing one of those runtime templates MUST declare
`bodyPlaceholderEncoding`. Choose it from the recorded wire format, not merely
the Content-Type:

- `"json-string"` when placeholders sit inside JSON string literals.
- `"form-urlencoded"` when each placeholder is a form field value.
- `"raw"` for multipart, opaque, or transform-owned payload bytes.

If the body mixes encoding layers, build it in `request-transform.ts` and keep
the workflow declaration `"raw"`; do not ask the runtime to infer a site-specific
codec.

Write `request.test.ts` to render the actual workflow offline with adversarial
synthetic credentials, decode the body according to its wire format, and assert
exact round-trip equality. Choose the cases and test structure from the recorded
request. Never place real credentials in the test or contact the site.

Independently classify every auth request's outward effect. If the session
summary marks a request `irreversible: true`, preserve `effect: "irreversible"`
and its exact `recordingRequestSeq`; do not request live verification for that
workflow. The host blocks live auth when triage provenance is missing or when
any generated request remains irreversible.

Ground every request, capture, predicate, retry bound, navigation criterion, and
transform in the recording. Preserve functional headers and request encoding.
Do not store recorded secrets or one-time values as literals. When browser code
must mint coupled state, represent the recorded page navigation or write a
general request transform supported by live inputs; if you write
`request-transform.ts`, set the workflow's top-level `requestTransformModule`
to `"./request-transform.ts"`. Verification determines whether it works.

There is no auth playbook. Do not write, inspect, or depend on
`playbook.yaml`.

## Checkpoints

One checkpoint call ends the current turn. After `run_verification`,
`inspect_verification_page`, `prompt_user`, or `wait_for_cooldown`, stop and wait
for the orchestrator.
It will resume the same Claude or Codex session with the result.
