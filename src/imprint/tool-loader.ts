/** Discover + load generated tools from examples/<site>/index.ts. Used
 *  by mcp-server, cron, and probe-backends. */

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

/** Scan examples/, dynamically import each index.ts. Per-entry errors
 *  go to stderr and the entry is skipped — discovery never throws. */
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

/** Tool fn export is the camelCase of toolName: book_x_y → bookXY. */
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

/** Zod validator from workflow parameters — enforces the same contract
 *  for MCP args (from the LLM) and cron.json params. */
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
