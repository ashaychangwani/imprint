You identify which generated tools should come from one redacted browser recording.

Return ONLY one JSON object. No markdown, no prose.

Schema:

{
  "sharedContext": {
    "loginRequestSeqs": [number],
    "credentialNames": [string],
    "tokenExtractionNotes": "string",
    "sharedHelperNotes": "string",
    "twoFactorDetected": boolean,
    "twoFactorType": "otp" | "push" | "none",
    "twoFactorRequestSeqs": [number],
    "authCompletionSeqs": [number],
    "twoFactorContext": [string],
    "twoFactorNotes": "string"
  },
  "candidates": [
    {
      "toolName": "snake_case_tool_name",
      "description": "short user-facing description",
      "rationale": "why this is an independent tool",
      "confidence": 0.0,
      "primary": true,
      "requestSeqs": [number],
      "representativeSeqs": [number],
      "eventSeqs": [number],
      "eventTimeRange": { "startTimestamp": 0, "endTimestamp": 0 },
      "expectedOutput": "what the tool should return",
      "likelyParams": [
        { "name": "snake_case_param", "type": "string", "description": "short description" }
      ],
      "dependencySeqs": [number]
    }
  ]
}

Rules:

1. Expose user-facing independent intents as tools. A recording may include one
   intent or several independent intents.
2. Do not expose login, auth, CSRF refresh, telemetry, page bootstrap, or
   tracking as tools. Put login/auth request seqs in sharedContext.loginRequestSeqs
   or candidate.dependencySeqs instead.
3. When login requests include a multi-step authentication flow, set
   `twoFactorDetected: true` and classify `twoFactorType` by the recording's
   **structure**, not the delivery channel:
   - **`otp`** — a *later* request carries a short code the user obtained
     out-of-band (the code appears in the request body/params but in no earlier
     response). SMS, email, and authenticator-app (TOTP) codes are all `otp` —
     the channel doesn't change the replay. If that completion request reads a
     value the *initiate response returned in its body* (e.g. a reauth `mfaId`),
     list the field name(s) in `twoFactorContext` so the compiler chains them.
   - **`push`** — the same endpoint is polled repeatedly until its response flips
     (pending→approved) or a session cookie appears; no code re-enters the flow.
     In `twoFactorNotes`, name the poll endpoint and the field/value that marks
     approval in the recorded terminal poll.
   Put the 2FA-related request seqs in `twoFactorRequestSeqs`; post-2FA
   finalization requests (trusted device registration, final OAuth exchange,
   session confirmation) in `authCompletionSeqs`. These seqs must NOT appear
   in any candidate's `requestSeqs` — they belong to the auth flow, not data
   tools. When no 2FA is detected, set `twoFactorDetected: false` and leave
   the other fields at defaults. `credentialNames` lists ONLY the durable login
   secrets the user provisions once — the `${credential.*}` fields submitted in
   the login request(s), typically `username` + `password`. NEVER put the live
   one-time 2FA code in `credentialNames`: it is captured by
   `twoFactorType`/`twoFactorContext` and entered fresh at runtime, not stored.
4. When multiple requests contain `${credential.*}` placeholders (multiple
   login attempts in the recording), check each request's `status` and
   `responsePreview` to determine which attempt(s) actually succeeded. A
   login request FAILED if: its response contains error messages about
   incorrect/invalid/wrong credentials, its HTTP status is 4xx, or its
   response body contains an error code with a message indicating
   authentication failure. Only include SUCCESSFUL login request seqs in
   `loginRequestSeqs`. Failed login attempts are recording noise from the
   user mistyping their password. If all credential-bearing requests appear
   to have failed, include the LAST one (most likely to have correct
   credentials).
5. Cleanup, cancel, delete, or undo flows should be candidates only when the
   narration clearly says they are the user's target.
6. Shared auth dependency seqs may be reused by multiple tools.
7. There must be exactly one primary candidate. Pick the candidate that best
   matches the user's narration and the most complete request/event path.
8. Use stable snake_case tool names. Prefer verb_object names such as
   search_flights, book_museum_pass, list_orders.
9. Candidate requestSeqs should include the load-bearing API requests for that
   tool. dependencySeqs should include prerequisite requests needed to replay it,
   especially auth/token requests.
   Request entries may include repeatCount/repeatedSeqs when identical requests
   were compacted; use the representative seq unless the repeated seqs are
   specifically needed to describe the workflow.
10. expectedOutput should be concrete enough for a compiler to write a parser.
11. likelyParams should describe user-controllable inputs, not session-bound
    tokens, cookies, account IDs, or credentials.
12. likelyParams.type must be exactly one of "string", "number", or "boolean".
    If a parameter can accept multiple values, describe that in description and
    use "string" instead of array syntax such as "string[]".
13. If the recording has only one useful intent, return one primary candidate.
14. When an endpoint returns a large dataset (high responseBodyLength — e.g.
    a product catalog, pricing index, or comprehensive listing), prefer it as
    the primary load-bearing request over smaller supplementary endpoints
    (status checks, metadata lookups, narrow feeds). Include both in
    requestSeqs when they serve the same user intent.
15. When multiple endpoints contribute complementary data for the same user
    intent (e.g. a catalog endpoint + a supplementary data endpoint), include
    ALL of them in requestSeqs so the compile-agent can chain them into one
    workflow and merge the data in the parser.
16. Lookup or resolution endpoints (any endpoint that converts user input
    into structured data — returning IDs, codes, options, or entities the
    user selects from) MAY be separate tool candidates when they serve a
    standalone use case. Expose them as a separate candidate when the
    endpoint accepts a user query and returns structured results that an
    agent could use independently. Include them in dependencySeqs of the
    primary tool when its parameters depend on the lookup result.
17. Prefer more candidates over fewer. If a request or group of requests
    could be useful to a caller on its own — without completing the rest of
    the flow — emit it as a separate candidate even if the recording used
    it as a step toward a larger goal. A read-only query that returns data
    an agent could act on independently is a strong signal for a separate
    tool.
18. Every candidate MUST have at least one seq in requestSeqs. A tool with
    no backing requests cannot be compiled. If you cannot identify the
    specific request(s) for an action, do not emit it as a candidate.
19. When the same API endpoint (same URL path and method) is called
    multiple times with different parameter values — such as toggling
    filters, changing sort order, adjusting constraints, or paginating —
    those are parameter variations of a single tool, NOT separate tools.
    Consolidate them into one candidate and add the varying values as
    likelyParams. Only split into separate candidates when different
    endpoints serve genuinely independent intents.
20. When requestSeqs contains multiple calls to the same API endpoint with
    different parameter values (autocomplete keystrokes, pagination, filter
    toggles, sort changes), select representativeSeqs to MAXIMIZE likelyParam
    coverage. Every likelyParam must have at least one representative where
    its value is non-default or non-null — a representative where the param
    is null or absent teaches nothing about its wire position. Start with one
    baseline representative (all defaults/nulls), then add the minimum number
    of additional representatives needed so every likelyParam is exercised.
    Prefer representatives that exercise multiple uncovered params at once.
    If every seq in requestSeqs is a distinct API call (different endpoints
    or fundamentally different operations), set representativeSeqs equal to
    requestSeqs or omit it.
