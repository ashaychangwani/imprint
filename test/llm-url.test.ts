import { describe, expect, it } from 'bun:test';
import { compactUrlForLlm } from '../src/imprint/llm-url.ts';

describe('compactUrlForLlm', () => {
  it('preserves path and query keys while truncating opaque query values', () => {
    const jwt = `${'a'.repeat(80)}.${'b'.repeat(80)}.${'c'.repeat(80)}`;
    const url = compactUrlForLlm(
      `https://example.com/search?origin=SFO&searchToken=${jwt}&date=2026-09-07`,
    );

    expect(url).toContain('https://example.com/search');
    expect(url).toContain('origin=SFO');
    expect(url).toContain('date=2026-09-07');
    expect(url).toContain('searchToken=');
    expect(url).toContain('truncated%3AsearchToken');
    expect(url).not.toContain(jwt);
  });

  it('caps extremely long URLs even when parsing fails', () => {
    const compacted = compactUrlForLlm(`not a url ${'x'.repeat(2000)}`, { maxUrlChars: 200 });

    expect(compacted.length).toBeLessThanOrEqual(200);
    expect(compacted).toContain('truncated url len=');
  });
});
