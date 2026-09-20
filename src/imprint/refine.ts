/** Targeted, staged refinement of installed tools. Originals change only after verification. */
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { newestRecording } from './cdp-jar-cache.ts';
import { runOwnedCli } from './compiler-process.ts';
import type { ProviderName } from './llm.ts';
import { imprintHomeDir, localSiteDir, localToolDir } from './paths.ts';
import { SessionSchema, type Workflow, WorkflowSchema } from './types.ts';

export interface RefineOptions {
  site: string;
  tool: string;
  issue: string;
  fromSession?: string;
  provider: ProviderName;
  model?: string;
  timeoutMs?: number;
  json?: boolean;
}
export function assertRefinementContract(before: Workflow, after: Workflow): void {
  if (before.site !== after.site || before.toolName !== after.toolName)
    throw new Error('Refinement changed the installed tool identity');
  for (const prior of before.parameters) {
    const next = after.parameters.find(({ name }) => name === prior.name);
    if (
      !next ||
      next.type !== prior.type ||
      (prior.default !== undefined && next.default === undefined)
    )
      throw new Error(`Refinement broke existing parameter ${prior.name}`);
    if (
      prior.choices &&
      next.choices &&
      prior.choices.some((value) => !next.choices?.includes(value))
    )
      throw new Error(`Refinement removed supported values from ${prior.name}`);
  }
  for (const next of after.parameters) {
    if (!before.parameters.some(({ name }) => name === next.name) && next.default === undefined)
      throw new Error(`New parameter ${next.name} must be optional for existing callers`);
  }
}
export function refinementArtifactHash(directory: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, prefix = ''): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'backends.json'
      )
        continue;
      const path = join(dir, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(path, `${name}/`);
      else if (entry.isFile()) hash.update(name).update(readFileSync(path));
    }
  };
  visit(directory);
  return hash.digest('hex');
}
export function promoteRefinement(input: {
  siteDir: string;
  stagedSiteDir: string;
  runRoot: string;
  runId: string;
  tools: string[];
  originalHashes: Record<string, string>;
}): void {
  for (const tool of input.tools) {
    if (refinementArtifactHash(join(input.siteDir, tool)) !== input.originalHashes[tool])
      throw new Error(
        `Installed tool ${tool} changed during refinement; staging retained without promotion`,
      );
  }
  const moved: { destination: string; backup: string; tool: string }[] = [];
  try {
    for (const tool of input.tools) {
      const destination = join(input.siteDir, tool);
      const backup = join(input.siteDir, `.refine-backup-${input.runId}-${tool}`);
      renameSync(destination, backup);
      moved.push({ destination, backup, tool });
      cpSync(join(input.stagedSiteDir, tool), destination, { recursive: true, dereference: false });
    }
  } catch (error) {
    const failed = join(input.runRoot, 'failed-promotion');
    mkdirSync(failed, { recursive: true });
    for (const { destination, backup, tool } of moved.reverse()) {
      if (existsSync(destination)) renameSync(destination, join(failed, tool));
      renameSync(backup, destination);
    }
    throw error;
  }
}
export async function runRefine(
  opts: RefineOptions,
): Promise<{ status: 'completed' | 'failed'; runRoot: string; reason?: string }> {
  const siteDir = localSiteDir(opts.site);
  const target = localToolDir(opts.site, opts.tool);
  if (!opts.issue.trim()) throw new Error('--issue must describe a repair or extension');
  if (!existsSync(join(target, 'workflow.json')))
    throw new Error(`Installed tool ${opts.tool} is unavailable`);
  const recordingPath = opts.fromSession
    ? resolve(opts.fromSession)
    : newestRecording(siteDir)?.path;
  if (!recordingPath) throw new Error('No retained recording found; provide --from-session <path>');
  const recording = SessionSchema.parse(JSON.parse(readFileSync(recordingPath, 'utf8')));
  if (recording.site !== opts.site) throw new Error('Refinement recording belongs to another site');
  const runId = randomUUID();
  const runRoot = join(imprintHomeDir(), '.refine-runs', runId);
  const stagedHome = join(runRoot, 'home');
  const stagedSiteDir = join(stagedHome, opts.site);
  mkdirSync(stagedSiteDir, { recursive: true, mode: 0o700 });
  const originalHashes: Record<string, string> = {};
  for (const entry of readdirSync(siteDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      !existsSync(join(siteDir, entry.name, 'workflow.json'))
    )
      continue;
    originalHashes[entry.name] = refinementArtifactHash(join(siteDir, entry.name));
    cpSync(join(siteDir, entry.name), join(stagedSiteDir, entry.name), {
      recursive: true,
      dereference: false,
    });
  }
  const configPath = join(runRoot, 'input.json');
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  writeFileSync(
    configPath,
    JSON.stringify(
      { ...opts, recordingPath, runRoot, stagedHome, deadlineMs: Date.now() + timeoutMs },
      null,
      2,
    ),
  );
  let child: Awaited<ReturnType<typeof runOwnedCli>>;
  try {
    child = await runOwnedCli({
      command: process.execPath,
      args: ['run', join(import.meta.dir, 'refine-worker.ts'), configPath],
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, IMPRINT_HOME: stagedHome },
      signal: AbortSignal.timeout(timeoutMs),
      onStderrChunk: (chunk) => process.stderr.write(chunk),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeFileSync(
      join(runRoot, 'interrupted.json'),
      JSON.stringify({ reason, at: new Date().toISOString() }),
    );
    return { status: 'failed', runRoot, reason };
  }
  writeFileSync(join(runRoot, 'worker.stdout.log'), child.stdout);
  writeFileSync(join(runRoot, 'worker.stderr.log'), child.stderr);
  const reportPath = join(runRoot, 'result.json');
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, 'utf8')) as {
        status: string;
        tools: string[];
        reason?: string;
      })
    : { status: 'failed', tools: [], reason: 'Refinement worker ended without verification' };
  if (child.exitCode !== 0 || report.status !== 'completed')
    return {
      status: 'failed',
      runRoot,
      reason: report.reason ?? 'Verification did not pass; installed tools preserved',
    };
  if (
    !report.tools.length ||
    !report.tools.includes(opts.tool) ||
    report.tools.some((tool) => !Object.hasOwn(originalHashes, tool))
  )
    throw new Error('Refinement returned an invalid replacement set');
  for (const [tool, originalHash] of Object.entries(originalHashes)) {
    if (
      !report.tools.includes(tool) &&
      refinementArtifactHash(join(stagedSiteDir, tool)) !== originalHash
    )
      throw new Error(`Unplanned tool ${tool} changed in staging; originals preserved`);
  }
  for (const tool of report.tools)
    assertRefinementContract(
      WorkflowSchema.parse(JSON.parse(readFileSync(join(siteDir, tool, 'workflow.json'), 'utf8'))),
      WorkflowSchema.parse(
        JSON.parse(readFileSync(join(stagedSiteDir, tool, 'workflow.json'), 'utf8')),
      ),
    );
  promoteRefinement({
    siteDir,
    stagedSiteDir,
    runRoot,
    runId,
    tools: report.tools,
    originalHashes,
  });
  writeFileSync(
    join(runRoot, 'promotion.json'),
    JSON.stringify({ tools: report.tools, completedAt: new Date().toISOString() }),
  );
  return { status: 'completed', runRoot };
}
