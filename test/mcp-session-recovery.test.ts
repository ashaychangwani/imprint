import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { emit } from '../src/imprint/emit.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const dirs: string[] = [];
const site = 'fixture';
const authTool = 'authenticate_site';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepare({
  managed = true,
  otp = false,
  refresh = false,
  unsafe = false,
  legacyData = false,
  invalidPolicy = false,
  fastIdle = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-renewal-'));
  dirs.push(root);
  const names = ['start', 'approve', 'finish', 'refresh'];
  const auth = WorkflowSchema.parse({
    toolName: authTool,
    toolKind: 'authenticate',
    site,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Auth step',
        default: 'start',
        choices: names,
      },
      ...(otp ? [{ name: 'otp', type: 'string', description: 'Verification code' }] : []),
    ],
    intent: { description: 'Fixture authentication' },
    requests: names.map((name) => ({
      method: name === 'approve' ? 'POST' : 'GET',
      url: `https://example.test/${name}${otp && name === 'finish' ? '?otp=${param.otp}' : ''}`,
      headers: {},
      effect: name === 'approve' ? 'unsafe' : 'safe',
      captures:
        name === 'finish' || name === 'refresh'
          ? [{ source: 'json', name: 'verified', path: 'verified', equals: true }]
          : [],
    })),
    authConfig: {
      entry: 'start',
      actions: Object.fromEntries(
        names.map((name, request) => [
          name,
          {
            parameters: name === 'finish' && otp ? ['otp'] : [],
            steps: [{ request }],
            outcome:
              name === 'start' || name === 'approve'
                ? {
                    type: 'pause',
                    next: name === 'start' ? 'approve' : 'finish',
                    ...(managed ? { resume: 'automatic' } : {}),
                    message: 'Continue verification.',
                  }
                : { type: 'success', evidence: ['verified'] },
          },
        ]),
      ),
    },
  });
  const data = WorkflowSchema.parse({
    toolName: 'search',
    site,
    parameters: [{ name: 'query', type: 'string', description: 'Search query' }],
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
  for (const workflow of [auth, data]) {
    const dir = join(root, site, workflow.toolName);
    mkdirSync(dir, { recursive: true });
    const workflowPath = join(dir, 'workflow.json');
    writeFileSync(workflowPath, JSON.stringify(workflow));
    emit({ workflowPath, outDir: dir });
    if (legacyData && workflow === data) {
      const wrapper = join(dir, 'index.ts');
      const emitted = readFileSync(wrapper, 'utf8');
      writeFileSync(
        wrapper,
        emitted.replace(
          'const WORKFLOW: Workflow = {',
          'const WORKFLOW: Workflow = {\n  "authConfig": {"twoFactorType":"none","sessionCapture":[]},',
        ),
      );
    }
  }
  if (managed) {
    writeFileSync(
      join(root, site, 'mcp-session-recovery.json'),
      invalidPolicy
        ? '{}'
        : JSON.stringify({
            authTool,
            protectedTools: ['search'],
            ...(refresh ? { refreshAction: 'refresh' } : {}),
          }),
    );
  }

  const runtime = join(import.meta.dir, '..', 'src', 'imprint');
  const preload = join(root, 'fixture.ts');
  const journal = join(root, 'requests.txt');
  const clock = join(root, 'clock');
  const release = join(root, 'release');
  const cookies = join(root, 'cookies.json');
  writeFileSync(cookies, '[]');
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { __setCdpBrowserFetchFactoryForTest } from ${JSON.stringify(join(runtime, 'backend-ladder.ts'))};
import { setBackendOverride } from ${JSON.stringify(join(runtime, 'credential-store.ts'))};
if (${fastIdle}) {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 300_000 ? 25 : ms, ...args);
}
const clock = ${JSON.stringify(clock)};
const now = Date.now;
Date.now = () => now() + (existsSync(clock) ? Number(readFileSync(clock, 'utf8')) : 0);
const store = ${JSON.stringify(cookies)};
const getCookies = () => JSON.parse(readFileSync(store, 'utf8'));
setBackendOverride({
  id: 'encrypted-file',
  lockDirectory: ${JSON.stringify(join(root, 'locks'))},
  getCookies: async () => getCookies(),
  setCookies: async (_, next) => writeFileSync(store, JSON.stringify(next)),
  getSecret: async () => null,
  listSecrets: async () => [],
  listSites: async () => [],
});
const fetchFixture = async (url, init) => {
  const path = new URL(url);
  appendFileSync(${JSON.stringify(journal)}, path.pathname + '\\n');
  if (path.pathname === '/search') {
    const query = path.searchParams.get('q');
    while (query === 'wait' && !existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    const authorized = new Headers(init?.headers).get('cookie')?.includes('sid=fresh');
    return authorized || query === 'public'
      ? Response.json({ query, count: 1 })
      : Response.json({}, { status: 401 });
  }
  if (${managed && !invalidPolicy} && path.pathname === '/approve' && init?.allowAmbiguousRetry !== false) {
    throw new Error('Managed approval must opt out of ambiguous retries');
  }
  if (${otp} && path.pathname === '/finish' && path.searchParams.get('otp') !== '123456') {
    return Response.json({}, { status: 400 });
  }
  if (path.pathname === '/finish' || path.pathname === '/refresh') {
    return Response.json({ verified: true }, { headers: { 'set-cookie': 'sid=fresh; Path=/; Secure' } });
  }
  return Response.json({});
};
globalThis.fetch = fetchFixture;
__setCdpBrowserFetchFactoryForTest(() => ({
  fetchImpl: fetchFixture,
  mintJar: async () => ({ cookies: getCookies(), ua: 'fixture', html: '', bootstrapEpoch: Date.now(), abckFlag: '0' }),
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
    transport,
    clock,
    cookies,
    release,
    journal,
    requests: () => readFileSync(journal, 'utf8').trim().split('\n'),
  };
}

function client(name = 'fixture') {
  return new Client({ name, version: '1' }, { capabilities: { elicitation: { form: {} } } });
}

function search(c: Client, query: string) {
  return c.callTool({ name: 'search', arguments: { query } });
}

function callAuth(c: Client, action: string, continuation?: string, otp?: string) {
  return c.callTool({ name: authTool, arguments: { action, continuation, otp } });
}

function continuationToken(result: Awaited<ReturnType<typeof callAuth>>) {
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  return text.match(/continuation: "([^"]+)"/)?.[1];
}

it('preserves legacy MFA continuation after a long wait', async () => {
  const { transport, clock, requests } = prepare({ managed: false });
  const c = client();
  try {
    await c.connect(transport());
    const started = await callAuth(c, 'start');
    expect(started.isError).toBe(true);
    const token = continuationToken(started);
    expect(token).toBeDefined();
    writeFileSync(clock, String(10 * 60 * 1000));
    const approved = await callAuth(c, 'approve', token);
    expect(approved.isError).toBe(true);
    expect(continuationToken(approved)).toBeDefined();
    expect((await callAuth(c, 'finish', continuationToken(approved))).isError).toBeFalsy();
    expect(requests()).toEqual(['/start', '/approve', '/finish']);
  } finally {
    await c.close();
  }
});

for (const invalidPolicy of [false, true]) {
  it(`dispatches legacy data with an old authConfig and ${invalidPolicy ? 'an invalid policy' : 'no policy'}`, async () => {
    const { transport, requests } = prepare({
      managed: invalidPolicy,
      invalidPolicy,
      legacyData: true,
    });
    const c = client();
    try {
      await c.connect(transport());
      expect((await search(c, 'public')).isError).toBeFalsy();
      expect(requests()).toEqual(['/search']);
    } finally {
      await c.close();
    }
  });
}

it('refreshes silently and retries the protected read once', async () => {
  const { transport, requests } = prepare({ refresh: true });
  const c = client();
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).isError).toBeFalsy();
    expect(requests()).toEqual(['/search', '/refresh', '/search']);
  } finally {
    await c.close();
  }
});

