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
  /** Agent-classified effect on a derived triaged session. */
  effect: z.literal('irreversible').optional(),
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
  /** Present only on derived triaged artifacts. Version 2 proves every request
   * in the source recording was shown to the effect-aware triage pass. The
   * arrays retain safety coverage for requests omitted from this relevance-
   * filtered artifact. */
  triage: z
    .object({
      effectSchemaVersion: z.literal(2),
      coveredSeqs: z.array(z.number().int().nonnegative()),
      irreversibleSeqs: z.array(z.number().int().nonnegative()),
      coveredOutboundEventSeqs: z.array(z.number().int().nonnegative()).default([]),
      irreversibleEventSeqs: z.array(z.number().int().nonnegative()).default([]),
    })
    .optional(),
  cookieSnapshots: z.array(CookieSnapshotSchema).default([]),
  storageSnapshots: z.array(StorageSnapshotSchema).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Workflow (output of `imprint generate`) ────────────────────────────────

const WorkflowParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  /** Optional finite choices to surface as JSON Schema enum values. */
  choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
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

const CaptureEqualsSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RequestCaptureCommonSchema = CaptureCommonSchema.extend({
  /** Optional exact scalar match. This also makes an explicitly matched empty
   *  string or null a valid capture value. */
  equals: CaptureEqualsSchema.optional(),
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

export const RequestCaptureSchema = z.discriminatedUnion('source', [
  RequestCaptureCommonSchema.extend({
    source: z.literal('json'),
    path: z.string(),
    /** When set, parse the value selected by `path` as JSON once and resolve
     *  this second path against the decoded value. */
    decodeJsonPath: z.string().min(1).optional(),
  }),
  RequestCaptureCommonSchema.extend({
    source: z.literal('response_header'),
    header: z.string(),
    mode: z.enum(['first', 'last', 'all']).optional().default('last'),
  }),
  RequestCaptureCommonSchema.extend({
    source: z.literal('text_regex'),
    pattern: z.string(),
    group: z.number().int().nonnegative().optional().default(1),
  }),
  CookieCaptureSchema.extend({ equals: CaptureEqualsSchema.optional() }),
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

const WorkflowRequestBaseSchema = z.object({
  method: z.string(),
  /** Sequence number of the captured request that grounds this outgoing
   *  workflow request. A navigation-selected background response records its
   *  distinct capture provenance in navigation.networkResponse. */
  recordingRequestSeq: z.number().int().nonnegative().optional(),
  /** Template; ${param.X} substitutes a parameter, ${response[N].path} an
   *  earlier extracted value. */
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().optional(),
  /** Agent-declared escaping for values substituted into `body` placeholders.
   *
   * Omitted is accepted only for backward compatibility with previously
   * generated workflows. New compile runs require an explicit value whenever
   * a body contains runtime placeholders, so payload syntax is decided and
   * tested at compile time instead of inferred from Content-Type at runtime. */
  bodyPlaceholderEncoding: z.enum(['raw', 'json-string', 'form-urlencoded']).optional(),
  /** Execute this GET or URL-encoded POST as a top-level browser navigation instead of fetch().
   *  This lets the recorded page run its own JavaScript and mint coupled browser
   *  state, and lets form POSTs retain document-navigation semantics, without
   *  teaching Imprint site- or framework-specific behavior. */
  mode: z.enum(['fetch', 'navigate']).optional(),
  /** Bounded completion criteria for mode="navigate". Predicates are ANDed.
   *  With no predicate, navigation completes at the selected lifecycle event. */
  navigation: z
    .object({
      waitUntil: z.enum(['domcontentloaded', 'load']).optional(),
      timeoutMs: z.number().int().positive().optional(),
      pollIntervalMs: z.number().int().positive().optional(),
      urlIncludes: z.string().min(1).optional(),
      /** Wait until the rendered document contains this CSS selector before
       * snapshotting outerHTML. Useful for pages whose meaningful results
       * hydrate after the load event. */
      selector: z.string().min(1).optional(),
      /** Optional browser interactions performed after the initial navigation
       * predicate is satisfied. This is a generic escape hatch for workflows
       * whose next request is assembled from private in-page state rather than
       * values serialized into HTML. */
      actions: z
        .array(
          z
            .object({
              action: z.literal('click'),
              selector: z.string().min(1),
            })
            .strict(),
        )
        .min(1)
        .optional(),
      /** After navigation actions run, wait for this rendered selector before
       * snapshotting the final document. */
      resultSelector: z.string().min(1).optional(),
      /** Return one page-generated network response instead of the rendered
       * document. This is an explicit, agent-selected browser operation for a
       * request that the page must construct itself. Matching is mechanical and
       * site-neutral; the runtime does not infer which response is meaningful. */
      networkResponse: z
        .object({
          /** Required URL substring observed in the target response. */
          urlIncludes: z.string().min(1),
          /** Exact recorded request whose response body/status/headers represent
           * the page-generated result returned by this workflow request. */
          recordingResponseRequestSeq: z.number().int().nonnegative(),
          /** Optional exact HTTP method (matched case-insensitively). */
          method: z.string().min(1).optional(),
          /** Optional exact CDP resource type, such as XHR or Fetch (matched
           * case-insensitively). */
          resourceType: z.string().min(1).optional(),
          /** Select the Nth matching response, ordered by its request start
           * within this navigation scope. Starts that never receive a response
           * do not consume an occurrence. */
          occurrence: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
      cookie: z
        .object({
          name: z.string().min(1),
          domain: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  /** Names → jsonpath expressions; later requests reference via ${response[N].name}. */
  extract: z.record(z.string()).optional(),
  captures: z.array(RequestCaptureSchema).optional(),
  /** Agent-classified outward effect. Runtime does not infer business intent. */
  effect: z.enum(['safe', 'idempotent', 'unsafe', 'irreversible']).optional(),
  /** When true, a non-2xx response from this request is logged and SKIPPED
   *  instead of aborting the flow. For best-effort, non-load-bearing steps whose
   *  failure must not block completion — e.g. a "remember this device" /
   *  trusted-device registration that 4xxs when the device is already trusted, or
   *  a telemetry beacon. The flow continues to the next (terminal) request. */
  optional: z.boolean().optional(),
});
const WorkflowRequestSchema = WorkflowRequestBaseSchema.superRefine((request, ctx) => {
  if (request.navigation?.networkResponse && request.mode !== 'navigate') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'navigation.networkResponse requires mode "navigate"',
    });
  }
});
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;
export type NavigationNetworkResponseMatcher = NonNullable<
  NonNullable<WorkflowRequest['navigation']>['networkResponse']
>;

const AuthConfigSchema = z
  .object({
    /** Recording-grounded auth program. Action names, boundaries, evidence,
     *  retry behavior, and completion are chosen by the compile agent. */
    entry: z.string().min(1),
    actions: z.record(
      z.string().min(1),
      z
        .object({
          parameters: z.array(z.string().min(1)).optional().default([]),
          steps: z
            .array(
              z
                .object({
                  request: z.number().int().nonnegative(),
                  onError: z.enum(['fail', 'continue', 'retry']).optional().default('fail'),
                  repeat: z
                    .object({
                      until: RequestCaptureSchema,
                      intervalMs: z.number().int().nonnegative(),
                      maxAttempts: z.number().int().positive(),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            )
            .min(1),
          outcome: z.discriminatedUnion('type', [
            z
              .object({
                type: z.literal('pause'),
                next: z.string().min(1),
                evidence: z.array(z.string().min(1)).optional().default([]),
                carry: z.array(z.string().min(1)).optional().default([]),
                message: z.string().min(1),
              })
              .strict(),
            z
              .object({
                type: z.literal('success'),
                evidence: z.array(z.string().min(1)).optional().default([]),
              })
              .strict(),
          ]),
        })
        .strict(),
    ),
    /** Durable credential interface names to store after success. */
    persist: z.array(z.string().min(1)).optional().default([]),
    /** Optional interface-name → compiled capture-name bindings. This lets the
     * auth agent rename an internal capture without changing data-tool inputs. */
    persistBindings: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Opt-in: when the recorded login carries its session through a CROSS-ORIGIN
     *  `Set-Cookie` (e.g. a `functions.*`/`global.*` host sets a cookie that a
     *  later leg depends on), set this so cdp-replay writes those cross-origin
     *  response cookies back into the browser jar. Default false — only declare it
     *  when the recording actually shows cross-origin cookie chaining; otherwise
     *  the browser's normal same-origin jar is left untouched. */
    crossOriginCookieReinjection: z.boolean().default(false),
  })
  .strict()
  .optional();
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export function persistedCaptureName(
  config: NonNullable<AuthConfig>,
  credentialName: string,
): string {
  return config.persistBindings?.[credentialName] ?? credentialName;
}

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
   *  - `{ url?: string; body?: string; headers?: Record<string, string>; navigation?: object; skip?: boolean }` —
   *    URL plus optional body and header overrides for complex body formats
   *    (JSPB, nested JSON-in-form) where placeholder substitution alone
   *    cannot handle the encoding. `navigation` may supply dynamic browser
   *    navigation actions derived from resolved parameters. `skip: true` skips this request, for
   *    conditional follow-up requests such as pagination/detail calls.
   *
   *  The optional 4th arg `params` carries the resolved workflow parameters
   *  so the transform can construct request bodies programmatically. */
  requestTransformModule: z.string().optional(),
  /** Agent-authored capability limitations retained with the generated tool.
   * A compiler may deliberately omit a secondary feature or parameter when the
   * recording and live evidence cannot support it without guessing. Runtime
   * execution does not interpret these notes; MCP descriptions and teach
   * summaries surface them to callers and operators. */
  limitations: z
    .array(
      z.object({
        feature: z.string().min(1),
        reason: z.string().min(1),
        omittedParameters: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
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
      kind: z.enum(['waived-bot', 'waived-infra', 'waived-safety']),
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

/** Value-free execution facts retained only to explain where a generated
 * request failed. They intentionally omit URLs, headers, bodies, parameter
 * values, and response content. */
export interface RequestStageFact {
  requestIndex: number;
  stage: 'preparation' | 'transform' | 'send';
  outcome: 'passed' | 'failed' | 'skipped' | 'unavailable';
  /** Final body metadata at this stage. No body bytes are retained. */
  bodyPresent?: boolean;
  bodyByteLength?: number;
  /** Whether a request transform replaced the prepared body. */
  bodyChanged?: boolean;
  /** HTTP status proves transport completed without exposing response content. */
  httpStatus?: number;
}

/** Discriminated union returned by every generated tool. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error:
        | 'AUTH_EXPIRED' // 401 — run `imprint login`
        | 'ACTION_REQUIRED' // declared auth action completed; another action/user input is needed
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
      /** Truncated response body of the failing request (first ~500 chars). */
      responseBodyPreview?: string;
      /** Value-free stage receipts for requests attempted before this failure. */
      requestStageFacts?: RequestStageFact[];
      /** Recording-derived state and generic action progress. Echo this object
       *  unchanged on the next auth call. */
      continuation?: Record<string, unknown>;
      nextAction?: string;
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

/** A named value extracted from a playbook's captured XHR response. */
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
