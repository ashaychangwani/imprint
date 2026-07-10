import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { compileAuthAgent } from '../src/imprint/auth-compile-agent.ts';
import {
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authExternalVerification,
  authGiveUpPreflightFailures,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
} from '../src/imprint/auth-compile-tools.ts';
import { __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { AuthToolPlan } from '../src/imprint/build-plan.ts';
import type { Session, ToolResult } from '../src/imprint/types.ts';

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_IMPRINT_HOME = process.env.IMPRINT_HOME;
const ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK = process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_IMPRINT_HOME === undefined) {
    process.env.IMPRINT_HOME = undefined;
  } else {
    process.env.IMPRINT_HOME = ORIGINAL_IMPRINT_HOME;
  }
  process.env.FAKE_CODEX_ARGS_LOG = undefined;
  if (ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK === undefined) {
    process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = undefined;
  } else {
    process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = ORIGINAL_AUTH_ALLOW_PLAYBOOK_FALLBACK;
  }
  __setAuthVerifierLadderForTest(null);
});

function fixtureSession(): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-07-09T00:00:00.000Z',
    url: 'https://example.test/login',
    imprintVersion: '0.0.0-test',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function fixtureAuthPlan(): NonNullable<AuthToolPlan> {
  return {
    toolName: 'authenticate_fixture',
    loginRequestSeqs: [1],
    twoFactorRequestSeqs: [2],
    twoFactorType: 'push',
    twoFactorContext: [],
    credentialNames: ['username', 'password'],
    captures: [],
    notes: 'fixture auth flow',
  };
}

function installSegmentingFakeCodex(binDir: string): void {
  const codexPath = pathJoin(binDir, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

if (process.env.FAKE_CODEX_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_LOG, process.argv.slice(2).join('\\u0000') + '\\n', { flag: 'a' });
}

let toolDir = process.env.FAKE_CODEX_TOOL_DIR;
for (const arg of process.argv.slice(2)) {
  const prefix = 'mcp_servers.imprint-compile.args=';
  if (!arg.startsWith(prefix)) continue;
  const mcpArgs = JSON.parse(arg.slice(prefix.length));
  const idx = mcpArgs.indexOf('--tool-dir');
  if (idx >= 0) toolDir = mcpArgs[idx + 1];
}
if (!toolDir) throw new Error('fake codex could not find --tool-dir');

if (process.argv.includes('resume')) {
  writeFileSync(
    pathJoin(toolDir, '.compile-done.json'),
    JSON.stringify({ verification: 'passed', summary: 'auth compiled after resume' }),
    'utf8',
  );
} else {
  writeFileSync(
    pathJoin(toolDir, '.compile-checkpoint.json'),
    JSON.stringify({ kind: 'run_verification', phase: 'initiate', timestamp: 1 }),
    'utf8',
  );
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }));
`,
    'utf8',
  );
  chmodSync(codexPath, 0o755);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ''}`;
}

