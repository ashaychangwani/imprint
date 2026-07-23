import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { joinBackendPreparation } from '../src/imprint/mcp-live-verifier-server.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('live verifier MCP server', () => {
  it('joins a backend preparation already in flight instead of starting a duplicate probe', async () => {
    const state: { current?: { promise: Promise<string>; forceReprobe: boolean } } = {};
    let starts = 0;
    let finish!: (value: string) => void;
    const start = () => {
      starts++;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const first = joinBackendPreparation(state, false, start);
    const second = joinBackendPreparation(state, false, start);
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(starts).toBe(1);
    finish('fetch');
    expect(await first.promise).toBe('fetch');
    expect(await second.promise).toBe('fetch');

    const third = joinBackendPreparation(state, false, async () => {
      starts++;
      return 'cdp-replay';
    });
    expect(third.joined).toBe(false);
    expect(await third.promise).toBe('cdp-replay');
    expect(starts).toBe(2);
  });

  it('queues a forced reprobe behind an ordinary preparation and lets later callers join it', async () => {
    const state: { current?: { promise: Promise<string>; forceReprobe: boolean } } = {};
    const finishes: Array<(value: string) => void> = [];
    let starts = 0;
    const start = () => {
      starts++;
      return new Promise<string>((resolve) => finishes.push(resolve));
    };

    const ordinary = joinBackendPreparation(state, false, start);
    const forced = joinBackendPreparation(state, true, start);
    const joinedForced = joinBackendPreparation(state, true, start);
    expect(starts).toBe(1);
    expect(forced.joined).toBe(false);
    expect(joinedForced.joined).toBe(true);

    finishes[0]?.('fetch');
    expect(await ordinary.promise).toBe('fetch');
    await Promise.resolve();
    expect(starts).toBe(2);
    finishes[1]?.('cdp-replay');
    expect(await forced.promise).toBe('cdp-replay');
    expect(await joinedForced.promise).toBe('cdp-replay');
  });

  it('stays alive through initialization and advertises only verifier tools', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-verifier-mcp-'));
    dirs.push(dir);
    const workflowPath = pathJoin(dir, 'workflow.json');
    writeFileSync(
      workflowPath,
      JSON.stringify({
        toolName: 'search_fixture',
        intent: { description: 'Search a fixture.' },
        parameters: [{ name: 'query', type: 'string', description: 'Search text.' }],
        requests: [{ method: 'GET', url: 'https://example.com?q=${param.query}', headers: {} }],
        site: 'live-verifier-mcp-fixture',
      }),
      'utf8',
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'run',
        pathJoin(import.meta.dir, '..', 'src', 'cli.ts'),
        '__mcp-live-verifier-server',
        '--workflow-path',
        workflowPath,
        '--report-path',
        pathJoin(dir, 'report.json'),
        '--session-label',
        'verifier-session-1',
      ],
      cwd: pathJoin(import.meta.dir, '..'),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'live-verifier-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'prepare_live_backend',
        'refresh_auth_session',
        'run_live_integration_suite',
        'run_live_integration_test',
        'submit_verification_report',
      ]);
      expect(
        listed.tools.find((tool) => tool.name === 'run_live_integration_test')?.description,
      ).toContain('Repeated parameters are allowed');
      const authSchema = JSON.stringify(
        listed.tools.find((tool) => tool.name === 'refresh_auth_session')?.inputSchema,
      );
      expect(authSchema).toContain('action');
      expect(authSchema).toContain('parameters');
      const submitSchema = JSON.stringify(
        listed.tools.find((tool) => tool.name === 'submit_verification_report')?.inputSchema,
      );
      expect(submitSchema).toContain('untestable');
      expect(submitSchema).toContain('suggestedFix');
      const firstRefresh = await client.callTool({
        name: 'refresh_auth_session',
        arguments: { reason: 'fixture auth failure' },
      });
      expect(firstRefresh.isError).toBe(true);
      expect(JSON.stringify(firstRefresh.content)).toContain(
        'no generated authentication workflow',
      );
      const premature = await client.callTool({
        name: 'submit_verification_report',
        arguments: {
          status: 'approved',
          summary: 'Looks good.',
          baseline: {
            verdict: 'semantically_correct',
            reason: 'Fixture result matched.',
          },
          parameters: [
            {
              name: 'query',
              verdict: 'works',
              reason: 'Query constrained the fixture.',
            },
          ],
          issues: [],
          gaps: [],
        },
      });
      expect(premature.isError).toBe(true);
      expect(JSON.stringify(premature.content)).toContain('run the final integration suite');
    } finally {
      await client.close();
    }
  });

  it('allows repeated targeted parameters when the verifier supplies a reason', async () => {
    const fixture = Bun.serve({
      port: 0,
      fetch: () => Response.json({ items: [{ name: 'fixture result' }] }),
    });
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-verifier-mcp-'));
    dirs.push(root);
    const toolDir = pathJoin(root, 'fixture-site', 'search_fixture');
    mkdirSync(toolDir, { recursive: true });
    const workflowPath = pathJoin(toolDir, 'workflow.json');
    writeFileSync(
      workflowPath,
      JSON.stringify({
        toolName: 'search_fixture',
        intent: { description: 'Search a fixture.' },
        parameters: [{ name: 'query', type: 'string', description: 'Search text.' }],
        requests: [
          {
            method: 'GET',
            url: `http://127.0.0.1:${fixture.port}/search?q=\${param.query}`,
            headers: {},
          },
        ],
        site: 'fixture-site',
      }),
    );
    writeFileSync(
      pathJoin(toolDir, 'backends.json'),
      JSON.stringify({
        probedAt: new Date().toISOString(),
        imprintVersion: '0.1.0',
        preferredOrder: ['fetch'],
        results: { fetch: { outcome: 'ok', durationMs: 10 } },
      }),
    );
    writeFileSync(
      pathJoin(toolDir, '.live-verification-evidence.json'),
      JSON.stringify([
        {
          kind: 'suite',
          label: 'suite-1',
          status: 'failed',
          verifierSession: 'verifier-session-1',
          finishedAt: new Date().toISOString(),
        },
      ]),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'run',
        pathJoin(import.meta.dir, '..', 'src', 'cli.ts'),
        '__mcp-live-verifier-server',
        '--workflow-path',
        workflowPath,
        '--report-path',
        pathJoin(toolDir, 'report.json'),
        '--session-label',
        'verifier-session-1',
      ],
      cwd: pathJoin(import.meta.dir, '..'),
      env: { ...getDefaultEnvironment(), IMPRINT_COMPILE_ACT_SPACING_MS: '0' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'live-verifier-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const [first, second] = await Promise.all([
        client.callTool({
          name: 'run_live_integration_test',
          arguments: { params: { query: 'tires' }, reason: 'initial semantic check' },
        }),
        client.callTool({
          name: 'run_live_integration_test',
          arguments: { params: { query: 'tires' }, reason: 'confirm after backend review' },
        }),
      ]);
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const evidence = JSON.parse(
        readFileSync(pathJoin(toolDir, '.live-verification-evidence.json'), 'utf8'),
      ) as Array<{ label: string }>;
      expect(
        evidence
          .map((item) => item.label)
          .filter((label) => label.startsWith('targeted-call-'))
          .sort(),
      ).toEqual(['targeted-call-1', 'targeted-call-2']);
    } finally {
      await client.close();
      fixture.stop(true);
    }
  }, 10_000);
});
