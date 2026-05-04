/**
 * Tests for integrations.ts — verifies platform-specific paste snippets,
 * SKILL.md generation, and command detection.
 */

import { describe, expect, it } from 'bun:test';
import {
  type Platform,
  buildRegistrationCommand,
  detectImprintCommand,
  generatePasteSnippet,
  generateSkillMd,
} from '../src/imprint/integrations.ts';
import type { CronConfig, Playbook, Workflow } from '../src/imprint/types.ts';

const FIXTURE_WORKFLOW: Workflow = {
  toolName: 'search_test_flights',
  intent: {
    description: 'Search for test flights',
    userSaid: 'I searched for flights from SJC to SAN',
  },
  parameters: [
    { name: 'origin', type: 'string', description: 'Origin airport code', default: 'SJC' },
    { name: 'destination', type: 'string', description: 'Destination airport code' },
    { name: 'date', type: 'string', description: 'Departure date (YYYY-MM-DD)' },
  ],
  requests: [{ method: 'GET', url: 'https://test.com/api', headers: {} }],
  site: 'testsite',
};

const FIXTURE_PLAYBOOK: Playbook = {
  toolName: 'search_test_flights',
  summary: 'Search for test flights via DOM',
  parameters: [
    { name: 'origin', type: 'string', description: 'Origin airport code', default: 'SJC' },
  ],
  steps: [
    { action: 'navigate', url: 'https://test.com' },
    { action: 'click', locators: [{ by: 'id', value: 'search-btn' }] },
  ],
  result: {
    source: 'xhr',
    url_pattern: '/api/search',
    extract: 'data.results',
    return_as: 'result',
  },
};

const FIXTURE_CRON: CronConfig = {
  schedule: '0 8 * * *',
  params: { origin: 'SJC', destination: 'SAN', date: '2026-05-15' },
  replayBackend: 'fetch',
};

describe('generatePasteSnippet', () => {
  const platforms: Platform[] = ['claude-code', 'codex', 'claude-desktop', 'openclaw', 'hermes'];

  for (const platform of platforms) {
    it(`generates a valid snippet for ${platform}`, () => {
      const snippet = generatePasteSnippet({
        site: 'testsite',
        workflow: FIXTURE_WORKFLOW,
        platform,
        imprintCommand: { command: 'imprint', args: [] },
      });

      // All snippets should reference the tool name.
      expect(snippet).toContain('imprint-testsite');

      // All snippets should reference the site.
      expect(snippet).toContain('testsite');

      // Most snippets should include the lowercase intent.
      if (platform !== 'claude-desktop') {
        expect(snippet).toContain('search for test flights');
      }
    });
  }

  it('includes parameter list in the snippet', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'claude-code',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('origin (string, default: "SJC")');
    expect(snippet).toContain('destination (string, required)');
    expect(snippet).toContain('date (string, required)');
  });

  it('handles a workflow with no parameters', () => {
    const noParamsWorkflow: Workflow = {
      ...FIXTURE_WORKFLOW,
      parameters: [],
    };
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: noParamsWorkflow,
      platform: 'codex',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('Parameters: none');
  });

  it('includes the correct command for claude-code', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'claude-code',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain(
      'claude mcp add --scope project imprint-testsite -- imprint mcp-server testsite',
    );
  });

  it('includes the correct command for codex', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'codex',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('codex mcp add imprint-testsite -- imprint mcp-server testsite');
  });

  it('includes JSON config for claude-desktop', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'claude-desktop',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('~/Library/Application Support/Claude/claude_desktop_config.json');
    expect(snippet).toContain('"imprint-testsite"');
    expect(snippet).toContain('"command": "imprint"');
    expect(snippet).toContain('"args": ["mcp-server", "testsite"]');
  });

  it('includes JSON config for openclaw', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'openclaw',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('~/.openclaw/openclaw.json');
    expect(snippet).toContain('"imprint-testsite"');
    expect(snippet).toContain('"command": "imprint"');
    expect(snippet).toContain('"args": ["mcp-server", "testsite"]');
  });

  it('includes YAML config for hermes', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'hermes',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(snippet).toContain('~/.hermes/config.yaml');
    expect(snippet).toContain('imprint-testsite:');
    expect(snippet).toContain('command: "imprint"');
    expect(snippet).toContain('args: ["mcp-server", "testsite"]');
  });

  it('uses the custom imprintCommand when provided', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'claude-code',
      imprintCommand: { command: 'bun', args: ['run', '/custom/path/cli.ts'] },
    });

    expect(snippet).toContain('bun run /custom/path/cli.ts mcp-server testsite');
  });

  it('separates command and args in JSON config for fallback imprintCommand', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'claude-desktop',
      imprintCommand: { command: 'bun', args: ['run', '/custom/path/cli.ts'] },
    });

    expect(snippet).toContain('"command": "bun"');
    expect(snippet).toContain('"args": ["run", "/custom/path/cli.ts", "mcp-server", "testsite"]');
  });

  it('separates command and args in YAML config for fallback imprintCommand', () => {
    const snippet = generatePasteSnippet({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'hermes',
      imprintCommand: { command: 'bun', args: ['run', '/custom/path/cli.ts'] },
    });

    expect(snippet).toContain('command: "bun"');
    expect(snippet).toContain('args: ["run", "/custom/path/cli.ts", "mcp-server", "testsite"]');
  });
});

