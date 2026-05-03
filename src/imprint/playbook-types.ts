/**
 * Playbook = the DOM-script artifact produced from a recorded session.
 *
 * Where workflow.json describes the API path (replayed via `fetch`),
 * playbook.yaml describes the DOM path (replayed via Playwright). The
 * same recording compiles to both: when the API replay gets blocked
 * (Akamai, Cloudflare, etc.), the playbook is the deterministic
 * fallback that runs in a real browser.
 *
 * This file is the canonical schema. The on-disk format is markdown
 * (human + LLM-agent friendly); src/imprint/playbook-parser.ts handles
 * the markdown ↔ Playbook conversion.
 */

import { z } from 'zod';

/**
 * Locator strategies, listed in the order the runner tries them.
 *
 * Priority intent (encoded by ordering in PlaybookStep.locators):
 *   role+name → aria_label → text → id → css
 *
 * Why text/aria first: those are accessibility-stable across CSS-Modules
 * deploys (where class names are content-hashed and change every release).
 * `css` is the last resort because it breaks first.
 */
export const LocatorSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('role'),
    /** Implicit/explicit ARIA role: button, link, textbox, listbox, option, etc. */
    value: z.string(),
    /** Optional accessible name (the rendered text or aria-label). */
    name: z.string().optional(),
  }),
  z.object({
    by: z.literal('aria_label'),
    /** Exact aria-label match. */
    value: z.string().optional(),
    /** Substring/regex pattern (supports parameter substitution via ${param.X}). */
    value_pattern: z.string().optional(),
  }),
  z.object({
    by: z.literal('text'),
    value: z.string().optional(),
    value_pattern: z.string().optional(),
  }),
  z.object({
    by: z.literal('id'),
    value: z.string(),
  }),
  z.object({
    by: z.literal('css'),
    value: z.string(),
  }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

/** What to wait for after a step completes before advancing. */
export const WaitForSchema = z.union([
  z.literal('networkidle'),
  z.literal('load'),
  z.literal('visible'),
  z.literal('hidden'),
  z.object({
    /** Wait for an XHR matching this URL substring or regex source. */
    xhr: z.string(),
    /** Optional HTTP method filter. */
    method: z.string().optional(),
    /** Optional timeout in ms. */
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({
    /** Sleep this many ms unconditionally. Use sparingly — prefer networkidle/visible. */
    sleep_ms: z.number().int().positive(),
  }),
]);
export type WaitFor = z.infer<typeof WaitForSchema>;

/** A single step in the playbook. */
export const PlaybookStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('navigate'),
    /** Supports ${param.X} substitution. */
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
    /** Supports ${param.X} substitution. */
    value: z.string(),
    /** If true, clear the field before typing. Default true. */
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
    /** Key to press (Playwright key string: Escape, Enter, Tab, ArrowDown, etc.). */
    key: z.string(),
    /** If specified, focus this locator before pressing. Otherwise dispatched on the page. */
    locators: z.array(LocatorSchema).optional(),
    wait_for: WaitForSchema.optional(),
  }),
  z.object({
    action: z.literal('wait'),
    wait_for: WaitForSchema,
  }),
]);
export type PlaybookStep = z.infer<typeof PlaybookStepSchema>;

/**
 * How to extract the playbook's return value at the end of the run.
 *
 * Two sources:
 *   - `xhr`: capture an XHR/fetch response by URL pattern, parse the body
 *     as JSON, extract values via the dot-path syntax (same walker as
 *     notify-when's pricePath: dots + [] for "iterate").
 *   - `dom`: extract from the rendered page via a locator (text content
 *     or attribute value). Use when the data only exists in the DOM
 *     (e.g., a server-rendered table without an XHR backing it).
 */
export const PlaybookResultSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('xhr'),
    /** Substring or regex pattern matching the response URL. First match wins. */
    url_pattern: z.string(),
    /** Optional method filter. */
    method: z.string().optional(),
    /** Dot-path with [] for array iteration (see notify-when.ts). */
    extract: z.string(),
    /** Field name in result.data. Defaults to "result". */
    return_as: z.string().default('result'),
  }),
  z.object({
    source: z.literal('dom'),
    locators: z.array(LocatorSchema).min(1),
    /** "text" (innerText) or attribute name (e.g., "value", "href"). */
    extract: z.string(),
    return_as: z.string().default('result'),
  }),
]);
export type PlaybookResult = z.infer<typeof PlaybookResultSchema>;

export const PlaybookParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type PlaybookParameter = z.infer<typeof PlaybookParameterSchema>;

export const PlaybookSchema = z.object({
  /** Tool name in snake_case (matches workflow.json's toolName when both exist). */
  toolName: z.string(),
  /** One-line human description. */
  summary: z.string(),
  parameters: z.array(PlaybookParameterSchema),
  steps: z.array(PlaybookStepSchema).min(1),
  result: PlaybookResultSchema,
  /** Free-form caveats for downstream agents (e.g., "must run --headed"). */
  notes: z.string().optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
