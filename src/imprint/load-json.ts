/**
 * Load + JSON-parse + schema-validate a config file. Errors at each step
 * include a specific remediation hint so the user knows what to fix.
 *
 * Used by: cron.ts (cron.json), emit.ts (workflow.json), cli.ts redact +
 * compile.ts (session.json). Before this helper each verb hand-rolled
 * the same three-branch error format.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ZodTypeAny, z } from 'zod';

interface LoadJsonRemediation {
  /** What to suggest when the file doesn't exist. Should be one or more lines, each starting with "→". */
  notFound: string;
  /** Suggestion when JSON.parse throws. Optional. Same format. */
  notJson?: string;
  /** Suggestion when schema validation fails. Optional. Same format. */
  badSchema?: string;
}

/** Read JSON from disk, validate against `schema`. Throws Error with
 *  a multi-line message on any failure. Returns the schema's *output*
 *  type (post-defaults), not the input type. */
export function loadJsonFile<S extends ZodTypeAny>(
  path: string,
  schema: S,
  remediation: LoadJsonRemediation,
  noun = 'file',
): z.infer<S> {
  if (!existsSync(path)) {
    throw new Error(`${noun} not found: ${path}\n${remediation.notFound}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`${noun} is not a file: ${path}\n${remediation.notFound}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tail = remediation.notJson ? `\n${remediation.notJson}` : '';
    throw new Error(`${path} is not valid JSON: ${msg}${tail}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `  - ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n');
    const tail = remediation.badSchema ? `\n${remediation.badSchema}` : '';
    throw new Error(`${path} doesn't match the ${noun} schema:\n${issues}${tail}`);
  }
  return parsed.data;
}
