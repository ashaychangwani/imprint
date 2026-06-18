import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import YAML from 'yaml';
import {
  disableMcpTarget,
  enableMcpTarget,
  runMcpCommand,
  scanMcpStatus,
  setCodexEnabled,
} from '../src/imprint/mcp-maintenance.ts';

function withTemp<T>(
  fn: (ctx: { root: string; home: string; cwd: string; imprint: string }) => T,
): T {
  const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-mcp-maint-'));
  const home = pathJoin(root, 'home');
  const cwd = pathJoin(root, 'project');
  const imprint = pathJoin(root, 'imprint-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(imprint, { recursive: true });
  const oldImprintHome = process.env.IMPRINT_HOME;
  const oldHermesConfig = process.env.HERMES_CONFIG;
  const oldHermesHome = process.env.HERMES_HOME;
  process.env.IMPRINT_HOME = imprint;
  Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
  Reflect.deleteProperty(process.env, 'HERMES_HOME');
  try {
    return fn({ root, home, cwd, imprint });
  } finally {
    if (oldImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
    else process.env.IMPRINT_HOME = oldImprintHome;
    if (oldHermesConfig === undefined) Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
    else process.env.HERMES_CONFIG = oldHermesConfig;
    if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
    else process.env.HERMES_HOME = oldHermesHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(pathJoin(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFile(path: string, value: string): void {
  mkdirSync(pathJoin(path, '..'), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function seedLocalSite(imprint: string): void {
  const site = pathJoin(imprint, 'demo');
  mkdirSync(pathJoin(site, 'sessions'), { recursive: true });
  writeFile(pathJoin(site, 'sessions', 'one.json'), '{}\n');
  writeFile(pathJoin(site, 'sessions', 'one.jsonl'), '{}\n');
  writeFile(pathJoin(site, 'sessions', 'one.redacted.json'), '{}\n');
  writeFile(pathJoin(site, 'sessions', 'orphan.json'), '{}\n');
  writeFile(pathJoin(site, 'sessions', 'orphan.jsonl'), '{}\n');
  writeFile(pathJoin(site, 'search_demo', 'index.ts'), 'export const x = 1;\n');
  writeJson(pathJoin(site, 'search_demo', 'workflow.json'), { toolName: 'search_demo' });
  writeJson(pathJoin(site, '.teach-state.json'), {
    workflows: {
      search_demo: {
        sessionPath: 'sessions/one.json',
        redactedPath: 'sessions/one.redacted.json',
        completedSteps: ['record', 'redact', 'generate', 'compile-playbook', 'emit', 'register'],
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      pending: {
        sessionPath: 'sessions/one.json',
        redactedPath: 'sessions/one.redacted.json',
        completedSteps: ['record', 'redact'],
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      missing_recording: {
        sessionPath: 'sessions/missing.json',
        completedSteps: ['record'],
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    },
  });
}

describe('mcp maintenance status', () => {
  it('reports complete, incomplete, missing-session, and stale-registration states', () => {
    withTemp(({ home, cwd, imprint }) => {
      seedLocalSite(imprint);
      writeFile(
        pathJoin(home, '.codex', 'config.toml'),
        [
          'model = "gpt-5.5"',
          '',
          '[mcp_servers.imprint-stale]',
          'command = "imprint"',
          'args = ["mcp-server", "stale"]',
          '',
          '[mcp_servers.not_imprint]',
          'command = "node"',
          'args = ["server.js"]',
          '',
        ].join('\n'),
      );

      const status = scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint });
      expect(status.registrations.map((r) => r.name)).toEqual(['imprint-stale']);
      expect(status.sites.find((s) => s.site === 'demo')?.tools[0]?.complete).toBe(true);
      expect(status.issues.map((i) => i.kind)).not.toContain('incomplete');
      expect(status.issues.map((i) => i.kind)).toContain('missing-session');
      expect(status.issues.map((i) => i.kind)).toContain('stale-registration');

      const json = JSON.parse(JSON.stringify(status)) as typeof status;
      expect(Array.isArray(json.registrations)).toBe(true);
      expect(Array.isArray(json.issues)).toBe(true);
    });
  });

  it('never treats untracked recordings as an issue and leaves them on disk', () => {
    withTemp(({ home, cwd, imprint }) => {
      seedLocalSite(imprint);

      const status = scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint });

      // Orphan recordings (untracked sessions) are out of scope for `imprint mcp`:
      // the recording is the irreplaceable source artifact, never a cleanup target.
      // No orphan inventory or issue is surfaced anywhere in the status payload.
      const orphanJsonl = pathJoin(imprint, 'demo', 'sessions', 'orphan.jsonl');
      const orphanJson = pathJoin(imprint, 'demo', 'sessions', 'orphan.json');
      expect(status.issues.some((i) => i.path === orphanJsonl || i.path === orphanJson)).toBe(
        false,
      );
      expect(JSON.stringify(status)).not.toContain('orphan');
      // The recordings are untouched on disk.
      expect(existsSync(orphanJsonl)).toBe(true);
      expect(existsSync(orphanJson)).toBe(true);
    });
  });

  it('reports stale backend caches as actionable MCP status issues', () => {
    withTemp(({ home, cwd, imprint }) => {
      const dir = pathJoin(imprint, 'demo', 'search_demo');
      mkdirSync(dir, { recursive: true });
      writeFile(pathJoin(dir, 'index.ts'), 'export const x = 1;\n');
      writeJson(pathJoin(dir, 'workflow.json'), {
        toolName: 'search_demo',
        intent: { description: 'x' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
        site: 'demo',
      });
      writeJson(pathJoin(dir, 'backends.json'), {
        probedAt: '2026-05-03T22:00:00.000Z',
        imprintVersion: '0.1.0',
        schemaVersion: 2,
        workflowHash: createHash('sha256')
          .update(JSON.stringify({ old: true }))
          .digest('hex'),
        capabilityHash: 'old',
        preferredOrder: ['stealth-fetch'],
        results: { 'stealth-fetch': { outcome: 'ok', durationMs: 9000 } },
      });

      const status = scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint });

      expect(status.sites[0]?.tools[0]?.backendCache.status).toBe('stale');
      expect(status.issues.map((i) => i.kind)).toContain('stale-backends');
      expect(status.issues.find((i) => i.kind === 'stale-backends')?.message).toContain(
        'runtime will fall back to the default ladder',
      );
    });
  });
});

describe('mcp maintenance adapters', () => {
  it('toggles Codex enabled while preserving unrelated TOML config', () => {
    withTemp(({ home }) => {
      const config = pathJoin(home, '.codex', 'config.toml');
      writeFile(
        config,
        [
          'model = "gpt-5.5"',
          '',
          '[mcp_servers.imprint-demo]',
          'command = "imprint"',
          'args = ["mcp-server", "demo"]',
          '',
          '[notice]',
          'hide_full_access_warning = true',
          '',
        ].join('\n'),
      );

      expect(setCodexEnabled(config, 'imprint-demo', false)).toBe(true);
      let src = readFileSync(config, 'utf8');
      expect(src).toContain('model = "gpt-5.5"');
      expect(src).toContain('[notice]');
      expect(src).toContain('enabled = false');

      expect(setCodexEnabled(config, 'imprint-demo', true)).toBe(true);
      src = readFileSync(config, 'utf8');
      expect(src).toContain('enabled = true');
    });
  });

  it('scans Codex user and project configs without claiming unrelated Bun servers', () => {
    withTemp(({ home, cwd, imprint }) => {
      const userConfig = pathJoin(home, '.codex', 'config.toml');
      const projectConfig = pathJoin(cwd, '.codex', 'config.toml');
      writeFile(
        userConfig,
        [
          '[mcp_servers.imprint-user]',
          'command = "imprint"',
          'args = ["mcp-server", "user"]',
          '',
        ].join('\n'),
      );
      writeFile(
        projectConfig,
        [
          '[mcp_servers.imprint-project]',
          'command = "bun"',
          'args = ["run", "/repo/src/cli.ts", "mcp-server", "project"]',
          '',
          '[mcp_servers.imprint-project.env]',
          'TOKEN = "value"',
          '',
          '[mcp_servers.imprint-project.tools.search_project]',
          'description = "nested tool metadata"',
          '',
          '[mcp_servers.other]',
          'command = "bun"',
          'args = ["mcp-server", "not-imprint"]',
          '',
        ].join('\n'),
      );

      const status = scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint });
      expect(status.registrations.map((r) => `${r.scope}:${r.name}`).sort()).toEqual([
        'project:imprint-project',
        'user:imprint-user',
      ]);

      const disabled = disableMcpTarget('project', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'codex',
      });
      expect(disabled.changed).toEqual(['disabled codex/imprint-project']);
      expect(readFileSync(projectConfig, 'utf8')).toContain('enabled = false');
      expect(readFileSync(userConfig, 'utf8')).not.toContain('enabled = false');
    });
  });

  it('removes and restores Claude Code project MCP JSON entries only for Imprint', () => {
    withTemp(({ cwd, home, imprint }) => {
      const config = pathJoin(cwd, '.mcp.json');
      const imprintServer = {
        command: 'imprint',
        args: ['mcp-server', 'demo'],
        env: { IMPRINT_TOKEN: 'fixture-token' },
        cwd: '/tmp/imprint-demo',
      };
      writeJson(config, {
        mcpServers: {
          'imprint-demo': imprintServer,
          other: { command: 'node', args: ['server.js'] },
        },
      });
      expect(
        JSON.stringify(scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint })),
      ).not.toContain('fixture-token');

      const disabled = disableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'claude-code',
      });
      expect(disabled.changed).toContain('disabled claude-code/imprint-demo');
      expect(JSON.parse(readFileSync(config, 'utf8')).mcpServers).toEqual({
        other: { command: 'node', args: ['server.js'] },
      });
      const store = JSON.parse(readFileSync(pathJoin(imprint, '.mcp-disabled.json'), 'utf8'));
      expect(store.disabled[0].server).toEqual(imprintServer);
      expect(
        JSON.stringify(scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint })),
      ).not.toContain('fixture-token');

      const enabled = enableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'claude-code',
      });
      expect(enabled.changed).toContain('enabled claude-code/imprint-demo');
      expect(JSON.parse(readFileSync(config, 'utf8')).mcpServers['imprint-demo']).toEqual(
        imprintServer,
      );
    });
  });

  it('removes and restores Claude Desktop and OpenClaw JSON entries only for Imprint', () => {
    withTemp(({ home, cwd, imprint }) => {
      const desktop = pathJoin(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      );
      const openclaw = pathJoin(home, '.openclaw', 'openclaw.json');
      writeJson(desktop, {
        mcpServers: {
          'imprint-demo': {
            command: 'imprint',
            args: ['mcp-server', 'demo'],
            env: { DESKTOP_TOKEN: 'fixture-desktop-token' },
            cwd: '/tmp/desktop-demo',
          },
          other: { command: 'node', args: [] },
        },
      });
      writeJson(openclaw, {
        mcp: {
          servers: {
            'imprint-demo': {
              command: 'imprint',
              args: ['mcp-server', 'demo'],
              env: { OPENCLAW_TOKEN: 'fixture-openclaw-token' },
              cwd: '/tmp/openclaw-demo',
            },
            other: { command: 'node', args: [] },
          },
        },
      });

      disableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'claude-desktop',
      });
      disableMcpTarget('demo', { homeDir: home, cwd, imprintHome: imprint, client: 'openclaw' });
      expect(JSON.parse(readFileSync(desktop, 'utf8')).mcpServers.other).toBeDefined();
      expect(JSON.parse(readFileSync(desktop, 'utf8')).mcpServers['imprint-demo']).toBeUndefined();
      expect(JSON.parse(readFileSync(openclaw, 'utf8')).mcp.servers.other).toBeDefined();
      expect(
        JSON.parse(readFileSync(openclaw, 'utf8')).mcp.servers['imprint-demo'],
      ).toBeUndefined();

      enableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'claude-desktop',
      });
      enableMcpTarget('demo', { homeDir: home, cwd, imprintHome: imprint, client: 'openclaw' });
      expect(JSON.parse(readFileSync(desktop, 'utf8')).mcpServers['imprint-demo'].env).toEqual({
        DESKTOP_TOKEN: 'fixture-desktop-token',
      });
      expect(JSON.parse(readFileSync(openclaw, 'utf8')).mcp.servers['imprint-demo'].cwd).toBe(
        '/tmp/openclaw-demo',
      );
    });
  });

  it('removes and restores Hermes YAML entries while preserving unrelated keys', () => {
    withTemp(({ home, cwd, imprint }) => {
      const config = pathJoin(home, '.hermes', 'config.yaml');
      writeFile(
        config,
        [
          'theme: dark',
          'mcp_servers:',
          '  imprint-demo:',
          '    command: imprint',
          '    args: ["mcp-server", "demo"]',
          '    env:',
          '      HERMES_TOKEN: fixture-hermes-token',
          '    cwd: /tmp/hermes-demo',
          '  other:',
          '    command: node',
          '    args: []',
          '',
        ].join('\n'),
      );

      const disabled = disableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'hermes',
      });
      expect(disabled.changed).toContain('disabled hermes/imprint-demo');
      let src = readFileSync(config, 'utf8');
      expect(src).toContain('theme: dark');
      expect(src).toContain('other:');
      expect(src).not.toContain('imprint-demo:');

      const enabled = enableMcpTarget('demo', {
        homeDir: home,
        cwd,
        imprintHome: imprint,
        client: 'hermes',
      });
      expect(enabled.changed).toContain('enabled hermes/imprint-demo');
      src = readFileSync(config, 'utf8');
      expect(src).toContain('theme: dark');
      expect(src).toContain('imprint-demo:');
      const parsed = YAML.parse(src) as { mcp_servers: Record<string, unknown> };
      expect(parsed.mcp_servers['imprint-demo']).toEqual({
        command: 'imprint',
        args: ['mcp-server', 'demo'],
        env: { HERMES_TOKEN: 'fixture-hermes-token' },
        cwd: '/tmp/hermes-demo',
      });
    });
  });

  it('uses HERMES_HOME/config.yaml when scanning Hermes registrations', () => {
    withTemp(({ root, home, cwd, imprint }) => {
      const hermesHome = pathJoin(root, 'hermes-runtime');
      const config = pathJoin(hermesHome, 'config.yaml');
      process.env.HERMES_HOME = hermesHome;
      writeFile(
        config,
        [
          'mcp_servers:',
          '  imprint-demo:',
          '    command: imprint',
          '    args: ["mcp-server", "demo"]',
          '',
        ].join('\n'),
      );

      const status = scanMcpStatus({ homeDir: home, cwd, imprintHome: imprint });

      expect(status.registrations.find((r) => r.client === 'hermes')?.configPath).toBe(config);
      expect(status.registrations.map((r) => r.name)).toContain('imprint-demo');
    });
  });
});

