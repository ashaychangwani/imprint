/**
 * Tests for the LLM provider helpers and JSON extraction utilities.
 *
 * The `analyze()` method itself is exercised end-to-end by compile.test.ts;
 * here we cover the parts that don't need a live LLM call.
 */

import { describe, expect, it } from 'bun:test';
import { runOwnedCli } from '../src/imprint/compiler-process.ts';
import {
  DEFAULT_VERIFICATION_PROVIDER,
  availableModelsForProvider,
  cliExitError,
  cliStderrTail,
  codexTurnWatchdogMs,
  detectProvider,
  detectTeachProvider,
  enrichCodexCliError,
  extractJsonObject,
  getProviderStatuses,
  isTeachCompatibleProvider,
  isValidProvider,
  normalizeCliAnalyzeOutput,
  preferredAgentModel,
  preferredVerificationModel,
  runCodexTurnWithWatchdog,
} from '../src/imprint/llm.ts';
import {
  ProviderReportedError,
  isTransientProviderCapacityError,
  retryTransientProviderFailure,
} from '../src/imprint/provider-retry.ts';
import {
  parseClaudeTerminalOutput,
  parseCodexTerminalOutput,
} from '../src/imprint/provider-terminal.ts';

describe('extractJsonObject', () => {
  it('returns the first balanced object as-is from a bare JSON response', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips fenced code blocks', () => {
    const text = 'Here is the result:\n```json\n{"x":42}\n```\nHope this helps.';
    expect(extractJsonObject(text)).toBe('{"x":42}');
  });

  it('handles fences without the language tag', () => {
    expect(extractJsonObject('```\n{"x":1}\n```')).toBe('{"x":1}');
  });

  it('finds the object in the middle of preamble text', () => {
    expect(extractJsonObject('preamble {"k":"v"} trailing')).toBe('{"k":"v"}');
  });

  it('handles nested objects without confusion', () => {
    const text = '{"outer":{"inner":{"deep":1}}}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('respects strings containing braces', () => {
    expect(extractJsonObject('{"k":"value with { and } in it"}')).toBe(
      '{"k":"value with { and } in it"}',
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject(String.raw`{"k":"a\"quote"}`)).toBe(String.raw`{"k":"a\"quote"}`);
  });

  it('returns null when no { found', () => {
    expect(extractJsonObject('no JSON here, just text')).toBe(null);
  });

  it('returns null when braces never balance', () => {
    expect(extractJsonObject('{"unclosed":')).toBe(null);
  });
});

describe('normalizeCliAnalyzeOutput', () => {
  it('preserves YAML with parameter placeholders instead of extracting ${...}', () => {
    const yaml = 'toolName: search_google_flights\nsteps:\n  - value: ${origin}\n';
    expect(normalizeCliAnalyzeOutput(yaml, 'Output YAML matching this exact shape.')).toBe(yaml);
  });

  it('extracts a JSON object only when the prompt asks for one', () => {
    expect(
      normalizeCliAnalyzeOutput('Here is the result:\n{"ok":true}\n', 'Output only a JSON object.'),
    ).toBe('{"ok":true}');
  });

  it('leaves JSON-array prompts untouched for the array parser', () => {
    const text = 'Here is the result:\n[1,2,3]\n';
    expect(
      normalizeCliAnalyzeOutput(text, 'Output only a JSON array of request seq numbers.'),
    ).toBe(text);
  });
});

