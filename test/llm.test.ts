/**
 * Tests for the Vertex error-enrichment + JSON extraction helpers.
 *
 * The `analyze()` method itself is exercised end-to-end by compile.test.ts;
 * here we cover the parts that don't need a live LLM call.
 */

import { describe, expect, it } from 'bun:test';
import { detectProvider, extractJsonObject, isValidProvider } from '../src/imprint/llm.ts';

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

describe('isValidProvider', () => {
  it('accepts valid provider names', () => {
    expect(isValidProvider('anthropic-api')).toBe(true);
    expect(isValidProvider('vertex')).toBe(true);
    expect(isValidProvider('claude-cli')).toBe(true);
    expect(isValidProvider('codex-cli')).toBe(true);
    expect(isValidProvider('cursor-cli')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidProvider('openai')).toBe(false);
    expect(isValidProvider('')).toBe(false);
    expect(isValidProvider('VERTEX')).toBe(false);
  });
});

describe('detectProvider', () => {
  it('prefers ANTHROPIC_API_KEY over other options', () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      expect(detectProvider()).toBe('anthropic-api');
    } finally {
      if (orig === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('falls back to vertex when ANTHROPIC_VERTEX_PROJECT_ID is set', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    try {
      process.env.ANTHROPIC_API_KEY = undefined;
      process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project';
      expect(detectProvider()).toBe('vertex');
    } finally {
      if (origKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = origKey;
      if (origProject === undefined) process.env.ANTHROPIC_VERTEX_PROJECT_ID = undefined;
      else process.env.ANTHROPIC_VERTEX_PROJECT_ID = origProject;
    }
  });
});
