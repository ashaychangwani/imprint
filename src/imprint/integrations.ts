/**
 * `imprint teach` integration module — generate platform-specific paste
 * snippets and inline SKILL.md content for registering Imprint MCP tools
 * with Claude Code, Codex, Claude Desktop, OpenClaw, and Hermes.
 */

import { execSync } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { CronConfig, Playbook, Workflow, WorkflowParameter } from './types.ts';

export type Platform = 'claude-code' | 'codex' | 'claude-desktop' | 'openclaw' | 'hermes';

export const PLATFORMS: readonly Platform[] = [
  'claude-code',
  'codex',
  'claude-desktop',
  'openclaw',
  'hermes',
] as const;

interface ImprintCommand {
  command: string;
  args: string[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Detects whether `imprint` is available on PATH; falls back to
 * `bun run <abs-path>` if not. Used by teach.ts to generate paste snippets.
 */
export function detectImprintCommand(): ImprintCommand {
  try {
    execSync('which imprint', { stdio: 'ignore' });
    return { command: 'imprint', args: [] };
  } catch {
    return detectDirectBunImprintCommand();
  }
}

export function detectDirectBunImprintCommand(): ImprintCommand {
  const cliPath = pathResolve(import.meta.dir, '..', 'cli.ts');
  return { command: process.execPath || 'bun', args: ['run', cliPath] };
}

/**
 * Generate the paste snippet for a given platform — the quick-install
 * instructions users can paste into their shell to register the MCP server.
 */
export function generatePasteSnippet(opts: {
  site: string;
  workflow: Workflow;
  workflows?: Workflow[];
  platform: Platform;
  imprintCommand: ImprintCommand;
  env?: Record<string, string>;
}): string {
  const { site, workflow, workflows, platform, imprintCommand: ic, env } = opts;
  const toolName = `imprint-${site}`;
  const workflowList = workflows && workflows.length > 0 ? workflows : [workflow];
  const descLower =
    workflowList.length === 1
      ? workflow.intent.description.toLowerCase()
      : `${workflowList.length} tools: ${workflowList.map((w) => w.toolName).join(', ')}`;
  const paramList =
    workflowList.length === 1
      ? formatParams(workflow.parameters)
      : workflowList.map((w) => `${w.toolName}: ${formatParams(w.parameters)}`).join('; ');
  const mcpArgs = [...ic.args, 'mcp-server', site];
  const argsStr = `[${mcpArgs.map((a) => `"${a}"`).join(', ')}]`;
  const envStr = env ? `, "env": ${JSON.stringify(env)}` : '';
  const registrationCommand = buildRegistrationCommand({
    site,
    platform,
    imprintCommand: ic,
    env,
  });
  const shellCmd = registrationCommand
    ? registrationCommand.map(shellQuote).join(' ')
    : [ic.command, ...mcpArgs].map(shellQuote).join(' ');

  switch (platform) {
    case 'claude-code':
      return `Add the ${toolName} tool: run \`${shellCmd}\` to register ${descLower}. Parameters: ${paramList}. The backend ladder handles browser/API state and bot detection automatically (fetch → gated fetch-bootstrap → cdp-replay → stealth-fetch → playbook).`;

    case 'codex':
      return `Add the ${toolName} tool: run \`${shellCmd}\` to register ${descLower}. Parameters: ${paramList}.`;

    case 'claude-desktop':
      return `Add to ~/Library/Application Support/Claude/claude_desktop_config.json under "mcpServers":

  "${toolName}": { "command": "${ic.command}", "args": ${argsStr}${envStr} }`;

    case 'openclaw':
      return `Add the ${toolName} tool: add to ~/.openclaw/openclaw.json under mcp.servers:

  "${toolName}": { "command": "${ic.command}", "args": ${argsStr}${envStr} }

This gives your agent a tool that ${descLower}. Parameters: ${paramList}.`;

    case 'hermes':
      return `Add the ${toolName} tool: add to $HERMES_HOME/config.yaml (or ~/.hermes/config.yaml outside Hermes) under mcp_servers:

  ${toolName}:
    command: "${ic.command}"
    args: ${argsStr}
${env ? `    env: ${JSON.stringify(env)}` : ''}

This gives your agent a tool that ${descLower}. Parameters: ${paramList}.`;

    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

/**
 * Format a list of workflow parameters as a human-readable string for
 * inline documentation — "param1 (type, default: X), param2 (type, required)".
 */
function formatParams(params: WorkflowParameter[]): string {
  if (params.length === 0) return 'none';
  return params
    .map((p) => {
      const defaultOrRequired =
        p.default !== undefined ? `default: ${JSON.stringify(p.default)}` : 'required';
      return `${p.name} (${p.type}, ${defaultOrRequired})`;
    })
    .join(', ');
}

/**
 * Build the platform-specific command that registers the MCP server.
 * Returns null for platforms that require manual config editing (claude-desktop).
 */
export function buildRegistrationCommand(opts: {
  site: string;
  platform: Platform;
  imprintCommand: ImprintCommand;
  env?: Record<string, string>;
}): string[] | null {
  const { site, platform, imprintCommand: ic, env } = opts;
  const toolName = `imprint-${site}`;
  const imprintArgs = [ic.command, ...ic.args, 'mcp-server', site];
  const envPairs = Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);

  switch (platform) {
    case 'claude-code':
      return [
        'claude',
        'mcp',
        'add',
        '--scope',
        'user',
        ...envPairs.flatMap((pair) => ['-e', pair]),
        toolName,
        '--',
        ...imprintArgs,
      ];
    case 'codex':
      return [
        'codex',
        'mcp',
        'add',
        ...envPairs.flatMap((pair) => ['--env', pair]),
        toolName,
        '--',
        ...imprintArgs,
      ];
    case 'claude-desktop':
      return null;
    case 'openclaw':
      return null;
    case 'hermes':
      return null;
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

export function buildUnregistrationCommand(opts: { site: string; platform: Platform }):
  | string[]
  | null {
  const toolName = `imprint-${opts.site}`;

  switch (opts.platform) {
    case 'claude-code':
      return ['claude', 'mcp', 'remove', '--scope', 'user', toolName];
    case 'codex':
      return ['codex', 'mcp', 'remove', toolName];
    case 'claude-desktop':
      return null;
    case 'openclaw':
      return null;
    case 'hermes':
      return null;
    default: {
      const _exhaustive: never = opts.platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

export function buildMcpServerConfig(opts: {
  site: string;
  imprintCommand: ImprintCommand;
  env?: Record<string, string>;
}): McpServerConfig {
  const { site, imprintCommand, env } = opts;
  return {
    name: `imprint-${site}`,
    command: imprintCommand.command,
    args: [...imprintCommand.args, 'mcp-server', site],
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Generate inline SKILL.md for OpenClaw or Hermes — a single markdown file
 * with frontmatter, workflow JSON, playbook YAML (if present), parameter
 * table, and platform-specific config snippet.
 */
export function generateSkillMd(opts: {
  site: string;
  workflow: Workflow;
  workflows?: Workflow[];
  playbook?: Playbook;
  playbooks?: Playbook[];
  cronConfig?: CronConfig;
  platform: 'openclaw' | 'hermes';
}): string {
  const { site, workflow, workflows, playbook, playbooks, cronConfig, platform } = opts;
  const workflowList = workflows && workflows.length > 0 ? workflows : [workflow];
  const playbookList = playbooks && playbooks.length > 0 ? playbooks : playbook ? [playbook] : [];
  const primaryWorkflow = workflowList[0] ?? workflow;
  const toolName = `imprint-${site}`;
  const description =
    workflowList.length === 1
      ? primaryWorkflow.intent.description
      : `${workflowList.length} Imprint tools for ${site}: ${workflowList.map((w) => w.toolName).join(', ')}`;

  const frontmatter = `---
name: ${toolName}
description: ${description}
version: 1.0.0
metadata:
  ${platform}:
    tags: [automation, imprint]
    category: workflow
---`;

  const contextBlock =
    workflowList.length === 1 && primaryWorkflow.intent.userSaid !== undefined
      ? `\nRecording context: ${primaryWorkflow.intent.userSaid}\n`
      : '';

  // Generate platform-specific config snippet.
  const imprintCommand = detectImprintCommand();
  const configSnippet = generatePasteSnippet({
    site,
    workflow: primaryWorkflow,
    workflows: workflowList,
    platform,
    imprintCommand,
  });

  // Workflow JSON block.
  const workflowBlock =
    workflowList.length === 1
      ? `## Workflow (API replay)

\`\`\`json
${JSON.stringify(primaryWorkflow, null, 2)}
\`\`\``
      : `## Workflows (API replay)

${workflowList
  .map(
    (w) => `### ${w.toolName}

\`\`\`json
${JSON.stringify(w, null, 2)}
\`\`\``,
  )
  .join('\n\n')}`;

  // Playbook YAML block (optional).
  let playbookBlock = '';
  if (playbookList.length === 1 && playbookList[0] !== undefined) {
    const playbookYaml = yamlStringify(playbookList[0], { lineWidth: 0 });
    playbookBlock = `\n## Playbook (DOM replay fallback)

\`\`\`yaml
${playbookYaml.trim()}
\`\`\``;
  } else if (playbookList.length > 1) {
    playbookBlock = `\n## Playbooks (DOM replay fallbacks)

${playbookList
  .map(
    (p) => `### ${p.toolName}

\`\`\`yaml
${yamlStringify(p, { lineWidth: 0 }).trim()}
\`\`\``,
  )
  .join('\n\n')}`;
  }

  // Parameter table.
  let paramTableBlock = '## Parameters\n\n';
  if (workflowList.length === 1 && primaryWorkflow.parameters.length === 0) {
    paramTableBlock += 'None.\n';
  } else if (workflowList.length === 1) {
    paramTableBlock += '| Name | Type | Default | Description |\n';
    paramTableBlock += '|------|------|---------|-------------|\n';
    for (const p of primaryWorkflow.parameters) {
      const defaultVal = p.default !== undefined ? JSON.stringify(p.default) : 'required';
      paramTableBlock += `| ${p.name} | ${p.type} | ${defaultVal} | ${p.description} |\n`;
    }
  } else {
    for (const w of workflowList) {
      paramTableBlock += `### ${w.toolName}\n\n`;
      if (w.parameters.length === 0) {
        paramTableBlock += 'None.\n\n';
        continue;
      }
      paramTableBlock += '| Name | Type | Default | Description |\n';
      paramTableBlock += '|------|------|---------|-------------|\n';
      for (const p of w.parameters) {
        const defaultVal = p.default !== undefined ? JSON.stringify(p.default) : 'required';
        paramTableBlock += `| ${p.name} | ${p.type} | ${defaultVal} | ${p.description} |\n`;
      }
      paramTableBlock += '\n';
    }
  }

  // Backend ladder explanation.
  const backendBlock = `## Backend Ladder

The MCP server automatically escalates from fetch API replay to gated fetch-bootstrap when browser-minted state is declared, then cdp-replay (API requests run inside a live trusted Chrome so a protected POST refreshes its anti-bot token between calls), then stealth-fetch for bot-defense state, then playbook for full DOM replay.
Bot detection is handled transparently.`;

  // Scheduling block (optional).
  let scheduleBlock = '';
  if (cronConfig !== undefined) {
    scheduleBlock = `\n## Scheduling

Imprint cron schedule: \`${cronConfig.schedule}\``;
    if (platform === 'hermes') {
      scheduleBlock += `\nHermes equivalent: \`/cron add "${cronConfig.schedule}" "Run ${toolName} ..."\``;
    }
  }

  return `${frontmatter}

# ${toolName}

${description}${contextBlock}

## MCP Integration

${configSnippet}

${workflowBlock}${playbookBlock}

${paramTableBlock}

${backendBlock}${scheduleBlock}
`;
}
