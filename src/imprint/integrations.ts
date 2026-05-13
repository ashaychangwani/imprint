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

interface ImprintCommand {
  command: string;
  args: string[];
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
    const cliPath = pathResolve(import.meta.dir, '..', 'cli.ts');
    return { command: 'bun', args: ['run', cliPath] };
  }
}

/**
 * Generate the paste snippet for a given platform — the quick-install
 * instructions users can paste into their shell to register the MCP server.
 */
export function generatePasteSnippet(opts: {
  site: string;
  workflow: Workflow;
  platform: Platform;
  imprintCommand: ImprintCommand;
}): string {
  const { site, workflow, platform, imprintCommand: ic } = opts;
  const toolName = `imprint-${site}`;
  const descLower = workflow.intent.description.toLowerCase();
  const paramList = formatParams(workflow.parameters);
  const shellCmd = [ic.command, ...ic.args, 'mcp-server', site].join(' ');
  const mcpArgs = [...ic.args, 'mcp-server', site];
  const argsStr = `[${mcpArgs.map((a) => `"${a}"`).join(', ')}]`;

  switch (platform) {
    case 'claude-code':
      return `Add the ${toolName} tool: run \`claude mcp add --scope user ${toolName} -- ${shellCmd}\` to register ${descLower}. Parameters: ${paramList}. The backend ladder handles browser/API state and bot detection automatically (fetch → gated fetch-bootstrap → stealth-fetch → playbook).`;

    case 'codex':
      return `Add the ${toolName} tool: run \`codex mcp add ${toolName} -- ${shellCmd}\` to register ${descLower}. Parameters: ${paramList}.`;

    case 'claude-desktop':
      return `Add to ~/Library/Application Support/Claude/claude_desktop_config.json under "mcpServers":

  "${toolName}": { "command": "${ic.command}", "args": ${argsStr} }`;

    case 'openclaw':
      return `Add the ${toolName} tool: add to ~/.openclaw/openclaw.json under mcp.servers:

  "${toolName}": { "command": "${ic.command}", "args": ${argsStr} }

This gives your agent a tool that ${descLower}. Parameters: ${paramList}.`;

    case 'hermes':
      return `Add the ${toolName} tool: add to ~/.hermes/config.yaml under mcp_servers:

  ${toolName}:
    command: "${ic.command}"
    args: ${argsStr}

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
}): string[] | null {
  const { site, platform, imprintCommand: ic } = opts;
  const toolName = `imprint-${site}`;
  const imprintArgs = [ic.command, ...ic.args, 'mcp-server', site];

  switch (platform) {
    case 'claude-code':
      return ['claude', 'mcp', 'add', '--scope', 'user', toolName, '--', ...imprintArgs];
    case 'codex':
      return ['codex', 'mcp', 'add', toolName, '--', ...imprintArgs];
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

/**
 * Generate inline SKILL.md for OpenClaw or Hermes — a single markdown file
 * with frontmatter, workflow JSON, playbook YAML (if present), parameter
 * table, and platform-specific config snippet.
 */
export function generateSkillMd(opts: {
  site: string;
  workflow: Workflow;
  playbook?: Playbook;
  cronConfig?: CronConfig;
  platform: 'openclaw' | 'hermes';
}): string {
  const { site, workflow, playbook, cronConfig, platform } = opts;
  const toolName = `imprint-${site}`;

  const frontmatter = `---
name: ${toolName}
description: ${workflow.intent.description}
version: 1.0.0
metadata:
  ${platform}:
    tags: [automation, imprint]
    category: workflow
---`;

  const contextBlock =
    workflow.intent.userSaid !== undefined
      ? `\nRecording context: ${workflow.intent.userSaid}\n`
      : '';

  // Generate platform-specific config snippet.
  const imprintCommand = detectImprintCommand();
  const configSnippet = generatePasteSnippet({ site, workflow, platform, imprintCommand });

  // Workflow JSON block.
  const workflowJson = JSON.stringify(workflow, null, 2);
  const workflowBlock = `## Workflow (API replay)

\`\`\`json
${workflowJson}
\`\`\``;

  // Playbook YAML block (optional).
  let playbookBlock = '';
  if (playbook !== undefined) {
    const playbookYaml = yamlStringify(playbook, { lineWidth: 0 });
    playbookBlock = `\n## Playbook (DOM replay fallback)

\`\`\`yaml
${playbookYaml.trim()}
\`\`\``;
  }

  // Parameter table.
  let paramTableBlock = '## Parameters\n\n';
  if (workflow.parameters.length === 0) {
    paramTableBlock += 'None.\n';
  } else {
    paramTableBlock += '| Name | Type | Default | Description |\n';
    paramTableBlock += '|------|------|---------|-------------|\n';
    for (const p of workflow.parameters) {
      const defaultVal = p.default !== undefined ? JSON.stringify(p.default) : 'required';
      paramTableBlock += `| ${p.name} | ${p.type} | ${defaultVal} | ${p.description} |\n`;
    }
  }

  // Backend ladder explanation.
  const backendBlock = `## Backend Ladder

The MCP server automatically escalates from fetch API replay to gated fetch-bootstrap when browser-minted state is declared, then stealth-fetch for bot-defense state, then playbook for full DOM replay.
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

${workflow.intent.description}${contextBlock}

## MCP Integration

${configSnippet}

${workflowBlock}${playbookBlock}

${paramTableBlock}

${backendBlock}${scheduleBlock}
`;
}
