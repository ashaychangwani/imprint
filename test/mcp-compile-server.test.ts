import { describe, expect, it } from 'bun:test';
import { COMPILE_SENTINELS } from '../src/imprint/mcp-compile-server.ts';

describe('compile MCP sentinels', () => {
  it('keeps factual completion and failure channels distinct', () => {
    expect(COMPILE_SENTINELS.done).toBe('.compile-done.json');
    expect(COMPILE_SENTINELS.giveUp).toBe('.compile-give-up.json');
  });
});
