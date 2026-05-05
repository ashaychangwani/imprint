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
    }),
  ),
});
export type CookieSnapshot = z.infer<typeof CookieSnapshotSchema>;

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
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Workflow (output of `imprint generate`) ────────────────────────────────

const WorkflowParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  /** Optional with this default if set. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type WorkflowParameter = z.infer<typeof WorkflowParameterSchema>;

const WorkflowRequestSchema = z.object({
  method: z.string(),
  /** Template; ${param.X} substitutes a parameter, ${response[N].path} an
   *  earlier extracted value. */
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().optional(),
  /** Names → jsonpath expressions; later requests reference via ${response[N].name}. */
  extract: z.record(z.string()).optional(),
});
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export const WorkflowSchema = z.object({
  toolName: z.string(),
  intent: z.object({
    description: z.string(),
    /** Concatenated narration the user spoke while recording. */
    userSaid: z.string().optional(),
  }),
  parameters: z.array(WorkflowParameterSchema),
  requests: z.array(WorkflowRequestSchema),
  site: z.string(),
  /** Path to a sibling parser module (relative to the workflow.json file)
   *  exporting `extract(rawResponse): unknown`. Applied by the runtime
   *  to transform the raw API response into structured agent output. */
  parserModule: z.string().optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ─── Generated tool runtime contract ─────────────────────────────────────────

/** Discriminated union returned by every generated tool. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error:
        | 'AUTH_EXPIRED' // 401 — run `imprint login`
        | 'FORBIDDEN' // 403 — bot detection, geo, ToS, capability mismatch
        | 'NETWORK' // fetch threw / timed out
        | 'RATE_LIMITED' // 429
        | 'BAD_RESPONSE' // other 4xx/5xx
        | 'UNKNOWN';
      message: string;
      remediation?: string;
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

/** fetch (cheap, breaks on Akamai) → stealth-fetch (mint tokens, ~1s) →
 *  playbook (full DOM walk, ~9s, universal). 'auto' walks the ladder,
 *  escalating only on FORBIDDEN. */
const ReplayBackendSchema = z.enum(['fetch', 'stealth-fetch', 'playbook', 'auto']);
export type ReplayBackend = z.infer<typeof ReplayBackendSchema>;

const ConcreteBackendSchema = ReplayBackendSchema.exclude(['auto']);
/** ReplayBackend without the 'auto' meta-value — what the ladder actually walks. */
export type ConcreteBackend = Exclude<ReplayBackend, 'auto'>;

/** Per-backend probe result. Written to examples/<site>/backends.json
 *  by `imprint probe-backends`; cron + MCP read it at startup so they
 *  start with the cheapest known-working backend. */
const BackendProbeResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    durationMs: z.number(),
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
  /** Ladder for runtime — preferredOrder[0] cheapest, rest fall back on
   *  FORBIDDEN. Excludes 'auto'. */
  preferredOrder: z.array(ConcreteBackendSchema).min(1),
  results: z.record(ConcreteBackendSchema, BackendProbeResultSchema),
});
export type BackendsCache = z.infer<typeof BackendsCacheSchema>;

export const CronConfigSchema = z.object({
  schedule: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  notifyWhen: NotifyWhenSchema.optional(),
  replayBackend: ReplayBackendSchema.optional().default('fetch'),
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

// Playbook params are structurally identical to workflow params — reuse
// the same schema directly to stay in sync.
export const PlaybookSchema = z.object({
  toolName: z.string(),
  summary: z.string(),
  parameters: z.array(WorkflowParameterSchema),
  steps: z.array(PlaybookStepSchema).min(1),
  result: PlaybookResultSchema,
  notes: z.string().optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