describe('buildRegistrationCommand', () => {
  it('returns an argv array for claude-code', () => {
    const cmd = buildRegistrationCommand({
      site: 'testsite',
      platform: 'claude-code',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(cmd).toEqual([
      'claude',
      'mcp',
      'add',
      '--scope',
      'project',
      'imprint-testsite',
      '--',
      'imprint',
      'mcp-server',
      'testsite',
    ]);
  });

  it('returns an argv array for codex', () => {
    const cmd = buildRegistrationCommand({
      site: 'testsite',
      platform: 'codex',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(cmd).toEqual([
      'codex',
      'mcp',
      'add',
      'imprint-testsite',
      '--',
      'imprint',
      'mcp-server',
      'testsite',
    ]);
  });

  it('returns null for claude-desktop (manual config)', () => {
    const cmd = buildRegistrationCommand({
      site: 'testsite',
      platform: 'claude-desktop',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(cmd).toBeNull();
  });

  it('returns null for openclaw (manual config)', () => {
    const cmd = buildRegistrationCommand({
      site: 'testsite',
      platform: 'openclaw',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(cmd).toBeNull();
  });

  it('returns null for hermes (manual config)', () => {
    const cmd = buildRegistrationCommand({
      site: 'testsite',
      platform: 'hermes',
      imprintCommand: { command: 'imprint', args: [] },
    });

    expect(cmd).toBeNull();
  });
});

describe('generateSkillMd', () => {
  it('generates valid SKILL.md for openclaw', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'openclaw',
    });

    // Frontmatter.
    expect(md).toContain('---');
    expect(md).toContain('name: imprint-testsite');
    expect(md).toContain('description: Search for test flights');
    expect(md).toContain('openclaw:');
    expect(md).toContain('tags: [automation, imprint]');

    // Main sections.
    expect(md).toContain('# imprint-testsite');
    expect(md).toContain('Search for test flights');
    expect(md).toContain('Recording context: I searched for flights from SJC to SAN');
    expect(md).toContain('## MCP Integration');
    expect(md).toContain('## Workflow (API replay)');
    expect(md).toContain('## Parameters');
    expect(md).toContain('## Backend Ladder');

    // Workflow JSON.
    expect(md).toContain('"toolName": "search_test_flights"');
    expect(md).toContain('"method": "GET"');

    // Parameter table.
    expect(md).toContain('| Name | Type | Default | Description |');
    expect(md).toContain('| origin | string | "SJC" | Origin airport code |');
    expect(md).toContain('| destination | string | required | Destination airport code |');
    expect(md).toContain('| date | string | required | Departure date (YYYY-MM-DD) |');
  });

  it('generates valid SKILL.md for hermes', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'hermes',
    });

    expect(md).toContain('hermes:');
    expect(md).toContain('~/.hermes/config.yaml');
  });

  it('includes playbook YAML when provided', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      playbook: FIXTURE_PLAYBOOK,
      platform: 'openclaw',
    });

    expect(md).toContain('## Playbook (DOM replay fallback)');
    expect(md).toContain('```yaml');
    expect(md).toContain('toolName: search_test_flights');
    expect(md).toContain('action: navigate');
    expect(md).toContain('url: https://test.com');
  });

  it('omits playbook section when not provided', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'openclaw',
    });

    expect(md).not.toContain('## Playbook (DOM replay fallback)');
  });

  it('includes scheduling section when cronConfig provided', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      cronConfig: FIXTURE_CRON,
      platform: 'openclaw',
    });

    expect(md).toContain('## Scheduling');
    expect(md).toContain('Imprint cron schedule: `0 8 * * *`');
  });

  it('includes hermes cron equivalent when platform is hermes', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      cronConfig: FIXTURE_CRON,
      platform: 'hermes',
    });

    expect(md).toContain('## Scheduling');
    expect(md).toContain('Hermes equivalent: `/cron add "0 8 * * *" "Run imprint-testsite ..."`');
  });

  it('omits scheduling section when cronConfig not provided', () => {
    const md = generateSkillMd({
      site: 'testsite',
      workflow: FIXTURE_WORKFLOW,
      platform: 'openclaw',
    });

    expect(md).not.toContain('## Scheduling');
  });

  it('handles workflow with no userSaid', () => {
    const workflowNoUserSaid: Workflow = {
      ...FIXTURE_WORKFLOW,
      intent: { description: 'Search for test flights' },
    };

    const md = generateSkillMd({
      site: 'testsite',
      workflow: workflowNoUserSaid,
      platform: 'openclaw',
    });

    expect(md).not.toContain('Recording context:');
  });

  it('handles workflow with no parameters', () => {
    const workflowNoParams: Workflow = {
      ...FIXTURE_WORKFLOW,
      parameters: [],
    };

    const md = generateSkillMd({
      site: 'testsite',
      workflow: workflowNoParams,
      platform: 'openclaw',
    });

    expect(md).toContain('## Parameters');
    expect(md).toContain('None.');
  });
});

describe('detectImprintCommand', () => {
  it('returns an ImprintCommand with command and args', () => {
    const ic = detectImprintCommand();

    expect(typeof ic.command).toBe('string');
    expect(Array.isArray(ic.args)).toBe(true);

    const isImprint = ic.command === 'imprint' && ic.args.length === 0;
    const isBunRun = ic.command === 'bun' && ic.args[0] === 'run' && ic.args[1]?.includes('cli.ts');

    expect(isImprint || isBunRun).toBe(true);
  });
});
