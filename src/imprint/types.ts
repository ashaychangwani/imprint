/**
 * Core types for Imprint.
 *
 * Data flow:
 *
 *   record(url) ──▶ session.json ──▶ generate() ──▶ workflow.json ──▶ emit() ──▶ generated TS
 *                   {requests,                       {requests,                    runWorkflow()
 *                    events,                          parameters,
 *                    narration}                       intent}
 */

import { z } from 'zod';

// ─── Captured session (output of `imprint record`) ──────────────────────────

export const CapturedRequestSchema = z.object({
  /** Monotonically increasing sequence within a session */
  seq: z.number().int().nonnegative(),
  /** ms since recording started */
  timestamp: z.number(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  /** Body as string (parsed if JSON, raw otherwise). May be omitted for GETs. */
  body: z.string().optional(),
  resourceType: z.string(),
  /** Filled in when the response arrives */
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

export const CapturedEventSchema = z.object({
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

/** Cookie state snapshot at a point in time. */
export const CookieSnapshotSchema = z.object({
  takenAt: z.string(),
  /** ms since recording started */
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

export const NarrationSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  text: z.string(),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const SessionSchema = z.object({
  /** Site label, e.g. "southwest", "luma", "canteen" */
  site: z.string(),
  /** ISO 8601 */
  startedAt: z.string(),
  /** Starting URL */
  url: z.string(),
  /** Imprint version that captured this session */
  imprintVersion: z.string(),
  requests: z.array(CapturedRequestSchema),
  events: z.array(CapturedEventSchema),
  narration: z.array(NarrationSchema),
  /** Cookie state snapshots — typically one at start, one at end. */
  cookieSnapshots: z.array(CookieSnapshotSchema).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Workflow (output of `imprint generate`) ────────────────────────────────

export const WorkflowParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  /** If set, the parameter is optional with this default */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type WorkflowParameter = z.infer<typeof WorkflowParameterSchema>;

export const WorkflowRequestSchema = z.object({
  method: z.string(),
  /**
   * URL template. May contain:
   *   ${param.fieldName}             — substitutes a workflow parameter
   *   ${response[N].jsonPath.field}  — substitutes from an earlier response in the chain
   */
  url: z.string(),
  headers: z.record(z.string()),
  /** Body template, same substitution rules as url */
  body: z.string().optional(),
  /**
   * After a successful response, extract these jsonpath expressions for later
   * requests to substitute via ${response[N].name}.
   */
  extract: z.record(z.string()).optional(),
});
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export const WorkflowSchema = z.object({
  /** Tool name in the generated MCP server (snake_case) */
  toolName: z.string(),
  /** Human description of what the workflow does */
  intent: z.object({
    description: z.string(),
    /** What the user said while recording (concatenated narration) */
    userSaid: z.string().optional(),
  }),
  parameters: z.array(WorkflowParameterSchema),
  /** Ordered chain of requests, executed sequentially */
  requests: z.array(WorkflowRequestSchema),
  /** Site this workflow targets (matches Session.site) */
  site: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ─── Generated tool runtime contract ─────────────────────────────────────────

/**
 * Every generated MCP tool returns a discriminated union. Either the request
 * chain completed and we have a `data` payload, or something specific went
 * wrong and we surface a remediation the user (or the LLM) can act on.
 */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error:
        | 'AUTH_EXPIRED' // 401 — credentials expired or missing; user runs `imprint login`
        | 'FORBIDDEN' // 403 — blocked (bot detection, geo, ToS, capability mismatch); body has the clue
        | 'NETWORK' // fetch threw / timed out
        | 'RATE_LIMITED' // 429
        | 'BAD_RESPONSE' // other 4xx/5xx
        | 'UNKNOWN';
      message: string;
      remediation?: string;
    };

// ─── Cron config (input to `imprint cron`) ───────────────────────────────────

/**
 * Optional "push only when..." predicate. Without it, cron only pushes on
 * failure (the default). With it, cron evaluates the predicate against
 * every successful tool result and pushes when it matches — useful for
 * watchers like "notify when any fare drops below $99".
 *
 * Discriminated by `type`. New predicate kinds slot in here as new
 * variants and a matching case in src/imprint/notify-when.ts.
 */
export const NotifyWhenSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('price_below'),
    /** Push when min(extracted prices) is strictly less than this. */
    threshold: z.number(),
    /**
     * Dot-path with `[]` to mean "iterate every element of this array".
     * E.g. "bounds[].flights[].fares[].price.amount" extracts every
     * fare price in a Southwest-shaped search response.
     */
    pricePath: z.string(),
  }),
]);
export type NotifyWhen = z.infer<typeof NotifyWhenSchema>;

/**
 * Per-example schedule + parameters, lives at examples/<site>/cron.json.
 * The schedule is a standard 5-field cron expression; node-cron validates it
 * before scheduling. Params are validated against the workflow's parameter
 * declarations at load time so a typo doesn't surface only on the first tick.
 */
/**
 * Which replay backend the cron / MCP server should use, in increasing
 * order of cost + bot-detection robustness:
 *
 *   - `'fetch'` (default): captured API workflow via Node `fetch`. ~200ms
 *     per call. Fails on sites with serious bot detection (Akamai,
 *     Cloudflare, etc).
 *   - `'stealth-fetch'`: brief Playwright bootstrap mints sensor tokens
 *     (~12s, one-time per process), then native `fetch` augmented with
 *     those tokens (~1s per call). Defeats Akamai for direct-API sites.
 *   - `'playbook'`: full Playwright + stealth + DOM walk via the
 *     compiled playbook.md. ~9.4s per call. Universal — handles sites
 *     that need form-fills, autocompletes, multi-page navigation.
 *   - `'auto'`: walks the ladder fetch → stealth-fetch → playbook,
 *     escalating only on FORBIDDEN. The principle: never fail with
 *     "Imprint can't help" as long as some backend would have worked.
 *
 * The `auto` ladder skips rungs whose prerequisites aren't met (e.g.,
 * playbook is skipped when no playbook.md exists). Non-FORBIDDEN errors
 * (AUTH_EXPIRED, NETWORK, RATE_LIMITED, etc) don't escalate — those
 * indicate a real problem the next backend can't solve.
 */
export const ReplayBackendSchema = z.enum(['fetch', 'stealth-fetch', 'playbook', 'auto']);
export type ReplayBackend = z.infer<typeof ReplayBackendSchema>;

export const CronConfigSchema = z.object({
  schedule: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  notifyWhen: NotifyWhenSchema.optional(),
  replayBackend: ReplayBackendSchema.optional().default('fetch'),
});
export type CronConfig = z.infer<typeof CronConfigSchema>;
