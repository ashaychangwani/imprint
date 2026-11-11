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
  idleMs,
  varyingBootstrap = false,
  timeoutMs,
  finishFailure,
  bootstrapCaptures = false,
  allowlist = false,
  keepBrowserOpen = false,
  serverOnlyRenewal = false,
  unsafeOtp = false,
  startAction,
}: {
  managed?: boolean;
  otp?: boolean;
  refresh?: boolean;
  unsafe?: boolean;
  legacyData?: boolean;
  invalidPolicy?: boolean;
  idleMs?: number;
  varyingBootstrap?: boolean;
  timeoutMs?: number;
  finishFailure?: 'hang' | 'network' | 'transform';
  bootstrapCaptures?: boolean;
  allowlist?: boolean;
  keepBrowserOpen?: boolean;
  serverOnlyRenewal?: boolean;
  unsafeOtp?: boolean;
  startAction?: string;
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
      ...(refresh
        ? [{ name: 'region', type: 'string', description: 'Region', default: 'us' }]
        : []),
      ...(otp ? [{ name: 'otp', type: 'string', description: 'Verification code' }] : []),
    ],
    intent: { description: 'Fixture authentication' },
    ...(finishFailure === 'transform' ? { requestTransformModule: './request-transform.ts' } : {}),
    ...(varyingBootstrap
      ? {
          bootstrap: {
            url: 'https://example.test/bootstrap/${param.action}',
            ...(bootstrapCaptures
              ? { captures: [{ source: 'response_header', name: 'nonce', header: 'x-nonce' }] }
              : {}),
          },
        }
      : {}),
    requests: names.map((name) => ({
      method: name === 'approve' || (name === 'finish' && unsafeOtp) ? 'POST' : 'GET',
      url: `https://example.test/${name}${otp && name === 'finish' ? '?otp=${param.otp}' : refresh && name === 'refresh' ? '?region=${param.region}' : ''}`,
      headers: {},
      effect:
        name === 'approve' || (name === 'finish' && (unsafeOtp || finishFailure === 'network'))
          ? 'unsafe'
          : 'safe',
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
            parameters:
              name === 'finish' && otp ? ['otp'] : name === 'refresh' && refresh ? ['region'] : [],
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
    if (workflow.requestTransformModule) {
      writeFileSync(
        join(dir, workflow.requestTransformModule),
        `export async function transform(_method: string, url: string) {
  if (new URL(url).pathname === '/finish') await new Promise(() => {});
}`,
      );
    }
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
            timeoutMs,
            startAction,
          }),
    );
  }

  const runtime = join(import.meta.dir, '..', 'src', 'imprint');
  const preload = join(root, 'fixture.ts');
  const journal = join(root, 'requests.txt');
  const browsers = join(root, 'browsers.txt');
  const clock = join(root, 'clock');
  const release = join(root, 'release');
  const cookies = join(root, 'cookies.json');
  const authorized = join(root, 'authorized');
  writeFileSync(cookies, '[]');
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { __setCdpBrowserFetchFactoryForTest } from ${JSON.stringify(join(runtime, 'backend-ladder.ts'))};
import { setBackendOverride } from ${JSON.stringify(join(runtime, 'credential-store.ts'))};
const idleMs = ${JSON.stringify(idleMs)};
if (idleMs !== undefined) {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 300_000 ? idleMs : ms, ...args);
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
    if (query === 'recheck-hang' && readFileSync(${JSON.stringify(journal)}, 'utf8').split('/search').length > 2) {
      await new Promise(() => {});
    }
    while (query === 'wait' && !existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    const signedIn = new Headers(init?.headers).get('cookie')?.includes('sid=fresh') || existsSync(${JSON.stringify(authorized)});
    while (query === 'stale' && !existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    return signedIn || query === 'public'
      ? Response.json({ query, count: 1 })
      : Response.json({}, { status: 401 });
  }
  if (${managed && !invalidPolicy} && path.pathname === '/approve' && init?.allowAmbiguousRetry !== false) {
    throw new Error('Managed approval must opt out of ambiguous retries');
  }
  if (path.pathname === '/finish' && ${JSON.stringify(finishFailure)} === 'hang') await new Promise(() => {});
  if (path.pathname === '/finish' && ${JSON.stringify(finishFailure)} === 'network') throw new Error('Response unavailable');
  if (${otp} && path.pathname === '/finish' && path.searchParams.get('otp') !== '123456') {
    return Response.json({}, { status: 400 });
  }
  if (${refresh} && path.pathname === '/refresh' && path.searchParams.get('region') !== 'us') {
    throw new Error('Missing configured refresh region');
  }
  if (path.pathname === '/finish' || path.pathname === '/refresh') {
    if (${serverOnlyRenewal}) {
      writeFileSync(${JSON.stringify(authorized)}, '');
      return Response.json({ verified: true });
    }
    return Response.json({ verified: true }, { headers: { 'set-cookie': 'sid=fresh; Path=/; Secure' } });
  }
  return Response.json({});
};
globalThis.fetch = fetchFixture;
__setCdpBrowserFetchFactoryForTest(() => {
  appendFileSync(${JSON.stringify(browsers)}, 'browser' + String.fromCharCode(10));
  const keepAlive = ${keepBrowserOpen} ? setInterval(() => {}, 1000) : undefined;
  return {
    fetchImpl: fetchFixture,
    mintJar: async () => ({ cookies: getCookies(), ua: 'fixture', html: '', bootstrapEpoch: Date.now(), abckFlag: '0', bootstrapResponseHeaders: { 'x-nonce': 'fixture-nonce' } }),
    close: async () => {
      if (!keepAlive) return;
      await Bun.sleep(2300);
      clearInterval(keepAlive);
      appendFileSync(${JSON.stringify(browsers)}, 'closed' + String.fromCharCode(10));
    },
  };
});
`,
  );
  const transport = () =>
    new StdioClientTransport({
      command: process.execPath,
      args: [
        'run',
        '--preload',
        preload,
        join(runtime, '..', 'cli.ts'),
        'mcp-server',
        site,
        ...(allowlist ? ['--include-tools', `search,${authTool}`] : []),
      ],
      env: { ...getDefaultEnvironment(), IMPRINT_HOME: root },
      stderr: 'ignore',
    });
  return {
    transport,
    clock,
    cookies,
    release,
    journal,
    browsers,
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
  const { transport, requests } = prepare({ refresh: true, allowlist: true });
  const c = client();
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).isError).toBeFalsy();
    expect(requests()).toEqual(['/search', '/search', '/refresh', '/search']);
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
        expect(requests()).toEqual(['/search', '/search', '/start', '/search', '/search']);
      }
    } finally {
      await c.close();
    }
  }, 20_000);
}

for (const unsafeOtp of [false, true]) {
  it(`accepts a corrected OTP in the same browser for a ${unsafeOtp ? 'consented write' : 'safe read'}`, async () => {
    const { transport, requests, browsers } = prepare({
      otp: true,
      varyingBootstrap: true,
      unsafeOtp,
    });
    const c = client();
    let approvals = 0;
    c.setRequestHandler(ElicitRequestSchema, async () => {
      approvals++;
      return { action: 'accept', content: {} };
    });
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
      expect(requests()).toEqual(['/search', '/search', '/start', '/approve']);
      const missing = await callAuth(c, 'finish', token);
      expect(missing.isError).toBe(true);
      expect(requests()).toEqual(['/search', '/search', '/start', '/approve']);
      expect((await callAuth(c, 'approve', token)).isError).toBe(true);
      expect(requests()).toEqual(['/search', '/search', '/start', '/approve']);
      const rejected = await callAuth(c, 'finish', token, '000000');
      expect(rejected.isError).toBe(true);
      const retry = continuationToken(rejected);
      expect(retry).toBeDefined();
      expect((await callAuth(c, 'finish', retry, '123456')).isError).toBeFalsy();
      expect(approvals).toBe(unsafeOtp ? 3 : 1);
      expect((await search(c, 'query')).isError).toBeFalsy();
      expect(readFileSync(browsers, 'utf8').trim().split('\n')).toEqual(['browser']);
    } finally {
      await c.close();
    }
  });
}

it('retains a queued OTP resume past the browser idle deadline', async () => {
  const { transport, requests, release } = prepare({ otp: true, idleMs: 250 });
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
      if (requests().filter((path) => path === '/search').length === 3) break;
      await Bun.sleep(5);
    }
    expect(requests().filter((path) => path === '/search')).toHaveLength(3);
    const resume = callAuth(c, 'finish', token, '123456');
    await Bun.sleep(350);
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
  const { transport, requests } = prepare({ otp: true, idleMs: 25 });
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
    expect(requests()).toEqual(['/search', '/search', '/start', '/approve']);
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
    expect(requests()).toEqual(['/search', '/search', '/start']);
    expect((await c.listTools()).tools.some((tool) => tool.name === authTool)).toBe(true);
  } finally {
    await c.close();
  }
});

it('requests consent from a client advertising the legacy form capability', async () => {
  const { transport, requests } = prepare();
  const c = new Client(
    { name: 'legacy-form', version: '1' },
    { capabilities: { elicitation: {} } },
  );
  let approvals = 0;
  c.setRequestHandler(ElicitRequestSchema, async () => {
    approvals++;
    return { action: 'accept', content: {} };
  });
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).isError).toBeFalsy();
    expect(approvals).toBe(1);
    expect(requests()).toEqual(['/search', '/search', '/start', '/approve', '/finish', '/search']);
  } finally {
    await c.close();
  }
});

it('does not use bootstrap document captures from a different action', async () => {
  const { transport, requests } = prepare({ varyingBootstrap: true, bootstrapCaptures: true });
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).structuredContent).toMatchObject({
      status: 'auth_required',
      message: expect.stringContaining('standalone auth tool'),
    });
    expect(requests()).toEqual(['/search', '/search', '/start']);
  } finally {
    await c.close();
  }
});

for (const finishFailure of ['hang', 'network', 'transform'] as const) {
  it(`settles a managed OTP resume that fails with ${finishFailure}`, async () => {
    const { transport, requests } = prepare({ otp: true, finishFailure, timeoutMs: 500 });
    const c = client();
    c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
    try {
      await c.connect(transport());
      const first = await search(c, 'query');
      const token = (first.structuredContent as { continuation?: string }).continuation;
      expect(token).toBeDefined();
      const result = await callAuth(c, 'finish', token, '123456');
      expect(continuationToken(result)).toBeUndefined();
      if (finishFailure !== 'network') {
        expect(result.structuredContent).toMatchObject({ status: 'auth_required' });
      } else {
        expect(result.isError).toBe(true);
      }
      expect(requests()).toEqual(
        finishFailure === 'transform'
          ? ['/search', '/search', '/start', '/approve']
          : ['/search', '/search', '/start', '/approve', '/finish'],
      );
      expect((await search(c, 'public')).isError).toBeFalsy();
    } finally {
      await c.close();
    }
  });
}

it('does not share standalone tokens or let an abandoned pause block renewal', async () => {
  const { transport, requests, clock } = prepare({ refresh: true });
  const c = new Client({ name: 'no-elicitation', version: '1' });
  try {
    await c.connect(transport());
    const standalone = await callAuth(c, 'start');
    expect(continuationToken(standalone)).toBeDefined();
    const protectedResult = await search(c, 'query');
    expect(protectedResult.structuredContent).toMatchObject({ status: 'auth_required' });
    expect(protectedResult.structuredContent).not.toHaveProperty('continuation');
    expect(requests()).toEqual(['/start', '/search']);
    writeFileSync(clock, String(10 * 60 * 1000));
    expect((await search(c, 'query')).isError).toBeFalsy();
    expect(requests()).toEqual(['/start', '/search', '/search', '/search', '/refresh', '/search']);
  } finally {
    await c.close();
  }
});

it('drains a parked sign-in browser despite the client SIGTERM after stdin closes', async () => {
  const { transport, browsers } = prepare({ otp: true, keepBrowserOpen: true });
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await c.connect(transport());
    expect((await search(c, 'query')).structuredContent).toHaveProperty('continuation');
  } finally {
    await c.close();
  }
  expect(readFileSync(browsers, 'utf8').trim().split('\n')).toEqual(['browser', 'closed']);
}, 10_000);

it('invalidates the old standalone continuation when the caller explicitly restarts', async () => {
  const { transport, requests } = prepare();
  const c = client();
  try {
    await c.connect(transport());
    const first = continuationToken(await callAuth(c, 'start'));
    expect(first).toBeDefined();
    expect(continuationToken(await callAuth(c, 'start'))).toBeDefined();
    const stale = await callAuth(c, 'approve', first);
    expect(stale.content).toEqual([
      { type: 'text', text: 'Invalid or expired continuation token.' },
    ]);
    expect(requests()).toEqual(['/start', '/start']);
  } finally {
    await c.close();
  }
});

it('can restart at the compiled entry after recovery used an alternate start action', async () => {
  const { transport, requests } = prepare({ otp: true, startAction: 'approve' });
  const c = client();
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));
  try {
    await c.connect(transport());
    const pending = await search(c, 'query');
    const token = (pending.structuredContent as { continuation?: string }).continuation;
    expect(token).toBeDefined();
    expect(continuationToken(await callAuth(c, 'start'))).toBeDefined();
    expect((await callAuth(c, 'finish', token, '123456')).isError).toBe(true);
    expect(requests()).toEqual(['/search', '/search', '/approve', '/start']);
  } finally {
    await c.close();
  }
});

it('releases the recovery queue when a protected recheck stalls', async () => {
  const { transport, requests } = prepare({ timeoutMs: 500 });
  const c = client();
  try {
    await c.connect(transport());
    expect((await search(c, 'recheck-hang')).structuredContent).toMatchObject({
      status: 'auth_required',
      message: expect.stringContaining('deadline'),
    });
    expect(requests()).toEqual(['/search', '/search']);
    expect((await search(c, 'public')).isError).toBeFalsy();
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
    expect(requests()).toEqual(['/search', '/search', '/start', '/search']);
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
      if (requests().filter((path) => path === '/search').length === 3) break;
      await Bun.sleep(10);
    }
    expect(requests().filter((path) => path === '/search')).toHaveLength(3);
    release.resolve();
    expect((await Promise.all([a, b])).every((result) => !result.isError)).toBe(true);
    expect(approvals).toBe(1);
    expect(requests().filter((path) => path === '/finish')).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.all([first.close(), second.close()]);
  }
}, 20_000);

for (const scenario of ['renewed credentials', 'unchanged credentials', 'a delayed 401'] as const) {
  it(`shares an OTP handoff across processes with ${scenario}`, async () => {
    const { transport, requests, release } = prepare({
      otp: true,
      serverOnlyRenewal: scenario !== 'renewed credentials',
    });
    const first = client('first');
    const second = client('second');
    let approvals = 0;
    for (const c of [first, second]) {
      c.setRequestHandler(ElicitRequestSchema, async () => {
        approvals++;
        return { action: 'accept', content: {} };
      });
    }
    try {
      await first.connect(transport());
      await second.connect(transport());
      const pending = await search(first, 'first');
      const token = (pending.structuredContent as { continuation?: string }).continuation;
      expect(token).toBeDefined();
      const waiting = search(second, scenario === 'a delayed 401' ? 'stale' : 'second');
      for (let attempt = 0; attempt < 200; attempt++) {
        if (requests().filter((path) => path === '/search').length === 3) break;
        await Bun.sleep(10);
      }
      expect(requests().filter((path) => path === '/search')).toHaveLength(3);
      await Bun.sleep(300);
      expect(requests().filter((path) => path === '/start')).toHaveLength(1);
      expect((await callAuth(first, 'finish', token, '123456')).isError).toBeFalsy();
      writeFileSync(release, '');
      expect((await waiting).isError).toBeFalsy();
      expect(approvals).toBe(1);
      expect(requests().filter((path) => path === '/approve')).toHaveLength(1);
    } finally {
      writeFileSync(release, '');
      await Promise.all([first.close(), second.close()]);
    }
  }, 20_000);
}
