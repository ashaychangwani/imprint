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
      error: 'AUTH_EXPIRED' | 'NETWORK' | 'RATE_LIMITED' | 'BAD_RESPONSE' | 'UNKNOWN';
      message: string;
      remediation?: string;
    };

// ─── Cron config (input to `imprint cron`) ───────────────────────────────────

/**
 * Per-example schedule + parameters, lives at examples/<site>/cron.json.
 * The schedule is a standard 5-field cron expression; node-cron validates it
 * before scheduling. Params are validated against the workflow's parameter
 * declarations at load time so a typo doesn't surface only on the first tick.
 */
export const CronConfigSchema = z.object({
  schedule: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CronConfig = z.infer<typeof CronConfigSchema>;
