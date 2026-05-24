/**
 * Tests for the LLM provider helpers and JSON extraction utilities.
 *
 * The `analyze()` method itself is exercised end-to-end by compile.test.ts;
 * here we cover the parts that don't need a live LLM call.
 */

import { describe, expect, it } from 'bun:test';
import {
  codexAnalyzeArgs,
  collectCliProcessOutput,
  detectProvider,
  detectTeachProvider,
  extractJsonObject,
  getProviderStatuses,
  isTeachCompatibleProvider,
  isValidProvider,
  normalizeCliAnalyzeOutput,
  preferredAgentModel,
} from '../src/imprint/llm.ts';

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

describe('collectCliProcessOutput', () => {
  it('drains stdout and stderr concurrently so verbose CLI stderr cannot deadlock', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        "const chunk = 'x'.repeat(1024); for (let i = 0; i < 2048; i++) process.stderr.write(chunk); process.stdout.write('ok');",
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (
      typeof proc.stdout === 'number' ||
      typeof proc.stderr === 'number' ||
      !proc.stdout ||
      !proc.stderr
    ) {
      throw new Error('test process did not expose streams');
    }

    const result = await collectCliProcessOutput({
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr.length).toBe(2048 * 1024);
  });
});

describe('codexAnalyzeArgs', () => {
  it('isolates generic Codex JSON calls from user MCP config and repo rules', () => {
    const args = codexAnalyzeArgs('gpt-test');

    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-test']);
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
      expect(preferredAgentModel('codex-cli')).toBe('gpt-5.5');
    });
  });
});
