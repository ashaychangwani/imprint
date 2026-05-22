import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  install,
  installMcpConfigFile,
  listInstallableSites,
  parseInstalledMcpServers,
  uninstallMcpConfigFile,
} from '../src/imprint/install.ts';
import type { McpServerConfig } from '../src/imprint/integrations.ts';

describe('installable site discovery', () => {
  it('lists only loadable emitted tools under an asset root', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    mkdirSync(pathJoin(root, 'google-flights', 'search_google_flights'), { recursive: true });
    writeFileSync(
      pathJoin(root, 'google-flights', 'search_google_flights', 'index.ts'),
      `export const WORKFLOW = {
  toolName: "search_google_flights",
  intent: { description: "Search flights" },
  parameters: [],
  requests: [],
  site: "google-flights"
};
export async function searchGoogleFlights() {
  return { ok: true, data: {} };
}
`,
    );
    mkdirSync(pathJoin(root, 'google-flights', 'sessions'), { recursive: true });
    writeFileSync(pathJoin(root, 'google-flights', 'sessions', 'ignored.json'), '{}');
    mkdirSync(pathJoin(root, 'broken-site', 'broken_tool'), { recursive: true });
    writeFileSync(pathJoin(root, 'broken-site', 'broken_tool', 'index.ts'), 'not valid ts');

    expect(await listInstallableSites('examples', root)).toEqual([
      {
        source: 'examples',
        assetRoot: root,
        site: 'google-flights',
        toolNames: ['search_google_flights'],
      },
    ]);
  });
});

describe('installMcpConfigFile', () => {
  const server: McpServerConfig = {
    name: 'imprint-google-flights',
    command: 'imprint',
    args: ['mcp-server', 'google-flights'],
    env: { IMPRINT_HOME: '/tmp/imprint-examples' },
  };

  it('upserts Claude Desktop config', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'claude_desktop_config.json');

    installMcpConfigFile('claude-desktop', server, configPath);

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        'imprint-google-flights': {
          command: 'imprint',
          args: ['mcp-server', 'google-flights'],
          env: { IMPRINT_HOME: '/tmp/imprint-examples' },
        },
      },
    });
  });

  it('upserts OpenClaw config without clobbering existing keys', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'openclaw.json');
    writeFileSync(configPath, '{"theme":"dark","mcp":{"servers":{"existing":{"command":"x"}}}}\n');

    installMcpConfigFile('openclaw', server, configPath);

    const out = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(out.theme).toBe('dark');
    expect(out.mcp.servers.existing).toEqual({ command: 'x' });
    expect(out.mcp.servers['imprint-google-flights']).toEqual({
      command: 'imprint',
      args: ['mcp-server', 'google-flights'],
      env: { IMPRINT_HOME: '/tmp/imprint-examples' },
    });
  });

  it('upserts Hermes YAML config', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'config.yaml');

    installMcpConfigFile('hermes', server, configPath);

    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain('imprint-google-flights:');
    expect(text).toContain('IMPRINT_HOME: /tmp/imprint-examples');
  });
});

describe('uninstallMcpConfigFile', () => {
  const server: McpServerConfig = {
    name: 'imprint-google-flights',
    command: 'imprint',
    args: ['mcp-server', 'google-flights'],
  };

  it('removes Claude Desktop config entries without clobbering other servers', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'claude_desktop_config.json');
    installMcpConfigFile('claude-desktop', server, configPath);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'imprint-google-flights': { command: 'imprint' },
            other: { command: 'other' },
          },
        },
        null,
        2,
      ),
    );

    expect(uninstallMcpConfigFile('claude-desktop', 'imprint-google-flights', configPath)).toEqual({
      path: configPath,
      removed: true,
    });

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        other: { command: 'other' },
      },
    });
  });

  it('removes OpenClaw config entries', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'openclaw.json');
    writeFileSync(
      configPath,
      '{"theme":"dark","mcp":{"servers":{"imprint-google-flights":{"command":"imprint"},"existing":{"command":"x"}}}}\n',
    );

    const result = uninstallMcpConfigFile('openclaw', 'imprint-google-flights', configPath);

    expect(result.removed).toBe(true);
    const out = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(out.theme).toBe('dark');
    expect(out.mcp.servers).toEqual({ existing: { command: 'x' } });
  });

  it('removes Hermes YAML config entries', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'config.yaml');
    installMcpConfigFile('hermes', server, configPath);

    const result = uninstallMcpConfigFile('hermes', 'imprint-google-flights', configPath);

    expect(result.removed).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain('imprint-google-flights:');
  });

  it('reports missing config entries as not removed', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const configPath = pathJoin(root, 'claude_desktop_config.json');

    expect(uninstallMcpConfigFile('claude-desktop', 'imprint-google-flights', configPath)).toEqual({
      path: configPath,
      removed: false,
    });
  });
});

