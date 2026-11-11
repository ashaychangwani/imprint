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

function prepare({
  unsafe = false,
  signedIn = false,
  managed = true,
  signedOutResponse,
  recoveryTimeoutMs = policy.recoveryTimeoutMs,
}: {
  unsafe?: boolean;
  signedIn?: boolean;
  managed?: boolean;
  signedOutResponse?: { status: number; errorCode: string };
  recoveryTimeoutMs?: number;
} = {}) {
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
      ...(managed ? { persistCookiesOnPause: false } : {}),
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
                : {
                    type: 'success',
                    evidence: ['expiry'],
                    ...(managed ? { expiresAtCapture: 'expiry' } : {}),
                  },
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
  if (managed) {
    writeFileSync(
      join(root, site, 'mcp-session-recovery.json'),
      JSON.stringify({ ...policy, signedOutResponse, recoveryTimeoutMs }),
    );
  }
  const preload = join(root, 'fixture.ts');
  const journal = join(root, 'requests.txt');
  const credentialDir = join(root, 'credential-lock');
  const savedCookies = join(root, 'cookies.json');
  const expired = join(root, 'expired');
  const clockOffset = join(root, 'clock-offset');
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

const clockOffset = ${JSON.stringify(clockOffset)};
const realNow = Date.now;
Date.now = () => realNow() + (existsSync(clockOffset) ? Number(readFileSync(clockOffset, 'utf8')) : 0);

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

const signedOut = ${JSON.stringify(signedOutResponse)};
const fetchFixture = async (url, init) => {
  const path = new URL(url);
  appendFileSync(${JSON.stringify(journal)}, path.pathname + '\\n');
  const cookie = new Headers(init?.headers).get('cookie');
  const valid = cookie?.includes('sid=fresh') ||
    (cookie?.includes('sid=old') && !existsSync(${JSON.stringify(expired)}));
  if (path.pathname === '/search') {
    if (!valid) {
      return signedOut
        ? Response.json({ errorCode: signedOut.errorCode, detail: 'x'.repeat(5_000) }, { status: signedOut.status })
        : Response.json({}, { status: 401 });
    }
    const query = path.searchParams.get('q');
    if (query === 'forbidden') return Response.json({}, { status: 403 });
    if (query === 'hang') {
      const signal = init.signal;
      await new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return Response.json({ query, count: 1 });
  }
  if (${managed} && path.pathname === '/approve' && init?.allowAmbiguousRetry !== false) {
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
  return {
    root,
    expired,
    clockOffset,
    journal,
    savedCookies,
    transport,
    workflows: { auth, data },
  };
}

it('preserves legacy MCP continuation across a long approval wait without a policy', async () => {
  const { clockOffset, journal, transport } = prepare({ managed: false });
  const client = new Client({ name: 'legacy-auth-test', version: '1' });
  const callAuth = (action: string, continuation?: string) =>
    client.callTool({ name: policy.authTool, arguments: { action, continuation } });
  try {
    await client.connect(transport());
    const start = await callAuth('start');
    const startText = (start.content as { text: string }[])[0]?.text ?? '';
    const startToken = startText.match(/continuation: "([^"]+)"/)?.[1];
    expect(start.isError).toBe(true);
    expect(startText).toContain('[ACTION_REQUIRED]');
    expect(startToken).toBeDefined();

    writeFileSync(clockOffset, String(10 * 60 * 1_000));
    const approve = await callAuth('approve', startToken);
    const approvalText = (approve.content as { text: string }[])[0]?.text ?? '';
    const approvalToken = approvalText.match(/continuation: "([^"]+)"/)?.[1];
    expect(approve.isError).toBe(true);
    expect(approvalText).toContain('nextAction: finish');
    expect(approvalToken).toBeDefined();

    const finish = await callAuth('finish', approvalToken);
    expect(finish.isError).toBeFalsy();
    expect(finish.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"authenticated": true') }),
    ]);
    expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual([
      '/start',
      '/approve',
      '/finish',
    ]);
  } finally {
    await client.close();
  }
}, 20_000);

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

it('matches only declared provider errors without depending on the body preview', async () => {
  const { workflows } = prepare();
  for (const status of [200, 403, 429]) {
    const options = {
      workflow: workflows.data,
      params: { query: 'fixture' },
      credentials: { site, cookies: [], values: {} },
      fetchImpl: Object.assign(
        async () =>
          Response.json({ detail: 'x'.repeat(5_000), errorCode: 'SIGNED_OUT' }, { status }),
        { preconnect: fetch.preconnect },
      ),
    };
    const signedOutResponse = { status, errorCode: 'SIGNED_OUT' };
    const legacy = await executeWorkflow(options);
    expect(isSignedOut(legacy, { ...policy, signedOutResponse })).toBe(false);
    expect(legacy.ok).toBe(status === 200);
    expect(legacy).not.toHaveProperty('providerError');
    const managed = await executeWorkflow({
      ...options,
      credentials: { ...options.credentials, providerErrorMatches: [signedOutResponse] },
    });
    expect(managed).toMatchObject({ ok: false, providerError: signedOutResponse });
    expect(isSignedOut(managed, { ...policy, signedOutResponse })).toBe(true);
    expect(
      isSignedOut(managed, {
        ...policy,
        signedOutResponse: { status, errorCode: 'BLOCKED' },
      }),
    ).toBe(false);
  }
});

it('stops a managed auth action on a matched provider error even if the step normally continues', async () => {
  const { workflows } = prepare();
  const workflow = structuredClone(workflows.auth);
  const start = workflow.authConfig?.actions.start?.steps[0];
  if (!start) throw new Error('Missing fixture start action');
  start.onError = 'continue';
  const providerError = { status: 200, errorCode: 'VERIFICATION_REQUIRED' };
  const result = await executeWorkflow({
    workflow,
    params: { action: 'start' },
    credentials: { site, values: {}, cookies: [], providerErrorMatches: [providerError] },
    fetchImpl: Object.assign(async () => Response.json({ errorCode: providerError.errorCode }), {
      preconnect: fetch.preconnect,
    }),
  });
  expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE', providerError });
  expect(result).not.toHaveProperty('nextAction');
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

it('bounds the protected retry with the managed renewal deadline', async () => {
  const { transport } = prepare({ recoveryTimeoutMs: 1_500 });
  const client = new Client(
    { name: 'renewal-deadline-test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await client.connect(transport());
    const result = await client.callTool({ name: 'search', arguments: { query: 'hang' } });
    expect(result.structuredContent).toEqual({
      status: 'auth_required',
      message: 'The protected retry did not finish before the renewal deadline.',
    });
    const next = await client.callTool({ name: 'search', arguments: { query: 'next' } });
    expect(next.isError).toBeFalsy();
  } finally {
    await client.close();
  }
}, 20_000);

it('rechecks newer persisted credentials before renewing in a second MCP process', async () => {
  const { expired, journal, transport } = prepare({
    signedIn: true,
    signedOutResponse: { status: 401, errorCode: 'SIGNED_OUT' },
  });
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
