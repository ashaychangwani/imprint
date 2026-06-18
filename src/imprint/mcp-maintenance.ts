/**
 * `imprint mcp ...` — audit and maintain Imprint-owned MCP registrations.
 *
 * This module intentionally scans config files directly instead of launching
 * MCP clients. Some client list commands perform health checks and can spawn
 * stdio servers, which is too side-effectful for a cleanup/audit command.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import * as p from '@clack/prompts';
import YAML from 'yaml';
import { imprintHomeDir, localSiteDir } from './paths.ts';
import { type BackendsCacheStatus, loadBackendsCacheStatus } from './probe-backends.ts';
import {
  type WorkflowState,
  loadTeachState,
  pruneStalePendingTeachWorkflows,
  resolveTeachStatePath,
  saveTeachState,
  teachStatePath,
} from './teach-state.ts';

type McpClient = 'claude-code' | 'codex' | 'claude-desktop' | 'openclaw' | 'hermes';
type LocalDeleteMode = 'none' | 'tool' | 'site';
type IssueKind = 'missing-session' | 'stale-registration' | 'stale-backends' | 'invalid-backends';

const CLIENTS: McpClient[] = ['claude-code', 'codex', 'claude-desktop', 'openclaw', 'hermes'];
const DISABLED_STORE_VERSION = 1;

interface McpRegistration {
  client: McpClient;
  name: string;
  site: string | null;
  configPath: string;
  scope?: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  server?: Record<string, unknown>;
}

interface DisabledMcpRegistration {
  client: McpClient;
  name: string;
  site: string | null;
  configPath: string;
  scope?: string;
  command?: string;
  args?: string[];
  server?: Record<string, unknown>;
  disabledAt: string;
}

interface DisabledStore {
  version: number;
  disabled: DisabledMcpRegistration[];
}

interface LocalToolStatus {
  site: string;
  toolName: string;
  dir: string;
  complete: boolean;
  hasWorkflow: boolean;
  hasPlaybook: boolean;
  hasBackends: boolean;
  hasCron: boolean;
  backendCache: PublicBackendsCacheStatus;
}

interface PublicBackendsCacheStatus {
  status: BackendsCacheStatus['status'];
  path: string | null;
  preferredOrder?: string[];
  reason?: string;
  remediation?: string;
}

interface LocalWorkflowStatus {
  site: string;
  name: string;
  sessionPath: string | null;
  redactedPath: string | null;
  completedSteps: string[];
  missingSession: boolean;
  incomplete: boolean;
  error?: string;
  updatedAt: string;
}

interface LocalSiteStatus {
  site: string;
  dir: string;
  tools: LocalToolStatus[];
  workflows: LocalWorkflowStatus[];
}

interface McpIssue {
  kind: IssueKind;
  site: string;
  message: string;
  client?: McpClient;
  name?: string;
  configPath?: string;
  workflow?: string;
  path?: string;
}

interface McpStatus {
  imprintHome: string;
  registrations: McpRegistration[];
  disabled: DisabledMcpRegistration[];
  sites: LocalSiteStatus[];
  issues: McpIssue[];
}

interface MaintenanceContext {
  homeDir: string;
  cwd: string;
  imprintHome: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

interface MutationResult {
  changed: string[];
  skipped: string[];
}

function defaultContext(opts: Partial<MaintenanceContext> = {}): MaintenanceContext {
  return {
    homeDir: opts.homeDir ?? homedir(),
    cwd: opts.cwd ?? process.cwd(),
    imprintHome: opts.imprintHome ?? imprintHomeDir(),
  };
}

function hermesConfigPath(ctx: MaintenanceContext): string {
  const explicit = process.env.HERMES_CONFIG?.trim();
  if (explicit) return explicit;
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) return pathJoin(hermesHome, 'config.yaml');
  return pathJoin(ctx.homeDir, '.hermes', 'config.yaml');
}

function parseSubArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const MCP_HELP = `imprint mcp — audit and clean up Imprint MCP registrations

USAGE
  imprint mcp
  imprint mcp status [--site <site>] [--json]
  imprint mcp disable <server-or-site> [--client <name|all>] [--yes]
  imprint mcp enable <server-or-site> [--client <name|all>] [--yes]
  imprint mcp delete <server-or-site> [--client <name|all>] [--local none|tool|site] [--yes]
  imprint mcp prune-state [--site <site>] [--missing-session] [--incomplete] [--yes]

DESCRIPTION
  Manages only Imprint-owned MCP registrations: names beginning with
  "imprint-" or commands that run "imprint mcp-server <site>".

  Mutating subcommands require --yes in direct mode. Run "imprint mcp"
  without a subcommand for the interactive cleanup flow.
`;

export async function runMcpCommand(argv: string[]): Promise<number> {
  if (argv.length === 0) return await runInteractiveMcp();
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(MCP_HELP);
    return 0;
  }

  const sub = argv[0] ?? '';
  const rest = argv.slice(1);

  switch (sub) {
    case 'status':
    case 'audit':
      return cmdStatus(rest);
    case 'disable':
      return cmdDisable(rest);
    case 'enable':
      return cmdEnable(rest);
    case 'delete':
    case 'remove':
    case 'rm':
      return cmdDelete(rest);
    case 'prune-state':
      return cmdPruneState(rest);
    default:
      console.error(`error: unknown subcommand 'mcp ${sub}' — run \`imprint mcp --help\``);
      return 2;
  }
}

async function runInteractiveMcp(): Promise<number> {
  p.intro('imprint mcp');
  const ctx = defaultContext();
  const status = scanMcpStatus(ctx);
  p.log.info(formatMcpStatus(status));

  const action = await p.select({
    message: 'What would you like to do?',
    options: [
      ...(status.issues.length > 0 ? [{ value: 'fix-issue', label: 'Fix an issue' }] : []),
      { value: 'disable', label: 'Disable a registration' },
      { value: 'enable', label: 'Re-enable a disabled registration' },
      { value: 'delete', label: 'Delete a registration' },
      { value: 'prune-state', label: 'Prune stale teach state' },
      { value: 'quit', label: 'Quit' },
    ],
  });
  if (p.isCancel(action) || action === 'quit') {
    p.outro('Done.');
    return 0;
  }

  if (action === 'fix-issue') {
    await runInteractiveIssueFix(status, ctx);
    p.outro('Done.');
    return 0;
  }

  if (action === 'prune-state') {
    const result = pruneTeachState({ missingSession: true, incomplete: true });
    reportMutation(result);
    p.outro('Done.');
    return 0;
  }

  const choices =
    action === 'enable'
      ? [
          ...status.registrations
            .filter((r) => r.client === 'codex' && !r.enabled)
            .map((r) => ({
              value: `registration:${registrationKey(r)}`,
              label: registrationLabel(r),
            })),
          ...status.disabled.map((d) => ({
            value: `snapshot:${disabledKey(d)}`,
            label: disabledLabel(d),
          })),
        ]
      : status.registrations
          .filter((r) => action !== 'disable' || r.enabled)
          .map((r) => ({
            value: `registration:${registrationKey(r)}`,
            label: registrationLabel(r),
          }));

  if (choices.length === 0) {
    if (action === 'delete' && status.sites.length > 0) {
      p.log.info('No active registrations found. You can still delete local Imprint artifacts.');
      await runInteractiveLocalDelete(status);
      p.outro('Done.');
      return 0;
    }
    p.log.info(
      action === 'enable' ? 'No disabled registrations found.' : 'No registrations found.',
    );
    p.outro('Done.');
    return 0;
  }

  const target = await p.select({
    message: `${String(action)[0]?.toUpperCase()}${String(action).slice(1)} which registration?`,
    options: choices,
  });
  if (p.isCancel(target)) {
    p.outro('Cancelled.');
    return 0;
  }

  if (action === 'disable') {
    const reg = findRegistrationChoice(status, String(target));
    reportMutation(
      reg ? disableRegistration(reg, ctx) : { changed: [], skipped: ['selection disappeared'] },
    );
  } else if (action === 'enable') {
    if (String(target).startsWith('registration:')) {
      const reg = findRegistrationChoice(status, String(target));
      reportMutation(
        reg ? enableRegistration(reg) : { changed: [], skipped: ['selection disappeared'] },
      );
    } else {
      const snap = findDisabledChoice(status, String(target));
      reportMutation(
        snap
          ? enableDisabledSnapshot(ctx, snap)
          : { changed: [], skipped: ['selection disappeared'] },
      );
    }
  } else if (action === 'delete') {
    const local = await p.select({
      message: 'Also delete local Imprint artifacts?',
      options: [
        { value: 'none', label: 'No, only delete external MCP registrations' },
        { value: 'tool', label: 'Delete generated tool directories, keep recordings' },
        { value: 'site', label: 'Delete the whole local site directory, including recordings' },
      ],
      initialValue: 'none',
    });
    if (p.isCancel(local)) {
      p.outro('Cancelled.');
      return 0;
    }
    if (local === 'site') {
      const confirm = await p.confirm({
        message:
          'This will permanently delete the local site directory, including raw recordings. Continue?',
      });
      if (p.isCancel(confirm) || !confirm) {
        p.outro('Cancelled.');
        return 0;
      }
    }
    const reg = findRegistrationChoice(status, String(target));
    reportMutation(
      reg
        ? deleteRegistration(reg, ctx, local as LocalDeleteMode)
        : { changed: [], skipped: ['selection disappeared'] },
    );
  }

  p.outro('Done.');
  return 0;
}

async function runInteractiveIssueFix(status: McpStatus, ctx: MaintenanceContext): Promise<void> {
  const SELECT_ALL = '__select_all__';
  const SELECT_NONE = '__select_none__';

  const issueOptions = status.issues.map((issue, index) => ({
    value: String(index),
    label: `${issue.kind}: ${issue.message}`,
  }));

  const choice = await p.multiselect<string>({
    message:
      'Fix which issues? (space to toggle, enter to submit; pick "Select all" to fix everything)',
    options: [
      { value: SELECT_ALL, label: 'Select all issues' },
      { value: SELECT_NONE, label: 'Select none (cancel)' },
      ...issueOptions,
    ],
    required: false,
    initialValues: [],
  });
  if (p.isCancel(choice)) return;

  const selected = choice as string[];
  if (selected.includes(SELECT_NONE) && !selected.includes(SELECT_ALL)) {
    p.log.info('No issues selected.');
    return;
  }

  const indices = selected.includes(SELECT_ALL)
    ? status.issues.map((_, i) => i)
    : selected
        .filter((value) => value !== SELECT_ALL && value !== SELECT_NONE)
        .map((value) => Number(value))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < status.issues.length);

  if (indices.length === 0) {
    p.log.info('No issues selected.');
    return;
  }

  const aggregate: MutationResult = { changed: [], skipped: [] };
  for (const index of indices) {
    const issue = status.issues[index];
    if (!issue) {
      appendMutation(aggregate, { changed: [], skipped: ['selection disappeared'] });
      continue;
    }
    appendMutation(aggregate, fixIssue(issue, status, ctx));
  }
  reportMutation(aggregate);
}

function fixIssue(issue: McpIssue, status: McpStatus, ctx: MaintenanceContext): MutationResult {
  if (issue.kind === 'stale-registration') {
    const reg = status.registrations.find(
      (r) =>
        r.client === issue.client &&
        r.name === issue.name &&
        (!issue.configPath || r.configPath === issue.configPath),
    );
    return reg
      ? deleteRegistration(reg, ctx, 'none')
      : {
          changed: [],
          skipped: [`registration not found for ${issue.client ?? '?'}/${issue.name ?? '?'}`],
        };
  }

  if (issue.kind === 'missing-session' && issue.workflow) {
    return pruneSingleTeachWorkflow(issue.site, issue.workflow);
  }

  return { changed: [], skipped: [`no automatic fix for ${issue.kind}`] };
}

async function runInteractiveLocalDelete(status: McpStatus): Promise<void> {
  const selectedSite = await p.select({
    message: 'Delete local artifacts for which site?',
    options: status.sites.map((s) => {
      const complete = s.tools.filter((t) => t.complete).length;
      return {
        value: s.site,
        label: `${s.site} (${complete} complete tool${complete === 1 ? '' : 's'})`,
      };
    }),
  });
  if (p.isCancel(selectedSite)) return;

  const local = await p.select({
    message: 'What local artifacts should be deleted?',
    options: [
      { value: 'tool', label: 'Delete generated tool directories, keep recordings' },
      { value: 'site', label: 'Delete the whole local site directory, including recordings' },
    ],
    initialValue: 'tool',
  });
  if (p.isCancel(local)) return;

  if (local === 'site') {
    const confirm = await p.confirm({
      message:
        'This will permanently delete the local site directory, including raw recordings. Continue?',
    });
    if (p.isCancel(confirm) || !confirm) return;
  }

  reportMutation(deleteMcpTarget(String(selectedSite), { local: local as LocalDeleteMode }));
}

function cmdStatus(argv: string[]): number {
  const { flags } = parseSubArgs(argv);
  const site = typeof flags.site === 'string' ? flags.site : undefined;
  const status = scanMcpStatus({ site });
  if (flags.json === true) console.log(JSON.stringify(status, null, 2));
  else console.log(formatMcpStatus(status));
  return status.issues.some(
    (i) =>
      i.kind === 'stale-registration' ||
      i.kind === 'missing-session' ||
      i.kind === 'stale-backends' ||
      i.kind === 'invalid-backends',
  )
    ? 1
    : 0;
}

function cmdDisable(argv: string[]): number {
  const { positionals, flags } = parseSubArgs(argv);
  const target = positionals[0];
  if (!target) {
    console.error('error: usage: imprint mcp disable <server-or-site> [--client <name|all>] --yes');
    return 2;
  }
  if (flags.yes !== true) return requireYes('disable');
  const client = parseClientFlag(flags.client);
  if (client === null) return 2;
  reportMutation(disableMcpTarget(target, { client }));
  return 0;
}

function cmdEnable(argv: string[]): number {
  const { positionals, flags } = parseSubArgs(argv);
  const target = positionals[0];
  if (!target) {
    console.error('error: usage: imprint mcp enable <server-or-site> [--client <name|all>] --yes');
    return 2;
  }
  if (flags.yes !== true) return requireYes('enable');
  const client = parseClientFlag(flags.client);
  if (client === null) return 2;
  const result = enableMcpTarget(target, { client });
  reportMutation(result);
  return result.skipped.some((s) => s.includes('conflict')) ? 1 : 0;
}

function cmdDelete(argv: string[]): number {
  const { positionals, flags } = parseSubArgs(argv);
  const target = positionals[0];
  if (!target) {
    console.error(
      'error: usage: imprint mcp delete <server-or-site> [--client <name|all>] [--local none|tool|site] --yes',
    );
    return 2;
  }
  if (flags.yes !== true) return requireYes('delete');
  const client = parseClientFlag(flags.client);
  if (client === null) return 2;
  const local = parseLocalFlag(flags.local);
  if (local === null) return 2;
  reportMutation(deleteMcpTarget(target, { client, local }));
  return 0;
}

function cmdPruneState(argv: string[]): number {
  const { flags } = parseSubArgs(argv);
  if (flags.yes !== true) return requireYes('prune-state');
  const site = typeof flags.site === 'string' ? flags.site : undefined;
  const missingSession = flags['missing-session'] === true;
  const incomplete = flags.incomplete === true;
  reportMutation(
    pruneTeachState({
      site,
      missingSession: missingSession || (!missingSession && !incomplete),
      incomplete: incomplete || (!missingSession && !incomplete),
    }),
  );
  return 0;
}

function requireYes(action: string): number {
  console.error(
    `error: \`imprint mcp ${action}\` mutates local config/state. Re-run with --yes, or run \`imprint mcp\` for the interactive flow.`,
  );
  return 2;
}

function parseClientFlag(raw: string | boolean | undefined): McpClient | 'all' | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === true) {
    console.error(
      'error: --client requires one of: all, claude-code, codex, claude-desktop, openclaw, hermes',
    );
    return null;
  }
  if (raw === 'all') return 'all';
  if (typeof raw === 'string' && (CLIENTS as string[]).includes(raw)) return raw as McpClient;
  console.error(
    `error: unknown --client "${raw}" — use one of: all, claude-code, codex, claude-desktop, openclaw, hermes`,
  );
  return null;
}

function parseLocalFlag(raw: string | boolean | undefined): LocalDeleteMode | null {
  if (raw === undefined) return 'none';
  if (raw === true) {
    console.error('error: --local requires one of: none, tool, site');
    return null;
  }
  if (raw === 'none' || raw === 'tool' || raw === 'site') return raw;
  console.error(`error: unknown --local "${raw}" — use one of: none, tool, site`);
  return null;
}

function reportMutation(result: MutationResult): void {
  for (const line of result.changed) console.log(`[imprint] ${line}`);
  for (const line of result.skipped) console.log(`[imprint] skipped: ${line}`);
  if (result.changed.length === 0 && result.skipped.length === 0) {
    console.log('[imprint] nothing to change');
  }
}

function registrationKey(reg: McpRegistration): string {
  return [reg.client, reg.name, reg.configPath].join('\u0000');
}

function disabledKey(reg: DisabledMcpRegistration): string {
  return [reg.client, reg.name, reg.configPath].join('\u0000');
}

function registrationLabel(reg: McpRegistration): string {
  const state = reg.enabled ? 'enabled' : 'disabled';
  const scope = reg.scope ? `, ${reg.scope}` : '';
  return `${reg.name} (${reg.client}${scope}, ${state}${reg.site ? `, site ${reg.site}` : ''})`;
}

function disabledLabel(reg: DisabledMcpRegistration): string {
  const scope = reg.scope ? `, ${reg.scope}` : '';
  return `${reg.name} (${reg.client}${scope}${reg.site ? `, site ${reg.site}` : ''})`;
}

function findRegistrationChoice(status: McpStatus, choice: string): McpRegistration | undefined {
  const key = choice.startsWith('registration:') ? choice.slice('registration:'.length) : choice;
  return status.registrations.find((r) => registrationKey(r) === key);
}

function findDisabledChoice(
  status: McpStatus,
  choice: string,
): DisabledMcpRegistration | undefined {
  const key = choice.startsWith('snapshot:') ? choice.slice('snapshot:'.length) : choice;
  return status.disabled.find((r) => disabledKey(r) === key);
}

export function scanMcpStatus(
  opts: Partial<MaintenanceContext> & { site?: string } = {},
): McpStatus {
  const ctx = defaultContext(opts);
  const registrations = scanRegistrations(ctx).filter((r) => !opts.site || r.site === opts.site);
  const disabled = loadDisabledStore(ctx)
    .disabled.filter((d) => !opts.site || d.site === opts.site)
    .map(publicDisabledSnapshot);
  const sites = scanLocalSites(ctx).filter((s) => !opts.site || s.site === opts.site);
  const issues = collectIssues({ registrations, sites });
  return { imprintHome: ctx.imprintHome, registrations, disabled, sites, issues };
}

function formatMcpStatus(status: McpStatus): string {
  const lines: string[] = ['imprint MCP status', `IMPRINT_HOME: ${status.imprintHome}`, ''];

  lines.push('Registrations:');
  if (status.registrations.length === 0) {
    lines.push('  none');
  } else {
    for (const r of status.registrations) {
      const state = r.enabled ? 'enabled' : 'disabled';
      lines.push(
        `  ${r.client.padEnd(14)} ${r.name} (${state}${r.site ? `, site: ${r.site}` : ''})`,
      );
    }
  }

  lines.push('');
  lines.push('Disabled snapshots:');
  if (status.disabled.length === 0) {
    lines.push('  none');
  } else {
    for (const d of status.disabled) {
      lines.push(`  ${d.client.padEnd(14)} ${d.name} (${d.site ?? 'unknown site'})`);
    }
  }

  lines.push('');
  lines.push('Local sites:');
  if (status.sites.length === 0) {
    lines.push('  none');
  } else {
    for (const s of status.sites) {
      const complete = s.tools.filter((t) => t.complete).length;
      const incomplete = s.workflows.filter((w) => w.incomplete).length;
      const missing = s.workflows.filter((w) => w.missingSession).length;
      lines.push(
        `  ${s.site}: ${complete} complete tool${complete === 1 ? '' : 's'}, ${incomplete} incomplete workflow${incomplete === 1 ? '' : 's'}, ${missing} missing-session issue${missing === 1 ? '' : 's'}`,
      );
    }
  }

  lines.push('');
  lines.push('Issues:');
  if (status.issues.length === 0) {
    lines.push('  none');
  } else {
    for (const issue of status.issues) {
      lines.push(`  ${issue.kind}: ${issue.message}`);
      const hint = issueFixHint(issue);
      if (hint) lines.push(`    fix: ${hint}`);
    }
  }

  return lines.join('\n');
}

function issueFixHint(issue: McpIssue): string | null {
  switch (issue.kind) {
    case 'stale-registration':
      return `choose "Fix an issue" or run: imprint mcp delete ${issue.name ?? `imprint-${issue.site}`} --client ${issue.client ?? 'all'} --yes`;
    case 'missing-session':
      return `choose "Fix an issue" or run: imprint mcp prune-state --site ${issue.site} --missing-session --yes`;
    case 'stale-backends':
    case 'invalid-backends':
      return issue.path
        ? `run: imprint probe-backends ${issue.site}${issue.workflow ? ` --tool ${issue.workflow}` : ''}`
        : `run: imprint probe-backends ${issue.site}${issue.workflow ? ` --tool ${issue.workflow}` : ''}`;
  }
  return null;
}

function scanRegistrations(ctx: MaintenanceContext): McpRegistration[] {
  return [
    ...scanCodex(ctx),
    ...scanClaudeCode(ctx),
    ...scanClaudeDesktop(ctx),
    ...scanOpenClaw(ctx),
    ...scanHermes(ctx),
  ].sort((a, b) => `${a.client}:${a.name}`.localeCompare(`${b.client}:${b.name}`));
}

function scanLocalSites(ctx: MaintenanceContext): LocalSiteStatus[] {
  if (!existsSync(ctx.imprintHome)) return [];
  const sites: LocalSiteStatus[] = [];
  for (const entry of readdirSync(ctx.imprintHome).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const dir = pathJoin(ctx.imprintHome, entry);
    if (!safeIsDir(dir)) continue;
    sites.push(scanLocalSite(entry, dir, ctx.imprintHome));
  }
  return sites;
}

function scanLocalSite(site: string, dir: string, imprintHome: string): LocalSiteStatus {
  const tools: LocalToolStatus[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'sessions' || entry === '_shared' || entry.startsWith('.')) continue;
    const toolDir = pathJoin(dir, entry);
    if (!safeIsDir(toolDir)) continue;
    const toolName = workflowJsonToolName(toolDir) ?? entry;
    const cacheStatus = loadBackendsCacheStatus(site, imprintHome, toolDir, {
      warn: false,
      toolName,
    });
    tools.push({
      site,
      toolName,
      dir: toolDir,
      complete: existsSync(pathJoin(toolDir, 'index.ts')),
      hasWorkflow: existsSync(pathJoin(toolDir, 'workflow.json')),
      hasPlaybook: existsSync(pathJoin(toolDir, 'playbook.yaml')),
      hasBackends: existsSync(pathJoin(toolDir, 'backends.json')),
      hasCron: existsSync(pathJoin(toolDir, 'cron.json')),
      backendCache: publicBackendsCacheStatus(cacheStatus),
    });
  }

  const state = loadTeachState(site);
  if (pruneStalePendingTeachWorkflows(site, state)) {
    saveTeachState(site, state);
  }
  const workflows = Object.entries(state.workflows)
    .map(([name, ws]) => workflowStatus(site, name, ws, tools))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { site, dir, tools, workflows };
}

function publicBackendsCacheStatus(status: BackendsCacheStatus): PublicBackendsCacheStatus {
  if (status.status === 'ok') {
    return {
      status: status.status,
      path: status.path,
      preferredOrder: status.cache.preferredOrder,
    };
  }
  if (status.status === 'missing') {
    return {
      status: status.status,
      path: status.path,
      remediation: status.remediation,
    };
  }
  return {
    status: status.status,
    path: status.path,
    reason: status.reason,
    remediation: status.remediation,
  };
}

function workflowStatus(
  site: string,
  name: string,
  ws: WorkflowState,
  tools: LocalToolStatus[],
): LocalWorkflowStatus {
  const sessionPath = resolveTeachStatePath(site, ws.sessionPath);
  const redactedPath = resolveTeachStatePath(site, ws.redactedPath);
  const hasSession = !!sessionPath && existsSync(sessionPath);
  const hasRedacted = !ws.redactedPath || (!!redactedPath && existsSync(redactedPath));
  const matchingTool = tools.find(
    (t) => t.toolName === name || workflowJsonToolName(t.dir) === name,
  );
  const completeTool = matchingTool?.complete === true;
  const hasEmit = ws.completedSteps.includes('emit');
  const hasRegister = ws.completedSteps.includes('register');

  return {
    site,
    name,
    sessionPath,
    redactedPath,
    completedSteps: [...ws.completedSteps],
    missingSession: !hasSession || !hasRedacted,
    incomplete: !hasEmit || !hasRegister || !completeTool,
    error: ws.error,
    updatedAt: ws.updatedAt,
  };
}

function workflowJsonToolName(toolDir: string): string | null {
  const path = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { toolName?: unknown };
    return typeof raw.toolName === 'string' ? raw.toolName : null;
  } catch {
    return null;
  }
}

function collectIssues(opts: {
  registrations: McpRegistration[];
  sites: LocalSiteStatus[];
}): McpIssue[] {
  const issues: McpIssue[] = [];
  const sitesByName = new Map(opts.sites.map((s) => [s.site, s]));

  for (const site of opts.sites) {
    for (const tool of site.tools) {
      if (tool.backendCache.status === 'stale' || tool.backendCache.status === 'invalid') {
        issues.push({
          kind: tool.backendCache.status === 'stale' ? 'stale-backends' : 'invalid-backends',
          site: site.site,
          workflow: tool.toolName,
          path: tool.backendCache.path ?? undefined,
          message:
            tool.backendCache.status === 'stale'
              ? `${site.site}/${tool.toolName} has a stale backends.json; runtime will fall back to the default ladder until reprobed`
              : `${site.site}/${tool.toolName} has an invalid backends.json; runtime will fall back to the default ladder until reprobed`,
        });
      }
    }

    for (const wf of site.workflows) {
      if (wf.missingSession) {
        issues.push({
          kind: 'missing-session',
          site: site.site,
          workflow: wf.name,
          message: `${site.site}/${wf.name} references a missing session file`,
          path: wf.sessionPath ?? undefined,
        });
      }
    }
  }

  for (const r of opts.registrations) {
    if (!r.site) continue;
    const site = sitesByName.get(r.site);
    if (!site || site.tools.every((t) => !t.complete)) {
      issues.push({
        kind: 'stale-registration',
        site: r.site,
        client: r.client,
        name: r.name,
        configPath: r.configPath,
        message: `${r.client}/${r.name} points at site "${r.site}" but no complete generated tool exists`,
      });
    }
  }

  return issues.sort((a, b) =>
    `${a.kind}:${a.site}:${a.workflow ?? a.name ?? ''}`.localeCompare(
      `${b.kind}:${b.site}:${b.workflow ?? b.name ?? ''}`,
    ),
  );
}

export function disableMcpTarget(
  target: string,
  opts: Partial<MaintenanceContext> & { client?: McpClient | 'all' } = {},
): MutationResult {
  const ctx = defaultContext(opts);
  const regs = scanRegistrations(ctx).filter((r) => matchesTarget(r, target, opts.client));
  const result: MutationResult = { changed: [], skipped: [] };
  if (regs.length === 0) result.skipped.push(`no active registration matched "${target}"`);

  for (const reg of regs) {
    appendMutation(result, disableRegistration(reg, ctx));
  }
  return result;
}

function disableRegistration(reg: McpRegistration, ctx: MaintenanceContext): MutationResult {
  const result: MutationResult = { changed: [], skipped: [] };
  if (!reg.enabled) {
    result.skipped.push(`${reg.client}/${reg.name} is already disabled`);
    return result;
  }
  if (reg.client === 'codex') {
    if (setCodexEnabled(reg.configPath, reg.name, false)) {
      result.changed.push(`disabled ${reg.client}/${reg.name}`);
    } else {
      result.skipped.push(`could not disable ${reg.client}/${reg.name}`);
    }
    return result;
  }
  const server = reg.server ?? fallbackServerConfig(reg);
  if (!server) {
    result.skipped.push(`${reg.client}/${reg.name} is not restorable (missing server config)`);
    return result;
  }
  const removed = removeRegistration(reg);
  if (removed) {
    addDisabledSnapshot(ctx, {
      client: reg.client,
      name: reg.name,
      site: reg.site,
      configPath: reg.configPath,
      scope: reg.scope,
      command: reg.command,
      args: reg.args,
      server,
      disabledAt: new Date().toISOString(),
    });
    result.changed.push(`disabled ${reg.client}/${reg.name}`);
  } else {
    result.skipped.push(`could not disable ${reg.client}/${reg.name}`);
  }
  return result;
}

export function enableMcpTarget(
  target: string,
  opts: Partial<MaintenanceContext> & { client?: McpClient | 'all' } = {},
): MutationResult {
  const ctx = defaultContext(opts);
  const result: MutationResult = { changed: [], skipped: [] };
  const codexMatches = scanCodex(ctx).filter((r) => matchesTarget(r, target, opts.client));
  for (const reg of codexMatches) {
    appendMutation(result, enableRegistration(reg));
  }

  const store = loadDisabledStore(ctx);
  const keep: DisabledMcpRegistration[] = [];
  for (const snap of store.disabled) {
    if (!matchesDisabledTarget(snap, target, opts.client)) {
      keep.push(snap);
      continue;
    }
    if (registrationExists(snap)) {
      result.skipped.push(
        `conflict: ${snap.client}/${snap.name} already exists in ${snap.configPath}`,
      );
      keep.push(snap);
      continue;
    }
    if (restoreDisabledSnapshot(snap)) {
      result.changed.push(`enabled ${snap.client}/${snap.name}`);
    } else {
      result.skipped.push(`could not restore ${snap.client}/${snap.name}`);
      keep.push(snap);
    }
  }
  if (keep.length !== store.disabled.length) saveDisabledStore(ctx, { ...store, disabled: keep });
  if (result.changed.length === 0 && result.skipped.length === 0) {
    result.skipped.push(`no disabled registration matched "${target}"`);
  }
  return result;
}

function enableRegistration(reg: McpRegistration): MutationResult {
  const result: MutationResult = { changed: [], skipped: [] };
  if (reg.client !== 'codex') {
    result.skipped.push(`${reg.client}/${reg.name} is not a native disabled registration`);
  } else if (reg.enabled) {
    result.skipped.push(`${reg.client}/${reg.name} is already enabled`);
  } else if (setCodexEnabled(reg.configPath, reg.name, true)) {
    result.changed.push(`enabled ${reg.client}/${reg.name}`);
  } else {
    result.skipped.push(`could not enable ${reg.client}/${reg.name}`);
  }
  return result;
}

function enableDisabledSnapshot(
  ctx: MaintenanceContext,
  snap: DisabledMcpRegistration,
): MutationResult {
  const result: MutationResult = { changed: [], skipped: [] };
  const store = loadDisabledStore(ctx);
  const key = disabledKey(snap);
  const fullSnap = store.disabled.find((d) => disabledKey(d) === key);
  if (!fullSnap) {
    result.skipped.push(`no disabled registration matched ${snap.client}/${snap.name}`);
    return result;
  }
  if (registrationExists(fullSnap)) {
    result.skipped.push(
      `conflict: ${fullSnap.client}/${fullSnap.name} already exists in ${fullSnap.configPath}`,
    );
    return result;
  }
  if (restoreDisabledSnapshot(fullSnap)) {
    result.changed.push(`enabled ${fullSnap.client}/${fullSnap.name}`);
    saveDisabledStore(ctx, {
      ...store,
      disabled: store.disabled.filter((d) => disabledKey(d) !== key),
    });
  } else {
    result.skipped.push(`could not restore ${fullSnap.client}/${fullSnap.name}`);
  }
  return result;
}

function deleteMcpTarget(
  target: string,
  opts: Partial<MaintenanceContext> & {
    client?: McpClient | 'all';
    local?: LocalDeleteMode;
  } = {},
): MutationResult {
  const ctx = defaultContext(opts);
  const regs = scanRegistrations(ctx).filter((r) => matchesTarget(r, target, opts.client));
  const result: MutationResult = { changed: [], skipped: [] };
  const local = opts.local ?? 'none';
  if (regs.length === 0 && local === 'none') {
    result.skipped.push(`no active registration matched "${target}"`);
  }

  const sites = new Set<string>();
  for (const reg of regs) {
    if (reg.site) sites.add(reg.site);
    if (removeRegistration(reg)) {
      result.changed.push(`deleted ${reg.client}/${reg.name}`);
    } else {
      result.skipped.push(`could not delete ${reg.client}/${reg.name}`);
    }
  }

  const targetSite = target.startsWith('imprint-') ? target.slice('imprint-'.length) : target;
  if (sites.size === 0 && local !== 'none') {
    const targetSiteDir = localSiteDirForContext(ctx, targetSite, result);
    if (targetSiteDir && existsSync(targetSiteDir)) sites.add(targetSite);
  }

  if (local !== 'none') deleteLocalArtifactsForSites(ctx, sites, local, result);

  return result;
}

function deleteRegistration(
  reg: McpRegistration,
  ctx: MaintenanceContext,
  local: LocalDeleteMode,
): MutationResult {
  const result: MutationResult = { changed: [], skipped: [] };
  const sites = new Set<string>();
  if (reg.site) sites.add(reg.site);
  if (removeRegistration(reg)) {
    result.changed.push(`deleted ${reg.client}/${reg.name}`);
  } else {
    result.skipped.push(`could not delete ${reg.client}/${reg.name}`);
  }
  if (local !== 'none') deleteLocalArtifactsForSites(ctx, sites, local, result);
  return result;
}

function deleteLocalArtifactsForSites(
  ctx: MaintenanceContext,
  sites: Set<string>,
  local: LocalDeleteMode,
  result: MutationResult,
): void {
  for (const site of sites) {
    const siteDir = localSiteDirForContext(ctx, site, result);
    if (!siteDir) continue;
    if (!existsSync(siteDir)) {
      result.skipped.push(`local site ${site} does not exist`);
      continue;
    }
    if (local === 'site') {
      rmSync(siteDir, { recursive: true, force: true });
      result.changed.push(`deleted local site ${siteDir}`);
    } else if (local === 'tool') {
      let count = 0;
      for (const entry of readdirSync(siteDir)) {
        if (entry === 'sessions' || entry === '_shared' || entry.startsWith('.')) continue;
        const toolDir = pathJoin(siteDir, entry);
        if (!safeIsDir(toolDir)) continue;
        rmSync(toolDir, { recursive: true, force: true });
        count++;
      }
      result.changed.push(
        `deleted ${count} generated tool director${count === 1 ? 'y' : 'ies'} under ${siteDir}`,
      );
    }
  }
}

function localSiteDirForContext(
  ctx: MaintenanceContext,
  site: string,
  result: MutationResult,
): string | null {
  if (!site || site.includes('..') || site.includes('/') || site.includes('\\')) {
    result.skipped.push(
      `invalid local site "${site}": must not contain path separators or ".." sequences`,
    );
    return null;
  }
  const root = pathResolve(ctx.imprintHome);
  const siteDir = pathResolve(root, site);
  const relative = pathRelative(root, siteDir);
  if (relative === '' || relative.startsWith('..') || pathIsAbsolute(relative)) {
    result.skipped.push(`refusing to delete local site outside IMPRINT_HOME: ${site}`);
    return null;
  }
  return siteDir;
}

function appendMutation(target: MutationResult, source: MutationResult): void {
  target.changed.push(...source.changed);
  target.skipped.push(...source.skipped);
}

function pruneTeachState(
  opts: Partial<MaintenanceContext> & {
    site?: string;
    missingSession?: boolean;
    incomplete?: boolean;
  } = {},
): MutationResult {
  const ctx = defaultContext(opts);
  const result: MutationResult = { changed: [], skipped: [] };
  const sites = opts.site ? [opts.site] : scanLocalSites(ctx).map((s) => s.site);
  for (const site of sites) {
    const statePath = teachStatePath(site);
    if (!existsSync(statePath)) continue;
    const status = scanLocalSite(site, localSiteDir(site), ctx.imprintHome);
    const remove = new Set(
      status.workflows
        .filter(
          (wf) => (opts.missingSession && wf.missingSession) || (opts.incomplete && wf.incomplete),
        )
        .map((wf) => wf.name),
    );
    if (remove.size === 0) continue;
    const state = loadTeachState(site);
    for (const key of remove) delete state.workflows[key];
    saveTeachState(site, state);
    result.changed.push(
      `pruned ${remove.size} teach-state entr${remove.size === 1 ? 'y' : 'ies'} from ${site}`,
    );
  }
  if (result.changed.length === 0) result.skipped.push('no matching teach-state entries found');
  return result;
}

function pruneSingleTeachWorkflow(site: string, workflow: string): MutationResult {
  const statePath = teachStatePath(site);
  if (!existsSync(statePath)) {
    return { changed: [], skipped: [`teach state for ${site} does not exist`] };
  }
  const state = loadTeachState(site);
  if (!(workflow in state.workflows)) {
    return { changed: [], skipped: [`${site}/${workflow} is not in teach state`] };
  }
  delete state.workflows[workflow];
  saveTeachState(site, state);
  return { changed: [`pruned teach-state entry ${site}/${workflow}`], skipped: [] };
}

function matchesTarget(
  reg: McpRegistration,
  target: string,
  client: McpClient | 'all' | undefined,
): boolean {
  if (client && client !== 'all' && reg.client !== client) return false;
  const targetSite = target.startsWith('imprint-') ? target.slice('imprint-'.length) : target;
  return reg.name === target || reg.name === `imprint-${target}` || reg.site === targetSite;
}

function matchesDisabledTarget(
  reg: DisabledMcpRegistration,
  target: string,
  client: McpClient | 'all' | undefined,
): boolean {
  if (client && client !== 'all' && reg.client !== client) return false;
  const targetSite = target.startsWith('imprint-') ? target.slice('imprint-'.length) : target;
  return reg.name === target || reg.name === `imprint-${target}` || reg.site === targetSite;
}

function isImprintRegistration(name: string, command?: string, args?: string[]): boolean {
  return name.startsWith('imprint-') || extractMcpSite(command, args) !== null;
}

function extractMcpSite(command?: string, args?: string[]): string | null {
  if (!command || !args) return null;
  const directImprint = command === 'imprint' || command.endsWith('/imprint');
  const bunRunsImprintCli =
    command === 'bun' &&
    args.some((arg) => arg === 'imprint' || arg.endsWith('/imprint') || arg.endsWith('src/cli.ts'));
  if (!directImprint && !bunRunsImprintCli) return null;
  const idx = args.indexOf('mcp-server');
  if (idx === -1) return null;
  const site = args[idx + 1];
  return site && !site.startsWith('-') ? site : null;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ─── Codex TOML adapter ─────────────────────────────────────────────────────

function scanCodex(ctx: MaintenanceContext): McpRegistration[] {
  const configs = [
    { configPath: pathJoin(ctx.homeDir, '.codex', 'config.toml'), scope: 'user' },
    { configPath: pathJoin(ctx.cwd, '.codex', 'config.toml'), scope: 'project' },
  ];
  const seen = new Set<string>();
  return configs.flatMap(({ configPath, scope }) => {
    if (seen.has(configPath)) return [];
    seen.add(configPath);
    return scanCodexConfig(configPath, scope);
  });
}

function scanCodexConfig(configPath: string, scope: string): McpRegistration[] {
  if (!existsSync(configPath)) return [];
  const src = readFileSync(configPath, 'utf8');
  const out: McpRegistration[] = [];
  for (const section of findTomlMcpSections(src)) {
    const parsed = parseTomlSection(section.body);
    const command = typeof parsed.command === 'string' ? parsed.command : undefined;
    const args = Array.isArray(parsed.args)
      ? parsed.args.filter((a) => typeof a === 'string')
      : undefined;
    if (!isImprintRegistration(section.name, command, args)) continue;
    out.push(
      withServerConfig(
        {
          client: 'codex',
          name: section.name,
          site: extractMcpSite(command, args) ?? siteFromName(section.name),
          configPath,
          scope,
          enabled: parsed.enabled !== false,
          command,
          args,
        },
        parsed,
      ),
    );
  }
  return out;
}

function findTomlMcpSections(
  src: string,
): Array<{ name: string; start: number; end: number; body: string }> {
  return findTomlTableSections(src)
    .filter((section) => section.path.length === 2 && section.path[0] === 'mcp_servers')
    .map((section) => ({
      name: section.path[1] ?? '',
      start: section.start,
      end: section.end,
      body: section.body,
    }));
}

function findTomlTableSections(
  src: string,
): Array<{ path: string[]; start: number; end: number; body: string }> {
  const lines = src.split(/(?<=\n)/);
  const sections: Array<{ path: string[]; startLine: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^\s*\[([^\]]+)\]\s*$/);
    const path = m?.[1] ? parseTomlDottedKey(m[1]) : null;
    if (path) sections.push({ path, startLine: i, endLine: lines.length });
  }
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    for (let j = section.startLine + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j] ?? '')) {
        section.endLine = j;
        break;
      }
    }
  }
  return sections.map((s) => ({
    path: s.path,
    start: lineOffset(lines, s.startLine),
    end: lineOffset(lines, s.endLine),
    body: lines.slice(s.startLine + 1, s.endLine).join(''),
  }));
}

function parseTomlDottedKey(raw: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const src = raw.trim();
  while (i < src.length) {
    while (/\s/.test(src[i] ?? '')) i++;
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      i++;
      let value = '';
      while (i < src.length) {
        const ch = src[i] ?? '';
        if (ch === quote) {
          i++;
          break;
        }
        if (quote === '"' && ch === '\\' && i + 1 < src.length) {
          value += ch + (src[i + 1] ?? '');
          i += 2;
        } else {
          value += ch;
          i++;
        }
      }
      parts.push(unquoteTomlKey(`${quote}${value}${quote}`));
    } else {
      const start = i;
      while (i < src.length && src[i] !== '.') i++;
      const value = src.slice(start, i).trim();
      if (!value) return null;
      parts.push(value);
    }
    while (/\s/.test(src[i] ?? '')) i++;
    if (i >= src.length) break;
    if (src[i] !== '.') return null;
    i++;
  }
  return parts.length > 0 ? parts : null;
}

function lineOffset(lines: string[], line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i]?.length ?? 0;
  return offset;
}

function unquoteTomlKey(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseTomlSection(body: string): Record<string, unknown> {
  try {
    const parsed = Bun.TOML.parse(`[x]\n${body}`) as { x?: Record<string, unknown> };
    return parsed.x ?? {};
  } catch {
    return {};
  }
}

export function setCodexEnabled(configPath: string, name: string, enabled: boolean): boolean {
  if (!existsSync(configPath)) return false;
  const src = readFileSync(configPath, 'utf8');
  const section = findTomlMcpSections(src).find((s) => s.name === name);
  if (!section) return false;
  const block = src.slice(section.start, section.end);
  const lines = block.split(/(?<=\n)/);
  const idx = lines.findIndex((line, i) => i > 0 && /^\s*enabled\s*=/.test(line));
  if (idx >= 0) {
    lines[idx] = `enabled = ${enabled ? 'true' : 'false'}\n`;
  } else {
    lines.splice(1, 0, `enabled = ${enabled ? 'true' : 'false'}\n`);
  }
  writeFileAtomic(
    configPath,
    `${src.slice(0, section.start)}${lines.join('')}${src.slice(section.end)}`,
  );
  return true;
}

function removeCodexRegistration(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  const src = readFileSync(configPath, 'utf8');
  const sections = findTomlTableSections(src).filter(
    (s) => s.path[0] === 'mcp_servers' && s.path[1] === name,
  );
  if (sections.length === 0) return false;
  let next = src;
  for (const section of sections.sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, section.start)}${next.slice(section.end)}`;
  }
  writeFileAtomic(configPath, next);
  return true;
}

// ─── JSON/YAML adapters ─────────────────────────────────────────────────────

function scanClaudeCode(ctx: MaintenanceContext): McpRegistration[] {
  const paths = [
    { path: pathJoin(ctx.homeDir, '.claude', 'settings.json'), scope: 'user' },
    { path: pathJoin(ctx.cwd, '.mcp.json'), scope: 'project' },
  ];
  return paths.flatMap(({ path, scope }) =>
    scanJsonMap(path, ['mcpServers'], 'claude-code', scope),
  );
}

function scanClaudeDesktop(ctx: MaintenanceContext): McpRegistration[] {
  return scanJsonMap(
    pathJoin(ctx.homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    ['mcpServers'],
    'claude-desktop',
  );
}

function scanOpenClaw(ctx: MaintenanceContext): McpRegistration[] {
  return scanJsonMap(
    pathJoin(ctx.homeDir, '.openclaw', 'openclaw.json'),
    ['mcp', 'servers'],
    'openclaw',
  );
}

function scanJsonMap(
  configPath: string,
  objectPath: string[],
  client: McpClient,
  scope?: string,
): McpRegistration[] {
  if (!existsSync(configPath)) return [];
  const root = readJsonObject(configPath);
  const servers = getNestedObject(root, objectPath, false);
  if (!servers) return [];
  const out: McpRegistration[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command : undefined;
    const args = Array.isArray(record.args)
      ? record.args.filter((a) => typeof a === 'string')
      : undefined;
    if (!isImprintRegistration(name, command, args)) continue;
    out.push(
      withServerConfig(
        {
          client,
          name,
          site: extractMcpSite(command, args) ?? siteFromName(name),
          configPath,
          scope,
          enabled: true,
          command,
          args,
        },
        record,
      ),
    );
  }
  return out;
}

function scanHermes(ctx: MaintenanceContext): McpRegistration[] {
  const configPath = hermesConfigPath(ctx);
  if (!existsSync(configPath)) return [];
  const doc = YAML.parseDocument(readFileSync(configPath, 'utf8'));
  const servers = doc.get('mcp_servers', true);
  if (!YAML.isMap(servers)) return [];
  const out: McpRegistration[] = [];
  for (const item of servers.items) {
    const keyValue = (item.key as { value?: unknown } | null | undefined)?.value;
    const name = String(keyValue ?? item.key?.toString() ?? '');
    const value = (
      item.value as { toJSON?: () => unknown } | null | undefined
    )?.toJSON?.() as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') continue;
    const command = typeof value.command === 'string' ? value.command : undefined;
    const args = Array.isArray(value.args)
      ? value.args.filter((a) => typeof a === 'string')
      : undefined;
    if (!isImprintRegistration(name, command, args)) continue;
    out.push(
      withServerConfig(
        {
          client: 'hermes',
          name,
          site: extractMcpSite(command, args) ?? siteFromName(name),
          configPath,
          enabled: true,
          command,
          args,
        },
        value,
      ),
    );
  }
  return out;
}

function siteFromName(name: string): string | null {
  return name.startsWith('imprint-') ? name.slice('imprint-'.length) : null;
}

function removeRegistration(reg: McpRegistration): boolean {
  switch (reg.client) {
    case 'codex':
      return removeCodexRegistration(reg.configPath, reg.name);
    case 'claude-code':
      return removeJsonRegistration(reg.configPath, ['mcpServers'], reg.name);
    case 'claude-desktop':
      return removeJsonRegistration(reg.configPath, ['mcpServers'], reg.name);
    case 'openclaw':
      return removeJsonRegistration(reg.configPath, ['mcp', 'servers'], reg.name);
    case 'hermes':
      return removeHermesRegistration(reg.configPath, reg.name);
  }
}

function restoreDisabledSnapshot(snap: DisabledMcpRegistration): boolean {
  switch (snap.client) {
    case 'codex':
      return false;
    case 'claude-code':
    case 'claude-desktop':
      return restoreJsonRegistration(snap.configPath, ['mcpServers'], snap);
    case 'openclaw':
      return restoreJsonRegistration(snap.configPath, ['mcp', 'servers'], snap);
    case 'hermes':
      return restoreHermesRegistration(snap.configPath, snap);
  }
}

function registrationExists(snap: DisabledMcpRegistration): boolean {
  switch (snap.client) {
    case 'codex':
      return scanCodex(defaultContext()).some((r) => r.name === snap.name);
    case 'claude-code':
    case 'claude-desktop': {
      const root = readJsonObject(snap.configPath);
      return snap.name in (getNestedObject(root, ['mcpServers'], false) ?? {});
    }
    case 'openclaw': {
      const root = readJsonObject(snap.configPath);
      return snap.name in (getNestedObject(root, ['mcp', 'servers'], false) ?? {});
    }
    case 'hermes': {
      if (!existsSync(snap.configPath)) return false;
      const doc = YAML.parseDocument(readFileSync(snap.configPath, 'utf8'));
      const servers = doc.get('mcp_servers', true);
      return YAML.isMap(servers) && servers.has(snap.name);
    }
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getNestedObject(
  root: Record<string, unknown>,
  path: string[],
  create: boolean,
): Record<string, unknown> | null {
  let cur: Record<string, unknown> = root;
  for (const key of path) {
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (!create) return null;
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  return cur;
}

function removeJsonRegistration(configPath: string, objectPath: string[], name: string): boolean {
  if (!existsSync(configPath)) return false;
  const root = readJsonObject(configPath);
  const servers = getNestedObject(root, objectPath, false);
  if (!servers || !(name in servers)) return false;
  delete servers[name];
  writeJsonAtomic(configPath, root);
  return true;
}

function restoreJsonRegistration(
  configPath: string,
  objectPath: string[],
  snap: DisabledMcpRegistration,
): boolean {
  const root = readJsonObject(configPath);
  const servers = getNestedObject(root, objectPath, true);
  if (!servers || snap.name in servers) return false;
  const server = serverConfigFromSnapshot(snap);
  if (!server) return false;
  servers[snap.name] = server;
  writeJsonAtomic(configPath, root);
  return true;
}

function removeHermesRegistration(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  const doc = YAML.parseDocument(readFileSync(configPath, 'utf8'));
  const servers = doc.get('mcp_servers', true);
  if (!YAML.isMap(servers) || !servers.has(name)) return false;
  servers.delete(name);
  writeFileAtomic(configPath, doc.toString());
  return true;
}

function restoreHermesRegistration(configPath: string, snap: DisabledMcpRegistration): boolean {
  const doc = existsSync(configPath)
    ? YAML.parseDocument(readFileSync(configPath, 'utf8'))
    : YAML.parseDocument('{}\n');
  let servers = doc.get('mcp_servers', true);
  if (!YAML.isMap(servers)) {
    doc.set('mcp_servers', {});
    servers = doc.get('mcp_servers', true);
  }
  if (!YAML.isMap(servers) || servers.has(snap.name)) return false;
  const server = serverConfigFromSnapshot(snap);
  if (!server) return false;
  servers.set(snap.name, server);
  writeFileAtomic(configPath, doc.toString());
  return true;
}

function serverConfigFromSnapshot(snap: DisabledMcpRegistration): Record<string, unknown> | null {
  if (isRecord(snap.server)) return cloneServerConfig(snap.server);
  if (typeof snap.command !== 'string') return null;
  return {
    command: snap.command,
    args: Array.isArray(snap.args) ? [...snap.args] : [],
  };
}

function fallbackServerConfig(reg: McpRegistration): Record<string, unknown> | null {
  if (typeof reg.command !== 'string') return null;
  return {
    command: reg.command,
    args: Array.isArray(reg.args) ? [...reg.args] : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneServerConfig(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function withServerConfig(
  reg: McpRegistration,
  server: Record<string, unknown> | undefined,
): McpRegistration {
  if (!server) return reg;
  Object.defineProperty(reg, 'server', {
    value: cloneServerConfig(server),
    enumerable: false,
    configurable: true,
  });
  return reg;
}

function publicDisabledSnapshot(snap: DisabledMcpRegistration): DisabledMcpRegistration {
  return {
    client: snap.client,
    name: snap.name,
    site: snap.site,
    configPath: snap.configPath,
    scope: snap.scope,
    command: snap.command,
    args: snap.args,
    disabledAt: snap.disabledAt,
  };
}

// ─── Disabled snapshot store ────────────────────────────────────────────────

function disabledStorePath(ctx: MaintenanceContext): string {
  return pathJoin(ctx.imprintHome, '.mcp-disabled.json');
}

function loadDisabledStore(ctx: MaintenanceContext): DisabledStore {
  const path = disabledStorePath(ctx);
  if (!existsSync(path)) return { version: DISABLED_STORE_VERSION, disabled: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DisabledStore;
    return {
      version: raw.version ?? DISABLED_STORE_VERSION,
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
    };
  } catch {
    return { version: DISABLED_STORE_VERSION, disabled: [] };
  }
}

function saveDisabledStore(ctx: MaintenanceContext, store: DisabledStore): void {
  mkdirSync(ctx.imprintHome, { recursive: true });
  writeJsonAtomic(disabledStorePath(ctx), {
    version: DISABLED_STORE_VERSION,
    disabled: store.disabled.sort((a, b) =>
      `${a.client}:${a.name}`.localeCompare(`${b.client}:${b.name}`),
    ),
  });
}

function addDisabledSnapshot(ctx: MaintenanceContext, snap: DisabledMcpRegistration): void {
  const store = loadDisabledStore(ctx);
  store.disabled = store.disabled.filter(
    (d) => !(d.client === snap.client && d.name === snap.name && d.configPath === snap.configPath),
  );
  store.disabled.push(snap);
  saveDisabledStore(ctx, store);
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(pathDirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
}
