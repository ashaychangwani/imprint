import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { defaultPlaywrightBrowsersPath, ensurePlaywrightChromiumInstalled } from './chromium.ts';
import {
  type McpServerConfig,
  PLATFORMS,
  type Platform,
  buildMcpServerConfig,
  buildRegistrationCommand,
  buildUnregistrationCommand,
  detectDirectBunImprintCommand,
  detectImprintCommand,
  generatePasteSnippet,
  shellQuote,
} from './integrations.ts';
import { imprintHomeDir } from './paths.ts';
import { type ResolvedTool, discoverTools } from './tool-loader.ts';
import type { Workflow } from './types.ts';

type InstallSource = 'local' | 'examples';
const installedMcpServerCache = new Map<Platform, InstalledMcpServer[]>();

interface InstallOptions {
  site?: string;
  platform?: Platform;
  source?: InstallSource;
  print?: boolean;
  noInteractive?: boolean;
  skipBrowserInstall?: boolean;
}

interface UninstallOptions {
  site?: string;
  platform?: Platform;
  print?: boolean;
  noInteractive?: boolean;
}

interface InstallableSite {
  source: InstallSource;
  assetRoot: string;
  site: string;
  toolNames: string[];
}

interface InstallResult {
  platform: Platform;
  site: string;
  source: InstallSource;
  assetRoot: string;
  serverName: string;
  message: string;
}

interface UninstallResult {
  platform: Platform;
  site: string;
  serverName: string;
  message: string;
  configPath?: string;
  removed: boolean;
}

type InstallTuiResult =
  | ({ action: 'install' } & InstallResult)
  | ({ action: 'uninstall' } & UninstallResult);

interface InstallTarget {
  source: InstallSource;
  assetRoot: string;
  site: string;
  tools: ResolvedTool[];
  workflows: Workflow[];
}

interface InstalledMcpServer {
  platform: Platform;
  site: string;
  serverName: string;
  configPath?: string;
  source?: string;
}

interface ConfigRemovalResult {
  path: string;
  removed: boolean;
}

function examplesAssetRoot(): string {
  return pathResolve(import.meta.dir, '..', '..', 'examples');
}

function defaultClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return pathJoin(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (process.platform === 'win32') {
    return pathJoin(
      process.env.APPDATA ?? pathJoin(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return pathJoin(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function defaultOpenClawConfigPath(): string {
  return pathJoin(homedir(), '.openclaw', 'openclaw.json');
}

export function defaultHermesConfigPath(): string {
  const explicit = process.env.HERMES_CONFIG?.trim();
  if (explicit) return explicit;
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) return pathJoin(hermesHome, 'config.yaml');
  return pathJoin(homedir(), '.hermes', 'config.yaml');
}

export async function listInstallableSites(
  source: InstallSource,
  assetRoot: string,
  onlySite?: string,
): Promise<InstallableSite[]> {
  const tools = await discoverTools(assetRoot, onlySite, '[imprint install]');
  const grouped = new Map<string, string[]>();
  for (const tool of tools) {
    const toolNames = grouped.get(tool.site) ?? [];
    toolNames.push(tool.workflow.toolName);
    grouped.set(tool.site, toolNames);
  }
  return [...grouped.entries()]
    .map(([site, toolNames]) => ({
      source,
      assetRoot,
      site,
      toolNames: toolNames.sort(),
    }))
    .sort((a, b) => `${a.source}:${a.site}`.localeCompare(`${b.source}:${b.site}`));
}

export function installMcpConfigFile(
  platform: 'claude-desktop' | 'openclaw' | 'hermes',
  server: McpServerConfig,
  configPath?: string,
): string {
  switch (platform) {
    case 'claude-desktop': {
      const outPath = configPath ?? defaultClaudeDesktopConfigPath();
      upsertJsonConfig(outPath, (config) => {
        const root = asRecord(config);
        const mcpServers = asRecord(root.mcpServers);
        mcpServers[server.name] = mcpServerJson(server);
        root.mcpServers = mcpServers;
        return root;
      });
      return outPath;
    }
    case 'openclaw': {
      const outPath = configPath ?? defaultOpenClawConfigPath();
      upsertJsonConfig(outPath, (config) => {
        const root = asRecord(config);
        const mcp = asRecord(root.mcp);
        const servers = asRecord(mcp.servers);
        servers[server.name] = mcpServerJson(server);
        mcp.servers = servers;
        root.mcp = mcp;
        return root;
      });
      return outPath;
    }
    case 'hermes': {
      const outPath = configPath ?? defaultHermesConfigPath();
      const parsed = readYamlRecord(outPath);
      const mcpServers = asRecord(parsed.mcp_servers);
      mcpServers[server.name] = mcpServerJson(server);
      parsed.mcp_servers = mcpServers;
      writeConfigFile(outPath, yamlStringify(parsed, { lineWidth: 0 }));
      return outPath;
    }
  }
}

export function uninstallMcpConfigFile(
  platform: 'claude-desktop' | 'openclaw' | 'hermes',
  serverName: string,
  configPath?: string,
): ConfigRemovalResult {
  switch (platform) {
    case 'claude-desktop': {
      const outPath = configPath ?? defaultClaudeDesktopConfigPath();
      const removed = deleteJsonConfig(outPath, (config) => {
        const root = asRecord(config);
        const mcpServers = asRecord(root.mcpServers);
        const existed = Object.hasOwn(mcpServers, serverName);
        if (existed) delete mcpServers[serverName];
        root.mcpServers = mcpServers;
        return { config: root, removed: existed };
      });
      return { path: outPath, removed };
    }
    case 'openclaw': {
      const outPath = configPath ?? defaultOpenClawConfigPath();
      const removed = deleteJsonConfig(outPath, (config) => {
        const root = asRecord(config);
        const mcp = asRecord(root.mcp);
        const servers = asRecord(mcp.servers);
        const existed = Object.hasOwn(servers, serverName);
        if (existed) delete servers[serverName];
        mcp.servers = servers;
        root.mcp = mcp;
        return { config: root, removed: existed };
      });
      return { path: outPath, removed };
    }
    case 'hermes': {
      const outPath = configPath ?? defaultHermesConfigPath();
      if (!existsSync(outPath)) return { path: outPath, removed: false };
      const parsed = readYamlRecord(outPath);
      const mcpServers = asRecord(parsed.mcp_servers);
      const removed = Object.hasOwn(mcpServers, serverName);
      if (removed) {
        delete mcpServers[serverName];
        parsed.mcp_servers = mcpServers;
        writeConfigFile(outPath, yamlStringify(parsed, { lineWidth: 0 }));
      }
      return { path: outPath, removed };
    }
  }
}

export async function installTui(): Promise<InstallTuiResult> {
  const action = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'install' as const, label: 'Install an emitted MCP server' },
      { value: 'uninstall' as const, label: 'Uninstall an MCP server' },
    ],
  });
  if (p.isCancel(action)) {
    p.outro('Cancelled.');
    process.exit(0);
  }

  if (action === 'uninstall') {
    return { action: 'uninstall', ...(await uninstall({})) };
  }
  return { action: 'install', ...(await install({})) };
}

export async function install(opts: InstallOptions = {}): Promise<InstallResult> {
  const target = await resolveInstallTarget(opts);
  const platform = await resolveInstallPlatform(opts);
  const imprintCommand = configFilePlatform(platform)
    ? detectDirectBunImprintCommand()
    : detectImprintCommand();
  const env = buildInstallEnvironment(target);
  const workflow = target.workflows[0];
  if (!workflow) {
    throw new Error(`No emitted workflows found for ${target.site}. Run \`imprint emit\` first.`);
  }
  const server = buildMcpServerConfig({
    site: target.site,
    imprintCommand,
    env,
  });

  if (opts.print) {
    console.log(
      generatePasteSnippet({
        site: target.site,
        workflow,
        workflows: target.workflows,
        platform,
        imprintCommand,
        env,
      }),
    );
    return {
      platform,
      site: target.site,
      source: target.source,
      assetRoot: target.assetRoot,
      serverName: server.name,
      message: `Printed ${server.name} ${platform} configuration.`,
    };
  }

  if (!opts.skipBrowserInstall) {
    ensureBrowserRuntimeForInstall(target);
  }

  const regCommand = buildRegistrationCommand({
    site: target.site,
    platform,
    imprintCommand,
    env,
  });

  let message: string;
  if (regCommand) {
    runRegistrationCommand(platform, server.name, regCommand);
    message = `${server.name} installed in ${formatPlatform(platform)}.`;
  } else {
    const configPath = installMcpConfigFile(
      platform as 'claude-desktop' | 'openclaw' | 'hermes',
      server,
    );
    message = `${server.name} installed in ${formatPlatform(platform)} config: ${configPath}`;
  }

  installedMcpServerCache.delete(platform);
  return {
    platform,
    site: target.site,
    source: target.source,
    assetRoot: target.assetRoot,
    serverName: server.name,
    message,
  };
}

