import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { emit } from '../src/imprint/emit.ts';
import {
  SessionFreshness,
  isSignedOut,
  loadRecoveryPolicy,
} from '../src/imprint/mcp-session-recovery.ts';
import { executeWorkflow } from '../src/imprint/runtime.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const dirs: string[] = [];
const site = 'fixture';
const policy = {
  authTool: 'authenticate_site',
  protectedTools: ['search'],
  statusAction: 'status',
  refreshAction: 'refresh',
  startAction: 'start',
  approvalAction: 'approve',
  terminalAction: 'finish',
  nextActions: { start: ['approve'], approve: ['finish'] },
  approvalMessage: 'Approve fixture verification?',
  approvalTimeoutMs: 5_000,
  recoveryTimeoutMs: 15_000,
  failureCooldownMs: 60_000,
  refreshBeforeExpiryMs: 90_000,
  verifyAgainAfterMs: 45_000,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepare({ unsafe = false, signedIn = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-renewal-'));
  dirs.push(root);
  const auth = WorkflowSchema.parse({
    toolName: policy.authTool,
    toolKind: 'authenticate',
    site,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Fixture authentication action',
        default: 'status',
        choices: ['status', 'refresh', 'start', 'approve', 'finish'],
      },
    ],
    intent: { description: 'Fixture authentication' },
    requests: ['status', 'refresh', 'start', 'approve', 'finish'].map((name) => ({
      method: 'GET',
      url: `https://example.test/${name}`,
      headers: {},
      effect: name === 'approve' ? 'unsafe' : 'safe',
      captures: ['status', 'refresh', 'finish'].includes(name)
        ? [{ source: 'json', name: 'expiry', path: 'expiry' }]
        : [],
    })),
    authConfig: {
      entry: 'status',
      persistCookiesOnPause: false,
      actions: Object.fromEntries(
        ['status', 'refresh', 'start', 'approve', 'finish'].map((name, request) => [
          name,
          {
            steps: [{ request }],
            outcome:
              name === 'start' || name === 'approve'
                ? {
                    type: 'pause',
                    next: name === 'start' ? 'approve' : 'finish',
                    message: 'Continue',
                  }
                : { type: 'success', evidence: ['expiry'], expiresAtCapture: 'expiry' },
          },
        ]),
      ),
    },
  });
  const data = WorkflowSchema.parse({
    toolName: 'search',
    site,
    parameters: [{ name: 'query', type: 'string', description: 'Fixture query' }],
    intent: { description: 'Fixture search' },
    requests: [
      {
        method: 'GET',
        url: 'https://example.test/search?q=${param.query}',
        headers: {},
        effect: unsafe ? 'irreversible' : 'safe',
      },
    ],
  });
  const repository = join(import.meta.dir, '..');
  const runtime = join(repository, 'src', 'imprint');
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(repository, join(root, 'node_modules', 'imprint'), 'dir');
  for (const workflow of [auth, data]) {
    const dir = join(root, site, workflow.toolName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify(workflow));
    emit({ workflowPath: join(dir, 'workflow.json'), outDir: dir });
  }
  writeFileSync(join(root, site, 'mcp-session-recovery.json'), JSON.stringify(policy));
  const preload = join(root, 'fixture.ts');
  const journal = join(root, 'requests.txt');
  const credentialDir = join(root, 'credential-lock');
  const savedCookies = join(root, 'cookies.json');
  const expired = join(root, 'expired');
  writeFileSync(
    savedCookies,
    JSON.stringify(
      signedIn
        ? [
            {
              name: 'sid',
              value: 'old',
              domain: 'example.test',
              path: '/',
              secure: true,
              hostOnly: true,
            },
          ]
        : [],
    ),
  );
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { __setCdpBrowserFetchFactoryForTest } from ${JSON.stringify(join(runtime, 'backend-ladder.ts'))};
import { setBackendOverride } from ${JSON.stringify(join(runtime, 'credential-store.ts'))};

const savedCookies = ${JSON.stringify(savedCookies)};
const getCookies = () => JSON.parse(readFileSync(savedCookies, 'utf8'));
setBackendOverride({
  id: 'encrypted-file',
  lockDirectory: ${JSON.stringify(credentialDir)},
  getCookies: async () => getCookies(),
  setCookies: async (_, next) => writeFileSync(savedCookies, JSON.stringify(next)),
  getSecret: async () => null,
  listSecrets: async () => [],
  listSites: async () => [],
});

const fetchFixture = async (url, init) => {
  const path = new URL(url);
  appendFileSync(${JSON.stringify(journal)}, path.pathname + '\\n');
  const cookie = new Headers(init?.headers).get('cookie');
  const valid = cookie?.includes('sid=fresh') ||
    (cookie?.includes('sid=old') && !existsSync(${JSON.stringify(expired)}));
  if (path.pathname === '/search') {
    if (!valid) return Response.json({}, { status: 401 });
    const query = path.searchParams.get('q');
    if (query === 'forbidden') return Response.json({}, { status: 403 });
    return Response.json({ query, count: 1 });
  }
  if (path.pathname === '/approve' && init?.allowAmbiguousRetry !== false) {
    throw new Error('Managed approval must opt out of ambiguous transport retries');
  }
  if ((path.pathname === '/status' || path.pathname === '/refresh') && !valid) {
    return Response.json({}, { status: 401 });
  }
  return Response.json(
    { expiry: Date.now() + 300_000 },
    path.pathname === '/finish' ? { headers: { 'set-cookie': 'sid=fresh; Path=/; Secure' } } : {},
  );
};
globalThis.fetch = fetchFixture;
__setCdpBrowserFetchFactoryForTest(() => ({
  fetchImpl: fetchFixture,
  mintJar: async () => ({
    cookies: getCookies(), ua: 'fixture', html: '', bootstrapEpoch: Date.now(), abckFlag: '0',
  }),
  close: async () => {},
}));
`,
  );
  const transport = () =>
    new StdioClientTransport({
      command: process.execPath,
      args: ['run', '--preload', preload, join(runtime, '..', 'cli.ts'), 'mcp-server', site],
      env: { ...getDefaultEnvironment(), IMPRINT_HOME: root },
      stderr: 'ignore',
    });
  return { root, expired, journal, savedCookies, transport, workflows: { auth, data } };
}

it('checks expiry before use and refreshes once per observed deadline', () => {
  const freshness = new SessionFreshness(policy);
  expect(freshness.next(100_000)).toBe('inspect');
  freshness.observe({ expiresAt: 500_000 }, 100_000);
  expect(freshness.next(409_999)).toBe('ready');
  expect(freshness.next(410_000)).toBe('proactive');
  expect(freshness.next(411_000)).toBe('ready');
  expect(freshness.next(500_000)).toBe('expired');
  freshness.observe({}, 500_500);
  expect(freshness.next(501_000)).toBe('ready');
  expect(freshness.next(545_500)).toBe('inspect');
});

it('rejects replay of an explicitly irreversible tool', () => {
  const { root, workflows } = prepare({ unsafe: true });
  expect(() => loadRecoveryPolicy(root, site, Object.values(workflows))).toThrow(
    'must be a read-only data tool',
  );
});

it('classifies only the configured signed-out status and code on a data response', async () => {
  const { workflows } = prepare();
  const result = await executeWorkflow({
    workflow: workflows.data,
    params: { query: 'fixture' },
    credentials: { site, cookies: [], values: {} },
    fetchImpl: Object.assign(
      async () => Response.json({ errorCode: 'SIGNED_OUT' }, { status: 403 }),
      { preconnect: fetch.preconnect },
    ),
  });
  expect(
    isSignedOut(result, { ...policy, signedOutResponse: { status: 403, errorCode: 'SIGNED_OUT' } }),
  ).toBe(true);
  expect(
    isSignedOut(result, { ...policy, signedOutResponse: { status: 403, errorCode: 'BLOCKED' } }),
  ).toBe(false);
});

it('requires managed consent and preserves a newer durable session during approval', async () => {
  const { journal, savedCookies, transport } = prepare();
  const client = new Client(
    { name: 'renewal-test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const newer = [
    {
      name: 'sid',
      value: 'newer',
      domain: 'example.test',
      path: '/',
      secure: true,
      hostOnly: true,
    },
  ];
  let approvals = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    expect(JSON.parse(readFileSync(savedCookies, 'utf8'))).toEqual([]);
    writeFileSync(savedCookies, JSON.stringify(newer));
    return { action: 'accept', content: {} };
  });
  try {
    await client.connect(transport());
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === policy.authTool)?.inputSchema.properties?.action,
    ).toMatchObject({ enum: ['status', 'refresh'] });
    const direct = await client.callTool({
      name: policy.authTool,
      arguments: { action: 'approve' },
    });
    expect(direct.structuredContent).toMatchObject({ status: 'auth_required' });
    expect(approvals).toBe(0);

    const result = await client.callTool({ name: 'search', arguments: { query: 'first' } });
    expect(result.structuredContent).toMatchObject({ status: 'auth_required' });
    expect(approvals).toBe(1);
    expect(JSON.parse(readFileSync(savedCookies, 'utf8'))).toEqual(newer);
    expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual([
      '/status',
      '/refresh',
      '/start',
      '/approve',
      '/finish',
    ]);
  } finally {
    await client.close();
  }
}, 20_000);

for (const accepted of [true, false]) {
  it(`shares one renewal across queued searches when approval is ${accepted ? 'accepted' : 'declined'}`, async () => {
    const { journal, transport } = prepare();
    const client = new Client(
      { name: 'renewal-test', version: '1' },
      { capabilities: { elicitation: {} } },
    );
    let approvals = 0;
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      expect(params.message).toBe(policy.approvalMessage);
      approvals++;
      return accepted ? { action: 'accept', content: {} } : { action: 'decline' };
    });
    try {
      await client.connect(transport());
      const queries = ['first', 'second', 'third'];
      const results = await Promise.all(
        queries.map((query) =>
          client.callTool({
            name: 'search',
            arguments: { query },
          }),
        ),
      );
      expect(approvals).toBe(1);
      const requests = readFileSync(journal, 'utf8').trim().split('\n');
      expect(requests.slice(0, 3)).toEqual(['/status', '/refresh', '/start']);
      if (accepted) {
        expect(requests.slice(3)).toEqual(['/approve', '/finish', '/search', '/search', '/search']);
        for (const [i, result] of results.entries()) {
          expect(result.isError).toBeFalsy();
          expect(JSON.stringify(result.content)).toContain(queries[i] ?? 'missing query');
        }
      } else {
        expect(requests).toEqual([
          '/status',
          '/refresh',
          '/start',
          '/status',
          '/refresh',
          '/status',
          '/refresh',
        ]);
        for (const result of results) {
          expect(result.isError).toBe(false);
          expect(result.structuredContent).toMatchObject({ status: 'auth_required' });
        }
      }
    } finally {
      await client.close();
    }
  }, 20_000);
}

it('rechecks newer persisted credentials before renewing in a second MCP process', async () => {
  const { expired, journal, transport } = prepare({ signedIn: true });
  const clients = ['first', 'second'].map(
    (name) => new Client({ name, version: '1' }, { capabilities: { elicitation: { form: {} } } }),
  );
  const [first, second] = clients as [Client, Client];
  const release = Promise.withResolvers<void>();
  const awaitingApproval = Promise.withResolvers<void>();
  let approvals = 0;
  first.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    awaitingApproval.resolve();
    await release.promise;
    return { action: 'accept', content: {} };
  });
  second.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    return { action: 'decline' };
  });
  const search = (client: Client, query: string) =>
    client.callTool({ name: 'search', arguments: { query } });
  try {
    for (const client of clients) {
      await client.connect(transport());
      expect((await search(client, 'warmup')).isError).toBeFalsy();
    }
    writeFileSync(journal, '');
    writeFileSync(expired, '');
    const firstSearch = search(first, 'first');
    await awaitingApproval.promise;
    const secondSearch = search(second, 'second');
    for (let attempt = 0; attempt < 200; attempt++) {
      const requests = readFileSync(journal, 'utf8').split('\n');
      if (requests.filter((request) => request === '/search').length >= 2) break;
      await Bun.sleep(10);
    }
    expect(readFileSync(journal, 'utf8').match(/^\/search$/gm)).toHaveLength(2);
    release.resolve();
    const results = await Promise.all([firstSearch, secondSearch]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(approvals).toBe(1);
    const requests = readFileSync(journal, 'utf8').trim().split('\n');
    expect(requests.slice(requests.indexOf('/finish') + 1)).toEqual([
      '/search',
      '/status',
      '/search',
    ]);
  } finally {
    release.resolve();
    await Promise.all(clients.map((client) => client.close()));
  }
}, 20_000);
