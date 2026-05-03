/**
 * Shared tool-discovery for the MCP server (`mcp-server`) and the cron
 * daemon (`cron`). Both consume the generated `examples/<site>/index.ts`
 * modules — same WORKFLOW export, same camelCase function. Keeping the
 * scan in one place avoids drift if we add new validation or sandboxing
 * later.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { z } from 'zod';
import type { ToolResult, Workflow, WorkflowParameter } from './types.ts';

export type GeneratedToolFn = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ToolResult>;

export interface GeneratedModule {
  WORKFLOW: Workflow;
  [exportName: string]: unknown;
}

export interface ResolvedTool {
  /** Directory name under examples/, e.g. "discoverandgo". */
  site: string;
  workflow: Workflow;
  toolFn: GeneratedToolFn;
}

/**
 * Discover every example directory containing a generated index.ts.
 * Each match is dynamically imported to extract its WORKFLOW + tool function.
 *
 * Errors during load (missing WORKFLOW, missing function, throwing import)
 * are written to stderr and the entry is skipped — discovery never throws.
 */
export async function discoverTools(
  examplesDir: string,
  only?: string,
  logPrefix = '[imprint]',
): Promise<ResolvedTool[]> {
  if (!existsSync(examplesDir)) return [];
  const entries = readdirSync(examplesDir);
  const out: ResolvedTool[] = [];
  for (const entry of entries) {
    if (only && entry !== only) continue;
    const dir = pathResolve(examplesDir, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const modulePath = pathResolve(dir, 'index.ts');
    if (!existsSync(modulePath)) continue;

    let mod: GeneratedModule;
    try {
      mod = (await import(modulePath)) as GeneratedModule;
    } catch (err) {
      process.stderr.write(
        `${logPrefix} skipping ${entry}: failed to load (${err instanceof Error ? err.message : String(err)})\n`,
      );
      continue;
    }
    if (!mod.WORKFLOW) {
      process.stderr.write(`${logPrefix} skipping ${entry}: missing WORKFLOW export\n`);
      continue;
    }
    const fn = findToolFunction(mod);
    if (!fn) {
      process.stderr.write(
        `${logPrefix} skipping ${entry}: missing exported function for "${mod.WORKFLOW.toolName}"\n`,
      );
      continue;
    }
    out.push({ site: entry, workflow: mod.WORKFLOW, toolFn: fn });
  }
  return out;
}

/**
 * Tool functions are exported under the camelCase form of `toolName`.
 * `book_discoverandgo_museum_pass` → `bookDiscoverandgoMuseumPass`.
 */
export function findToolFunction(mod: GeneratedModule): GeneratedToolFn | null {
  const camelName = toCamelCase(mod.WORKFLOW.toolName);
  const fn = mod[camelName];
  return typeof fn === 'function' ? (fn as GeneratedToolFn) : null;
}

export function toCamelCase(snake: string): string {
  return snake
    .split('_')
    .map((p, i) =>
      i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Build a Zod validator from a workflow's parameter declarations. Used by
 * both the MCP server (validate args coming from the LLM) and the cron
 * daemon (validate params coming from cron.json) so the contract is
 * enforced identically in both places.
 */
export function buildZodValidator(parameters: WorkflowParameter[]): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const p of parameters) {
    let field: z.ZodType;
    switch (p.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
    }
    field = field.describe(p.description);
    if (p.default !== undefined) field = field.optional();
    shape[p.name] = field;
  }
  return z.object(shape);
}
