import {
  basename,
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import type { ResolvedTool } from './tool-loader.ts';

interface SelectGeneratedToolOptions {
  site: string;
  tools: ResolvedTool[];
  purpose: 'cron' | 'probe';
  toolName?: string;
  pathHint?: string;
  pathHintLabel?: string;
}

export function selectGeneratedTool(opts: SelectGeneratedToolOptions): ResolvedTool | null {
  const { site, tools, purpose, toolName, pathHint, pathHintLabel } = opts;
  if (tools.length === 0) return null;

  const byName = toolName ? findToolByName(tools, toolName) : null;
  if (toolName && !byName) {
    throw new Error(
      [
        `No generated tool named "${toolName}" for site "${site}".`,
        `Available tools: ${tools.map(displayToolName).join(', ')}`,
      ].join('\n'),
    );
  }

  const byPath = pathHint ? findToolByPath(tools, pathHint) : null;
  if (byName && byPath && byName.dir !== byPath.dir) {
    throw new Error(
      `${pathHintLabel ?? 'path'} belongs to "${displayToolName(byPath)}", but --tool selected "${displayToolName(byName)}".`,
    );
  }
  if (byName) return byName;
  if (byPath) return byPath;
  if (tools.length === 1) return tools[0] ?? null;

  throw new Error(
    [
      `Site "${site}" has ${tools.length} generated tools; choose one for ${purpose}.`,
      `Available tools:\n${tools.map((tool) => `  --tool ${displayToolName(tool)}    (${tool.dir})`).join('\n')}`,
    ].join('\n'),
  );
}

function findToolByName(tools: ResolvedTool[], name: string): ResolvedTool | null {
  return (
    tools.find((tool) => tool.workflow.toolName === name || basename(tool.dir) === name) ?? null
  );
}

function findToolByPath(tools: ResolvedTool[], pathHint: string): ResolvedTool | null {
  const absolutePath = pathResolve(pathHint);
  for (const tool of tools) {
    const dir = pathResolve(tool.dir);
    const relative = pathRelative(dir, absolutePath);
    if (relative === '' || (!relative.startsWith('..') && !pathIsAbsolute(relative))) {
      return tool;
    }
  }
  return null;
}

function displayToolName(tool: ResolvedTool): string {
  return tool.workflow.toolName || basename(tool.dir);
}
