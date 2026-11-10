import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthActionTestHarness } from '../src/imprint/runtime.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

function fixture(carry: string[] = []) {
  return WorkflowSchema.parse({
    site: 'fixture-boundaries',
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    intent: { description: 'Synthetic two-stage challenge' },
    parameters: [{ name: 'action', type: 'string', description: 'Action', default: 'begin' }],
    requests: [
      {
        method: 'POST',
        url: 'https://fixture.invalid/begin',
        headers: {},
        captures: [{ name: 'ticket', source: 'json', path: 'ticket' }],
      },
      {
        method: 'POST',
        url: 'https://fixture.invalid/finish',
        headers: {},
        body: '${state.ticket}',
        captures: [{ name: 'done', source: 'json', path: 'done' }],
      },
    ],
    authConfig: {
      entry: 'begin',
      persist: [],
      actions: {
        begin: {
          parameters: [],
          steps: [{ request: 0 }],
          outcome: {
            type: 'pause',
            evidence: ['ticket'],
            carry,
            next: 'finish',
            message: 'Continue',
          },
        },
        finish: {
          parameters: [],
          steps: [{ request: 1 }],
          outcome: { type: 'success', evidence: ['done'] },
        },
      },
    },
  });
}

describe('actual auth action boundaries', () => {
  it('does not supply earlier action responses or undeclared state', async () => {
    let sends = 0;
    const harness = createAuthActionTestHarness({
      workflow: fixture(),
      respond: () => {
        sends += 1;
        return Response.json({ ticket: 'synthetic-ticket' });
      },
    });
    expect(await harness.run('begin')).toMatchObject({
      ok: false,
      error: 'ACTION_REQUIRED',
      continuation: {},
    });
    expect(await harness.run('finish')).toMatchObject({
      ok: false,
      error: 'STATE_MISSING',
      authExecution: { phase: 'preparation', transportInvoked: false, requestIndex: 1 },
    });
    expect(sends).toBe(1);
  });

  it('continues with the explicitly carried ticket and retains session cookies', async () => {
    const harness = createAuthActionTestHarness({
      workflow: fixture(['ticket']),
      respond: (request) => {
        if (request.action === 'begin')
          return Response.json(
            { ticket: 'synthetic-ticket' },
            {
              headers: { 'set-cookie': 'session=fixture-rotated; Path=/; Secure' },
            },
          );
        expect(request.body).toBe('synthetic-ticket');
        expect(request.headers.cookie).toBe('session=fixture-rotated');
        return Response.json({ done: true });
      },
    });
    expect(await harness.run('begin')).toMatchObject({ ok: false, error: 'ACTION_REQUIRED' });
    expect(await harness.run('finish')).toEqual({ ok: true, data: { authenticated: true } });
  });

  it('preserves the local cause and authored attempts without HTTP dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imprint-auth-boundaries-'));
    try {
      writeFileSync(
        join(dir, 'transform.ts'),
        "export function transform() { throw new Error('fixture missing challenge field'); }",
      );
      const workflow = fixture();
      workflow.requestTransformModule = './transform.ts';
      const step = workflow.authConfig?.actions.begin?.steps[0];
      if (!step) throw new Error('Missing synthetic step');
      step.onError = 'retry';
      step.repeat = {
        maxAttempts: 3,
        intervalMs: 0,
        until: {
          name: 'ticket',
          source: 'json',
          path: 'ticket',
          required: true,
          capability: 'ordinary_http',
        },
      };
      let sends = 0;
      const harness = createAuthActionTestHarness({
        workflow,
        workflowPath: join(dir, 'workflow.json'),
        respond: () => {
          sends += 1;
          return Response.json({ ticket: 'unused' });
        },
      });
      const result = await harness.run('begin');
      expect(result).toMatchObject({
        ok: false,
        error: 'BAD_RESPONSE',
        authExecution: {
          attempts: 3,
          phase: 'transform',
          transportInvoked: false,
          lastFailure: {
            error: 'BAD_RESPONSE',
            message: expect.stringContaining('fixture missing challenge field'),
          },
        },
      });
      expect(sends).toBe(0);
      if (!result.ok) expect(result.message).toContain('after 3 attempts. Last failure:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a concrete HTTP failure through a repeated polling flow', async () => {
    const workflow = fixture();
    const step = workflow.authConfig?.actions.begin?.steps[0];
    if (!step) throw new Error('Missing synthetic step');
    step.onError = 'retry';
    step.repeat = {
      maxAttempts: 2,
      intervalMs: 0,
      until: {
        name: 'ticket',
        source: 'json',
        path: 'ticket',
        required: true,
        capability: 'ordinary_http',
      },
    };
    let sends = 0;
    const harness = createAuthActionTestHarness({
      workflow,
      respond: () => {
        sends += 1;
        return Response.json({ message: 'fixture rejected' }, { status: 401 });
      },
    });
    expect(await harness.run('begin')).toMatchObject({
      ok: false,
      error: 'AUTH_EXPIRED',
      status: 401,
      authExecution: { attempts: 2, phase: 'send', transportInvoked: true, httpStatus: 401 },
    });
    expect(sends).toBe(2);
  });
});
