import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const failures = [
  {
    name: 'a synchronous exception',
    source: `export function transform() { throw new Error('fixture transform failed'); }`,
    message: 'fixture transform failed',
  },
  {
    name: 'a rejected asynchronous transform',
    source: `export async function transform() {
      await Promise.resolve();
      throw new Error('fixture async transform failed');
    }`,
    message: 'fixture async transform failed',
  },
  {
    name: 'an asynchronous transform using the wrong arguments',
    source: `export async function transform(request, context) {
      return request.url.endsWith('/fixture') ? request : context;
    }`,
    message: 'request transform failed for request 0',
  },
];

for (const kind of ['data', 'auth'] as const) {
  describe(`${kind} request transform error recovery`, () => {
    for (const failure of failures) {
      it(`returns repairable feedback for ${failure.name} and accepts the next revision`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'imprint-transform-recovery-'));
        try {
          writeFileSync(join(dir, 'request-transform.ts'), failure.source);
          // An isolated process proves a rejected generated hook cannot terminate
          // the teach process, even if the test runner handles rejections itself.
          writeFileSync(
            join(dir, 'run.ts'),
            `import { writeFileSync } from 'node:fs';
import { executeWorkflow } from ${JSON.stringify(resolve(import.meta.dir, '../src/imprint/runtime.ts'))};
const workflow = {
  site: 'fixture-transform',
  toolName: 'fixture_transform',
  intent: { description: 'Synthetic transform recovery' },
  parameters: [{ name: 'value', type: 'string', description: 'Synthetic value' }],
  requestTransformModule: './request-transform.ts',
  requests: [{
    method: 'POST', url: 'https://fixture.invalid/fixture', headers: {},
    body: 'original body',
    captures: [{ name: 'verified', source: 'json', path: 'ok' }],
  }],
  ...${JSON.stringify(
    kind === 'auth'
      ? {
          toolKind: 'authenticate',
          authConfig: {
            entry: 'start',
            actions: {
              start: {
                parameters: ['value'],
                steps: [{ request: 0 }],
                outcome: { type: 'success', evidence: ['verified'] },
              },
            },
            persist: [],
          },
        }
      : {},
  )},
};
const sends = [];
const run = () => executeWorkflow({
  workflow, workflowPath: ${JSON.stringify(join(dir, 'workflow.json'))},
  params: { value: 'fixture & 雪' },
  credentials: { site: workflow.site, cookies: [], values: {} },
  persistAuthState: false,
  fetchImpl: async (url, init) => {
    sends.push({ url, body: init?.body, headers: init?.headers });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
const failed = await run();
await new Promise(resolve => setTimeout(resolve, 0));
const sendsBeforeRepair = sends.length;
writeFileSync(${JSON.stringify(join(dir, 'request-transform.ts'))}, ${JSON.stringify(`export async function transform(method, url, responses, params) {
  await Promise.resolve();
  return {
    url,
    body: JSON.stringify({ method, value: params.value }),
    headers: { 'x-fixture-transform': 'awaited' },
  };
}`)});
const repaired = await run();
console.log(JSON.stringify({ failed, sendsBeforeRepair, repaired, sends }));
`,
          );
          const child = Bun.spawn([process.execPath, join(dir, 'run.ts')], {
            cwd: dir,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
          const result = JSON.parse(stdout);
          expect(result.failed).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
          expect(result.failed.message).toContain(failure.message);
          expect(result.sendsBeforeRepair).toBe(0);
          expect(result.repaired.ok).toBe(true);
          expect(result.sends).toEqual([
            {
              url: 'https://fixture.invalid/fixture',
              body: JSON.stringify({ method: 'POST', value: 'fixture & 雪' }),
              headers: { 'x-fixture-transform': 'awaited' },
            },
          ]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
