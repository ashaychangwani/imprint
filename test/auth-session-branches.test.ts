import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authWorkflowHash,
  authWorkflowPreflightFailures,
  readAuthVerificationReceiptStatus,
} from '../src/imprint/auth-compile-tools.ts';
import { createAuthActionTestHarness, executeWorkflow } from '../src/imprint/runtime.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

function fixture() {
  return WorkflowSchema.parse({
    site: 'fixture-session-branches',
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    intent: { description: 'Reuse access before login or factor delivery' },
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action',
        default: 'resume',
        choices: ['resume', 'login', 'deliver', 'finish'],
      },
    ],
    requests: [
      {
        method: 'GET',
        url: 'https://fixture.invalid/session',
        headers: {},
        captures: [
          {
            source: 'json',
            name: 'needs_login',
            path: 'authenticated',
            equals: false,
            required: false,
          },
        ],
      },
      {
        method: 'POST',
        url: 'https://fixture.invalid/login',
        headers: {},
        body: 'user=${credential.username}',
        bodyPlaceholderEncoding: 'form-urlencoded',
        captures: [{ source: 'json', name: 'challenge', path: 'challenge', required: false }],
      },
      {
        method: 'POST',
        url: 'https://fixture.invalid/deliver',
        headers: {},
        body: '${state.challenge}',
        bodyPlaceholderEncoding: 'raw',
        captures: [{ source: 'json', name: 'delivered', path: 'delivered', equals: true }],
      },
      {
        method: 'POST',
        url: 'https://fixture.invalid/finish',
        headers: {},
        captures: [{ source: 'json', name: 'finished', path: 'authenticated', equals: true }],
      },
    ],
    authConfig: {
      entry: 'resume',
      persist: [],
      actions: {
        resume: {
          steps: [{ request: 0 }],
          branches: [
            {
              when: { source: 'json', name: 'session_ready', path: 'authenticated', equals: true },
              outcome: { type: 'success', evidence: ['session_ready'] },
            },
          ],
          outcome: {
            type: 'pause',
            next: 'login',
            evidence: ['needs_login'],
            message: 'Current response requires login.',
          },
        },
        login: {
          steps: [{ request: 1 }],
          branches: [
            {
              when: { source: 'json', name: 'trusted_ready', path: 'authenticated', equals: true },
              outcome: { type: 'success', evidence: ['trusted_ready'] },
            },
          ],
          outcome: {
            type: 'pause',
            next: 'deliver',
            evidence: ['challenge'],
            carry: ['challenge'],
            message: 'Current challenge is available for delivery.',
          },
        },
        deliver: {
          steps: [{ request: 2 }],
          outcome: {
            type: 'pause',
            next: 'finish',
            evidence: ['delivered'],
            message: 'Approve the current delivered factor.',
          },
        },
        finish: {
          steps: [{ request: 3 }],
          outcome: { type: 'success', evidence: ['finished'] },
        },
      },
    },
  });
}

