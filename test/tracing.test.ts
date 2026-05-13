import { describe, expect, it } from 'bun:test';
import { traceBatchEnabled } from '../src/imprint/tracing.ts';

describe('traceBatchEnabled', () => {
  it('defaults to batched export when IMPRINT_TRACE_BATCH is unset', () => {
    expect(traceBatchEnabled(undefined)).toBe(true);
  });

  it('allows immediate export only when explicitly disabled', () => {
    expect(traceBatchEnabled('false')).toBe(false);
    expect(traceBatchEnabled('0')).toBe(false);
    expect(traceBatchEnabled('true')).toBe(true);
    expect(traceBatchEnabled('1')).toBe(true);
  });
});
