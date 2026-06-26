/**
 * Zod schemas + types shared across imprint. Capture (Session), workflow
 * (Workflow + Request), runtime (ToolResult), config (Cron, NotifyWhen,
 * BackendsCache), and the playbook DOM-replay schema (Locator/Step/etc).
 *
 * For the data-flow diagram (record → generate → emit → MCP), see
 * docs/architecture.md.
 */

import { z } from 'zod';

// ─── Captured session (output of `imprint record`) ──────────────────────────

const CapturedRequestSchema = z.object({
  seq: z.number().int().nonnegative(),
  /** ms since recording started */
  timestamp: z.number(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().optional(),
  resourceType: z.string(),
  response: z
    .object({
      status: z.number(),
      headers: z.record(z.string()),
      body: z.string().optional(),
      mimeType: z.string().optional(),
    })
    .optional(),
});
export type CapturedRequest = z.infer<typeof CapturedRequestSchema>;

const CapturedEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  type: z.enum([
    'navigation',
    'click',
    'input',
    'change',
    'submit',
    'dom-snapshot',
    'ws-sent',
    'ws-received',
  ]),
  /**
   * For navigation: the URL.
   * For click/input/change: JSON of { selector, tag, id, name, value?, text? }.
   * For submit: JSON of { selector, action, method, fields[] }.
   * For ws-sent/ws-received: JSON of { url, opcode, payloadDataPreview }.
   */
  detail: z.string(),
});
export type CapturedEvent = z.infer<typeof CapturedEventSchema>;

const CookieSnapshotSchema = z.object({
  takenAt: z.string(),
  timestamp: z.number(),
  label: z.enum(['start', 'end', 'manual']),
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.string().optional(),
      hostOnly: z.boolean().optional(),
      creationIndex: z.number().optional(),
    }),
  ),
});
export type CookieSnapshot = z.infer<typeof CookieSnapshotSchema>;

const StorageSnapshotSchema = z.object({
  takenAt: z.string(),
  timestamp: z.number(),
  label: z.enum(['start', 'end', 'manual']),
  origin: z.string(),
  localStorage: z.record(z.string()).default({}),
  sessionStorage: z.record(z.string()).default({}),
});
export type StorageSnapshot = z.infer<typeof StorageSnapshotSchema>;

const NarrationSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  text: z.string(),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const SessionSchema = z.object({
  site: z.string(),
  startedAt: z.string(),
  url: z.string(),
  imprintVersion: z.string(),
  requests: z.array(CapturedRequestSchema),
  events: z.array(CapturedEventSchema),
  narration: z.array(NarrationSchema),
  cookieSnapshots: z.array(CookieSnapshotSchema).default([]),
  storageSnapshots: z.array(StorageSnapshotSchema).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Workflow (output of `imprint generate`) ────────────────────────────────

const WorkflowParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  /** Optional with this default if set. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Whether a `param:<name>` integration test verified this parameter's effect
   *  against live data at compile time. `false` means it ships unverified (the
   *  live differential was waived by anti-bot, or explicitly annotated
   *  exposed-but-not-verified) and is exercised at runtime via the backend
   *  ladder. Undefined on tools compiled before this gate (treated as verified
   *  for back-compat). Not surfaced in the user-facing MCP schema. */
  verified: z.boolean().optional(),
  /** Why the parameter is unverified (e.g. `waived-bot`, `waived-infra`,
   *  `annotated`, `waived-chain`). Undefined when `verified` is true/undefined. */
  verifyNote: z.string().optional(),
  /** Set when this parameter is an opaque token/id minted by a sibling tool — the
   *  consumer takes a value produced by `tool`'s `field` output. Surfaced in the
   *  MCP param description so the orchestrating LLM calls `tool` first and reuses
   *  the value; used by the compile gate to require a chained verification test and
   *  by `imprint audit` to chain producer→consumer instead of fabricating a token. */
  sourcedFrom: z
    .object({
      tool: z.string(),
      field: z.string(),
    })
    .optional(),
});
export type WorkflowParameter = z.infer<typeof WorkflowParameterSchema>;

const StateCapabilitySchema = z.enum([
  'ordinary_http',
  'browser_bootstrap',
  'stealth_bootstrap',
  'credential_required',
  'unsupported',
]);
export type StateCapability = z.infer<typeof StateCapabilitySchema>;

const CaptureCommonSchema = z.object({
  name: z.string(),
  required: z.boolean().optional().default(true),
  capability: StateCapabilitySchema.optional().default('ordinary_http'),
});