describe('compileAuthAgent with codex-cli', () => {
  it('blocks auth compile agents from writing a login playbook by default', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const tools = buildAuthCompileTools(fixtureSession(), root, '/tmp/session.json', {
        site: 'fixture-site',
        values: { username: 'fixture-user', password: 'fixture-pass' },
      });
      const writeFile = tools.find((tool) => tool.name === 'write_file');
      if (!writeFile) throw new Error('write_file tool missing');

      const result = await writeFile.handler({
        relativePath: 'playbook.yaml',
        content: 'toolName: authenticate_fixture\nsteps: []\n',
      });

      expect(result.isError).toBe(true);
      expect(existsSync(pathJoin(root, 'playbook.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets auth compile agents write a login playbook only when explicitly enabled', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK = '1';
      const tools = buildAuthCompileTools(fixtureSession(), root, '/tmp/session.json', {
        site: 'fixture-site',
        values: { username: 'fixture-user', password: 'fixture-pass' },
      });
      const writeFile = tools.find((tool) => tool.name === 'write_file');
      if (!writeFile) throw new Error('write_file tool missing');

      const result = await writeFile.handler({
        relativePath: 'playbook.yaml',
        content: 'toolName: authenticate_fixture\nsteps: []\n',
      });

      expect(result.isError).toBeUndefined();
      expect(existsSync(pathJoin(root, 'playbook.yaml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks auth shell exploration until the first workflow is written', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const tools = buildAuthCompileTools(fixtureSession(), root, '/tmp/session.json', {
        site: 'fixture-site',
        values: {},
      });
      const runBash = tools.find((tool) => tool.name === 'run_bash');
      if (!runBash) throw new Error('run_bash tool missing');

      const blocked = await runBash.handler({ command: 'pwd' });
      expect(blocked.isError).toBe(true);
      expect(blocked.result).toContain('unavailable before the first workflow.json');

      writeFileSync(pathJoin(root, 'workflow.json'), '{}');
      const allowed = await runBash.handler({ command: 'pwd' });
      expect(allowed.isError).toBe(false);
      expect(allowed.result).toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects recorded-only auth workflow values before writing workflow.json', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const tools = buildAuthCompileTools(fixtureSession(), root, '/tmp/session.json', {
        site: 'fixture-site',
        values: { username: 'fixture-user', password: 'fixture-pass' },
      });
      const writeFile = tools.find((tool) => tool.name === 'write_file');
      if (!writeFile) throw new Error('write_file tool missing');

      const result = await writeFile.handler({
        relativePath: 'workflow.json',
        content: JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            {
              method: 'POST',
              url: 'https://example.test/login',
              headers: {
                'one-data-correlation-id': 'dba66605-9e2a-4a8b-8f7e-849c2892fd16',
              },
              body: 'UserID=${credential.username}&Password=${credential.password}&b_hour=23&b_minute=12',
            },
          ],
          authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
        }),
      });

      expect(result.isError).toBe(true);
      expect(String(result.result)).toContain('correlation');
      expect(String(result.result)).toContain('b_hour');
      expect(existsSync(pathJoin(root, 'workflow.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preflights recorded OAuth nonce/challenge values before live verification', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            {
              method: 'POST',
              url: 'https://example.test/oauth',
              headers: {},
              body: JSON.stringify({
                clientId: '7572a115-6cbc-4758-86e8-71fadbbbb553',
                nonce: '5fa7a37d-fa03-4acb-ab92-14f2a455977f',
                codeChallenge: 'XL_4wmKv9SmOngCaw93M-tpvDqtwllpCYAVlWpUX6ZY',
              }),
            },
          ],
          authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
        }),
      );

      const failures = authWorkflowPreflightFailures(root);

      expect(failures.join('\n')).toContain('nonce');
      expect(failures.join('\n')).toContain('codeChallenge');
      expect(failures.join('\n')).not.toContain('clientId');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a 2FA workflow whose initiate split cannot deliver a challenge', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            { method: 'POST', url: 'https://example.test/login', headers: {} },
            { method: 'POST', url: 'https://example.test/complete', headers: {} },
          ],
          authConfig: {
            twoFactorType: 'push',
            pollEndpoint: 'https://example.test/poll',
          },
        }),
      );

      expect(authWorkflowPreflightFailures(root).join('\n')).toContain(
        'initiateRequestCount must include the login and 2FA-delivery requests',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects authConfig.type instead of silently defaulting twoFactorType to none', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [{ method: 'POST', url: 'https://example.test/login', headers: {} }],
          authConfig: { type: 'push', initiateRequestCount: 1 },
        }),
      );

      const failures = authWorkflowPreflightFailures(root).join('\n');
      expect(failures).toContain("Unrecognized key(s) in object: 'type'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires successful completion verification before a push workflow can call done', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            { method: 'POST', url: 'https://example.test/login', headers: {} },
            {
              method: 'POST',
              url: 'https://example.test/push',
              headers: {},
              captures: [{ source: 'json', name: 'trackingId', path: '$.trackingId' }],
            },
            { method: 'POST', url: 'https://example.test/finish', headers: {} },
          ],
          authConfig: {
            twoFactorType: 'push',
            initiateRequestCount: 2,
            twoFactorContext: ['trackingId'],
            pollEndpoint: 'https://example.test/poll',
          },
        }),
      );
      writeFileSync(
        pathJoin(root, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ phase: 'initiate', ok: true }),
      );

      expect(authExternalVerification(root, [], { requireLiveAttempt: true }).join('\n')).toContain(
        'must successfully verify phase "complete" before done',
      );

      writeFileSync(
        pathJoin(root, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ phase: 'complete', ok: true }),
      );
      expect(authExternalVerification(root, [], { requireLiveAttempt: true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects direct PKCE challenge replay even when the challenge is generated', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            {
              method: 'POST',
              url: 'https://issuer.example.test/oauth/token',
              headers: {},
              body: '{"codeChallenge":"${generated.uuid}"}',
            },
          ],
          authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
        }),
      );

      expect(authWorkflowPreflightFailures(root).join('\n')).toContain(
        'carries an OAuth PKCE code challenge directly',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires recording-grounded completion evidence for browser navigation', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const workflow = {
        toolName: 'authenticate_fixture',
        toolKind: 'authenticate',
        intent: { description: 'auth' },
        site: 'fixture-site',
        parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
        requests: [
          {
            method: 'GET',
            url: 'https://relying-party.example.test/start',
            headers: {},
            mode: 'navigate',
            navigation: undefined as { cookie: { name: string; domain: string } } | undefined,
          },
        ],
        authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
      } as unknown as import('../src/imprint/types.ts').Workflow;
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));
      expect(authWorkflowPreflightFailures(root).join('\n')).toContain(
        'without navigation.urlIncludes or navigation.cookie evidence',
      );

      const navigationRequest = workflow.requests[0];
      if (!navigationRequest) throw new Error('missing navigation request fixture');
      navigationRequest.navigation = {
        cookie: { name: 'session-token', domain: 'relying-party.example.test' },
      };
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));
      expect(authWorkflowPreflightFailures(root)).toEqual([]);

      navigationRequest.navigation = {
        urlIncludes: '/start',
      } as unknown as typeof navigationRequest.navigation;
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));
      expect(authWorkflowPreflightFailures(root).join('\n')).toContain(
        'navigation.urlIncludes already matches the starting URL and cannot prove that navigation completed',
      );

      navigationRequest.navigation = {
        urlIncludes: '/oauth/callback',
      } as unknown as typeof navigationRequest.navigation;
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));
      expect(authWorkflowPreflightFailures(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects fixed indexes when the recorded auth array has a stable discriminator', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const session = fixtureSession();
      session.requests.push({
        seq: 1,
        timestamp: 1,
        method: 'POST',
        url: 'https://example.test/challenges',
        headers: {},
        resourceType: 'Fetch',
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({
            methods: [
              { category: 'PUSH', token: 'SYNTH-PUSH' },
              { category: 'SMS', token: 'SYNTH-SMS' },
            ],
          }),
        },
      });
      const workflow = {
        toolName: 'authenticate_fixture',
        toolKind: 'authenticate',
        intent: { description: 'auth' },
        site: 'fixture-site',
        parameters: [{ name: 'action', type: 'string', description: 'phase', default: 'initiate' }],
        requestTransformModule: './request-transform.ts',
        requests: [
          {
            method: 'POST',
            url: 'https://example.test/challenges',
            headers: {},
            captures: [{ source: 'json', name: 'token', path: '$.methods[0].token' }],
          },
        ],
        authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
      };
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));

      expect(authWorkflowPreflightFailures(root, session).join('\n')).toContain(
        'stable field predicate [category=PUSH]',
      );

      const capture = workflow.requests[0]?.captures[0];
      if (!capture) throw new Error('missing capture fixture');
      capture.path = '$.methods[category=PUSH].token';
      writeFileSync(pathJoin(root, 'workflow.json'), JSON.stringify(workflow));
      expect(authWorkflowPreflightFailures(root, session)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires final-initiate delivery evidence before live 2FA verification', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            { method: 'POST', url: 'https://example.test/send-push', headers: {} },
            { method: 'POST', url: 'https://example.test/finish', headers: {} },
          ],
          authConfig: {
            twoFactorType: 'push',
            initiateRequestCount: 1,
            twoFactorContext: ['messageTrackingId'],
            pollEndpoint: 'https://example.test/poll',
          },
        }),
      );

      expect(authWorkflowPreflightFailures(root).join('\n')).toContain(
        'final initiate request must capture at least one authConfig.twoFactorContext value',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows preserved recorded auth crypto blobs to reach live verification', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const replayBody = new URLSearchParams({
        username: '${credential.username}',
        password: '${credential.password}',
        encryptedData:
          '1ZYXdpUq%2ByjZlXOcGH5iJ1F69wmLaxss0IkNEJDK0Vb1qR6dDseg%2F4ZAkcl5gM0ciQTzXP7GHMpnk6hpUN%2FCc5Wj4gY7kmkVKHjZLFO7TR1k92aW7POHuXtzhcrhS5MhsDdbMarsNWgCquy4bpyVBneYcCYIJWill90D09qz7fpnXXQ1RPyL1pANp1l3qyyEvlo0YVLYtP%2FB9ml7OdkCJk0WesGcwMP651ftxMRTU67fGcI%3D',
        signature:
          'dnlvEVkQKN9tnfM%2BHWduZ0owdtXWXOk0%2BIx%2FBJr9YJtFJR7MQbeZOgbbLlLWTlxSk3Lw0859r7yEcUSj38BimQ%3D%3D',
        publicKey:
          'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErniMDrmHDnBvx4sTpxn9WTWJYfLQJ3MmLMRG2YYddUeT9AuLtod50gvfEVufvvXoPVOKU0bInao54mZEvF3LVA%3D%3D',
      }).toString();
      const session = fixtureSession();
      session.requests.push({
        seq: 1,
        timestamp: 100,
        method: 'POST',
        url: 'https://example.test/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        resourceType: 'xhr',
        body: replayBody,
      });
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            {
              method: 'POST',
              url: 'https://example.test/login',
              headers: {},
              body: replayBody,
            },
          ],
          authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
        }),
      );

      expect(authWorkflowPreflightFailures(root, session)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks giving up on recorded auth crypto until live verification runs', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const session = fixtureSession();
      session.requests.push({
        seq: 41,
        timestamp: 100,
        method: 'POST',
        url: 'https://example.test/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        resourceType: 'xhr',
        body: new URLSearchParams({
          username: 'recorded-user',
          encryptedData: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcd',
          signature: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5',
          publicKey: 'TUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FF',
        }).toString(),
      });

      expect(authGiveUpPreflightFailures(root, session, [41]).join('\n')).toContain(
        'no live verification has run',
      );

      writeFileSync(
        pathJoin(root, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ phase: 'initiate', ok: false, error: 'FORBIDDEN' }),
      );
      expect(authGiveUpPreflightFailures(root, session, [41])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not require live verification before give-up when login has no recorded auth crypto', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const session = fixtureSession();
      session.requests.push({
        seq: 42,
        timestamp: 100,
        method: 'POST',
        url: 'https://example.test/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        resourceType: 'xhr',
        body: 'username=fixture-user&password=fixture-password',
      });

      expect(authGiveUpPreflightFailures(root, session, [42])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preflights raw-password replacement for a recorded encrypted login form', () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const session = fixtureSession();
      session.requests.push({
        seq: 1,
        timestamp: 100,
        method: 'POST',
        url: 'https://example.test/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        resourceType: 'xhr',
        body: new URLSearchParams({
          UserID: 'recorded-user',
          Password: 'recorded-pass',
          encryptedData:
            '1ZYXdpUq+yjZlXOcGH5iJ1F69wmLaxss0IkNEJDK0Vb1qR6dDseg/4ZAkcl5gM0ciQTzXP7GHMpnk6hpUN/Cc5Wj4gY7kmkVKHjZLFO7TR1k92aW7POHuXtzhcrhS5MhsDdbMarsNWgCquy4bpyVBneYcCYIJWill90D09qz7fpnXXQ1RPyL1pANp1l3qyyEvlo0YVLYtP/B9ml7OdkCJk0WesGcwMP651ftxMRTU67fGcI=',
          signature:
            'dnlvEVkQKN9tnfM+HWduZ0owdtXWXOk0+Ix/BJr9YJtFJR7MQbeZOgbbLlLWTlxSk3Lw0859r7yEcUSj38BimQ==',
        }).toString(),
      });
      writeFileSync(
        pathJoin(root, 'workflow.json'),
        JSON.stringify({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          intent: { description: 'auth' },
          site: 'fixture-site',
          parameters: [
            { name: 'action', type: 'string', description: 'phase', default: 'initiate' },
          ],
          requests: [
            {
              method: 'POST',
              url: 'https://example.test/login',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'UserID=${credential.username}&Password=${credential.password}',
            },
          ],
          authConfig: { twoFactorType: 'none', initiateRequestCount: 1 },
        }),
      );

      const failures = authWorkflowPreflightFailures(root, session);

      expect(failures.join('\n')).toContain('browser-computed auth crypto fields');
      expect(failures.join('\n')).toContain('${credential.password}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drives checkpointed auth compilation through codex exec resume', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-agent-codex-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const imprintHome = pathJoin(root, 'imprint-home');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(imprintHome, { recursive: true });
      process.env.IMPRINT_HOME = imprintHome;
      installSegmentingFakeCodex(binDir);

      const argsLog = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_ARGS_LOG = argsLog;
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

      const okLogin: ToolResult = { ok: true, data: {} };
      __setAuthVerifierLadderForTest(async () => ({
        result: okLogin,
        usedBackend: 'cdp-replay',
        attempts: [],
      }));

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: fixtureSession(),
        sessionPath,
        authToolPlan: fixtureAuthPlan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli' },
        maxDurationMs: 30_000,
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('done');
      expect(result.turns).toBe(2);
      expect(result.message).toBe('auth compiled after resume');

      const commandLines = readFileSync(argsLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\u0000'));
      expect(commandLines).toHaveLength(2);
      expect(commandLines[0]).toContain('exec');
      expect(commandLines[0]).not.toContain('--ephemeral');
      expect(
        commandLines[1]?.slice(
          commandLines[1].indexOf('exec'),
          commandLines[1].indexOf('exec') + 2,
        ),
      ).toEqual(['exec', 'resume']);
      expect(commandLines[1]).toContain('fake-thread');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
