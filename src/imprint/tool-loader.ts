/** Discover + load generated tools from <assetRoot>/<site>/<toolName>/index.ts. Used
 *  by mcp-server, cron, and probe-backends. */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { type ToolResult, type Workflow, type WorkflowParameter, WorkflowSchema } from './types.ts';

type GeneratedToolFn = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ToolResult>;

interface GeneratedModule {
  WORKFLOW: Workflow;
  [exportName: string]: unknown;
}

export interface ResolvedTool {
  /** Directory name under the asset root, e.g. "discoverandgo". */
  site: string;
  /** Absolute path to the directory containing workflow.json, playbook.yaml, etc. */
  dir: string;
  workflow: Workflow;
  toolFn: GeneratedToolFn;
}

/** Scan the generated asset root, dynamically import each nested tool index.ts. Per-entry
 *  errors go to stderr and the entry is skipped — discovery never throws. */
export async function discoverTools(
  assetRoot: string,
  only?: string,
  logPrefix = '[imprint]',
): Promise<ResolvedTool[]> {
  if (!existsSync(assetRoot)) return [];
  // Self-heal the node_modules/imprint symlink so generated tools' import
  // of `imprint/runtime` resolves even when the original codegen-time
  // repo path has moved or vanished (e.g. ephemeral Conductor workspace).
  ensureImprintRuntimeLink(assetRoot);
  const entries = readdirSync(assetRoot);
  const out: ResolvedTool[] = [];
  for (const entry of entries) {
    if (only && entry !== only) continue;
    const dir = pathResolve(assetRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    // Tool layout: <assetRoot>/<site>/<toolName>/index.ts
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
  if (hasStaleRuntimeImport(modulePath)) {
    await tryRepairGeneratedModule(modulePath, logPrefix);
  }
  try {
    mod = (await import(modulePath)) as GeneratedModule;
  } catch (err) {
    if (
      canRepairStaleRuntimeImport(err) &&
      (await tryRepairGeneratedModule(modulePath, logPrefix))
    ) {
      try {
        mod = await importRepairedGeneratedModule(modulePath);
      } catch (repairErr) {
        process.stderr.write(
          `${logPrefix} skipping ${modulePath}: failed to load after repair (${repairErr instanceof Error ? repairErr.message : String(repairErr)})\n`,
        );
        return null;
      }
    } else {
      process.stderr.write(
        `${logPrefix} skipping ${modulePath}: failed to load (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return null;
    }
  }
  if (!mod.WORKFLOW) {
    process.stderr.write(`${logPrefix} skipping ${modulePath}: missing WORKFLOW export\n`);
    return null;
  }
  const workflowStatus = embeddedWorkflowStatus(modulePath, mod.WORKFLOW);
  if (workflowStatus === 'stale') {
    if (await tryRepairGeneratedModule(modulePath, logPrefix, 'stale embedded WORKFLOW')) {
      try {
        mod = await importRepairedGeneratedModule(modulePath);
      } catch (repairErr) {
        process.stderr.write(
          `${logPrefix} skipping ${modulePath}: failed to load after workflow repair (${repairErr instanceof Error ? repairErr.message : String(repairErr)})\n`,
        );
        return null;
      }
      if (!mod.WORKFLOW) {
        process.stderr.write(`${logPrefix} skipping ${modulePath}: missing WORKFLOW export\n`);
        return null;
      }
    } else {
      return null;
    }
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

function hasStaleRuntimeImport(modulePath: string): boolean {
  try {
    const source = readFileSync(modulePath, 'utf8');
    return /from\s+['"][^'"]*\/src\/imprint\/runtime\.ts['"]/.test(source);
  } catch {
    return false;
  }
}

function canRepairStaleRuntimeImport(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Cannot find module') && message.includes('/src/imprint/runtime.ts');
}

async function tryRepairGeneratedModule(
  modulePath: string,
  logPrefix: string,
  reason = 'stale generated wrapper',
): Promise<boolean> {
  const toolDir = dirname(modulePath);
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  try {
    const { emit } = await import('./emit.ts');
    emit({ workflowPath, outDir: toolDir, force: true });
    process.stderr.write(`${logPrefix} repaired ${reason} at ${modulePath}\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `${logPrefix} could not repair stale generated wrapper at ${modulePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

let repairedImportSeq = 0;

async function importRepairedGeneratedModule(modulePath: string): Promise<GeneratedModule> {
  const toolDir = dirname(modulePath);
  const tempPath = pathJoin(
    toolDir,
    `.index.imprint-repaired-${process.pid}-${Date.now()}-${repairedImportSeq++}.ts`,
  );
  writeFileSync(tempPath, readFileSync(modulePath, 'utf8'), 'utf8');
  try {
    return (await import(pathToFileURL(tempPath).href)) as GeneratedModule;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; stale temp wrappers are harmless and hidden.
    }
  }
}

function embeddedWorkflowStatus(modulePath: string, embedded: Workflow): 'current' | 'stale' {
  const workflowPath = pathJoin(dirname(modulePath), 'workflow.json');
  if (!existsSync(workflowPath)) return 'current';
  try {
    const disk = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
    const wrapped = WorkflowSchema.parse(embedded);
    return stableStringify(disk) === stableStringify(wrapped) ? 'current' : 'stale';
  } catch {
    return 'current';
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
    if (p.choices?.length) {
      field = field.refine((value) => p.choices?.includes(value), {
        message: `Expected one of: ${p.choices.join(', ')}`,
      });
    }
    field = field.describe(p.description);
    if (p.default !== undefined) field = field.optional();
    shape[p.name] = field;
  }
  return z.object(shape);
}
