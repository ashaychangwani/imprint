import { describe, expect, it } from 'bun:test';
import { redactFreeformText } from '../src/imprint/freeform-redact.ts';
const placeholder = '$' + '{credential.password}';
describe('explicit credential values only', () => {
  it('never guesses secrets or PII from names, length, or shape', () => {
    const input = JSON.stringify({
      email: 'fixture@example.com',
      phone: '212-555-1234',
      AWS_SESSION_TOKEN: 'A'.repeat(160),
      password: 'server-value',
      authorization: 'Bearer token',
      cookie: 'session=value',
    });
    expect(redactFreeformText(input)).toEqual({ redacted: input, redactionsCount: 0 });
  });
  it('replaces only supplied credential values and preserves existing placeholders', () => {
    const input = `password=typed-pass&token=opaque ${placeholder}`;
    expect(redactFreeformText(input, new Map([['typed-pass', placeholder]])).redacted).toBe(
      `password=${placeholder}&token=opaque ${placeholder}`,
    );
  });
  it('preserves identifiers containing a shorter credential', () => {
    expect(
      redactFreeformText('username=alice&record=aliceairport', new Map([['alice', placeholder]]))
        .redacted,
    ).toBe(`username=${placeholder}&record=aliceairport`);
  });
  it('protects literal, URL-encoded, form-encoded, and JSON-escaped typed values', () => {
    const value = 'typed + pass"';
    const values = new Map([[value, placeholder]]);
    for (const encoded of [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
    ]) {
      expect(redactFreeformText(`value=${encoded}`, values).redacted).toBe(`value=${placeholder}`);
    }
  });
});