export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const platform = await resolveInstallPlatform(
    opts,
    'Uninstall this MCP server from where?',
    'uninstall',
  );
  const site = await resolveUninstallSite(opts, platform);
  const serverName = serverNameForSite(site);

  if (opts.print) {
    console.log(generateUninstallSnippet(platform, site));
    return {
      platform,
      site,
      serverName,
      message: `Printed ${serverName} ${formatPlatform(platform)} uninstall instructions.`,
      removed: false,
    };
  }

  const command = buildUnregistrationCommand({ site, platform });
  let removed = true;
  let configPath: string | undefined;
  let message: string;
  if (command) {
    runUnregistrationCommand(serverName, command);
    message = `${serverName} uninstalled from ${formatPlatform(platform)}.`;
  } else {
    const result = uninstallMcpConfigFile(
      platform as 'claude-desktop' | 'openclaw' | 'hermes',
      serverName,
    );
    removed = result.removed;
    configPath = result.path;
    message = removed
      ? `${serverName} uninstalled from ${formatPlatform(platform)} config: ${result.path}`
      : `${serverName} was not installed in ${formatPlatform(platform)} config: ${result.path}`;
  }

  installedMcpServerCache.delete(platform);
  return { platform, site, serverName, message, configPath, removed };
}

async function resolveInstallTarget(opts: InstallOptions): Promise<InstallTarget> {
  const localRoot = imprintHomeDir();
  const roots = [
    { source: 'local' as const, assetRoot: localRoot },
    { source: 'examples' as const, assetRoot: examplesAssetRoot() },
  ].filter((root) => !opts.source || root.source === opts.source);

  const sites = (
    await Promise.all(
      roots.map((root) => listInstallableSites(root.source, root.assetRoot, opts.site)),
    )
  ).flat();
  let selected: InstallableSite | undefined;

  if (opts.site) {
    const matches = sites.filter((site) => site.site === opts.site);
    selected =
      matches.find((match) => match.source === 'local') ??
      matches.find((match) => match.source === 'examples');
    if (!selected) {
      const sourceHint = opts.source ? ` in ${opts.source}` : '';
      throw new Error(
        `No emitted tools found for site "${opts.site}"${sourceHint}. Run \`imprint emit\` first, or install a checked-in example with \`imprint install ${opts.site} --source examples\`.`,
      );
    }
  } else {
    if (opts.noInteractive) {
      throw new Error('`imprint install --no-interactive` requires a <site> argument.');
    }
    if (sites.length === 0) {
      throw new Error(
        'No emitted tools found. Run `imprint teach <site>` or `imprint emit <workflow.json>` first.',
      );
    }
    const choice = await p.select({
      message: 'Which emitted MCP server should be installed?',
      options: sites.map((site) => ({
        value: `${site.source}:${site.site}`,
        label: `${site.site} (${site.source}, ${site.toolNames.length} tool${site.toolNames.length === 1 ? '' : 's'})`,
      })),
    });
    if (p.isCancel(choice)) {
      p.outro('Cancelled.');
      process.exit(0);
    }
    const [source, site] = String(choice).split(':') as [InstallSource, string];
    selected = sites.find((entry) => entry.source === source && entry.site === site);
  }

  if (!selected) throw new Error('No emitted MCP server selected.');
  const tools = await discoverTools(selected.assetRoot, selected.site, '[imprint install]');
  const workflows = tools.map((tool) => tool.workflow);
  if (workflows.length === 0) {
    throw new Error(
      `No loadable emitted tools found for site "${selected.site}" at ${selected.assetRoot}.`,
    );
  }

  return {
    source: selected.source,
    assetRoot: selected.assetRoot,
    site: selected.site,
    tools,
    workflows,
  };
}