const CookieCaptureSchema = CaptureCommonSchema.extend({
  source: z.literal('cookie'),
  cookie: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  sameSite: z.string().optional(),
  allowHttpOnlyProjection: z.boolean().optional().default(false),
});

const RequestCaptureSchema = z.discriminatedUnion('source', [
  CaptureCommonSchema.extend({
    source: z.literal('json'),
    path: z.string(),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('response_header'),
    header: z.string(),
    mode: z.enum(['first', 'last', 'all']).optional().default('last'),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('text_regex'),
    pattern: z.string(),
    group: z.number().int().nonnegative().optional().default(1),
  }),
  CookieCaptureSchema,
]);
export type RequestCapture = z.infer<typeof RequestCaptureSchema>;

const BootstrapCaptureSchema = z.discriminatedUnion('source', [
  CookieCaptureSchema,
  CaptureCommonSchema.extend({
    source: z.literal('local_storage'),
    origin: z.string(),
    key: z.string(),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('session_storage'),
    origin: z.string(),
    key: z.string(),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('html_regex'),
    pattern: z.string(),
    group: z.number().int().nonnegative().optional().default(1),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('dom_attribute'),
    selector: z.string(),
    attribute: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  CaptureCommonSchema.extend({
    source: z.literal('dom_text'),
    selector: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  /** Read the value of a header from the bootstrap GET's own HTTP response.
   *  Use this when the token (CSRF, anti-replay, page nonce, etc.) is
   *  returned in a response header — not embedded in the HTML body — which
   *  no `html_regex` or `dom_*` capture can ever match. Mirrors the shape
   *  of `RequestCaptureSchema.source = 'response_header'` so the agent
   *  documents one consistent rule across request- and bootstrap-scoped
   *  captures. */
  CaptureCommonSchema.extend({
    source: z.literal('response_header'),
    header: z.string(),
    mode: z.enum(['first', 'last', 'all']).optional().default('last'),
  }),
]);
export type BootstrapCapture = z.infer<typeof BootstrapCaptureSchema>;

const WorkflowRequestSchema = z.object({
  method: z.string(),
  /** Template; ${param.X} substitutes a parameter, ${response[N].path} an
   *  earlier extracted value. */
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().optional(),
  /** Names → jsonpath expressions; later requests reference via ${response[N].name}. */
  extract: z.record(z.string()).optional(),
  captures: z.array(RequestCaptureSchema).optional(),
  effect: z.enum(['safe', 'idempotent', 'unsafe']).optional(),
  /** When true, a non-2xx response from this request is logged and SKIPPED
   *  instead of aborting the flow. For best-effort, non-load-bearing steps whose
   *  failure must not block completion — e.g. a "remember this device" /
   *  trusted-device registration that 4xxs when the device is already trusted, or
   *  a telemetry beacon. The flow continues to the next (terminal) request. */
  optional: z.boolean().optional(),
});
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

/** The two *structural* 2FA cases the runtime actually branches on, plus `none`.
 *  A code that arrives out-of-band (sms / email / authenticator app) and is typed
 *  back into a second request is one case (`otp`); an approval the user taps
 *  elsewhere while we poll is the other (`push`). The delivery *channel* never
 *  changes how we replay it, so we don't model it. */
export const TwoFactorTypeSchema = z.enum(['otp', 'push', 'none']).default('none');

const AuthConfigSchema = z
  .object({
    twoFactorType: TwoFactorTypeSchema,
    /** How many requests to execute for the 'initiate' phase (login + 2FA trigger).
     *  The remaining requests run during the 'complete'/'submit_otp' phase. */
    initiateRequestCount: z.number().int().nonnegative().default(0),
    pollEndpoint: z.string().optional(),
    /** Push only: HTTP method for the poll request (default POST). */
    pollMethod: z.string().optional(),
    /** Push only: the request body to send on each poll attempt, templated like
     *  any other request body (`${param.X}` / `${state.X}` / `${credential.X}`).
     *  Some poll/status endpoints reject an empty body (e.g. require a JSON
     *  `{mfaId,...}` payload), so the compile agent must declare the recorded
     *  poll body here — otherwise the poll silently sends nothing and the
     *  approved push is never recognized. Omitted → body-less poll (legacy). */
    pollBody: z.string().optional(),
    /** Push only: Content-Type for the poll body (default application/json when
     *  pollBody is set). Grounded in the recorded poll request's header. */
    pollContentType: z.string().optional(),
    pollIntervalMs: z.number().int().positive().default(3000),
    maxPollAttempts: z.number().int().positive().default(60),
    /** Push only: a recording-grounded capture that resolves on the *approved*
     *  poll response (and not on the pending ones). When it yields a non-empty
     *  value the poll is done. Omitted → fall back to "a session Set-Cookie
     *  appeared". Replaces hardcoded body-substring matching. */
    pollTerminal: RequestCaptureSchema.optional(),
    /** OTP only: the names of `${state.X}` values captured from the initiate
     *  response that the completion (submit_otp) requests need (e.g. a reauth
     *  `mfaId`). Because each MCP call is stateless, these are echoed back to
     *  the caller in the AWAITING_2FA result and passed in again on submit_otp. */
    twoFactorContext: z.array(z.string()).default([]),
    /** Opt-in: when the recorded login carries its session through a CROSS-ORIGIN
     *  `Set-Cookie` (e.g. a `functions.*`/`global.*` host sets a cookie that a
     *  later leg depends on), set this so cdp-replay writes those cross-origin
     *  response cookies back into the browser jar. Default false — only declare it
     *  when the recording actually shows cross-origin cookie chaining; otherwise
     *  the browser's normal same-origin jar is left untouched. */
    crossOriginCookieReinjection: z.boolean().default(false),
    /** Durable session tokens to persist after a SUCCESSFUL login completion so
     *  DATA tools can reuse them without re-running auth (they re-auth only on
     *  expiry / AUTH_EXPIRED). Cookies persist automatically; declare here only
     *  the NON-cookie material a data request needs — a bearer / access / CSRF
     *  token the completion response returns in its body or a header. Each
     *  capture's resolved value is stored as a durable credential secret
     *  (`${credential.NAME}`). Grounded in the recording; channel/site-agnostic. */
    sessionCapture: z.array(RequestCaptureSchema).default([]),
  })
  .optional();
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const WorkflowSchema = z.object({
  toolName: z.string(),
  toolKind: z.enum(['data', 'authenticate']).optional(),
  intent: z.object({
    description: z.string(),
    /** Concatenated narration the user spoke while recording. */
    userSaid: z.string().optional(),
  }),
  parameters: z.array(WorkflowParameterSchema),
  requests: z.array(WorkflowRequestSchema),
  authConfig: AuthConfigSchema,
  site: z.string(),
  bootstrap: z
    .object({
      url: z.string(),
      waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
      waitMs: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().positive().optional(),
      captures: z.array(BootstrapCaptureSchema).optional(),
    })
    .optional(),
  /** Path to a sibling parser module (relative to the workflow.json file)
   *  exporting `extract(rawResponse): unknown`. Applied by the runtime
   *  to transform the raw API response into structured agent output. */
  parserModule: z.string().optional(),
  /** Path to a sibling request-transform module (relative to workflow.json)
   *  exporting `transform(method, url, responses, params?)`.
   *
   *  Return value:
   *  - `string` — the transformed URL (backward-compatible).
   *  - `{ url: string; body?: string; headers?: Record<string, string> }` —
   *    URL plus optional body and header overrides for complex body formats
   *    (JSPB, nested JSON-in-form) where placeholder substitution alone
   *    cannot handle the encoding.
   *
   *  The optional 4th arg `params` carries the resolved workflow parameters
   *  so the transform can construct request bodies programmatically. */
  requestTransformModule: z.string().optional(),
  /** Did this tool's integration test produce live data at compile time?
   *
   *  - `liveVerified: true` (default when present) — the integration test
   *    passed at one of the API/stealth-fetch rungs of the ladder.
   *  - `liveVerified: false` — the test failed and was waived (anti-bot
   *    block or transient infra), so the tool shipped without a passing
   *    live call. Downstream consumers (audit gate, teach summary) treat
   *    this as a flying-blind signal — the runtime playbook fallback is
   *    the only remaining path, and it is a last-ditch one. `liveVerified`
   *    is absent on tools predating this field; absent is treated as
   *    "unknown" by readers, which is more honest than defaulting true. */
  liveVerified: z.boolean().optional(),
  /** Structured reason a waiver was applied. Only present when
   *  `liveVerified === false`. */
  liveVerifiedWaiver: z
    .object({
      kind: z.enum(['waived-bot', 'waived-infra']),
      firstError: z.string(),
      exhaustedBackends: z.array(z.string()),
    })
    .optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ─── Generated tool runtime contract ─────────────────────────────────────────

export type StateMissingFailure =
  | 'producer_unavailable'
  | 'producer_ran_value_absent'
  | 'ambiguous_cookie'
  | 'credential_missing'
  | 'unsupported_workflow';

export interface StateMissingItem {
  name: string;
  source: 'credential' | 'cookie' | 'state' | 'storage' | 'response' | 'workflow';
  capability: StateCapability;
  required: boolean;
  failure: StateMissingFailure;
  message: string;
}

/** Discriminated union returned by every generated tool. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T; loginResponsePreview?: string }
  | {
      ok: false;
      error:
        | 'AUTH_EXPIRED' // 401 — run `imprint login`
        | 'AWAITING_2FA' // 2FA required — user must approve push / enter OTP
        | 'FORBIDDEN' // 403 — bot detection, geo, ToS, capability mismatch
        | 'NETWORK' // fetch threw / timed out
        | 'RATE_LIMITED' // 429
        | 'BAD_RESPONSE' // other 4xx/5xx
        | 'STATE_MISSING' // required cookie/state could not be produced
        | 'UNKNOWN';
      message: string;
      remediation?: string;
      missing?: StateMissingItem[];
      /** HTTP status code that produced this failure, when one was received
       *  (absent for transport/STATE_MISSING failures). Surfaced so the auth
       *  compile agent sees the concrete code, not just a prose message. */
      status?: number;
      /** Truncated response body of the failing request (first ~500 chars).
       *  Lets the compile agent inspect the server's actual error payload
       *  without re-running. Distinct from `loginResponsePreview`, which is the
       *  *initiate* response preview on the AWAITING_2FA path. */
      responseBodyPreview?: string;
      twoFactorType?: string;
      /** OTP only: the `${state.X}` values captured from the initiate response
       *  that the caller must echo back on the submit_otp call (stateless
       *  state-chain bridge). Names are declared in authConfig.twoFactorContext. */
      twoFactorContext?: Record<string, unknown>;
      loginResponsePreview?: string;
    };

// ─── Cron config (input to `imprint cron`) ───────────────────────────────────

/** Push-on-success predicate. Without one, cron only pushes on failure.
 *  See docs/architecture.md for the predicate language. */
const NotifyWhenSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('price_below'),
    threshold: z.number(),
    /** Dot-path with [] for array iteration; see json-path.ts.
     *  Accepts an array of paths to try in order — useful when a tool
     *  returns different shapes from different backends (e.g. raw API
     *  shape from stealth-fetch vs. reshaped output from playbook).
     *  The union of values from every matching path is taken. */
    pricePath: z.union([z.string(), z.array(z.string()).min(1)]),
  }),
]);
export type NotifyWhen = z.infer<typeof NotifyWhenSchema>;

/** fetch (plain API replay) → gated fetch-bootstrap (browser state init +
 *  API replay) → cdp-replay (API requests run IN a live trusted Chrome page so
 *  a protected POST's invalidated _abck is auto-re-validated by the page's bmak
 *  sensor between calls — the only way to sustain multiple sensitive .act POSTs)
 *  → stealth-fetch (bot-defense state + API replay) → playbook (full DOM walk).
 *  'auto' only inserts fetch-bootstrap / cdp-replay for declared or satisfiable
 *  browser-minted state. */
const ReplayBackendSchema = z.enum([
  'fetch',
  'fetch-bootstrap',
  'cdp-replay',
  'stealth-fetch',
  'playbook',
  'auto',
]);
export type ReplayBackend = z.infer<typeof ReplayBackendSchema>;

const ConcreteBackendSchema = ReplayBackendSchema.exclude(['auto']);
/** ReplayBackend without the 'auto' meta-value — what the ladder actually walks. */
export type ConcreteBackend = Exclude<ReplayBackend, 'auto'>;

/** Per-backend probe result. Written to <IMPRINT_HOME>/<site>/<toolName>/backends.json
 *  by `imprint probe-backends`; cron + MCP read it at startup so they
 *  start with the cheapest known-working backend. */
const BackendProbeResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    durationMs: z.number(),
    /** Optional cdp-replay cold-start measurement. `durationMs` remains the
     *  first-call duration for backward compatibility. */
    coldDurationMs: z.number().optional(),
    /** Optional cdp-replay warm-pool measurement from a second call against the
     *  same pooled Chrome. Used to explain why CDP may outrank stealth when its
     *  cold start is still under the operator timeout. */
    warmDurationMs: z.number().optional(),
    /** Effective duration used for preference ranking when it differs from the
     *  first-call duration, e.g. warm cdp-replay. */
    rankingDurationMs: z.number().optional(),
    tooSlow: z.boolean().optional(),
    detail: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('forbidden'),
    durationMs: z.number(),
    detail: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('failed'),
    durationMs: z.number(),
    error: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('unavailable'),
    detail: z.string(),
  }),
  z.object({
    outcome: z.literal('skipped'),
    detail: z.string(),
  }),
]);