for (const accepted of [true, false]) {
  it(`coalesces queued reads when consent is ${accepted ? 'accepted' : 'declined'}`, async () => {
    const { transport, requests, cookies } = prepare();
    const c = client();
    let approvals = 0;
    c.setRequestHandler(ElicitRequestSchema, async () => {
      approvals++;
      expect(JSON.parse(readFileSync(cookies, 'utf8'))).toEqual([]);
      return accepted ? { action: 'accept', content: {} } : { action: 'decline' };
    });
    try {
      await c.connect(transport());
      const results = await Promise.all(
        ['first', 'second', 'third'].map((query) => search(c, query)),
      );
      expect(approvals).toBe(1);
      if (accepted) {
        expect(results.every((result) => !result.isError)).toBe(true);
        expect(requests()).toEqual([
          '/search',
          '/start',
          '/approve',
          '/finish',
          '/search',
          '/search',
          '/search',
        ]);
      } else {
        expect(
          results.every(
            (result) =>
              (result.structuredContent as { status?: string })?.status === 'auth_required',
          ),
        ).toBe(true);
        expect(requests()).toEqual(['/search', '/start', '/search', '/search']);
      }
    } finally {
      await c.close();
    }
  }, 20_000);
}

it('hands off a required OTP and accepts the original continuation on the auth tool', async () => {
  const { transport, requests } = prepare({ otp: true });
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await c.connect(transport());
    const first = await search(c, 'query');
    expect(first.structuredContent).toMatchObject({
      status: 'auth_required',
      authTool,
      nextAction: 'finish',
    });
    const token = (first.structuredContent as { continuation?: string }).continuation;
    expect(token).toBeDefined();
    expect(requests()).toEqual(['/search', '/start', '/approve']);
    const rejected = await callAuth(c, 'finish', token, '000000');
    expect(rejected.isError).toBe(true);
    const retry = continuationToken(rejected);
    expect(retry).toBeDefined();
    expect((await callAuth(c, 'finish', retry, '123456')).isError).toBeFalsy();
    expect((await search(c, 'query')).isError).toBeFalsy();
  } finally {
    await c.close();
  }
});

