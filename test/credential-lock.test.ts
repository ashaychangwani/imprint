import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCredentialLock } from '../src/imprint/credential-lock.ts';

async function waitForFile(path: string): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error('Synthetic worker did not reach its checkpoint');
}

test('cookie CAS serializes real child processes sharing one credential namespace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'imprint-credential-process-'));
  const script = join(directory, 'worker.ts');
  const module = new URL('../src/imprint/credential-store.ts', import.meta.url).href;
  writeFileSync(
    join(directory, 'state.json'),
    JSON.stringify({
      cookies: [{ name: 'sid', value: 'synthetic-old', domain: 'fixture.invalid', path: '/' }],
      values: { password: 'synthetic-secret' },
      storage: [],
    }),
  );
  writeFileSync(
    script,
    `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { setBackendOverride, loadSiteCredentials, compareAndSwapSiteCookies } from ${JSON.stringify(module)};
    const [directory, id] = process.argv.slice(2);
    const file = join(directory, 'state.json');
    let state;
    const persist = () => writeFileSync(file, JSON.stringify(state));
    setBackendOverride({
      id: 'keyring', lockDirectory: join(directory, 'tickets'),
      async refresh() { state = JSON.parse(readFileSync(file, 'utf8')); },
      async listSecrets() { return Object.keys(state.values); },
      async getSecret(_site, name) { return state.values[name] ?? null; },
      async setSecret(_site, name, value) { state.values[name] = value; persist(); },
      async deleteSecret(_site, name) { delete state.values[name]; persist(); },
      async getCookies() { return state.cookies; },
      async setCookies(_site, cookies) { await Bun.sleep(10); state.cookies = cookies; persist(); },
      async getStorage() { return state.storage; },
      async listSites() { return ['fixture']; },
    });
    const original = await loadSiteCredentials('fixture');
    writeFileSync(join(directory, 'ready-' + id), 'ready');
    while (!existsSync(join(directory, 'go'))) await Bun.sleep(5);
    const result = await compareAndSwapSiteCookies('fixture', original.revision, [
      { name: 'sid', value: 'synthetic-renewed-' + id, domain: 'fixture.invalid', path: '/' }
    ]);
    console.log(JSON.stringify(result));
  `,
  );
  const children = ['a', 'b', 'c'].map((id) =>
    Bun.spawn([process.execPath, script, directory, id], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH: '' },
    }),
  );
  try {
    await Promise.all(['a', 'b', 'c'].map((id) => waitForFile(join(directory, `ready-${id}`))));
    writeFileSync(join(directory, 'go'), 'go');
    const results = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        const errors = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(errors).toBe('');
        return JSON.parse(output) as { status: string; revision: string };
      }),
    );
    expect(results.map(({ status }) => status).sort()).toEqual(['stale', 'stale', 'updated']);
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].value).toMatch(/^synthetic-renewed-[abc]$/);
    expect(state.values).toEqual({ password: 'synthetic-secret' });
    expect(readdirSync(join(directory, 'tickets'))).toEqual([]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test('a dead child lock owner is recovered without a lease deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'imprint-credential-dead-'));
  const script = join(directory, 'holder.ts');
  const module = new URL('../src/imprint/credential-lock.ts', import.meta.url).href;
  const tickets = join(directory, 'tickets');
  const checkpoint = join(directory, 'entered');
  writeFileSync(
    script,
    `
    import { writeFileSync } from 'node:fs';
    import { withCredentialLock } from ${JSON.stringify(module)};
    await withCredentialLock(${JSON.stringify(tickets)}, undefined, async () => {
      writeFileSync(${JSON.stringify(checkpoint)}, 'entered');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `,
  );
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
  try {
    await waitForFile(checkpoint);
    expect(readdirSync(tickets)).toHaveLength(1);
    child.kill('SIGKILL');
    await child.exited;
    let entered = false;
    await withCredentialLock(tickets, undefined, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    expect(readdirSync(tickets)).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test('a warm encrypted-file process refreshes before CAS and preserves other-site writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'imprint-encrypted-cas-'));
  const script = join(directory, 'worker.ts');
  const module = new URL('../src/imprint/credential-store.ts', import.meta.url).href;
  writeFileSync(
    script,
    `
    import { mock } from 'bun:test';
    import { writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const [directory, role] = process.argv.slice(2);
    mock.module('env-paths', () => ({ default: () => ({ config: directory }) }));
    process.env.IMPRINT_BACKEND = 'file';
    process.env.IMPRINT_PASSPHRASE = 'synthetic-encrypted-fixture-passphrase';
    const { loadSiteCredentials, commitSiteAuthState, compareAndSwapSiteCookies } = await import(${JSON.stringify(module)});
    const cookie = value => ({ name: 'sid', value, domain: 'fixture.invalid', path: '/' });
    const wait = async name => { while (!existsSync(join(directory, name))) await Bun.sleep(5); };
    if (role === 'warm') {
      await commitSiteAuthState('fixture', [cookie('synthetic-old')], { password: 'synthetic-old-password' });
      const original = await loadSiteCredentials('fixture');
      writeFileSync(join(directory, 'warm-ready'), 'ready');
      await wait('writer-ready');
      const result = await compareAndSwapSiteCookies('fixture', original.revision, [cookie('synthetic-stale-browser')]);
      const fresh = await loadSiteCredentials('fixture');
      const other = await loadSiteCredentials('other-site');
      console.log(JSON.stringify({ status: result.status, current: fresh.cookies[0]?.value, password: fresh.values.password, other: other.cookies[0]?.value }));
    } else {
      await wait('warm-ready');
      await commitSiteAuthState('other-site', [cookie('synthetic-other')], {});
      await commitSiteAuthState('fixture', [cookie('synthetic-new')], { password: 'synthetic-new-password' });
      writeFileSync(join(directory, 'writer-ready'), 'ready');
    }
  `,
  );
  const children = ['warm', 'writer'].map((role) =>
    Bun.spawn([process.execPath, script, directory, role], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH: '' },
    }),
  );
  try {
    const results = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        const errors = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(errors).toBe('');
        return output;
      }),
    );
    expect(JSON.parse(results[0] ?? '')).toEqual({
      status: 'stale',
      current: 'synthetic-new',
      password: 'synthetic-new-password',
      other: 'synthetic-other',
    });
    expect(results[1]).toBe('');
    expect(readdirSync(join(directory, 'secrets.enc.lock'))).toEqual([]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
