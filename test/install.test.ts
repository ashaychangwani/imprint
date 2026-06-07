import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  __setChromiumFinderForTest,
  __setPlaywrightChromiumInstallerForTest,
} from '../src/imprint/chromium.ts';
import {
  defaultHermesConfigPath,
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

describe('checked-in examples', () => {
  it('marks Google Flights page tokens as browser-bootstrap state', () => {
    const flightsRoot = pathResolve(import.meta.dir, '..', 'examples', 'google-flights');
    for (const toolDir of readdirSync(flightsRoot, { withFileTypes: true })) {
      if (!toolDir.isDirectory()) continue;
      const workflowPath = pathJoin(flightsRoot, toolDir.name, 'workflow.json');
      if (!existsSync(workflowPath)) continue;
      const workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
        bootstrap?: { captures?: { name: string; capability?: string }[] };
        requests?: { url?: string }[];
      };
      const usesGooglePageTokens = JSON.stringify(workflow.requests ?? []).includes(
        '${state.f_sid}',
      );
      if (!usesGooglePageTokens) continue;

      const captures = new Map(
        (workflow.bootstrap?.captures ?? []).map((capture) => [capture.name, capture.capability]),
      );
      expect(captures.get('f_sid')).toBe('browser_bootstrap');
      expect(captures.get('bl')).toBe('browser_bootstrap');
    }
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

  it('uses HERMES_HOME/config.yaml as the default Hermes config path', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-hermes-home-'));
    const oldHermesConfig = process.env.HERMES_CONFIG;
    const oldHermesHome = process.env.HERMES_HOME;
    Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
    process.env.HERMES_HOME = root;
    try {
      expect(defaultHermesConfigPath()).toBe(pathJoin(root, 'config.yaml'));

      installMcpConfigFile('hermes', server);

      const text = readFileSync(pathJoin(root, 'config.yaml'), 'utf8');
      expect(text).toContain('mcp_servers:');
      expect(text).toContain('imprint-google-flights:');
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (oldHermesConfig === undefined) Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
      else process.env.HERMES_CONFIG = oldHermesConfig;
      if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
      else process.env.HERMES_HOME = oldHermesHome;
    }
  });

  it('lets HERMES_CONFIG override the default Hermes config path', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-hermes-config-'));
    const configPath = pathJoin(root, 'custom-hermes.yaml');
    const oldHermesConfig = process.env.HERMES_CONFIG;
    const oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_CONFIG = configPath;
    process.env.HERMES_HOME = pathJoin(root, 'ignored-home');
    try {
      expect(defaultHermesConfigPath()).toBe(configPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (oldHermesConfig === undefined) Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
      else process.env.HERMES_CONFIG = oldHermesConfig;
      if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
      else process.env.HERMES_HOME = oldHermesHome;
    }
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
imprint-webwidget-domains: imprint mcp-server webwidget-domains - ✗ Failed to connect
`,
    );

    expect(servers.map((server) => server.serverName)).toEqual([
      'imprint-google-flights',
      'imprint-webwidget-domains',
    ]);
    expect(servers.map((server) => server.site)).toEqual(['google-flights', 'webwidget-domains']);
  });

  it('parses Codex mcp list table output', () => {
    const servers = parseInstalledMcpServers(
      'codex',
      `Name                       Command  Args                          Env                 Cwd  Status   Auth
imprint-echo               imprint  mcp-server echo               IMPRINT_HOME=*****  -    enabled  Unsupported
imprint-webwidget-domains  imprint  mcp-server webwidget-domains  IMPRINT_HOME=*****  -    enabled  Unsupported

Name                 Url                                Bearer Token Env Var  Status   Auth
openaiDeveloperDocs  https://developers.openai.com/mcp  -                     enabled  Unsupported
`,
    );

    expect(servers.map((server) => server.serverName)).toEqual([
      'imprint-echo',
      'imprint-webwidget-domains',
    ]);
    expect(servers.map((server) => server.site)).toEqual(['echo', 'webwidget-domains']);
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

  function writeFixtureTool(root: string, site = 'browser-site'): string {
    const toolDir = pathResolve(root, site, 'search_browser_site');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      pathJoin(toolDir, 'index.ts'),
      `export const WORKFLOW = {
  toolName: "search_browser_site",
  intent: { description: "Search browser site" },
  parameters: [],
  requests: [{ method: "GET", url: "https://example.com", headers: {} }],
  site: "${site}"
};
export async function searchBrowserSite() {
  return { ok: true, data: {}, backend: "fetch" };
}
`,
    );
    return toolDir;
  }

  it('prints install instructions for every checked-in example MCP', async () => {
    const examplesRoot = pathResolve(import.meta.dir, '..', 'examples');
    const sites = await listInstallableSites('examples', examplesRoot);
    expect(
      sites.map((site) => ({
        site: site.site,
        toolNames: site.toolNames,
      })),
    ).toEqual([
      {
        site: 'discoverandgo',
        toolNames: ['book_discoverandgo_museum_pass'],
      },
      {
        site: 'echo',
        toolNames: ['echo_test'],
      },
      {
        site: 'google-flights',
        toolNames: [
          'get_flight_booking_details',
          'get_flight_calendar_prices',
          'lookup_airport',
          'search_flights',
        ],
      },
      {
        site: 'google-hotels',
        toolNames: [
          'autocomplete_hotel_location',
          'get_hotel_booking_options',
          'get_hotel_reviews',
          'search_hotels',
        ],
      },
      {
        site: 'southwest',
        toolNames: ['search_southwest_flights'],
      },
    ]);

    const logs: string[] = [];
    const consoleLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      for (const site of sites) {
        const result = await install({
          site: site.site,
          platform: 'claude-desktop',
          source: 'examples',
          print: true,
          noInteractive: true,
        });
        expect(result.site).toBe(site.site);
        expect(result.source).toBe('examples');
        expect(result.serverName).toBe(`imprint-${site.site}`);
        expect(result.message).toBe(`Printed imprint-${site.site} claude-desktop configuration.`);
      }
    } finally {
      console.log = consoleLog;
    }

    const printed = logs.join('\n');
    for (const site of sites) {
      expect(printed).toContain(`"imprint-${site.site}"`);
      expect(printed).toContain('"IMPRINT_HOME"');
      expect(printed).toContain('/examples');
    }
  });

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

  it('auto-installs Playwright Chromium for browser-backed MCP installs', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const hermesHome = mkdtempSync(pathJoin(tmpdir(), 'imprint-hermes-home-'));
    const toolDir = writeFixtureTool(root);
    writeFileSync(pathJoin(toolDir, 'playbook.yaml'), 'toolName: search_browser_site\nsteps: []\n');

    const oldHermesHome = process.env.HERMES_HOME;
    const oldHermesConfig = process.env.HERMES_CONFIG;
    const oldBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const browserPath = pathJoin(
      hermesHome,
      '.cache',
      'ms-playwright',
      'chromium-9999',
      'chrome-linux64',
      'chrome',
    );
    const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
    let installed = false;
    process.env.HERMES_HOME = hermesHome;
    Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
    Reflect.deleteProperty(process.env, 'PLAYWRIGHT_BROWSERS_PATH');
    __setChromiumFinderForTest(() => (installed ? browserPath : null));
    __setPlaywrightChromiumInstallerForTest((command, env) => {
      calls.push({ command, env });
      mkdirSync(pathJoin(browserPath, '..'), { recursive: true });
      writeFileSync(browserPath, '#!/bin/sh\necho "Chromium 9999"\n');
      chmodSync(browserPath, 0o755);
      installed = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    try {
      const result = await withImprintHome(root, () =>
        install({
          site: 'browser-site',
          platform: 'hermes',
          source: 'local',
          noInteractive: true,
        }),
      );

      expect(result.serverName).toBe('imprint-browser-site');
      expect(calls).toHaveLength(1);
      const commandText = calls[0]?.command.join(' ') ?? '';
      expect(commandText).toContain('playwright');
      expect(calls[0]?.command).toContain('install');
      expect(calls[0]?.command).toContain('chromium');
      expect(calls[0]?.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        pathJoin(hermesHome, '.cache', 'ms-playwright'),
      );
      const config = readFileSync(pathJoin(hermesHome, 'config.yaml'), 'utf8');
      expect(config).toContain('PLAYWRIGHT_BROWSERS_PATH:');
      expect(config).toContain(pathJoin(hermesHome, '.cache', 'ms-playwright'));
    } finally {
      __setChromiumFinderForTest(null);
      __setPlaywrightChromiumInstallerForTest(null);
      rmSync(root, { recursive: true, force: true });
      rmSync(hermesHome, { recursive: true, force: true });
      if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldHermesConfig === undefined) Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
      else process.env.HERMES_CONFIG = oldHermesConfig;
      if (oldBrowsersPath === undefined)
        Reflect.deleteProperty(process.env, 'PLAYWRIGHT_BROWSERS_PATH');
      else process.env.PLAYWRIGHT_BROWSERS_PATH = oldBrowsersPath;
    }
  });

  it('allows offline installs to skip browser auto-install', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-install-'));
    const hermesHome = mkdtempSync(pathJoin(tmpdir(), 'imprint-hermes-home-'));
    const toolDir = writeFixtureTool(root);
    writeFileSync(pathJoin(toolDir, 'playbook.yaml'), 'toolName: search_browser_site\nsteps: []\n');

    const oldHermesHome = process.env.HERMES_HOME;
    const oldHermesConfig = process.env.HERMES_CONFIG;
    process.env.HERMES_HOME = hermesHome;
    Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
    __setChromiumFinderForTest(() => null);
    __setPlaywrightChromiumInstallerForTest(() => {
      throw new Error('installer should not run');
    });
    try {
      const result = await withImprintHome(root, () =>
        install({
          site: 'browser-site',
          platform: 'hermes',
          source: 'local',
          noInteractive: true,
          skipBrowserInstall: true,
        }),
      );

      expect(result.serverName).toBe('imprint-browser-site');
      expect(readFileSync(pathJoin(hermesHome, 'config.yaml'), 'utf8')).toContain(
        'imprint-browser-site:',
      );
    } finally {
      __setChromiumFinderForTest(null);
      __setPlaywrightChromiumInstallerForTest(null);
      rmSync(root, { recursive: true, force: true });
      rmSync(hermesHome, { recursive: true, force: true });
      if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldHermesConfig === undefined) Reflect.deleteProperty(process.env, 'HERMES_CONFIG');
      else process.env.HERMES_CONFIG = oldHermesConfig;
    }
  });
});