describe('installed MCP discovery parsing', () => {
  it('parses Claude Code mcp list output', () => {
    const servers = parseInstalledMcpServers(
      'claude-code',
      `Checking MCP server health...
context7: https://mcp.context7.com/mcp (HTTP) - ✓ Connected
imprint-google-flights: imprint mcp-server google-flights - ✓ Connected
imprint-namecheap-domains: imprint mcp-server namecheap-domains - ✗ Failed to connect
`,
    );

    expect(servers.map((server) => server.serverName)).toEqual([
      'imprint-google-flights',
      'imprint-namecheap-domains',
    ]);
    expect(servers.map((server) => server.site)).toEqual(['google-flights', 'namecheap-domains']);
  });

  it('parses Codex mcp list table output', () => {
    const servers = parseInstalledMcpServers(
      'codex',
      `Name                       Command  Args                          Env                 Cwd  Status   Auth
imprint-echo               imprint  mcp-server echo               IMPRINT_HOME=*****  -    enabled  Unsupported
imprint-namecheap-domains  imprint  mcp-server namecheap-domains  IMPRINT_HOME=*****  -    enabled  Unsupported

Name                 Url                                Bearer Token Env Var  Status   Auth
openaiDeveloperDocs  https://developers.openai.com/mcp  -                     enabled  Unsupported
`,
    );

    expect(servers.map((server) => server.serverName)).toEqual([
      'imprint-echo',
      'imprint-namecheap-domains',
    ]);
    expect(servers.map((server) => server.site)).toEqual(['echo', 'namecheap-domains']);
  });
});

describe('install', () => {
  const originalImprintHome = process.env.IMPRINT_HOME;

  async function withImprintHome<T>(path: string, fn: () => Promise<T>): Promise<T> {
    process.env.IMPRINT_HOME = path;
    try {
      return await fn();
    } finally {
      if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
      else process.env.IMPRINT_HOME = originalImprintHome;
    }
  }

  it('prints install instructions for an emitted local MCP without touching platform config', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const toolDir = pathResolve(root, 'testsite', 'search_test_flights');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      pathJoin(toolDir, 'index.ts'),
      `export const WORKFLOW = {
  toolName: "search_test_flights",
  intent: { description: "Search test flights" },
  parameters: [],
  requests: [{ method: "GET", url: "https://example.com", headers: {} }],
  site: "testsite"
};
export async function searchTestFlights() {
  return { ok: true, data: {}, backend: "fetch" };
}
`,
    );

    const logs: string[] = [];
    const consoleLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    let result: Awaited<ReturnType<typeof install>> | undefined;
    try {
      result = await withImprintHome(root, () =>
        install({
          site: 'testsite',
          platform: 'claude-desktop',
          source: 'local',
          print: true,
          noInteractive: true,
        }),
      );
    } finally {
      console.log = consoleLog;
    }

    if (!result) throw new Error('expected install result');
    expect(result.site).toBe('testsite');
    expect(result.source).toBe('local');
    expect(result.serverName).toBe('imprint-testsite');
    expect(result.assetRoot).toBe(root);
    const printed = logs.join('\n');
    expect(printed).toContain(`"command": "${process.execPath}"`);
    expect(printed).toContain('/src/cli.ts');
    expect(printed).toContain('"mcp-server", "testsite"');
  });
});
