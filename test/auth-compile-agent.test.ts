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
import type { AuthBrowserAction } from '../src/imprint/auth-browser-discovery.ts';
import { AuthCompileContext, compileAuthAgent } from '../src/imprint/auth-compile-agent.ts';
import {
  AUTH_COMPILE_TOOL_NAMES,
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authExternalVerification,
  authLivePreflightFailures,
  authWorkflowHash,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
  readAuthVerificationReceiptStatus,
} from '../src/imprint/auth-compile-tools.ts';
import { __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import { renderWorkflowRequests } from '../src/imprint/backend-ladder.ts';
import type { AuthToolPlan } from '../src/imprint/build-plan.ts';
import { type CredentialBackend, setBackendOverride } from '../src/imprint/credential-store.ts';
import type { ToolUseProvider } from '../src/imprint/llm.ts';
import { NativeTeachAgents } from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import {
  ProviderDeadlineError,
  ProviderReportedError,
  ProviderUnavailableError,
} from '../src/imprint/provider-retry.ts';
import { recordedRequestMatchesWorkflow } from '../src/imprint/recording-request.ts';
import { type Session, type Workflow, WorkflowSchema } from '../src/imprint/types.ts';
import { UserInteraction } from '../src/imprint/user-interaction.ts';

const originalPath = process.env.PATH;
const originalHome = process.env.IMPRINT_HOME;
const originalTeachCredentials = process.env.IMPRINT_TEACH_CREDENTIALS;
type VerifierRunner = NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>;
type VerifierRunnerArgs = Parameters<VerifierRunner>[0];

describe('interactive API auth compiler', () => {
  it('returns an explicit nonsecret choice so the agent can distinguish Unable from Ready', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-api-auth-choice-'));
    const toolDir = pathJoin(root, 'authentication');
    const responses: string[] = [];
    const otherAnswer = 'fixture-sensitive-other-answer';
    let promptCount = 0;
    const script = [
      {
        name: 'prompt_user',
        input: { message: 'Is the fixture device ready?', options: ['Ready', 'Unable'] },
      },
      {
        name: 'prompt_user',
        input: { message: 'Is the fixture device ready?', options: ['Ready', 'Unable'] },
      },
      { name: 'give_up', input: { reason: 'Human selected Unable; no fixture login was fired.' } },
    ];
    const provider: ToolUseProvider = {
      name: 'anthropic-api',
      analyze: async () => {
        throw new Error('Unexpected ordinary analyze call');
      },
      messageWithTools: async (input) => {
        responses.push(JSON.stringify(input.messages));
        const next = script.shift();
        if (!next) throw new Error('Unexpected extra choice turn');
        return {
          id: `fixture-choice-${script.length}`,
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [{ type: 'tool_use', id: `choice-${script.length}`, ...next }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as Awaited<ReturnType<ToolUseProvider['messageWithTools']>>;
      },
    };
    try {
      process.env.IMPRINT_HOME = root;
      mkdirSync(toolDir);
      writeWorkflow(toolDir);
      const { sessionPath } = writeSessionPair(root);
      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        outDir: toolDir,
        authToolPlan: plan(),
        teachCredentials: { site: 'fixture-site', values: {} },
        llmProvider: provider,
        onPrompt: async (message, options) => {
          expect(message).toBe('Is the fixture device ready?');
          expect(options).toEqual(['Ready', 'Unable']);
          return promptCount++ === 0 ? 'Unable' : otherAnswer;
        },
      });
      expect(result.success).toBe(false);
      expect(responses).toHaveLength(3);
      const messages = JSON.parse(responses[1] ?? '[]') as Array<{
        content: Array<{ type: string; content?: string }>;
      }>;
      const answer = messages.at(-1)?.content.find(({ type }) => type === 'tool_result')?.content;
      expect(JSON.parse(answer ?? '{}')).toEqual({
        status: 'answered',
        kind: 'choice',
        value: 'Unable',
      });
      expect(answer).not.toContain('${prompt.');
      expect(responses.join('\n')).not.toContain(otherAnswer);
      expect(responses[2]).toContain('${prompt.');
    } finally {
      if (originalHome === undefined) process.env.IMPRINT_HOME = undefined;
      else process.env.IMPRINT_HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prompts for an OTP and continues the same browser and challenge without exposing the answer', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-api-auth-otp-'));
    const toolDir = pathJoin(root, 'authentication');
    const answer = 'fixture-live-otp-694215';
    const interaction = new UserInteraction(async () => ({ status: 'answered', value: answer }));
    let closed = 0;
    let calls = 0;
    const browser = {
      interactBrowser: async (action: AuthBrowserAction) => {
        expect(action).toEqual({ action: 'fill', selector: '#otp', value: answer });
        return {
          sourceId: 'fixture-api-discovery',
          page: {
            url: 'https://fixture.test/otp',
            title: 'Current OTP',
            bodyText: answer,
            controls: [],
            controlsTruncated: false,
          },
          requests: [
            {
              seq: 0,
              timestamp: 0,
              method: 'POST',
              url: 'https://fixture.test/new-otp',
              headers: {},
              body: `code=${answer}`,
              resourceType: 'Fetch',
              response: { status: 200, headers: {}, body: '{"next":"finish"}' },
            },
          ],
          captureErrors: [],
        };
      },
      close: async () => {
        closed += 1;
      },
    };
    const messages: string[] = [];
    try {
      process.env.IMPRINT_HOME = root;
      mkdirSync(toolDir);
      writeWorkflow(toolDir);
      const { sessionPath } = writeSessionPair(root);
      __setAuthVerifierLadderForTest((async (input: VerifierRunnerArgs) => {
        calls += 1;
        if (input.params?.action === 'begin') {
          input.cdpPool?.set('fixture-browser', browser as never);
          return {
            result: {
              ok: false,
              error: 'ACTION_REQUIRED',
              message: 'Enter the OTP.',
              nextAction: 'finish',
              continuation: { ticket: 'fixture-current-challenge' },
            },
            usedBackend: 'cdp-replay',
            attempts: [],
          };
        }
        expect(input.cdpPool?.get('fixture-browser') === (browser as unknown)).toBe(true);
        expect(input.initialState).toEqual({ ticket: 'fixture-current-challenge' });
        expect(input.params?.answer).toBe(answer);
        return {
          result: { ok: true, data: { authenticated: true } },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }) as VerifierRunner);
      const script = [
        { name: 'run_verification', input: { action: 'begin' } },
        { name: 'prompt_user', input: { message: 'Enter the fixture OTP.' } },
        {
          name: 'interact_verification_browser',
          input: { action: 'fill', selector: '#otp', value: '${prompt.1}' },
        },
        { name: 'read_request', input: { seq: 3 } },
        {
          name: 'run_verification',
          input: { action: 'finish', parameters: { answer: '${prompt.1}' } },
        },
        { name: 'done', input: { summary: 'Fixture login verified.' } },
      ];
      const provider: ToolUseProvider = {
        name: 'anthropic-api',
        analyze: async () => {
          throw new Error('Unexpected ordinary analyze call');
        },
        messageWithTools: async (input) => {
          messages.push(JSON.stringify(input.messages));
          expect(input.tools.map(({ name }) => name)).toContain('prompt_user');
          const next = script.shift();
          if (!next) throw new Error('Unexpected extra auth turn');
          return {
            id: `fixture-${script.length}`,
            type: 'message',
            role: 'assistant',
            model: 'fixture',
            content: [
              {
                type: 'tool_use',
                id: `tool-${script.length}`,
                ...JSON.parse(
                  JSON.stringify(next).replace(
                    '${prompt.1}',
                    JSON.stringify(input.messages).match(/\$\{prompt\.[^}]+\}/)?.[0] ??
                      '${prompt.missing}',
                  ),
                ),
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as Awaited<ReturnType<ToolUseProvider['messageWithTools']>>;
        },
      };
      const result = await interaction.run(() =>
        compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          outDir: toolDir,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: 'fixture-user', password: 'fixture-pass' },
          },
          llmProvider: provider,
          maxDurationMs: 10_000,
        }),
      );
      expect(result.success).toBe(true);
      expect(calls).toBe(2);
      expect(closed).toBe(1);
      expect(messages.join('\n')).not.toContain(answer);
      expect(readFileSync(result.conversationLogPath, 'utf8')).not.toContain(answer);
      expect(readFileSync(pathJoin(toolDir, '.auth-evidence-session.json'), 'utf8')).not.toContain(
        answer,
      );
      expect(messages.join('\n')).toContain('/new-otp');
    } finally {
      interaction.clear();
      __setAuthVerifierLadderForTest(null);
      if (originalHome === undefined) process.env.IMPRINT_HOME = undefined;
      else process.env.IMPRINT_HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('retained authentication recovery', () => {
  it('retains API history and browser, lets the agent inspect then choose a fresh login, and expires prior-operation answers', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-retained-auth-'));
    const context = new AuthCompileContext();
    const toolDir = pathJoin(root, 'auth');
    const seen: string[] = [];
    const actions: string[] = [];
    let closed = 0;
    let oldReference = '';
    let prompts = 0;
    let browser = {
      close: async () => {
        closed += 1;
      },
      inspectPage: async () => ({
        url: 'https://fixture.test/current',
        title: 'Current page',
        bodyText: 'Fixture page',
        cookies: [],
      }),
    };
    try {
      process.env.IMPRINT_HOME = root;
      mkdirSync(toolDir);
      writeWorkflow(toolDir);
      const { sessionPath } = writeSessionPair(root);
      __setAuthVerifierLadderForTest(async (input) => {
        actions.push(String(input.params.action));
        if (actions.length === 1) {
          input.cdpPool?.set('fixture', browser as never);
          return {
            result: {
              ok: false,
              error: 'BAD_RESPONSE',
              message: 'Fixture repairable transform failure',
            },
            usedBackend: 'cdp-replay',
            attempts: [],
          };
        }
        if (input.params.action === 'begin') {
          expect(input.cdpPool?.size).toBe(0);
          browser = { ...browser };
          input.cdpPool?.set('fixture', browser as never);
          return {
            result: {
              ok: false,
              error: 'ACTION_REQUIRED',
              message: 'Fresh fixture challenge',
              nextAction: 'finish',
              continuation: { ticket: 'fixture-new-ticket' },
            },
            usedBackend: 'cdp-replay',
            attempts: [],
          };
        }
        expect(input.cdpPool?.get('fixture')).toBe(browser as never);
        if (actions.length === 5)
          expect(input.initialState).toEqual({ ticket: 'fixture-new-ticket' });
        return { result: { ok: true, data: {} }, usedBackend: 'cdp-replay', attempts: [] };
      });
      const script: Array<{ name: string; input: Record<string, unknown> }> = [
        {
          name: 'prompt_user',
          input: {
            message: 'Fixture current approval',
            options: ['Current approved', 'Not approved'],
          },
        },
        { name: 'run_verification', input: { action: 'finish', parameters: {} } },
        { name: 'run_verification', input: { action: 'finish', parameters: {} } },
        { name: 'done', input: { summary: 'First current session passed' } },
        { name: 'inspect_verification_page', input: {} },
        // The old reference must fail locally, without another network action.
        { name: 'run_verification', input: { action: 'finish', parameters: {} } },
        { name: 'run_verification', input: { action: 'finish', parameters: {} } },
        { name: 'run_verification', input: { action: 'begin', freshSession: true } },
        {
          name: 'prompt_user',
          input: {
            message: 'Approve the fresh fixture challenge',
            options: ['Current approved', 'Not approved'],
          },
        },
        { name: 'run_verification', input: { action: 'finish', parameters: {} } },
        {
          name: 'done',
          input: { summary: 'Agent selected new login after inspecting retained context' },
        },
      ];
      let turn = 0;
      const provider: ToolUseProvider = {
        name: 'anthropic-api',
        analyze: async () => {
          throw new Error('Unexpected analyze');
        },
        messageWithTools: async (input) => {
          const text = JSON.stringify(input.messages);
          seen.push(text);
          const next = script.shift();
          if (!next) throw new Error('Unexpected auth turn');
          if (turn === 1) {
            oldReference = text.match(/\$\{prompt\.[^}]+\}/)?.[0] ?? '';
            expect(oldReference).not.toBe('');
            next.input.parameters = { answer: oldReference };
          }
          if (turn === 2 || turn === 5) next.input.parameters = { answer: oldReference };
          if (turn === 9) {
            const reference = Array.from(text.matchAll(/\$\{prompt\.[^}]+\}/g)).at(-1)?.[0];
            expect(reference).toBeDefined();
            expect(reference).not.toBe(oldReference);
            next.input.parameters = { answer: reference };
          }
          turn += 1;
          return {
            id: `fixture-${turn}`,
            type: 'message',
            role: 'assistant',
            model: 'fixture',
            content: [{ type: 'tool_use', id: `call-${turn}`, ...next }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as Awaited<ReturnType<ToolUseProvider['messageWithTools']>>;
        },
      };
      const options = {
        context,
        site: 'fixture-site',
        session: session(),
        sessionPath,
        outDir: toolDir,
        authToolPlan: plan(),
        teachCredentials: { site: 'fixture-site', values: {} },
        llmProvider: provider,
        maxDurationMs: 30_000,
        onPrompt: async () => {
          prompts += 1;
          return 'fixture-current-response';
        },
      };
      expect((await compileAuthAgent(options)).success).toBe(true);
      expect(closed).toBe(0);
      const recovered = await compileAuthAgent({
        ...options,
        authToolPlan: {
          ...plan(),
          notes: 'Consumer returned a different failure; inspect current browser',
        },
      });
      expect(recovered.success).toBe(true);
      expect(actions).toEqual(['finish', 'finish', 'finish', 'begin', 'finish']);
      expect(prompts).toBe(2);
      expect(closed).toBe(1); // The agent explicitly selected freshSession.
      expect(seen[4]).toContain('Continue the existing authentication task');
      expect(seen[4]).toContain('First current session passed');
      expect(seen[6]).toContain('User-input reference has no attached host');
      expect(seen.join('')).not.toContain('fixture-current-response');
      await context.dispose();
      await context.dispose();
      expect(closed).toBe(2);
    } finally {
      await context.dispose();
      __setAuthVerifierLadderForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('auth compile prompt response provenance', () => {
  it('distinguishes the outgoing navigation from its selected background response', () => {
    const prompt = readFileSync(
      pathJoin(import.meta.dir, '..', 'prompts', 'auth-compile-agent.md'),
      'utf8',
    );
    expect(prompt).toMatch(
      /For `navigation\.networkResponse`, the capture evidence is\s+instead the response cited by `recordingResponseRequestSeq`\./,
    );
    expect(prompt).toMatch(
      /locate `navigation\.networkResponse\.recordingResponseRequestSeq` when the\s+capture reads a selected page-generated response/,
    );
  });
});

describe('recorded auth request grounding', () => {
  it('treats only a zero-length redaction marker as the recorded empty value', () => {
    const workflowRequest = {
      method: 'POST',
      url: 'https://example.test/login',
      headers: {},
      body: '{"optional_marker":""}',
    };
    expect(
      recordedRequestMatchesWorkflow(
        {
          method: 'POST',
          url: workflowRequest.url,
          body: '{"optional_marker":"[REDACTED:v3:id=2:len=0]"}',
        },
        workflowRequest,
      ),
    ).toBe(true);
    expect(
      recordedRequestMatchesWorkflow(
        {
          method: 'POST',
          url: workflowRequest.url,
          body: '{"optional_marker":"[REDACTED:v3:id=2:len=44]"}',
        },
        workflowRequest,
      ),
    ).toBe(false);
  });
});

function session(): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-07-09T00:00:00.000Z',
    url: 'https://fixture.test/login',
    imprintVersion: '0.0.0-test',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function writeSessionPair(
  root: string,
  value = session(),
): {
  sessionPath: string;
} {
  const sessionPath = pathJoin(root, 'session.json');
  const text = JSON.stringify(value);
  writeFileSync(sessionPath, text);
  return { sessionPath };
}

function plan(): NonNullable<AuthToolPlan> {
  return {
    toolName: 'authenticate_fixture',
    credentialRequestSeqs: [1],
    authRequestSeqs: [1, 2],
    credentialNames: ['username', 'password'],
    captures: [],
    notes: 'Synthetic planner hints',
  };
}

function validWorkflow(): Workflow {
  return WorkflowSchema.parse({
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    intent: { description: 'Synthetic auth' },
    site: 'fixture-site',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Compiled action',
        default: 'begin',
        choices: ['begin', 'finish'],
      },
      { name: 'answer', type: 'string', description: 'Live answer' },
    ],
    requests: [
      {
        method: 'POST',
        url: 'https://fixture.test/begin',
        headers: {},
        body: 'username=${credential.username}&password=${credential.password}',
        bodyPlaceholderEncoding: 'form-urlencoded',
        captures: [{ source: 'json', name: 'ticket', path: 'ticket' }],
      },
      {
        method: 'POST',
        url: 'https://fixture.test/finish',
        headers: {},
        captures: [{ source: 'json', name: 'done', path: 'done', equals: true }],
      },
    ],
    authConfig: {
      entry: 'begin',
      actions: {
        begin: {
          parameters: [],
          steps: [{ request: 0, onError: 'fail' }],
          outcome: {
            type: 'pause',
            next: 'finish',
            evidence: ['ticket'],
            carry: ['ticket'],
            message: 'Provide the live answer.',
          },
        },
        finish: {
          parameters: ['answer'],
          steps: [{ request: 1, onError: 'fail' }],
          outcome: { type: 'success', evidence: ['done'] },
        },
      },
      persist: [],
      crossOriginCookieReinjection: false,
    },
  });
}

const VALID_REQUEST_TEST = `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderWorkflowRequests } from 'imprint/backend-ladder';
import { WorkflowSchema } from 'imprint/types';

test('round trips adversarial form values', async () => {
  const value = '@&="\\\\\\n\\t 雪';
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync('workflow.json', 'utf8')));
  const { requests } = await renderWorkflowRequests({
    workflow,
    params: { action: 'begin' },
    credentials: {
      site: 'fixture-site',
      cookies: [],
      values: { username: value, password: value },
    },
  });
  const body = new URLSearchParams(requests[0]?.body ?? '');
  expect(body.get('username')).toBe(value);
  expect(body.get('password')).toBe(value);
});
`;

const NESTED_CAPTURE_CONTRACT_TEST = `
test('nested token matches the exact structured producer field', () => {
  const sessionPath = process.env.IMPRINT_SESSION_PATH;
  if (!sessionPath) throw new Error('IMPRINT_SESSION_PATH is not set');
  const recorded = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const request = recorded.requests.find((item: { seq: number }) => item.seq === 7);
  const body = request?.response?.body;
  if (typeof body !== 'string') throw new Error('recorded producer response is missing');
  const response = JSON.parse(body);
  const expected = JSON.parse(response.payload).session.token;

  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync('workflow.json', 'utf8')));
  const capture = workflow.requests[0]?.captures?.[0];
  if (!capture) throw new Error('compiled capture is missing');
  const actual =
    capture.source === 'json'
      ? capture.path === '$.payload' && capture.decodeJsonPath === '$.session.token'
        ? JSON.parse(response.payload).session.token
        : undefined
      : capture.source === 'text_regex'
        ? new RegExp(capture.pattern).exec(body)?.[capture.group ?? 1]
        : undefined;
  expect(actual).toBe(expected);
});
`;

function writeWorkflow(dir: string, workflow: Workflow = validWorkflow()): void {
  writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow), 'utf8');
  writeFileSync(pathJoin(dir, 'request.test.ts'), VALID_REQUEST_TEST, 'utf8');
}

afterEach(() => {
  process.env.PATH = originalPath;
  process.env.IMPRINT_HOME = originalHome;
  process.env.FAKE_CODEX_ARGS_LOG = undefined;
  process.env.FAKE_CODEX_TOOL_DIR = undefined;
  process.env.FAKE_CODEX_EARLY_STOP = undefined;
  process.env.FAKE_CODEX_PROMPT_CHECKPOINT = undefined;
  process.env.FAKE_CODEX_COOLDOWN_CHECKPOINT = undefined;
  process.env.FAKE_CODEX_INSPECT_CHECKPOINT = undefined;
  process.env.FAKE_CODEX_RETAINED_RECOVERY = undefined;
  process.env.FAKE_CODEX_STDIN_LOG = undefined;
  process.env.FAKE_CODEX_EXIT_101_ONCE = undefined;
  process.env.FAKE_CODEX_EXIT_101_NO_SESSION = undefined;
  process.env.FAKE_CLAUDE_ARGS_LOG = undefined;
  process.env.FAKE_CLAUDE_TOOL_DIR = undefined;
  process.env.FAKE_CLAUDE_TERMINAL_ERROR = undefined;
  process.env.FAKE_CLAUDE_OVERLOAD_ONCE = undefined;
  process.env.FAKE_CLAUDE_OVERLOAD_DELAY_MS = undefined;
  process.env.FAKE_CLAUDE_INVALID_RESUME = undefined;
  if (originalTeachCredentials === undefined) process.env.IMPRINT_TEACH_CREDENTIALS = undefined;
  else process.env.IMPRINT_TEACH_CREDENTIALS = originalTeachCredentials;
  __setAuthVerifierLadderForTest(null);
  setBackendOverride(null);
});

describe('stored auth credential resolution', () => {
  for (const providerName of ['anthropic-api', 'codex-cli'] as const) {
    it(`uses stored credentials instead of recorded reference strings with ${providerName}`, async () => {
      const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-stored-auth-'));
      const values: Record<string, string> = {
        username: 'fixture-keyring-user',
        password: 'fixture-keyring-pass-9472',
      };
      const backend: CredentialBackend = {
        id: 'keyring',
        getSecret: async (_site, name) => values[name] ?? null,
        listSecrets: async () => Object.keys(values),
        getCookies: async () => [],
        setSecret: async () => {
          throw new Error('Verification must not replace stored secrets');
        },
        deleteSecret: async () => {},
        setCookies: async () => {},
        listSites: async () => ['fixture-site'],
      };
      const rendered: URLSearchParams[] = [];
      const messages: string[] = [];
      try {
        setBackendOverride(backend);
        process.env.IMPRINT_HOME = pathJoin(root, 'home');
        const toolDir = pathJoin(root, 'authentication');
        mkdirSync(toolDir);
        writeWorkflow(toolDir);
        const { sessionPath } = writeSessionPair(root);
        __setAuthVerifierLadderForTest(async (input) => {
          const workflow = WorkflowSchema.parse(
            JSON.parse(readFileSync(input.workflowPath, 'utf8')),
          );
          const { requests } = await renderWorkflowRequests({
            workflow,
            params: { action: 'begin' },
            credentials: input.credentials,
          });
          rendered.push(new URLSearchParams(requests[0]?.body ?? ''));
          return {
            result: { ok: true, data: { authenticated: true } },
            usedBackend: 'cdp-replay',
            attempts: [],
          };
        });
        let provider: ToolUseProvider | undefined;
        if (providerName === 'codex-cli') {
          const bin = pathJoin(root, 'bin');
          mkdirSync(bin);
          process.env.PATH = `${bin}:${originalPath ?? ''}`;
          process.env.FAKE_CODEX_TOOL_DIR = toolDir;
          process.env.FAKE_CODEX_STDIN_LOG = pathJoin(root, 'stdin.log');
          process.env.FAKE_CODEX_INSPECT_CHECKPOINT = '1';
          installFakeCodex(bin);
        } else {
          const script = [
            { name: 'run_verification', input: { action: 'finish' } },
            { name: 'done', input: { summary: 'Stored credential fixture verified.' } },
          ];
          provider = {
            name: 'anthropic-api',
            analyze: async () => {
              throw new Error('Unexpected ordinary analyze call');
            },
            messageWithTools: async (input) => {
              messages.push(JSON.stringify(input.messages));
              const next = script.shift();
              if (!next) throw new Error('Unexpected extra auth turn');
              return {
                id: `fixture-${script.length}`,
                type: 'message',
                role: 'assistant',
                model: 'fixture',
                content: [{ type: 'tool_use', id: `tool-${script.length}`, ...next }],
                stop_reason: 'tool_use',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              } as Awaited<ReturnType<ToolUseProvider['messageWithTools']>>;
            },
          };
        }
        const result = await compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          outDir: toolDir,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: '${credential.username}', password: '${credential.password}' },
          },
          llmConfig: { provider: providerName },
          llmProvider: provider,
          onPrompt: async () => {
            throw new Error('Stored credentials should not require another human prompt');
          },
          maxDurationMs: 20_000,
        });
        expect(result.success).toBe(true);
        expect(rendered).toHaveLength(1);
        expect(rendered[0]?.get('username')).toBe(values.username);
        expect(rendered[0]?.get('password')).toBe(values.password);
        if (providerName === 'codex-cli') {
          messages.push(readFileSync(pathJoin(root, 'stdin.log'), 'utf8'));
        }
        expect(messages.join('\n')).not.toContain(values.password as string);
        expect(readFileSync(result.conversationLogPath, 'utf8')).not.toContain(
          values.password as string,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
});

describe('auth compile tools', () => {
  it('gives every provider the optional verification-page inspection tool', () => {
    expect(AUTH_COMPILE_TOOL_NAMES).toContain('inspect_verification_page');
    expect(AUTH_COMPILE_TOOL_NAMES).toContain('run_tests');
  });

  it('does not allow auth agents to write playbook.yaml', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const write = buildAuthCompileTools(session(), dir, '/tmp/session.json', {
        site: 'fixture-site',
        values: {},
      }).find((tool) => tool.name === 'write_file');
      expect(write).toBeDefined();
      const result = await write?.handler({
        relativePath: 'playbook.yaml',
        content: 'steps: []',
      });
      expect(result?.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not expose real teach credentials to agent-authored offline tests', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-test-credentials-'));
    try {
      const secret = 'must-not-reach-agent-tests';
      const tools = buildAuthCompileTools(session(), dir, '/tmp/session.json', {
        site: 'fixture-site',
        values: { username: 'fixture-user', password: secret },
      });
      const write = tools.find((tool) => tool.name === 'write_file');
      const runTests = tools.find((tool) => tool.name === 'run_tests');
      await write?.handler({
        relativePath: 'workflow.json',
        content: JSON.stringify(validWorkflow()),
      });
      await write?.handler({
        relativePath: 'request.test.ts',
        content: `${VALID_REQUEST_TEST}
test('offline auth tests receive no real teach payload', () => {
  expect(process.env.IMPRINT_TEACH_CREDENTIALS).toBeUndefined();
});`,
      });

      const result = await runTests?.handler({});
      expect(result?.isError).not.toBe(true);
      expect(result?.result).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an authored request test and reports its Bun failure before live auth', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-request-test-'));
    try {
      const tools = buildAuthCompileTools(session(), dir, '/tmp/session.json', {
        site: 'fixture-site',
        values: {},
      });
      const write = tools.find((tool) => tool.name === 'write_file');
      expect(write).toBeDefined();
      await write?.handler({
        relativePath: 'workflow.json',
        content: JSON.stringify(validWorkflow()),
      });
      await write?.handler({
        relativePath: 'request.test.ts',
        content: VALID_REQUEST_TEST,
      });
      expect(await authLivePreflightFailures(dir, session())).toEqual([]);

      await write?.handler({
        relativePath: 'request.test.ts',
        content: `import { expect, test } from 'bun:test';
test('agent-chosen encoding check', () => expect(1).toBe(2));`,
      });
      expect((await authLivePreflightFailures(dir, session())).join('\n')).toContain(
        'agent-authored request tests failed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks live auth when triage provenance loses its irreversible effect', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-irreversible-'));
    try {
      const workflow = validWorkflow();
      const request = workflow.requests[0];
      if (!request) throw new Error('bad fixture');
      request.recordingRequestSeq = 42;
      writeWorkflow(dir, workflow);
      const recorded = session();
      recorded.requests = [
        {
          seq: 42,
          timestamp: 1,
          method: request.method,
          url: request.url,
          headers: {},
          body: request.body,
          resourceType: 'Fetch',
          effect: 'irreversible',
        },
      ];

      expect((await authLivePreflightFailures(dir, recorded, [], [42])).join('\n')).toContain(
        'must declare effect: "irreversible"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores irreversible data requests outside the auth plan', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-scoped-provenance-'));
    try {
      const workflow = validWorkflow();
      const request = workflow.requests[0];
      if (!request) throw new Error('bad fixture');
      request.recordingRequestSeq = 1;
      writeWorkflow(dir, workflow);
      writeFileSync(pathJoin(dir, 'request.test.ts'), VALID_REQUEST_TEST);
      const recorded = session();
      recorded.requests = [
        {
          seq: 1,
          timestamp: 1,
          method: request.method,
          url: request.url,
          headers: {},
          body: request.body,
          resourceType: 'Fetch',
        },
        {
          seq: 42,
          timestamp: 2,
          method: 'POST',
          url: 'https://fixture.test/place-order',
          headers: {},
          body: '{"item":"lunch"}',
          resourceType: 'Fetch',
          effect: 'irreversible',
        },
      ];

      expect(await authLivePreflightFailures(dir, recorded, [], [1])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks only the generic action-program contract', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-contract-'));
    try {
      const workflow = validWorkflow();
      const first = workflow.requests[0];
      if (!first) throw new Error('bad fixture');
      workflow.requests[0] = {
        ...first,
        url: 'https://fixture.test/start?code_challenge=fixture-dynamic',
        body: '{"b_hour":"12","name":"Fixture Device","items[0]":"opaque"}',
      };
      writeWorkflow(dir, workflow);
      expect(authWorkflowPreflightFailures(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires every recording-planned credential in executable auth requests', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-credentials-'));
    try {
      const workflow = validWorkflow();
      const first = workflow.requests[0];
      if (!first) throw new Error('bad fixture');
      first.body = 'username=${credential.username}';
      writeWorkflow(dir, workflow);

      const failures = authWorkflowPreflightFailures(dir, undefined, ['username', 'password']).join(
        '\n',
      );
      expect(failures).not.toContain('planned credential "username"');
      expect(failures).toContain('planned credential "password"');

      first.body = 'username=${credential.username}&password=${credential.password}';
      writeWorkflow(dir, workflow);
      expect(authWorkflowPreflightFailures(dir, undefined, ['username', 'password'])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count credentials referenced only by unreachable requests', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-unreachable-credentials-'));
    try {
      const workflow = validWorkflow();
      const first = workflow.requests[0];
      if (!first) throw new Error('bad fixture');
      first.body = 'username=${credential.username}';
      workflow.requests.push({
        method: 'POST',
        url: 'https://fixture.test/unused',
        headers: {},
        body: 'password=${credential.password}',
      });
      writeWorkflow(dir, workflow);

      expect(authWorkflowPreflightFailures(dir, undefined, ['password']).join('\n')).toContain(
        'planned credential "password"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid request, action, evidence, and retry references', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-invalid-'));
    try {
      const workflow = validWorkflow();
      const begin = workflow.authConfig?.actions.begin;
      if (!begin || begin.outcome.type !== 'pause') throw new Error('bad fixture');
      begin.steps = [{ request: 99, onError: 'retry' }];
      begin.outcome.next = 'missing';
      begin.outcome.evidence = ['unknown'];
      writeWorkflow(dir, workflow);
      const failures = authWorkflowPreflightFailures(dir).join('\n');
      expect(failures).toContain('missing request 99');
      expect(failures).toContain('onError="retry" without repeat bounds');
      expect(failures).toContain('unknown action "missing"');
      expect(failures).toContain('unknown evidence capture "unknown"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the public action selector to match the compiled actions', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-selector-'));
    try {
      const missing = validWorkflow();
      missing.parameters = missing.parameters.filter((parameter) => parameter.name !== 'action');
      writeWorkflow(dir, missing);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain('action selector');

      const mismatched = validWorkflow();
      const action = mismatched.parameters.find((parameter) => parameter.name === 'action');
      if (!action) throw new Error('bad fixture');
      action.choices = ['begin'];
      writeWorkflow(dir, mismatched);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain(
        'choices exactly match authConfig.actions',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown action-program fields instead of silently stripping them', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-strict-'));
    try {
      const workflow = validWorkflow();
      const begin = workflow.authConfig?.actions.begin;
      if (!begin) throw new Error('bad fixture');
      writeWorkflow(dir, {
        ...workflow,
        authConfig: {
          ...workflow.authConfig,
          actions: {
            ...workflow.authConfig?.actions,
            begin: { ...begin, undeclaredPolicy: true },
          },
        },
      } as Workflow);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain('unrecognized_keys');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the latest live success to come from a declared success action', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-live-'));
    try {
      writeWorkflow(dir);
      const workflow = validWorkflow();
      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ action: 'begin', ok: true, workflowHash: authWorkflowHash(workflow) }),
      );
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true }).join('\n')).toContain(
        'does not declare a success outcome',
      );

      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ action: 'finish', ok: true, workflowHash: authWorkflowHash(workflow) }),
      );
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true })).toEqual([]);

      const changed = validWorkflow();
      const changedRequest = changed.requests[1];
      if (!changedRequest) throw new Error('bad fixture');
      changedRequest.url = 'https://fixture.test/changed-after-verification';
      writeWorkflow(dir, changed);
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true }).join('\n')).toContain(
        'changed after the most recent successful live auth verification',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing, failed, verified, and stale auth receipts without rerunning auth', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-receipt-'));
    try {
      const workflow = validWorkflow();
      writeWorkflow(dir, workflow);
      expect(readAuthVerificationReceiptStatus(dir, workflow).status).toBe('missing');

      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ action: 'finish', ok: false, workflowHash: authWorkflowHash(workflow) }),
      );
      expect(readAuthVerificationReceiptStatus(dir, workflow).status).toBe('failed');

      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({
          action: 'finish',
          ok: true,
          workflowHash: authWorkflowHash(workflow),
          backend: 'cdp-replay',
          timestamp: 456,
        }),
      );
      expect(readAuthVerificationReceiptStatus(dir, workflow)).toEqual(
        expect.objectContaining({
          status: 'verified',
          action: 'finish',
          backend: 'cdp-replay',
          timestamp: 456,
        }),
      );

      const changed = validWorkflow();
      const request = changed.requests[1];
      if (!request) throw new Error('bad fixture');
      request.url = 'https://fixture.test/changed';
      expect(readAuthVerificationReceiptStatus(dir, changed).status).toBe('stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires downstream credentials in authConfig.persist regardless of transport', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-persist-'));
    try {
      writeWorkflow(dir);
      expect(
        authExternalVerification(dir, [
          { name: 'opaque_alpha', usedAs: 'header:authorization' },
          { name: 'opaque_beta', usedAs: 'body.session_token' },
        ]).join('\n'),
      ).toContain('authConfig.persist');
      expect(
        authExternalVerification(dir, [
          { name: 'opaque_alpha', usedAs: 'header:authorization' },
          { name: 'opaque_beta', usedAs: 'body.session_token' },
        ]).join('\n'),
      ).toContain('opaque_alpha, opaque_beta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the auth agent to bind a durable interface to a renamed capture', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-persist-binding-'));
    try {
      const workflow = validWorkflow();
      const authConfig = workflow.authConfig;
      const request = workflow.requests[0];
      if (!authConfig || !request) throw new Error('bad fixture');
      authConfig.persist = ['opaque_alpha'];
      authConfig.persistBindings = { opaque_alpha: 'ticket' };
      request.recordingRequestSeq = 7;
      writeWorkflow(dir, workflow);
      writeFileSync(
        pathJoin(dir, 'request.test.ts'),
        `${VALID_REQUEST_TEST}
test('the durable interface preserves the planned capture binding', () => {
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync('workflow.json', 'utf8')));
  expect(workflow.authConfig?.persistBindings?.opaque_alpha).toBe('ticket');
});`,
        'utf8',
      );
      expect(
        authExternalVerification(dir, [{ name: 'opaque_alpha', usedAs: 'header:authorization' }]),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires persisted captures to identify their producing recorded request', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-capture-seq-'));
    try {
      const workflow = validWorkflow();
      const authConfig = workflow.authConfig;
      const request = workflow.requests[0];
      if (!authConfig || !request) throw new Error('bad fixture');
      authConfig.persist = ['ticket'];
      writeWorkflow(dir, workflow);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain('recordingRequestSeq');

      request.recordingRequestSeq = 7;
      writeWorkflow(dir, workflow);
      const recorded = session();
      recorded.requests = [
        {
          seq: 7,
          timestamp: 1,
          method: 'POST',
          url: 'https://fixture.test/begin',
          headers: {},
          body: 'username=fixture&password=fixture',
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            body: '{"ticket":"fixture-ticket"}',
            mimeType: 'application/json',
          },
        },
      ];
      expect(authWorkflowPreflightFailures(dir, recorded)).toEqual([]);

      const recordedRequest = recorded.requests[0];
      if (!recordedRequest?.response) throw new Error('bad recorded fixture');
      recordedRequest.method = 'GET';
      expect(authWorkflowPreflightFailures(dir, recorded).join('\n')).toContain(
        'does not match its workflow request',
      );
      recordedRequest.method = 'POST';
      recordedRequest.response.body = '{}';
      expect(authWorkflowPreflightFailures(dir, recorded).join('\n')).toContain('is not produced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires and runs an authored test for a persisted nested JSON capture', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-nested-json-capture-'));
    try {
      const workflow = validWorkflow();
      const authConfig = workflow.authConfig;
      const request = workflow.requests[0];
      if (!authConfig || !request) throw new Error('bad fixture');
      const token = 'synthetic/persisted+=value';
      request.recordingRequestSeq = 7;
      request.captures = [
        {
          source: 'json',
          name: 'nested_token',
          path: '$.payload',
          decodeJsonPath: '$.session.token',
          required: true,
          capability: 'ordinary_http',
        },
      ];
      authConfig.persist = ['nested_token'];
      const begin = authConfig.actions.begin;
      if (!begin || begin.outcome.type !== 'pause') throw new Error('bad fixture');
      begin.outcome.evidence = ['nested_token'];
      begin.outcome.carry = ['nested_token'];
      writeWorkflow(dir, workflow);
      rmSync(pathJoin(dir, 'request.test.ts'));

      const recorded = session();
      recorded.requests = [
        {
          seq: 7,
          timestamp: 1,
          method: 'POST',
          url: 'https://fixture.test/begin',
          headers: {},
          body: 'username=fixture&password=fixture',
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({
              unrelated: 'wrong-but-nonempty',
              payload: JSON.stringify({ session: { token } }).replaceAll('/', '\\/'),
            }),
            mimeType: 'application/json',
          },
        },
      ];
      expect(authWorkflowPreflightFailures(dir, recorded)).toEqual([]);
      const sessionPath = pathJoin(dir, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(recorded), 'utf8');

      expect(
        (await authLivePreflightFailures(dir, recorded, [], [], sessionPath)).join('\n'),
      ).toContain('request.test.ts is required');

      writeFileSync(
        pathJoin(dir, 'request.test.ts'),
        `${VALID_REQUEST_TEST}${NESTED_CAPTURE_CONTRACT_TEST}`,
        'utf8',
      );
      expect(await authLivePreflightFailures(dir, recorded, [], [], sessionPath)).toEqual([]);

      request.captures = [
        {
          source: 'text_regex',
          name: 'nested_token',
          pattern: '"unrelated":"([^"]+)"',
          group: 1,
          required: true,
          capability: 'ordinary_http',
        },
      ];
      writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow), 'utf8');
      expect(authWorkflowPreflightFailures(dir, recorded)).toEqual([]);
      expect(
        (await authLivePreflightFailures(dir, recorded, [], [], sessionPath)).join('\n'),
      ).toContain('agent-authored request tests failed');

      request.captures = [
        {
          source: 'json',
          name: 'nested_token',
          path: '$.payload',
          decodeJsonPath: '$.session.missing',
          required: true,
          capability: 'ordinary_http',
        },
      ];
      writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow), 'utf8');
      expect(authWorkflowPreflightFailures(dir, recorded).join('\n')).toContain('is not produced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('grounds the navigation final URL header in the recorded request URL', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-final-url-'));
    try {
      const workflow = validWorkflow();
      const request = workflow.requests[0];
      const authConfig = workflow.authConfig;
      if (!request || !authConfig) throw new Error('bad fixture');
      request.recordingRequestSeq = 3;
      request.captures = [
        {
          name: 'ticket',
          source: 'response_header',
          header: 'x-imprint-final-url',
          mode: 'first',
          required: true,
          capability: 'ordinary_http',
        },
      ];
      authConfig.persist = ['ticket'];
      writeWorkflow(dir, workflow);
      const recorded = session();
      recorded.requests = [
        {
          seq: 3,
          timestamp: 1,
          method: 'POST',
          url: 'https://fixture.test/begin',
          headers: {},
          body: 'username=fixture&password=fixture',
          resourceType: 'Document',
          response: { status: 200, headers: {}, body: '<html></html>', mimeType: 'text/html' },
        },
      ];

      expect(authWorkflowPreflightFailures(dir, recorded)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate capture names and grounds persisted polling captures', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-capture-owner-'));
    try {
      const duplicate = validWorkflow();
      const duplicateRequest = duplicate.requests[1];
      const duplicateCapture = duplicate.requests[0]?.captures?.[0];
      if (!duplicateRequest || duplicateCapture?.source !== 'json') throw new Error('bad fixture');
      duplicateRequest.captures = [{ ...duplicateCapture }];
      writeWorkflow(dir, duplicate);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain(
        'capture name "ticket" must be unique',
      );

      const repeatOnly = validWorkflow();
      const repeatAuthConfig = repeatOnly.authConfig;
      const begin = repeatAuthConfig?.actions.begin;
      const repeatCapture = repeatOnly.requests[0]?.captures?.[0];
      if (!repeatAuthConfig || !begin || repeatCapture?.source !== 'json') {
        throw new Error('bad fixture');
      }
      begin.steps[0] = {
        request: 0,
        onError: 'retry',
        repeat: {
          until: { ...repeatCapture, name: 'poll_token', path: 'poll_token' },
          intervalMs: 1,
          maxAttempts: 2,
        },
      };
      const repeatRequest = repeatOnly.requests[0];
      if (!repeatRequest) throw new Error('bad fixture');
      repeatRequest.recordingRequestSeq = 12;
      repeatAuthConfig.persist = ['poll_token'];
      writeWorkflow(dir, repeatOnly);
      const recorded = session();
      recorded.requests = [
        {
          seq: 12,
          timestamp: 1,
          method: 'POST',
          url: 'https://fixture.test/begin',
          headers: {},
          body: 'username=fixture&password=fixture',
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            body: '{"poll_token":"grounded-token"}',
            mimeType: 'application/json',
          },
        },
      ];
      expect(authWorkflowPreflightFailures(dir, recorded)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function installFakeCodex(binDir: string): void {
  const path = pathJoin(binDir, 'codex');
  const workflow = JSON.stringify(validWorkflow());
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.FAKE_CODEX_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_LOG, process.argv.slice(2).join('\\u0000') + '\\n', { flag: 'a' });
}
const toolDir = process.env.FAKE_CODEX_TOOL_DIR;
if (!toolDir) throw new Error('missing fake tool dir');
if (process.env.IMPRINT_TEACH_CREDENTIALS) throw new Error('teach credentials reached codex child');
writeFileSync(join(toolDir, 'request.test.ts'), ${JSON.stringify(VALID_REQUEST_TEST)});
const resumed = process.argv.includes('resume');
const recoveryMarker = join(toolDir, '.fake-recovered');
const inspectionMarker = join(toolDir, '.fake-inspected');
const prompt = await Bun.stdin.text();
if (process.env.FAKE_CODEX_STDIN_LOG) {
  writeFileSync(process.env.FAKE_CODEX_STDIN_LOG, prompt + '\\n---\\n', { flag: 'a' });
}
if (process.env.FAKE_CODEX_EXIT_101_ONCE && !resumed) {
  if (!process.env.FAKE_CODEX_EXIT_101_NO_SESSION) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  }
  process.exit(101);
}
if (process.env.FAKE_CODEX_RETAINED_RECOVERY && prompt.includes('Continue the existing authentication task')) {
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'inspect_verification_page', maxChars: 4096, includeCookies: false }));
} else if (process.env.FAKE_CODEX_RETAINED_RECOVERY && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(workflow)});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
} else if (process.env.FAKE_CODEX_INSPECT_CHECKPOINT && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(workflow)});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture-otp' } }));
} else if (process.env.FAKE_CODEX_INSPECT_CHECKPOINT && !existsSync(inspectionMarker)) {
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'inspect_verification_page', maxChars: 4096, includeCookies: true }));
  writeFileSync(inspectionMarker, '1');
} else if (process.env.FAKE_CODEX_INSPECT_CHECKPOINT) {
  writeFileSync(join(toolDir, '.compile-done.json'), JSON.stringify({ verification: 'mechanical_passed', summary: 'inspected' }));
} else if (process.env.FAKE_CODEX_EARLY_STOP && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), '{}');
} else if (process.env.FAKE_CODEX_EARLY_STOP && !existsSync(recoveryMarker)) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
  writeFileSync(recoveryMarker, '1');
} else if (process.env.FAKE_CODEX_PROMPT_CHECKPOINT && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'prompt_user', message: 'Confirm fixture action.' }));
} else if (process.env.FAKE_CODEX_COOLDOWN_CHECKPOINT && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'wait_for_cooldown', minutes: 1, reason: 'fixture cooldown' }));
} else if (resumed) {
  writeFileSync(join(toolDir, '.compile-done.json'), JSON.stringify({ verification: 'mechanical_passed', summary: 'resumed' }));
} else {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 2, cache_write_input_tokens: 3 } }));
`,
  );
  chmodSync(path, 0o755);
}

function installFakeClaude(binDir: string): void {
  const path = pathJoin(binDir, 'claude');
  const workflow = JSON.stringify(validWorkflow());
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.FAKE_CLAUDE_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n', { flag: 'a' });
}
const toolDir = process.env.FAKE_CLAUDE_TOOL_DIR;
if (!toolDir) throw new Error('missing fake tool dir');
if (process.env.IMPRINT_TEACH_CREDENTIALS) throw new Error('teach credentials reached claude child');
writeFileSync(join(toolDir, 'request.test.ts'), ${JSON.stringify(VALID_REQUEST_TEST)});
const resumed = process.argv.includes('--resume');
const overload = Boolean(process.env.FAKE_CLAUDE_OVERLOAD_ONCE) && !resumed;
const overloadDelayMs = Number(process.env.FAKE_CLAUDE_OVERLOAD_DELAY_MS) || 10;
if (overload && process.env.FAKE_CLAUDE_OVERLOAD_DELAY_MS) process.on('SIGTERM', () => {});
const invalidResume = Boolean(process.env.FAKE_CLAUDE_INVALID_RESUME) && resumed;
if (process.env.FAKE_CLAUDE_TERMINAL_ERROR || overload || invalidResume) {
  // A terminal errors[] event with exit 0 is still a provider error.
} else if (resumed) {
  writeFileSync(join(toolDir, '.compile-done.json'), JSON.stringify({ verification: 'mechanical_passed', summary: 'resumed' }));
} else {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
}
if (!invalidResume) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-claude-session' }));
}
if (process.env.FAKE_CLAUDE_TERMINAL_ERROR) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, errors: ['workflow schema validation failed'] }));
} else if (invalidResume) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'unrelated-claude-session', errors: ['No conversation found with session ID: fixture-claude-session'] }));
} else if (overload) {
  setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'fixture-claude-session', api_error_status: 529, errors: ['provider overloaded'] })), overloadDelayMs);
} else {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }));
}
`,
  );
  chmodSync(path, 0o755);
}

