import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  COMPILE_SENTINELS,
  canWaiveIrreversibleLiveVerification,
  compileDoneToolDescription,
} from '../src/imprint/mcp-compile-server.ts';
import { SessionSchema, type Workflow } from '../src/imprint/types.ts';
import {
  UserInteraction,
  type UserPromptAnswer,
  withUserInteraction,
} from '../src/imprint/user-interaction.ts';

it('closes a live compiler on malformed protocol input instead of leaving calls pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-protocol-'));
  const sessionPath = join(root, 'session.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      site: 'fixture',
      url: 'https://fixture.invalid',
      startedAt: new Date().toISOString(),
      imprintVersion: 'fixture',
      requests: [],
      events: [],
      narration: [],
    }),
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      'run',
      join(import.meta.dir, '..', 'src', 'cli.ts'),
      '__mcp-compile-server',
      '--session-path',
      sessionPath,
      '--tool-dir',
      root,
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
  );
  try {
    proc.stdin.write('invalid JSON protocol frame\n');
    const exited = await Promise.race([proc.exited, Bun.sleep(2000).then(() => null)]);
    expect(exited).not.toBeNull();
    expect(await new Response(proc.stderr).text()).toContain('protocol or channel error');
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

it('settles a pending call when the compiler response stream ends but its input stays open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-output-'));
  const sessionPath = join(root, 'session.json');
  const closePath = join(root, 'close-output');
  const entryPath = join(root, 'peer.ts');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      site: 'fixture',
      url: 'https://fixture.invalid',
      startedAt: new Date().toISOString(),
      imprintVersion: 'fixture',
      requests: [],
      events: [],
      narration: [],
    }),
  );
  writeFileSync(
    entryPath,
    `import { existsSync } from 'node:fs'; import { runCompileMcpServer } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'imprint', 'mcp-compile-server.ts'))}; const timer = setInterval(() => { if (existsSync(${JSON.stringify(closePath)})) process.stdout.end(); }, 5); try { await runCompileMcpServer({ sessionPath: ${JSON.stringify(sessionPath)}, toolDir: ${JSON.stringify(root)} }); } finally { clearInterval(timer); }`,
  );
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const interaction = new UserInteraction(async (_prompt, signal) => {
    entered();
    return await new Promise<UserPromptAnswer>((_resolve, reject) =>
      signal?.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(signal.reason);
        },
        { once: true },
      ),
    );
  });
  try {
    await withUserInteraction(interaction, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['run', entryPath],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'fixture-output-close', version: '1' });
      try {
        await client.connect(transport);
        const pending = client
          .callTool(
            { name: 'prompt_user', arguments: { message: 'Held fixture question' } },
            undefined,
            { timeout: 2000 },
          )
          .catch((error: unknown) => error);
        await started;
        writeFileSync(closePath, 'close');
        const error = await pending;
        expect(error).toMatchObject({ code: -32000 });
        expect(cancelled).toBe(true);
      } finally {
        await client.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('routes a data compiler MCP question to the parent terminal host without an auth checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-question-'));
  const sessionPath = join(root, 'session.json');
  writeFileSync(
    sessionPath,
    JSON.stringify(
      SessionSchema.parse({
        site: 'fixture-question',
        url: 'https://fixture.invalid',
        startedAt: new Date().toISOString(),
        imprintVersion: '0.7.0',
        requests: [],
        events: [],
        narration: [],
      }),
    ),
  );
  const interaction = new UserInteraction(async () => ({
    status: 'answered',
    value: 'fixture-secret-452631',
  }));
  try {
    await withUserInteraction(interaction, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          'run',
          join(import.meta.dir, '..', 'src', 'cli.ts'),
          '__mcp-compile-server',
          '--session-path',
          sessionPath,
          '--tool-dir',
          root,
        ],
        cwd: join(import.meta.dir, '..'),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'fixture-compiler-question', version: '1.0.0' });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(({ name }) => name)).toContain('authenticate');
        const result = await client.callTool({
          name: 'prompt_user',
          arguments: { message: 'Enter a fixture secret', sensitive: true },
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain('${prompt.');
        expect(JSON.stringify(result)).not.toContain('fixture-secret-452631');
        expect(existsSync(join(root, '.compile-checkpoint.json'))).toBe(false);
      } finally {
        await client.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cancellationKind of ['request', 'disconnect'] as const) {
  it(`propagates SDK ${cancellationKind} cancellation through MCP and the parent HTTP bridge`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-cancel-'));
    const sessionPath = join(root, 'session.json');
    writeFileSync(
      sessionPath,
      JSON.stringify(
        SessionSchema.parse({
          site: 'fixture-cancel',
          url: 'https://fixture.invalid',
          startedAt: new Date().toISOString(),
          imprintVersion: '0.7.0',
          requests: [],
          events: [],
          narration: [],
        }),
      ),
    );
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const interaction = new UserInteraction(async (_prompt, signal) => {
      entered();
      return await new Promise<UserPromptAnswer>((_resolve, reject) => {
        const abort = (): void => {
          cancelled();
          reject(signal?.reason);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    try {
      await withUserInteraction(interaction, async () => {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            'run',
            join(import.meta.dir, '..', 'src', 'cli.ts'),
            '__mcp-compile-server',
            '--session-path',
            sessionPath,
            '--tool-dir',
            root,
          ],
          cwd: join(import.meta.dir, '..'),
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stderr: 'pipe',
        });
        const client = new Client({ name: 'fixture-cancellation', version: '1.0.0' });
        try {
          await client.connect(transport);
          const controller = new AbortController();
          const pending = client
            .callTool(
              {
                name: 'prompt_user',
                arguments: { message: 'Fixture pending input', sensitive: false },
              },
              undefined,
              { signal: controller.signal },
            )
            .catch((error: unknown) => error);
          await started;
          if (cancellationKind === 'request')
            controller.abort(new Error('Fixture MCP cancellation'));
          else await client.close();
          expect(await pending).toBeInstanceOf(Error);
          await cancellation;
        } finally {
          await client.close();
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

describe('compile MCP sentinels', () => {
  it('offers and checkpoints live auth discovery before a workflow exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-mcp-auth-discovery-'));
    const sessionPath = join(root, 'session.json');
    writeFileSync(
      sessionPath,
      JSON.stringify(
        SessionSchema.parse({
          site: 'fixture-site',
          url: 'https://fixture.invalid/login',
          startedAt: new Date().toISOString(),
          imprintVersion: '0.7.0',
          requests: [],
          events: [],
          narration: [],
        }),
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'run',
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        '__mcp-compile-server',
        '--session-path',
        sessionPath,
        '--tool-dir',
        root,
        '--site',
        'fixture-site',
        '--auth-plan-json',
        JSON.stringify({
          toolName: 'authenticate_fixture',
          credentialRequestSeqs: [],
          authRequestSeqs: [],
          credentialNames: [],
          captures: [],
          notes: 'Learn live flow',
        }),
      ],
      cwd: join(import.meta.dir, '..'),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'fixture-auth-discovery', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(
        'interact_verification_browser',
      );
      const result = await client.callTool({
        name: 'interact_verification_browser',
        arguments: { action: 'inspect' },
      });
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse(readFileSync(join(root, COMPILE_SENTINELS.checkpoint), 'utf8')),
      ).toMatchObject({ kind: 'interact_verification_browser', action: 'inspect' });
      expect(existsSync(join(root, 'workflow.json'))).toBe(false);
      expect(existsSync(join(root, COMPILE_SENTINELS.done))).toBe(false);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps factual completion and failure channels distinct', () => {
    expect(COMPILE_SENTINELS.done).toBe('.compile-done.json');
    expect(COMPILE_SENTINELS.giveUp).toBe('.compile-give-up.json');
  });

  it('describes master MVP done as a deterministic handoff', () => {
    const description = compileDoneToolDescription('master_mvp');
    expect(description).toContain('deterministic artifact, schema, test, and type facts');
    expect(description).toContain('hands the artifact back to the master for live verification');
    expect(description).not.toContain('independent external verification');
  });
});

describe('irreversible compile completion', () => {
  const workflow = {
    requests: [{ effect: 'irreversible' }],
  } as Workflow;

  it('waives only live execution after deterministic checks pass', () => {
    expect(canWaiveIrreversibleLiveVerification([], workflow)).toBe(true);
    expect(canWaiveIrreversibleLiveVerification(['request.test.ts failed'], workflow)).toBe(false);
    expect(canWaiveIrreversibleLiveVerification([], undefined)).toBe(false);
  });
});
