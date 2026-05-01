/**
 * Sanity test — proves the toolchain works end-to-end.
 * Real coverage lands incrementally: see the test plan in docs/sprint.md.
 */

import { describe, expect, it } from 'bun:test';
import { SessionSchema, WorkflowSchema } from '../src/imprint/types.ts';

describe('schemas', () => {
  it('Session validates a minimal session', () => {
    const result = SessionSchema.safeParse({
      site: 'sanity',
      startedAt: '2026-04-30T00:00:00.000Z',
      url: 'https://example.com',
      imprintVersion: '0.1.0',
      requests: [],
      events: [],
      narration: [],
    });
    expect(result.success).toBe(true);
  });

  it('Workflow validates a minimal workflow', () => {
    const result = WorkflowSchema.safeParse({
      toolName: 'sanity_check',
      intent: { description: 'A sanity workflow' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com', headers: {} }],
      site: 'sanity',
    });
    expect(result.success).toBe(true);
  });

  it('Session rejects a malformed payload', () => {
    const result = SessionSchema.safeParse({ site: 'sanity' });
    expect(result.success).toBe(false);
  });
});
