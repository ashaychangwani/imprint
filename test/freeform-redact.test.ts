/**
 * Free-form redaction policy tests. Confirms the trimmed redactum policy set
 * still catches real PII / secrets but no longer fires the GENERIC_* catch-alls
 * on benign numeric/identifier data (the over-redaction that corrupted
 * doubly-encoded JSON payloads).
 */

import { describe, expect, it } from 'bun:test';
import { redactFreeformText } from '../src/imprint/freeform-redact.ts';

const syntheticJwt = (): string =>
  [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('.');

describe('redactFreeformText (trimmed policy set)', () => {
  it('still redacts core PII and specific secrets', () => {
    expect(redactFreeformText('email alice@example.com').redactionsCount).toBeGreaterThanOrEqual(1);
    expect(redactFreeformText('SSN 123-45-6789').redactionsCount).toBeGreaterThanOrEqual(1);
    expect(redactFreeformText('card 4111 1111 1111 1111').redactionsCount).toBeGreaterThanOrEqual(
      1,
    );
    expect(redactFreeformText(`token ${syntheticJwt()}`).redactionsCount).toBeGreaterThanOrEqual(1);
  });

  it('does not fire on benign key=value numeric identifiers', () => {
    // No secret keyword → never even enters the scan.
    const benign = 'id=1234567890 ref=9876543210 count=42 seq=230';
    const r = redactFreeformText(benign);
    expect(r.redactionsCount).toBe(0);
    expect(r.redacted).toBe(benign);
  });

  it('does not fire GENERIC_* on small keyword=value pairs after the trim', () => {
    // `secret`/`token`/`key` keywords pass the hint gate, but the dropped GENERIC_*
    // policies no longer match the tiny values, so nothing is redacted.
    const benign = 'secret=42 token=99 key=7';
    const r = redactFreeformText(benign);
    expect(r.redactionsCount).toBe(0);
    expect(r.redacted).toBe(benign);
  });

  it('leaves bare long numeric IDs (JSPB array) untouched', () => {
    // The exact shape that lives inside batchexecute payloads — must survive
    // intact so the inner JSON still parses.
    const ids = '[[1780090256964458,16330791,520982862]]';
    const r = redactFreeformText(ids);
    expect(r.redactionsCount).toBe(0);
    expect(r.redacted).toBe(ids);
  });
});