describe('mcp maintenance direct mode guardrails', () => {
  it('refuses delete and prune-state mutations without --yes', async () => {
    await withTemp(async () => {
      expect(await runMcpCommand(['delete', 'imprint-demo'])).toBe(2);
      expect(await runMcpCommand(['prune-state'])).toBe(2);
    });
  });

  it('can prune stale teach state with --yes', () => {
    withTemp(({ imprint }) => {
      seedLocalSite(imprint);
      const statePath = pathResolve(imprint, 'demo', '.teach-state.json');
      expect(readFileSync(statePath, 'utf8')).toContain('pending');
      const code = Bun.spawnSync({
        cmd: [
          'bun',
          'run',
          'src/cli.ts',
          'mcp',
          'prune-state',
          '--site',
          'demo',
          '--incomplete',
          '--yes',
        ],
        cwd: pathResolve(import.meta.dir, '..'),
        env: { ...process.env, IMPRINT_HOME: imprint },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(code.exitCode).toBe(0);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.workflows.pending).toBeUndefined();
      expect(state.workflows.search_demo).toBeDefined();
    });
  });

  it('can delete local tool artifacts without an active registration when --local is explicit', () => {
    withTemp(({ imprint }) => {
      seedLocalSite(imprint);
      const code = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'mcp', 'delete', 'demo', '--local', 'tool', '--yes'],
        cwd: pathResolve(import.meta.dir, '..'),
        env: { ...process.env, IMPRINT_HOME: imprint },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(code.exitCode).toBe(0);
      expect(() => readFileSync(pathResolve(imprint, 'demo', 'search_demo', 'index.ts'))).toThrow();
      expect(readFileSync(pathResolve(imprint, 'demo', 'sessions', 'one.json'), 'utf8')).toBe(
        '{}\n',
      );
    });
  });

  it('refuses local delete targets that escape IMPRINT_HOME', () => {
    withTemp(({ root, home, imprint }) => {
      const victim = pathJoin(root, 'victim');
      mkdirSync(victim, { recursive: true });
      writeFile(pathJoin(victim, 'keep.txt'), 'safe\n');

      const code = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'mcp', 'delete', '../victim', '--local', 'site', '--yes'],
        cwd: pathResolve(import.meta.dir, '..'),
        env: { ...process.env, HOME: home, IMPRINT_HOME: imprint },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(code.exitCode).toBe(0);
      expect(existsSync(pathJoin(victim, 'keep.txt'))).toBe(true);
      expect(code.stdout.toString()).toContain('invalid local site "../victim"');
    });
  });
});