it('retains a pending OTP while a protected call is ahead of its resume in the queue', async () => {
  const { transport, requests, release } = prepare({ otp: true });
  const c = client();
  let approvals = 0;
  c.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    return { action: 'accept', content: {} };
  });
  try {
    await c.connect(transport());
    const first = await search(c, 'first');
    const token = (first.structuredContent as { continuation?: string }).continuation;
    expect(token).toBeDefined();
    const read = search(c, 'wait');
    for (let attempt = 0; attempt < 200; attempt++) {
      if (requests().filter((path) => path === '/search').length === 2) break;
      await Bun.sleep(5);
    }
    expect(requests().filter((path) => path === '/search')).toHaveLength(2);
    const resume = callAuth(c, 'finish', token, '123456');
    await Bun.sleep(25);
    writeFileSync(release, '');
    expect((await read).structuredContent).toMatchObject({ continuation: token });
    expect((await resume).isError).toBeFalsy();
    expect(approvals).toBe(1);
  } finally {
    writeFileSync(release, '');
    await c.close();
  }
}, 20_000);

it('does not resume a managed handoff in a replacement browser after idle eviction', async () => {
  const { transport, requests } = prepare({ otp: true, fastIdle: true });
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await c.connect(transport());
    const first = await search(c, 'query');
    const token = (first.structuredContent as { continuation?: string }).continuation;
    expect(token).toBeDefined();
    await Bun.sleep(150);
    const result = await callAuth(c, 'finish', token, '123456');
    expect(result.structuredContent).toMatchObject({ status: 'auth_required' });
    expect(requests()).toEqual(['/search', '/start', '/approve']);
  } finally {
    await c.close();
  }
});

it('does not direct a client without consent support to an unsafe action', async () => {
  const { transport, requests } = prepare();
  const c = new Client({ name: 'no-elicitation', version: '1' });
  try {
    await c.connect(transport());
    const result = await search(c, 'query');
    expect(result.structuredContent).toMatchObject({ status: 'auth_required' });
    expect(result.structuredContent).not.toHaveProperty('nextAction');
    expect(requests()).toEqual(['/search', '/start']);
    expect((await c.listTools()).tools.some((tool) => tool.name === authTool)).toBe(true);
  } finally {
    await c.close();
  }
});

it('reuses credentials saved while the consent prompt was open', async () => {
  const { transport, requests, cookies } = prepare();
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => {
    writeFileSync(
      cookies,
      JSON.stringify([
        {
          name: 'sid',
          value: 'fresh',
          domain: 'example.test',
          path: '/',
          hostOnly: true,
          secure: true,
        },
      ]),
    );
    return { action: 'accept', content: {} };
  });
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).isError).toBeFalsy();
    expect(requests()).toEqual(['/search', '/start', '/search']);
  } finally {
    await c.close();
  }
});

it('leaves explicitly unsafe tools on their regular path', async () => {
  const { transport, requests } = prepare({ unsafe: true });
  const c = client();
  try {
    await c.connect(transport());
    const result = await search(c, 'query');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(requests()).toEqual(['/search']);
  } finally {
    await c.close();
  }
});

it('uses the newer saved session instead of prompting twice across MCP processes', async () => {
  const { transport, requests } = prepare();
  const first = client('first');
  const second = client('second');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let approvals = 0;
  first.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    started.resolve();
    await release.promise;
    return { action: 'accept', content: {} };
  });
  second.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    return { action: 'decline' };
  });
  try {
    await first.connect(transport());
    await second.connect(transport());
    const a = search(first, 'first');
    await started.promise;
    const b = search(second, 'second');
    for (let attempt = 0; attempt < 200; attempt++) {
      if (requests().filter((path) => path === '/search').length === 2) break;
      await Bun.sleep(10);
    }
    expect(requests().filter((path) => path === '/search')).toHaveLength(2);
    release.resolve();
    expect((await Promise.all([a, b])).every((result) => !result.isError)).toBe(true);
    expect(approvals).toBe(1);
    expect(requests().filter((path) => path === '/finish')).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.all([first.close(), second.close()]);
  }
}, 20_000);