describe('structured CLI provider failures', () => {
  it('normalizes the Codex SDK exit shape before applying provider retry policy', async () => {
    const interruption = enrichCodexCliError(new Error('Codex Exec exited with code 101: '), {
      model: 'gpt-5.6-sol',
    });
    expect(interruption).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(interruption)).toBe(true);

    const diagnosed = enrichCodexCliError(
      new Error('Codex Exec exited with code 101: worker panic'),
      { model: 'gpt-5.6-sol' },
    );
    expect(diagnosed).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(diagnosed)).toBe(true);
    expect(diagnosed.message).toContain('worker panic');

    const otherExit = enrichCodexCliError(new Error('Codex Exec exited with code 1: '), {
      model: 'gpt-5.6-sol',
    });
    expect(otherExit).not.toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(otherExit)).toBe(false);

    const embedded = enrichCodexCliError(
      new Error('wrapper mentioned Codex Exec exited with code 101: '),
      { model: 'gpt-5.6-sol' },
    );
    expect(isTransientProviderCapacityError(embedded)).toBe(false);

    const providerNotFound = enrichCodexCliError(new Error('requested model was not found'), {
      model: 'gpt-5.6-sol',
    });
    expect(providerNotFound.message).toBe('codex-cli failed: requested model was not found');

    const missingExecutable = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    expect(enrichCodexCliError(missingExecutable, { model: 'gpt-5.6-sol' }).message).toContain(
      'codex-cli not found',
    );

    let calls = 0;
    const retryReasons: string[] = [];
    const recovered = await retryTransientProviderFailure(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw enrichCodexCliError(new Error('Codex Exec exited with code 101: '), {
            model: 'gpt-5.6-sol',
          });
        }
        return 'recovered';
      },
      {
        sleep: async () => {},
        onRetry: ({ reason }) => retryReasons.push(reason),
      },
    );
    expect(recovered).toBe('recovered');
    expect(calls).toBe(2);
    expect(retryReasons).toEqual(['provider_process_interrupted']);
  });

  it('retries a diagnostic-free Codex process exit without guessing about artifact failure', () => {
    const interruption = cliExitError('codex-cli', 101, '');
    expect(interruption).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(interruption)).toBe(true);
    expect((interruption as ProviderReportedError).codes).toEqual(['cli_exit_101']);
    expect((interruption as ProviderReportedError).interruption).toBe(
      'provider_process_interrupted',
    );

    expect(isTransientProviderCapacityError(cliExitError('codex-cli', 1, ''))).toBe(false);
    expect(isTransientProviderCapacityError(cliExitError('codex-cli', 101, 'panic'))).toBe(true);
  });

  it('bounds a Codex SDK turn that never settles and aborts its child', async () => {
    let childSignal: AbortSignal | undefined;
    const result = runCodexTurnWithWatchdog(
      (signal) => {
        childSignal = signal;
        return new Promise<string>(() => {});
      },
      { timeoutMs: 5 },
    );

    await expect(result).rejects.toMatchObject({
      name: 'ProviderReportedError',
      interruption: 'provider_process_interrupted',
      codes: ['codex_turn_stalled'],
    });
    expect(childSignal?.aborted).toBe(true);
  });

  it('propagates cancellation through the Codex turn watchdog', async () => {
    const parent = new AbortController();
    const cancelled = new DOMException('user cancelled', 'AbortError');
    const result = runCodexTurnWithWatchdog(() => new Promise<string>(() => {}), {
      signal: parent.signal,
      timeoutMs: 1_000,
    });
    parent.abort(cancelled);
    await expect(result).rejects.toBe(cancelled);
  });

  it('uses a five-minute Codex watchdog unless a valid override is supplied', () => {
    expect(codexTurnWatchdogMs(undefined)).toBe(5 * 60_000);
    expect(codexTurnWatchdogMs('1250')).toBe(1_250);
    expect(codexTurnWatchdogMs('nope')).toBe(5 * 60_000);
  });

  it('backs off and reruns the same call after a diagnostic-free Codex exit 101', async () => {
    let calls = 0;
    const retries: string[] = [];
    const result = await retryTransientProviderFailure(
      async () => {
        calls++;
        if (calls === 1) throw cliExitError('codex-cli', 101, '');
        return 'recovered';
      },
      {
        sleep: async () => {},
        onRetry: ({ reason }) => retries.push(reason),
      },
    );

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
    expect(retries).toEqual(['provider_process_interrupted']);
  });

  it('surfaces Claude errors-only output before missing-result or exit reduction', () => {
    const error = parseClaudeTerminalOutput(
      JSON.stringify({ type: 'result', is_error: true, errors: ['529 provider overloaded'] }),
    ).providerError;
    expect(error).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(error)).toBe(true);
  });

  it('preserves deterministic Claude facts when a transient status is also present', () => {
    const error = parseClaudeTerminalOutput(
      JSON.stringify({
        type: 'result',
        is_error: true,
        api_error_status: 429,
        errors: ['insufficient_quota'],
      }),
    ).providerError;
    expect(error).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(error)).toBe(false);
  });

  it('extracts Codex final output and provider terminal facts from JSONL', () => {
    expect(
      parseCodexTerminalOutput(
        [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '{"ok":true}' },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      ),
    ).toMatchObject({ text: '{"ok":true}', sessionId: 'thread-1' });

    const failed = parseCodexTerminalOutput(
      JSON.stringify({
        type: 'turn.failed',
        status: 529,
        error: { code: 'overloaded', message: 'provider unavailable' },
      }),
    );
    expect(failed.providerError).toBeInstanceOf(ProviderReportedError);
    expect(isTransientProviderCapacityError(failed.providerError)).toBe(true);

    const contradicted = parseCodexTerminalOutput(
      [
        JSON.stringify({ type: 'error', status: 529, error: { code: 'overloaded' } }),
        JSON.stringify({
          type: 'turn.failed',
          error_code: 'insufficient_quota',
        }),
      ].join('\n'),
    );
    expect(isTransientProviderCapacityError(contradicted.providerError)).toBe(false);
  });

  it('treats stringified Codex failure messages as diagnostic-only', () => {
    const nested = JSON.stringify({
      error: {
        status: 529,
        code: 'overloaded_error',
        message: 'provider temporarily unavailable',
      },
    });
    const parsed = parseCodexTerminalOutput(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'target returned HTTP 429 invalid API key' },
        }),
        JSON.stringify({ type: 'turn.failed', message: nested }),
      ].join('\n'),
    );
    expect(isTransientProviderCapacityError(parsed.providerError)).toBe(false);

    const trusted = parseCodexTerminalOutput(
      JSON.stringify({
        type: 'turn.failed',
        provider: 'openai',
        provider_error: { status: 529, code: 'overloaded_error' },
      }),
    );
    expect(isTransientProviderCapacityError(trusted.providerError)).toBe(true);
  });

  it('never lets stderr or stringified nested facts declare provider disposition', () => {
    const transient = JSON.stringify({
      type: 'turn.failed',
      status: 429,
      error: JSON.stringify({ code: 'insufficient_quota' }),
    });
    expect(
      isTransientProviderCapacityError(
        parseCodexTerminalOutput(transient, 'MCP tool: invalid API key').providerError,
      ),
    ).toBe(true);
    const codex = parseCodexTerminalOutput(transient, 'codex provider error: invalid API key');
    expect(isTransientProviderCapacityError(codex.providerError)).toBe(true);

    const claudeStderr = parseClaudeTerminalOutput(
      JSON.stringify({ type: 'result', result: '{"ok":true}' }),
      'claude provider error: 529 overloaded\ninvalid API key',
    );
    expect(claudeStderr.providerError).toBeUndefined();
    expect(claudeStderr.text).toBe('{"ok":true}');

    const claude = parseClaudeTerminalOutput(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result:
          'I am unable to respond to this request because it appears to violate our Usage Policy.',
        errors: ['insufficient_quota'],
      }),
    );
    expect(claude.interruption).toBeUndefined();
    expect(isTransientProviderCapacityError(claude.providerError)).toBe(false);
  });
});