function buildInstallEnvironment(target: InstallTarget): Record<string, string> {
  const env: Record<string, string> = { IMPRINT_HOME: target.assetRoot };
  const browsersPath = defaultPlaywrightBrowsersPath();
  if (browsersPath && installTargetNeedsBrowserRuntime(target)) {
    env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
  return env;
}

function ensureBrowserRuntimeForInstall(target: InstallTarget): void {
  if (!installTargetNeedsBrowserRuntime(target)) return;
  const result = ensurePlaywrightChromiumInstalled({
    log: (message) => process.stderr.write(`[imprint install] ${message}\n`),
  });
  if (result.installed) {
    process.stderr.write(`[imprint install] installed Playwright Chromium at ${result.path}\n`);
  }
}

function installTargetNeedsBrowserRuntime(target: InstallTarget): boolean {
  return target.tools.some(
    (tool) => workflowNeedsBrowserRuntime(tool.workflow) || toolDirNeedsBrowserRuntime(tool.dir),
  );
}

function workflowNeedsBrowserRuntime(workflow: Workflow): boolean {
  if (workflow.bootstrap) return true;
  if (workflow.liveVerified === false && workflow.liveVerifiedWaiver?.kind === 'waived-bot') {
    return true;
  }
  if (workflow.requests.some((request) => request.url.includes('${state.'))) return true;
  return workflow.requests.some((request) =>
    (request.captures ?? []).some((capture) => captureNeedsBrowserRuntime(capture.capability)),
  );
}

function toolDirNeedsBrowserRuntime(toolDir: string): boolean {
  if (existsSync(pathJoin(toolDir, 'playbook.yaml'))) return true;
  const backendsPath = pathJoin(toolDir, 'backends.json');
  if (!existsSync(backendsPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(backendsPath, 'utf8')) as { preferredOrder?: unknown };
    if (!Array.isArray(parsed.preferredOrder)) return false;
    return parsed.preferredOrder.some(
      (backend) =>
        typeof backend === 'string' &&
        ['fetch-bootstrap', 'cdp-replay', 'stealth-fetch', 'playbook'].includes(backend),
    );
  } catch {
    return false;
  }
}

function captureNeedsBrowserRuntime(capability: string | undefined): boolean {
  return capability === 'browser_bootstrap' || capability === 'stealth_bootstrap';
}

async function resolveInstallPlatform(
  opts: Pick<InstallOptions, 'platform' | 'noInteractive'>,
  message = 'Install this MCP server where?',
  verb = 'install',
): Promise<Platform> {
  if (opts.platform) return opts.platform;
  if (opts.noInteractive) {
    throw new Error(`\`imprint ${verb} --no-interactive\` requires --platform <name>.`);
  }
  const platformOptions =
    verb === 'uninstall' ? listDetectedPlatformsWithInstalledServers() : listDetectedPlatforms();
  if (platformOptions.length === 0) {
    const intent =
      verb === 'uninstall'
        ? 'No installed Imprint MCP servers were found in detected AI platforms.'
        : 'No supported AI platforms were detected on this system.';
    throw new Error(`${intent} Pass --platform <name> to target a platform explicitly.`);
  }
  const choice = await p.select({
    message,
    options: platformOptions.map((platform) => ({
      value: platform,
      label: platformOptionLabel(platform, verb),
    })),
  });
  if (p.isCancel(choice)) {
    p.outro('Cancelled.');
    process.exit(0);
  }
  return choice as Platform;
}

async function resolveUninstallSite(opts: UninstallOptions, platform: Platform): Promise<string> {
  if (opts.site) return normalizeSiteInput(opts.site);
  if (opts.noInteractive) {
    throw new Error('`imprint uninstall --no-interactive` requires a <site> argument.');
  }

  const installed = listInstalledMcpServers(platform);
  if (installed.length > 0) {
    const choice = await p.select({
      message: `Which MCP server should be uninstalled from ${formatPlatform(platform)}?`,
      options: installed.map((server) => ({
        value: server.site,
        label: server.serverName,
      })),
    });
    if (p.isCancel(choice)) {
      p.outro('Cancelled.');
      process.exit(0);
    }
    return String(choice);
  }
  throw new Error(`No installed Imprint MCP servers found in ${formatPlatform(platform)}.`);
}

function runRegistrationCommand(platform: Platform, serverName: string, command: string[]): void {
  const result = Bun.spawnSync(command, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode === 0) return;

  const output = `${result.stderr.toString()}\n${result.stdout.toString()}`;
  if (output.includes('already exists')) {
    const removeCommand =
      platform === 'claude-code'
        ? ['claude', 'mcp', 'remove', '--scope', 'user', serverName]
        : platform === 'codex'
          ? ['codex', 'mcp', 'remove', serverName]
          : null;
    if (removeCommand) {
      Bun.spawnSync(removeCommand, { stdio: ['ignore', 'ignore', 'ignore'] });
      const retry = Bun.spawnSync(command, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (retry.exitCode === 0) return;
      throw new Error(retry.stderr.toString().trim() || `Command exited with ${retry.exitCode}`);
    }
  }

  throw new Error(output.trim() || `Command exited with ${result.exitCode}`);
}

function runUnregistrationCommand(serverName: string, command: string[]): void {
  const result = Bun.spawnSync(command, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode === 0) return;

  const output = `${result.stderr.toString()}\n${result.stdout.toString()}`.trim();
  if (isAlreadyAbsent(output)) return;
  throw new Error(
    output || `Failed to remove ${serverName}; command exited with ${result.exitCode}`,
  );
}

function upsertJsonConfig(
  path: string,
  update: (config: unknown) => Record<string, unknown>,
): void {
  let parsed: unknown = {};
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(
        `Config at ${path} contains invalid JSON — fix it manually or delete it and retry.`,
      );
    }
  }
  writeConfigFile(path, `${JSON.stringify(update(parsed), null, 2)}\n`);
}

