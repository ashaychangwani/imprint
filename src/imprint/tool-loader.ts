/** Discover + load generated tools from examples/<site>/<toolName>/index.ts. Used
 *  by mcp-server, cron, and probe-backends. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { z } from 'zod';
import type { ToolResult, Workflow, WorkflowParameter } from './types.ts';

type GeneratedToolFn = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ToolResult>;

interface GeneratedModule {
  WORKFLOW: Workflow;
  [exportName: string]: unknown;
}

export interface ResolvedTool {
  /** Directory name under examples/, e.g. "discoverandgo". */
  site: string;
  /** Absolute path to the directory containing workflow.json, playbook.yaml, etc. */
  dir: string;
  workflow: Workflow;
  toolFn: GeneratedToolFn;
}

/** Scan examples/, dynamically import each nested tool index.ts. Per-entry
 *  errors go to stderr and the entry is skipped — discovery never throws. */
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

    // Tool layout: examples/<site>/<toolName>/index.ts
    for (const sub of readdirSync(dir)) {
      const subDir = pathResolve(dir, sub);
      try {
        if (!statSync(subDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const subModule = pathResolve(subDir, 'index.ts');
      if (!existsSync(subModule)) continue;
      const tool = await tryLoadTool(subModule, entry, logPrefix);
      if (tool) out.push(tool);
    }
  }
  return out;
}

async function tryLoadTool(
  modulePath: string,
  site: string,
  logPrefix: string,
): Promise<ResolvedTool | null> {
  let mod: GeneratedModule;
  try {
    mod = (await import(modulePath)) as GeneratedModule;
  } catch (err) {
    process.stderr.write(
      `${logPrefix} skipping ${modulePath}: failed to load (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return null;
  }
  if (!mod.WORKFLOW) {
    process.stderr.write(`${logPrefix} skipping ${modulePath}: missing WORKFLOW export\n`);
    return null;
  }
  const fn = findToolFunction(mod);
  if (!fn) {
    process.stderr.write(
      `${logPrefix} skipping ${modulePath}: missing exported function for "${mod.WORKFLOW.toolName}"\n`,
    );
    return null;
  }
  return { site, dir: dirname(modulePath), workflow: mod.WORKFLOW, toolFn: fn };
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