describe('compile CLI launch errors', () => {
  for (const provider of ['claude-cli', 'codex-cli'] as const) {
    it(`preserves an existing compile log when ${provider} cannot launch`, async () => {
      const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-launch-error-'));
      try {
        const bin = pathJoin(root, 'empty-bin');
        const home = pathJoin(root, 'home');
        const toolDir = pathJoin(home, 'fixture-site', 'authenticate_fixture');
        mkdirSync(bin);
        mkdirSync(toolDir, { recursive: true });
        process.env.PATH = bin;
        process.env.IMPRINT_HOME = home;
        const logPath = pathJoin(toolDir, '.compile-log.json');
        const existing = [{ type: 'assistant', message: 'prior compile work' }];
        writeFileSync(logPath, JSON.stringify(existing));
        const { sessionPath } = writeSessionPair(root);

        const result = await compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: 'fixture-user', password: 'fixture-pass' },
          },
          llmConfig: { provider },
          maxDurationMs: 5_000,
        });

        expect(result).toMatchObject({ success: false, outcome: 'error' });
        const persisted = JSON.parse(readFileSync(logPath, 'utf8')) as Array<{
          type: string;
          message?: string;
          error?: string;
        }>;
        expect(persisted[0]).toEqual(existing[0]);
        expect(persisted.some((event) => event.type === 'host_error')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('retained native authentication', () => {
  it('awaits host checkpoints in one assignment and retains the same native agent and browser for recovery', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-native-auth-recovery-'));
    const context = new AuthCompileContext();
    let closed = 0;
    let inspected = 0;
    let cooldowns = 0;
    const answer = 'fixture-native-current-answer';
    const observedActions: string[] = [];
    const family = new NativeTeachAgents(
      {
        root: pathJoin(root, 'native'),
        model: 'fixture',
        deadline: new RunDeadline(Date.now() + 30_000),
      },
      async (_family, signal) =>
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    );
    try {
      process.env.IMPRINT_HOME = root;
      const toolDir = pathJoin(root, 'auth');
      mkdirSync(toolDir);
      writeWorkflow(toolDir);
      const { sessionPath } = writeSessionPair(root);
      __setAuthVerifierLadderForTest(async (input) => {
        observedActions.push(String(input.params?.action));
        if (input.cdpPool?.size) expect(closed).toBe(0);
        else
          input.cdpPool?.set('fixture', {
            interactBrowser: async () => ({
              sourceId: 'fixture-native-discovery',
              page: {
                url: 'https://fixture.test/new-factor',
                title: 'New factor',
                bodyText: 'Choose a factor',
                controls: [],
                controlsTruncated: false,
              },
              requests: [
                {
                  seq: 0,
                  timestamp: 0,
                  method: 'GET',
                  url: 'https://fixture.test/new-factor',
                  headers: {},
                  resourceType: 'Document',
                  response: { status: 200, headers: {}, body: 'New factor' },
                },
              ],
              captureErrors: [],
            }),
            close: async () => {
              closed += 1;
            },
            inspectPage: async () => {
              inspected += 1;
              return {
                url: 'https://fixture.test/retained',
                title: 'Retained page',
                bodyText: 'Fixture',
                cookies: [],
              };
            },
          } as never);
        if (input.params?.action === 'begin')
          return {
            result: {
              ok: false,
              error: 'ACTION_REQUIRED',
              message: 'Current fixture challenge',
              nextAction: 'finish',
              continuation: { ticket: 'fixture-native-challenge' },
            },
            usedBackend: 'cdp-replay',
            attempts: [],
          };
        if (observedActions.length === 2) {
          expect(input.initialState).toEqual({ ticket: 'fixture-native-challenge' });
          expect(input.params?.answer).toBe(answer);
        }
        return { result: { ok: true, data: {} }, usedBackend: 'cdp-replay', attempts: [] };
      });
      const options = {
        context,
        site: 'fixture-site',
        session: session(),
        sessionPath,
        outDir: toolDir,
        authToolPlan: plan(),
        teachCredentials: { site: 'fixture-site', values: {} },
        llmConfig: { provider: 'codex-cli' as const },
        maxDurationMs: 30_000,
        onPrompt: async () => answer,
        onCooldown: async () => {
          cooldowns += 1;
        },
      };
      const execute = async (steps: string[], recovery: boolean) => {
        const compiling = compileAuthAgent({
          ...options,
          authToolPlan: { ...plan(), notes: recovery ? 'New consumer failure' : 'First request' },
        });
        void compiling.catch(() => {});
        const offered = (await family.handle('assignments', {})) as {
          tasks: Array<{ id: string; conversation: string; retainedAgentId?: string }>;
        };
        const task = offered.tasks[0];
        if (!task) throw new Error('Missing native auth assignment');
        if (recovery) expect(task.retainedAgentId).toBe('/root/fixture_auth');
        const assignment = (await family.handle('read_assignment', {
          id: task.id,
          agentId: '/root/fixture_auth',
        })) as { prompt: string };
        expect(assignment.prompt).toContain('Auth host tools execute inline');
        if (recovery) {
          expect(assignment.prompt).toContain('Continue the existing authentication task');
          expect(assignment.prompt).not.toContain('MANDATORY FIRST ACTION');
        }
        const listed = (await family.handle('list_assignment_tools', { id: task.id })) as {
          tools: Array<{ name: string; description?: string }>;
        };
        expect(listed.tools.find(({ name }) => name === 'run_verification')?.description).toContain(
          'Await the host result',
        );
        let reference = '';
        for (const [index, name] of steps.entries()) {
          const result = await family.handle('call_assignment_tool', {
            id: task.id,
            name,
            args:
              name === 'done'
                ? { summary: 'Current declared action passed' }
                : name === 'run_verification'
                  ? index === 0 && !recovery
                    ? { action: 'begin' }
                    : { action: 'finish', parameters: { answer: reference || 'fixture' } }
                  : name === 'prompt_user'
                    ? { message: 'Enter the current fixture answer.' }
                    : name === 'wait_for_cooldown'
                      ? { minutes: 0.1, reason: 'Fixture delay observation' }
                      : name === 'interact_verification_browser'
                        ? { action: 'inspect' }
                        : { includeCookies: false },
          });
          if (name === 'prompt_user') {
            reference = JSON.stringify(result).match(/\$\{prompt\.[^}]+\}/)?.[0] ?? '';
            expect(reference).not.toBe('');
            expect(JSON.stringify(result)).not.toContain(answer);
          }
          if (name === 'run_verification' && index === 0 && !recovery) {
            expect(JSON.stringify(result)).toContain('declared pause outcome');
            expect(JSON.stringify(result)).toContain('nextAction=finish');
          }
          expect(existsSync(pathJoin(toolDir, '.compile-checkpoint.json'))).toBe(false);
        }
        await family.handle('submit', { id: task.id, text: 'Fixture task completed' });
        expect((await compiling).success).toBe(true);
      };
      await family.run(async () => {
        await execute(['run_verification', 'prompt_user', 'run_verification', 'done'], false);
        expect(closed).toBe(0);
        await execute(
          [
            'interact_verification_browser',
            'inspect_verification_page',
            'wait_for_cooldown',
            'run_verification',
            'done',
          ],
          true,
        );
        expect(readFileSync(pathJoin(toolDir, '.auth-evidence-session.json'), 'utf8')).toContain(
          '/new-factor',
        );
        expect(inspected).toBe(1);
        expect(cooldowns).toBe(1);
        expect(observedActions).toEqual(['begin', 'finish', 'finish']);
        const events = readFileSync(pathJoin(root, 'native', 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(events.filter(({ type }) => type === 'assignment.created')).toHaveLength(2);
        expect(events.filter(({ type }) => type === 'assignment.bound')).toHaveLength(2);
        const checkpoints = events.filter(
          ({ type, name }) =>
            type === 'assignment.tool.completed' &&
            [
              'run_verification',
              'prompt_user',
              'interact_verification_browser',
              'inspect_verification_page',
              'wait_for_cooldown',
            ].includes(name),
        );
        expect(checkpoints).toHaveLength(7);
        expect(
          checkpoints.every(({ durationMs, status }) => durationMs >= 0 && status === 'returned'),
        ).toBe(true);
        expect(readFileSync(pathJoin(toolDir, '.compile-log.json'), 'utf8')).not.toContain(answer);
        expect(closed).toBe(0);
      });
      await context.dispose();
      expect(closed).toBe(1);
    } finally {
      await context.dispose();
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('retained Codex authentication', () => {
  it('resumes the finalized compiler assignment and existing browser for a later recovery request', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-retained-'));
    const context = new AuthCompileContext();
    let closed = 0;
    let inspected = 0;
    try {
      const bin = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'auth');
      mkdirSync(bin);
      mkdirSync(toolDir);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = root;
      process.env.FAKE_CODEX_TOOL_DIR = toolDir;
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_STDIN_LOG = pathJoin(root, 'stdin.log');
      process.env.FAKE_CODEX_RETAINED_RECOVERY = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);
      __setAuthVerifierLadderForTest(async (input) => {
        input.cdpPool?.set('fixture', {
          close: async () => {
            closed += 1;
          },
          inspectPage: async () => {
            inspected += 1;
            return {
              url: 'https://fixture.test/current',
              title: 'Retained',
              bodyText: 'Current context',
              cookies: [],
            };
          },
        } as never);
        return { result: { ok: true, data: {} }, usedBackend: 'cdp-replay', attempts: [] };
      });
      const options = {
        context,
        site: 'fixture-site',
        session: session(),
        sessionPath,
        outDir: toolDir,
        authToolPlan: plan(),
        teachCredentials: { site: 'fixture-site', values: {} },
        llmConfig: { provider: 'codex-cli' as const },
        maxDurationMs: 30_000,
      };
      expect((await compileAuthAgent(options)).success).toBe(true);
      expect(closed).toBe(0);
      expect(
        (
          await compileAuthAgent({
            ...options,
            authToolPlan: { ...plan(), notes: 'Consumer reported a new failure' },
          })
        ).success,
      ).toBe(true);
      expect(inspected).toBe(1);
      expect(closed).toBe(0);
      const commands = readFileSync(pathJoin(root, 'args.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\u0000'));
      expect(commands).toHaveLength(4);
      expect(
        commands
          .slice(1)
          .every((args) => args.includes('resume') && args.includes('fixture-thread')),
      ).toBe(true);
      const prompts = readFileSync(pathJoin(root, 'stdin.log'), 'utf8').split('\n---\n');
      expect(prompts[2]).toContain('Continue the existing authentication task');
      expect(prompts[2]).not.toContain('MANDATORY FIRST ACTION');
      await context.dispose();
      expect(closed).toBe(1);
    } finally {
      await context.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('compileAuthAgent with Codex', () => {
  it('backs off and resumes the same compile after a diagnostic-free exit 101', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-exit-101-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_EXIT_101_ONCE = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli', model: 'gpt-5.6-terra' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({
        success: true,
        outcome: 'done',
        sessionId: 'fixture-thread',
      });
      const commands = readFileSync(process.env.FAKE_CODEX_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\u0000'));
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('resume');
      expect(commands[1]).toContain('fixture-thread');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports exit 101 without a session as provider unavailability', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-exit-101-no-session-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_EXIT_101_ONCE = '1';
      process.env.FAKE_CODEX_EXIT_101_NO_SESSION = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      const compile = compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli', model: 'gpt-5.6-terra' },
        maxDurationMs: 30_000,
      });

      await expect(compile).rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(compile).rejects.toThrow('artifact was not treated as the cause');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets Codex inspect the existing verification page through a checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-inspect-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.IMPRINT_TEACH_CREDENTIALS = JSON.stringify({
        site: 'fixture-site',
        values: { password: 'must-stay-in-root' },
      });
      process.env.FAKE_CODEX_STDIN_LOG = pathJoin(root, 'stdin.log');
      process.env.FAKE_CODEX_INSPECT_CHECKPOINT = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      __setAuthVerifierLadderForTest((async (args: VerifierRunnerArgs) => {
        args.cdpPool?.set('fixture', {
          inspectPage: async () => ({
            url: 'https://fixture.test/auth-error',
            title: 'Authentication error',
            bodyText: 'Cookies are disabled for fixture-user and fixture-otp.',
            cookies: [
              {
                name: 'transaction',
                domain: '.fixture.test',
                path: '/',
                httpOnly: true,
                secure: true,
              },
            ],
          }),
          close: async () => {},
        } as never);
        return {
          result: { ok: true, data: { authenticated: true } },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }) as VerifierRunner);

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli', model: 'gpt-5.6-terra' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({ success: true, outcome: 'done', turns: 3 });
      const prompts = readFileSync(process.env.FAKE_CODEX_STDIN_LOG, 'utf8');
      expect(prompts).toContain('Current verification page snapshot');
      expect(prompts).toContain('Cookies are disabled for [REDACTED] and [REDACTED].');
      expect(prompts).toContain('"name": "transaction"');
      expect(prompts).not.toContain('fixture-pass');
      expect(prompts).not.toContain('fixture-otp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes the same Codex session after an arbitrary action checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli', model: 'gpt-5.6-terra' },
        maxDurationMs: 30_000,
      });
      expect(result).toMatchObject({
        success: true,
        outcome: 'done',
        turns: 2,
        inputTokens: 2,
        outputTokens: 2,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 6,
      });

      const commands = readFileSync(process.env.FAKE_CODEX_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\u0000'));
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('resume');
      expect(commands[1]).toContain('fixture-thread');
      for (const command of commands) {
        expect(command[command.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
        expect(command[command.indexOf('-C') + 1]).toBe(process.env.FAKE_CODEX_TOOL_DIR);
        expect(command).not.toContain('shell_tool');
        expect(command).not.toContain('unified_exec');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes Codex when a turn ends before a valid checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-recovery-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_EARLY_STOP = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));
      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({ success: true, outcome: 'done', turns: 3 });
      const commands = readFileSync(process.env.FAKE_CODEX_ARGS_LOG, 'utf8').trim().split('\n');
      expect(commands).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps user-input wait inside the one run deadline', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-prompt-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_PROMPT_CHECKPOINT = '1';
      process.env.FAKE_CODEX_STDIN_LOG = pathJoin(root, 'stdin.log');
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);

      await expect(
        compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: 'fixture-user', password: 'fixture-pass' },
          },
          llmConfig: { provider: 'codex-cli' },
          maxDurationMs: 1000,
          onPrompt: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            return 'confirmed';
          },
        }),
      ).rejects.toBeInstanceOf(ProviderDeadlineError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('cancels an auth cooldown immediately instead of waiting for its timer', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-cooldown-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_COOLDOWN_CHECKPOINT = '1';
      installFakeCodex(bin);
      const { sessionPath } = writeSessionPair(root);
      const controller = new AbortController();

      await expect(
        compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: 'fixture-user', password: 'fixture-pass' },
          },
          llmConfig: { provider: 'codex-cli' },
          maxDurationMs: 30_000,
          signal: controller.signal,
          onCooldown: async () => {
            controller.abort(new Error('cancelled during cooldown'));
            await new Promise<void>(() => {});
          },
        }),
      ).rejects.toThrow('cancelled during cooldown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 5_000);
});

describe('compileAuthAgent with Claude', () => {
  it('surfaces an errors-only deterministic terminal event as a typed provider error', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-error-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_TERMINAL_ERROR = '1';
      installFakeClaude(bin);
      const { sessionPath } = writeSessionPair(root);

      await expect(
        compileAuthAgent({
          site: 'fixture-site',
          session: session(),
          sessionPath,
          authToolPlan: plan(),
          teachCredentials: {
            site: 'fixture-site',
            values: { username: 'fixture-user', password: 'fixture-pass' },
          },
          llmConfig: { provider: 'claude-cli' },
          maxDurationMs: 30_000,
        }),
      ).rejects.toBeInstanceOf(ProviderReportedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains and recovers a late structured 529 result in the same Claude session', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-overload-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CLAUDE_OVERLOAD_ONCE = '1';
      installFakeClaude(bin);
      const { sessionPath } = writeSessionPair(root);

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'claude-cli' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({
        success: true,
        outcome: 'done',
        sessionId: 'fixture-claude-session',
      });
      const commands = readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('--resume');
      expect(commands[1]).toContain('fixture-claude-session');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a late provider fact as provider unavailable instead of artifact timeout', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-deadline-fact-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CLAUDE_OVERLOAD_ONCE = '1';
      process.env.FAKE_CLAUDE_OVERLOAD_DELAY_MS = '1500';
      installFakeClaude(bin);
      const { sessionPath } = writeSessionPair(root);

      const compile = compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'claude-cli' },
        maxDurationMs: 1_000,
      });

      await expect(compile).rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(compile).rejects.toThrow('artifact was not treated as the cause');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Claude invalid-resume replacement sessions without retrying', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-invalid-resume-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CLAUDE_INVALID_RESUME = '1';
      installFakeClaude(bin);
      const { sessionPath } = writeSessionPair(root);
      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'claude-cli' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({
        success: false,
        outcome: 'error',
        sessionId: 'fixture-claude-session',
      });
      expect(result.message).toContain('unrelated-claude-session');
      expect(result.message).toContain('No conversation found with session ID');
      expect(
        readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, 'utf8').trim().split('\n'),
      ).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes the same Claude session after an arbitrary action checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.IMPRINT_TEACH_CREDENTIALS = JSON.stringify({
        site: 'fixture-site',
        values: { password: 'must-stay-in-root' },
      });
      installFakeClaude(bin);
      const { sessionPath } = writeSessionPair(root);

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));
      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'claude-cli', model: 'fixture-claude-model' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({
        success: true,
        outcome: 'done',
        turns: 2,
        inputTokens: 2,
        outputTokens: 2,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 6,
      });
      const commands = readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('--resume');
      expect(commands[1]).toContain('fixture-claude-session');
      for (const command of commands) {
        expect(command[command.indexOf('--model') + 1]).toBe('fixture-claude-model');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