describe('response-based authentication branches', () => {
  it('reuses authenticated access and skips delivery for a trusted login response', async () => {
    let authenticated = false;
    const calls: string[] = [];
    const harness = createAuthActionTestHarness({
      workflow: fixture(),
      credentials: {
        site: 'fixture-session-branches',
        cookies: [],
        values: { username: 'fixture-user' },
      },
      respond: (request) => {
        calls.push(request.action);
        if (request.action === 'resume') return Response.json({ authenticated });
        if (request.action === 'login') {
          expect(request.body).toBe('user=fixture-user');
          return Response.json(
            authenticated ? { authenticated: true } : { challenge: 'fixture-current-ticket' },
          );
        }
        if (request.action === 'deliver') {
          expect(request.body).toBe('fixture-current-ticket');
          return Response.json({ delivered: true });
        }
        authenticated = true;
        return Response.json({ authenticated });
      },
    });
    expect(await harness.run('resume')).toMatchObject({ ok: false, nextAction: 'login' });
    expect(await harness.run('login')).toMatchObject({ ok: false, nextAction: 'deliver' });
    expect(await harness.run('deliver')).toMatchObject({ ok: false, nextAction: 'finish' });
    expect(await harness.run('finish')).toEqual({ ok: true, data: { authenticated: true } });
    expect(await harness.run('resume')).toEqual({ ok: true, data: { authenticated: true } });
    expect(await harness.run('resume')).toEqual({ ok: true, data: { authenticated: true } });
    expect(await harness.run('login')).toEqual({ ok: true, data: { authenticated: true } });
    expect(calls).toEqual(['resume', 'login', 'deliver', 'finish', 'resume', 'resume', 'login']);
  });

  it('does not fall back to login using stale carried evidence after an unknown response', async () => {
    const result = await executeWorkflow({
      workflow: fixture(),
      params: { action: 'resume' },
      persistAuthState: false,
      credentials: { site: 'fixture-session-branches', cookies: [], values: {} },
      initialState: { needs_login: false, session_ready: true },
      fetchImpl: (async () => Response.json({ unknown: true })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    if (!result.ok) {
      expect(result.message).toContain('needs_login');
      expect(result.nextAction).toBeUndefined();
    }
  });

  it('returns repair feedback for a malformed condition instead of accepting its fallback', async () => {
    const workflow = fixture();
    const resume = workflow.authConfig?.actions.resume;
    if (!resume) throw new Error('Missing fixture action');
    resume.branches = [
      {
        when: {
          source: 'text_regex',
          name: 'broken',
          pattern: '[',
          group: 1,
          required: true,
          capability: 'ordinary_http',
        },
        outcome: { type: 'success', evidence: ['broken'] },
      },
    ];
    resume.outcome = { type: 'success', evidence: [] };
    const harness = createAuthActionTestHarness({
      workflow,
      respond: () => Response.json({ authenticated: true }),
    });
    expect(await harness.run('resume')).toMatchObject({
      ok: false,
      error: 'BAD_RESPONSE',
      message: expect.stringContaining('could not evaluate branch "broken"'),
      authExecution: { phase: 'outcome' },
    });
  });

  it('persists a selected branch capture under its downstream credential interface', async () => {
    const workflow = fixture();
    const config = workflow.authConfig;
    const resume = config?.actions.resume;
    if (!config || !resume) throw new Error('Missing fixture action');
    config.persist = ['session_token'];
    config.persistBindings = { session_token: 'branch_token' };
    resume.branches = [
      {
        when: {
          source: 'json',
          name: 'branch_token',
          path: 'session.token',
          required: true,
          capability: 'ordinary_http',
        },
        outcome: { type: 'success', evidence: ['branch_token'] },
      },
    ];
    let persisted: Record<string, string> | undefined;
    expect(
      await executeWorkflow({
        workflow,
        params: { action: 'resume' },
        persistAuthState: false,
        credentials: { site: workflow.site, cookies: [], values: {} },
        fetchImpl: (async () =>
          Response.json({
            session: { token: 'fixture-session-token' },
          })) as unknown as typeof fetch,
        onAuthState: (credentials) => {
          persisted = credentials.values;
        },
      }),
    ).toEqual({ ok: true, data: { authenticated: true } });
    expect(persisted).toEqual({ session_token: 'fixture-session-token' });
  });

  it('matches false and null exactly and takes only the first matching branch', async () => {
    const workflow = fixture();
    const resume = workflow.authConfig?.actions.resume;
    if (!resume) throw new Error('Missing fixture action');
    resume.branches = [false, null].flatMap((value, index) =>
      [0, 1].map((duplicate) => ({
        when: {
          source: 'json' as const,
          name: `matched_${index}_${duplicate}`,
          path: 'state',
          equals: value,
          required: true,
          capability: 'ordinary_http' as const,
        },
        outcome: {
          type: 'pause' as const,
          next: 'login',
          evidence: [`matched_${index}_${duplicate}`],
          carry: [`matched_${index}_${duplicate}`],
          message: `selected_${index}_${duplicate}`,
        },
      })),
    );
    for (const [index, state] of [false, null].entries()) {
      const harness = createAuthActionTestHarness({
        workflow,
        respond: () => Response.json({ state }),
      });
      expect(await harness.run('resume')).toMatchObject({
        ok: false,
        error: 'ACTION_REQUIRED',
        message: `selected_${index}_0`,
        continuation: { [`matched_${index}_0`]: state },
      });
    }
  });

  for (const finalStep of ['failed', 'skipped'] as const) {
    it(`does not select success from an earlier response when the final step is ${finalStep}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'imprint-auth-branch-final-'));
      try {
        const workflow = fixture();
        const resume = workflow.authConfig?.actions.resume;
        if (!resume) throw new Error('Missing fixture action');
        workflow.requests.push({
          method: 'GET',
          url: 'https://fixture.invalid/final',
          headers: {},
        });
        resume.steps.push({ request: 4, onError: 'continue' });
        if (finalStep === 'skipped') {
          workflow.requestTransformModule = './transform.ts';
          writeFileSync(
            join(dir, 'transform.ts'),
            "export function transform(_method, url) { return url.endsWith('/final') ? { skip: true } : { url }; }",
          );
        }
        const calls: string[] = [];
        const harness = createAuthActionTestHarness({
          workflow,
          workflowPath: join(dir, 'workflow.json'),
          respond: (request) => {
            calls.push(request.url);
            return request.url.endsWith('/final')
              ? new Response('{}', { status: 401 })
              : Response.json({ authenticated: true });
          },
        });
        expect(await harness.run('resume')).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
        expect(calls).toHaveLength(finalStep === 'failed' ? 2 : 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('validates conditional transitions, branch-only success reachability and live receipts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imprint-auth-branch-preflight-'));
    try {
      const workflow = fixture();
      const config = workflow.authConfig;
      if (!config) throw new Error('Missing fixture config');
      config.actions.finish = {
        parameters: [],
        steps: [{ request: 3, onError: 'fail' }],
        outcome: {
          type: 'pause',
          next: 'resume',
          evidence: [],
          carry: [],
          message: 'Check access again.',
        },
      };
      const save = () => writeFileSync(join(dir, 'workflow.json'), JSON.stringify(workflow));
      save();
      expect(authWorkflowPreflightFailures(dir)).toEqual([]);
      writeFileSync(
        join(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({
          action: 'resume',
          ok: true,
          workflowHash: authWorkflowHash(workflow),
        }),
      );
      expect(readAuthVerificationReceiptStatus(dir, workflow).status).toBe('verified');
      const branch = config.actions.resume?.branches?.[0];
      if (!branch) throw new Error('Missing fixture branch');
      branch.outcome = {
        type: 'pause',
        next: 'missing_action',
        evidence: ['unknown_evidence'],
        carry: ['unknown_carry'],
        message: 'Invalid branch',
      };
      save();
      const failures = authWorkflowPreflightFailures(dir).join('\n');
      expect(failures).toContain('unknown action "missing_action"');
      expect(failures).toContain('unknown evidence capture "unknown_evidence"');
      expect(failures).toContain('unknown capture "unknown_carry"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the compiler prompt branch example compatible with the workflow schema', () => {
    const prompt = readFileSync(join(import.meta.dir, '../prompts/auth-compile-agent.md'), 'utf8');
    const example = prompt
      .split('<!-- canonical-example:auth-session-branches -->')[1]
      ?.match(/```json\s*([\s\S]*?)```/)?.[1];
    if (!example) throw new Error('Missing auth branch example');
    const config = JSON.parse(example);
    const parsed = WorkflowSchema.parse({
      site: 'fixture-prompt',
      toolName: 'authenticate_fixture',
      toolKind: 'authenticate',
      intent: { description: 'Synthetic prompt contract' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://fixture.invalid', headers: {} }],
      authConfig: config,
    });
    expect(parsed.authConfig?.actions.agent_chosen_entry?.branches).toHaveLength(1);
  });
});
