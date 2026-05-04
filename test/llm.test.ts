/**
 * Tests for the Vertex error-enrichment + JSON extraction helpers.
 *
 * The `analyze()` method itself is exercised end-to-end by compile.test.ts;
 * here we cover the parts that don't need a live LLM call.
 */

import { describe, expect, it } from 'bun:test';
import { extractJsonObject } from '../src/imprint/llm.ts';

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