export const BackendsCacheSchema = z.object({
  probedAt: z.string(),
  /** Schema-bump invalidator. */
  imprintVersion: z.string(),
  workflowHash: z.string().optional(),
  schemaVersion: z.number().optional(),
  capabilityHash: z.string().optional(),
  /** Ladder for runtime — preferredOrder[0] cheapest, rest fall back on
   *  FORBIDDEN. Excludes 'auto'. */
  preferredOrder: z.array(ConcreteBackendSchema).min(1),
  results: z.record(z.string(), BackendProbeResultSchema),
});
export type BackendsCache = z.infer<typeof BackendsCacheSchema>;

export const CronConfigSchema = z.object({
  schedule: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  notifyWhen: NotifyWhenSchema.optional(),
  replayBackend: ReplayBackendSchema.optional().default('auto'),
});
export type CronConfig = z.infer<typeof CronConfigSchema>;

// ─── Playbook (DOM-replay artifact) ─────────────────────────────────────────

/** Locator strategies, in priority order: role+name → aria_label → text → id → css. */
const LocatorSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('role'),
    value: z.string(),
    name: z.string().optional(),
  }),
  z.object({
    by: z.literal('aria_label'),
    value: z.string().optional(),
    value_pattern: z.string().optional(),
  }),
  z.object({
    by: z.literal('text'),
    value: z.string().optional(),
    value_pattern: z.string().optional(),
  }),
  z.object({ by: z.literal('id'), value: z.string() }),
  z.object({ by: z.literal('css'), value: z.string() }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

const WaitForSchema = z.union([
  z.literal('networkidle'),
  z.literal('load'),
  z.literal('visible'),
  z.literal('hidden'),
  z.object({
    xhr: z.string(),
    method: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({ sleep_ms: z.number().int().positive() }),
]);
export type WaitFor = z.infer<typeof WaitForSchema>;

const PlaybookStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('navigate'),
    url: z.string(),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('click'),
    locators: z.array(LocatorSchema).min(1),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('type'),
    locators: z.array(LocatorSchema).min(1),
    value: z.string(),
    clear: z.boolean().optional(),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('submit'),
    locators: z.array(LocatorSchema).min(1),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('press'),
    key: z.string(),
    locators: z.array(LocatorSchema).optional(),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('wait'),
    wait_for: WaitForSchema,
  }),
]);
export type PlaybookStep = z.infer<typeof PlaybookStepSchema>;

const PlaybookResultSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('xhr'),
    url_pattern: z.string(),
    method: z.string().optional(),
    /** Dot-path with [] for array iteration (see json-path.ts). */
    extract: z.string(),
    return_as: z.string().default('result'),
  }),
  z.object({
    source: z.literal('dom'),
    locators: z.array(LocatorSchema).min(1),
    /** "text" (innerText) or attribute name (e.g. "value", "href"). */
    extract: z.string(),
    return_as: z.string().default('result'),
  }),
]);
export type PlaybookResult = z.infer<typeof PlaybookResultSchema>;

/** A named value extracted from a captured XHR response, in addition to the
 *  success marker. Used by a login playbook to carry a 2FA-chain token (e.g. a
 *  single-use `SecurityCode` minted in the browser during the OTP-send step)
 *  out of the playbook run so a later stateless `submit_otp` can include it.
 *  The `name` should match an `authConfig.twoFactorContext` entry. */
const PlaybookCaptureSchema = z.object({
  name: z.string(),
  /** Regex matched against the captured response URL. */
  url_pattern: z.string(),
  method: z.string().optional(),
  /** Dot-path with [] for array iteration (see json-path.ts), or '*'/'' for the
   *  whole parsed body. */
  extract: z.string(),
});
export type PlaybookCapture = z.infer<typeof PlaybookCaptureSchema>;

// Playbook params are structurally identical to workflow params — reuse
// the same schema directly to stay in sync.
export const PlaybookSchema = z.object({
  toolName: z.string(),
  summary: z.string(),
  parameters: z.array(WorkflowParameterSchema),
  steps: z.array(PlaybookStepSchema).min(1),
  result: PlaybookResultSchema,
  /** Optional named XHR captures for the 2FA chain (best-effort). */
  captures: z.array(PlaybookCaptureSchema).optional(),
  notes: z.string().optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