function deleteJsonConfig(
  path: string,
  update: (config: unknown) => { config: Record<string, unknown>; removed: boolean },
): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `Config at ${path} contains invalid JSON — fix it manually or delete it and retry.`,
    );
  }
  const result = update(parsed);
  if (result.removed) writeConfigFile(path, `${JSON.stringify(result.config, null, 2)}\n`);
  return result.removed;
}

function readYamlRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `Config at ${path} contains invalid YAML — fix it manually or delete it and retry.`,
    );
  }
  return asRecord(parsed);
}

function writeConfigFile(path: string, contents: string): void {
  mkdirSync(pathDirname(path), { recursive: true });
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mcpServerJson(server: McpServerConfig): Record<string, unknown> {
  return {
    command: server.command,
    args: server.args,
    ...(server.env ? { env: server.env } : {}),
  };
}

function listInstalledMcpServers(platform: Platform): InstalledMcpServer[] {
  const cached = installedMcpServerCache.get(platform);
  if (cached) return [...cached];

  const servers = (() => {
    switch (platform) {
      case 'claude-code':
        return listCliInstalledServers(platform, ['claude', 'mcp', 'list']);
      case 'codex':
        return listCliInstalledServers(platform, ['codex', 'mcp', 'list']);
      case 'claude-desktop':
        return listJsonInstalledServers(platform, defaultClaudeDesktopConfigPath(), (root) =>
          asRecord(root.mcpServers),
        );
      case 'openclaw':
        return listJsonInstalledServers(platform, defaultOpenClawConfigPath(), (root) =>
          asRecord(asRecord(root.mcp).servers),
        );
      case 'hermes': {
        const configPath = defaultHermesConfigPath();
        if (!existsSync(configPath)) return [];
        try {
          const parsed = readYamlRecord(configPath);
          return serverNamesFromRecord(platform, configPath, asRecord(parsed.mcp_servers));
        } catch {
          return [];
        }
      }
    }
  })();
  installedMcpServerCache.set(platform, servers);
  return [...servers];
}

export function parseInstalledMcpServers(
  platform: 'claude-code' | 'codex',
  output: string,
): InstalledMcpServer[] {
  switch (platform) {
    case 'claude-code':
      return [...output.matchAll(/^((?:imprint-)[^:\s]+):/gm)].map((match) =>
        installedServerFromName(platform, match[1] ?? '', 'claude mcp list'),
      );
    case 'codex':
      return output
        .split(/\r?\n/)
        .map((line) => line.match(/^(imprint-[^\s]+)/)?.[1])
        .filter((serverName): serverName is string => !!serverName)
        .map((serverName) => installedServerFromName(platform, serverName, 'codex mcp list'));
  }
}

function listDetectedPlatforms(): Platform[] {
  return PLATFORMS.filter(isPlatformDetected);
}

function listDetectedPlatformsWithInstalledServers(): Platform[] {
  return listDetectedPlatforms().filter((platform) => listInstalledMcpServers(platform).length > 0);
}

function isPlatformDetected(platform: Platform): boolean {
  switch (platform) {
    case 'claude-code':
      return commandExists('claude');
    case 'codex':
      return commandExists('codex');
    case 'claude-desktop':
      return (
        existsSync(defaultClaudeDesktopConfigPath()) ||
        (process.platform === 'darwin' && existsSync('/Applications/Claude.app'))
      );
    case 'openclaw':
      return commandExists('openclaw') || existsSync(pathJoin(homedir(), '.openclaw'));
    case 'hermes':
      return (
        commandExists('hermes') ||
        Boolean(process.env.HERMES_CONFIG?.trim()) ||
        Boolean(process.env.HERMES_HOME?.trim()) ||
        existsSync(defaultHermesConfigPath()) ||
        existsSync(pathJoin(homedir(), '.hermes'))
      );
  }
}

function commandExists(command: string): boolean {
  return (
    Bun.spawnSync(['which', command], { stdio: ['ignore', 'ignore', 'ignore'] }).exitCode === 0
  );
}

function platformOptionLabel(platform: Platform, verb: string): string {
  const label = formatPlatform(platform);
  if (verb !== 'uninstall') return label;
  const count = listInstalledMcpServers(platform).length;
  return `${label} (${count} Imprint MCP${count === 1 ? '' : 's'})`;
}

function listCliInstalledServers(
  platform: 'claude-code' | 'codex',
  command: string[],
): InstalledMcpServer[] {
  const result = Bun.spawnSync(command, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode !== 0) return [];
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  return parseInstalledMcpServers(platform, output);
}

function listJsonInstalledServers(
  platform: Platform,
  configPath: string,
  selectServers: (root: Record<string, unknown>) => Record<string, unknown>,
): InstalledMcpServer[] {
  if (!existsSync(configPath)) return [];
  try {
    const root = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
    return serverNamesFromRecord(platform, configPath, selectServers(root));
  } catch {
    return [];
  }
}

function serverNamesFromRecord(
  platform: Platform,
  configPath: string,
  servers: Record<string, unknown>,
): InstalledMcpServer[] {
  return Object.keys(servers)
    .filter((serverName) => serverName.startsWith('imprint-'))
    .sort()
    .map((serverName) => ({
      platform,
      site: serverName.slice('imprint-'.length),
      serverName,
      configPath,
    }));
}

function installedServerFromName(
  platform: Platform,
  serverName: string,
  source?: string,
): InstalledMcpServer {
  return {
    platform,
    site: serverName.slice('imprint-'.length),
    serverName,
    ...(source ? { source } : {}),
  };
}

function generateUninstallSnippet(platform: Platform, site: string): string {
  const command = buildUnregistrationCommand({ site, platform });
  const serverName = serverNameForSite(site);
  if (command) {
    return `Remove the ${serverName} tool: run \`${command.map(shellQuote).join(' ')}\`.`;
  }

  switch (platform) {
    case 'claude-desktop':
      return `Remove "${serverName}" from ~/Library/Application Support/Claude/claude_desktop_config.json under "mcpServers".`;
    case 'openclaw':
      return `Remove "${serverName}" from ~/.openclaw/openclaw.json under mcp.servers.`;
    case 'hermes':
      return `Remove "${serverName}" from ~/.hermes/config.yaml under mcp_servers.`;
    case 'claude-code':
    case 'codex':
      throw new Error(`Missing uninstall command for ${platform}.`);
  }
}

function configFilePlatform(platform: Platform): boolean {
  return platform === 'claude-desktop' || platform === 'openclaw' || platform === 'hermes';
}

function serverNameForSite(site: string): string {
  return `imprint-${normalizeSiteInput(site)}`;
}

const VALID_SITE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeSiteInput(value: string): string {
  const trimmed = value.trim();
  const site = trimmed.startsWith('imprint-') ? trimmed.slice('imprint-'.length) : trimmed;
  if (!VALID_SITE_NAME.test(site)) {
    throw new Error(
      `Invalid site name "${site}" — must be lowercase alphanumeric with dots, underscores, or hyphens (e.g. "google-flights").`,
    );
  }
  return site;
}

function isAlreadyAbsent(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('not found') ||
    lower.includes('does not exist') ||
    lower.includes('no such') ||
    lower.includes('unknown server')
  );
}

function formatPlatform(platform: Platform): string {
  switch (platform) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'openclaw':
      return 'OpenClaw';
    case 'hermes':
      return 'Hermes';
  }
}