describe('owned CLI process', () => {
  it('drains stdout and stderr concurrently so verbose CLI stderr cannot deadlock', async () => {
    const result = await runOwnedCli({
      command: 'bun',
      args: [
        '-e',
        "const chunk = 'x'.repeat(1024); for (let i = 0; i < 2048; i++) process.stderr.write(chunk); process.stdout.write('ok');",
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr.length).toBe(2048 * 1024);
  });

  it('kills and settles an active CLI provider call when directly aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('direct cancellation')), 20);

    await expect(
      runOwnedCli({
        command: 'bun',
        args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(() => {}, 1000)'],
        signal: controller.signal,
        shutdownGraceMs: 20,
      }),
    ).rejects.toThrow('direct cancellation');
  });

  it('delivers the final JSONL line when it has no newline', async () => {
    const lines: string[] = [];
    const result = await runOwnedCli({
      command: 'bun',
      args: ['-e', 'process.stdout.write(JSON.stringify({type:"turn.completed"}))'],
      onStdoutLine: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual([JSON.stringify({ type: 'turn.completed' })]);
  });
});

describe('CLI provider failure diagnostics', () => {
  it('keeps only the stderr tail for verbose CLI failures', () => {
    const stderr = `${'prompt echo '.repeat(500)}final error`;
    const tail = cliStderrTail(stderr, 32);

    expect(tail.length).toBe(32);
    expect(tail.endsWith('final error')).toBe(true);
  });
});

describe('isValidProvider', () => {
  it('accepts valid provider names', () => {
    expect(isValidProvider('anthropic-api')).toBe(true);
    expect(isValidProvider('claude-cli')).toBe(true);
    expect(isValidProvider('codex-cli')).toBe(true);
    expect(isValidProvider('cursor-cli')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidProvider('openai')).toBe(false);
    expect(isValidProvider('')).toBe(false);
    expect(isValidProvider('vertex')).toBe(false);
  });
});

describe('detectProvider', () => {
  /** Run `fn` with Bun.which stubbed so none of the CLI providers are seen
   *  on PATH. Lets us exercise the env-var branches deterministically even
   *  when the dev machine has claude/codex/cursor installed. */
  function withoutCliProviders<T>(fn: () => T): T {
    const orig = Bun.which;
    Bun.which = (() => null) as typeof Bun.which;
    try {
      return fn();
    } finally {
      Bun.which = orig;
    }
  }

  it('prefers claude-cli over env-var providers when claude is on PATH', () => {
    const origWhich = Bun.which;
    const origKey = process.env.ANTHROPIC_API_KEY;
    Bun.which = ((cmd: string) =>
      cmd === 'claude' ? '/usr/bin/claude' : null) as typeof Bun.which;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      expect(detectProvider()).toBe('claude-cli');
    } finally {
      Bun.which = origWhich;
      if (origKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('falls back to anthropic-api when no CLI is on PATH but ANTHROPIC_API_KEY is set', () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      withoutCliProviders(() => {
        expect(detectProvider()).toBe('anthropic-api');
      });
    } finally {
      if (orig === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('prefers env providers over cursor-cli for generic provider auto-detection', () => {
    const origWhich = Bun.which;
    const origKey = process.env.ANTHROPIC_API_KEY;
    try {
      Bun.which = ((cmd: string) => (cmd === 'cursor' ? '/bin/cursor' : null)) as typeof Bun.which;
      process.env.ANTHROPIC_API_KEY = 'sk-test';

      expect(detectProvider()).toBe('anthropic-api');
      expect(detectTeachProvider()).toBe('anthropic-api');
    } finally {
      Bun.which = origWhich;
      if (origKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('falls back to cursor-cli when no compile-agent provider is detected', () => {
    const origWhich = Bun.which;
    const origKey = process.env.ANTHROPIC_API_KEY;
    try {
      Bun.which = ((cmd: string) => (cmd === 'cursor' ? '/bin/cursor' : null)) as typeof Bun.which;
      process.env.ANTHROPIC_API_KEY = undefined;

      expect(detectProvider()).toBe('cursor-cli');
      expect(() => detectTeachProvider()).toThrow(/No teach-compatible/);
    } finally {
      Bun.which = origWhich;
      if (origKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

describe('provider status metadata', () => {
  function withProviderEnv<T>(opts: { which?: (cmd: string) => string | null }, fn: () => T): T {
    const origWhich = Bun.which;
    const origApiKey = process.env.ANTHROPIC_API_KEY;
    const origCodexModel = process.env.CODEX_MODEL;
    const origCodexAgentModel = process.env.CODEX_MODEL_AGENT;
    try {
      Bun.which = (opts.which ?? (() => null)) as typeof Bun.which;
      process.env.ANTHROPIC_API_KEY = undefined;
      process.env.CODEX_MODEL = undefined;
      process.env.CODEX_MODEL_AGENT = undefined;
      return fn();
    } finally {
      Bun.which = origWhich;
      if (origApiKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = origApiKey;
      if (origCodexModel === undefined) process.env.CODEX_MODEL = undefined;
      else process.env.CODEX_MODEL = origCodexModel;
      if (origCodexAgentModel === undefined) process.env.CODEX_MODEL_AGENT = undefined;
      else process.env.CODEX_MODEL_AGENT = origCodexAgentModel;
    }
  }

  it('reports every detected provider instead of only the first', () => {
    withProviderEnv(
      {
        which: (cmd) => {
          if (cmd === 'claude') return '/bin/claude';
          if (cmd === 'codex') return '/bin/codex';
          if (cmd === 'cursor') return '/bin/cursor';
          return null;
        },
      },
      () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        const statuses = getProviderStatuses();
        expect(statuses.filter((s) => s.detected).map((s) => s.name)).toEqual([
          'claude-cli',
          'codex-cli',
          'cursor-cli',
          'anthropic-api',
        ]);
      },
    );
  });

  it('includes setup hints for providers that were not detected', () => {
    withProviderEnv({}, () => {
      const statuses = getProviderStatuses();
      expect(statuses.find((s) => s.name === 'codex-cli')?.setupHint).toContain('codex login');
      expect(statuses.find((s) => s.name === 'anthropic-api')?.setupHint).toContain(
        'ANTHROPIC_API_KEY',
      );
    });
  });

  it('marks codex-cli as teach-compatible but cursor-cli as not yet supported', () => {
    expect(isTeachCompatibleProvider('codex-cli')).toBe(true);
    expect(isTeachCompatibleProvider('cursor-cli')).toBe(false);
  });

  it('uses a current Codex model for agentic compile by default', () => {
    withProviderEnv({}, () => {
      expect(preferredAgentModel('codex-cli')).toBe('gpt-5.6-sol');
    });
  });

  it('offers the gpt-5.6 Codex models with sol as the only default', () => {
    const models = availableModelsForProvider('codex-cli');
    expect(models.slice(0, 3)).toEqual([
      { model: 'gpt-5.6-sol', isDefault: true },
      { model: 'gpt-5.6-terra', isDefault: false },
      { model: 'gpt-5.6-luna', isDefault: false },
    ]);
    expect(models.filter((model) => model.isDefault)).toEqual([
      { model: 'gpt-5.6-sol', isDefault: true },
    ]);
  });

  it('pins the independent Codex verifier to Terra', () => {
    expect(DEFAULT_VERIFICATION_PROVIDER).toBe('codex-cli');
    expect(preferredVerificationModel('codex-cli')).toBe('gpt-5.6-terra');
  });

  it('selects the latest ordered Sonnet for both Claude providers', () => {
    expect(preferredVerificationModel('claude-cli')).toBe('claude-sonnet-4-6');
    expect(preferredVerificationModel('anthropic-api')).toBe('claude-sonnet-4-6');
  });

  it('does not silently fall back for unsupported verifier providers', () => {
    expect(() => preferredVerificationModel('cursor-cli')).toThrow(
      'does not support live semantic verification',
    );
  });
});
