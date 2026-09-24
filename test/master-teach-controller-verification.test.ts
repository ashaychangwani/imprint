import { expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRecordingMvp } from '../src/imprint/master-teach-controller.ts';
import { ProviderDeadlineError } from '../src/imprint/provider-retry.ts';

it('keeps a missing-fixture reviewer timeout as unverified evidence', async () => {
  const input = {
    tool: {
      candidate: {
        toolName: 'search_items',
        description: 'Search items',
        expectedOutput: 'Matching items',
      },
    },
    live: {
      verificationCaseId: 'live_recorded_request',
      rawResponses: ['{"items":[{"id":"fresh"}]}'],
      result: { ok: true, data: { items: [{ id: 'fresh' }] } },
      parameters: { query: 'example' },
    },
    implementation: {
      verificationCases: [
        {
          id: 'live_recorded_request',
          check: 'live',
          recordedCall: { requestSeqs: [1], freshnessChanges: 'none' },
          recordingFixtureUnavailable: true,
        },
      ],
    },
    session: {
      requests: [{ seq: 1, method: 'POST', url: 'https://example.test/search', body: '{}' }],
    },
    directory: mkdtempSync(join(tmpdir(), 'imprint-missing-fixture-timeout-')),
    agent: {
      provider: 'codex-cli',
      analyzer: {
        analyze: async () => {
          throw new ProviderDeadlineError(Date.now(), undefined, 'phase');
        },
      },
    },
  } as unknown as Parameters<typeof verifyRecordingMvp>[0];

  const review = await verifyRecordingMvp(input);
  expect(review.status).toBe('unverified');
  expect(review.reason).toContain('Provider call exceeded its deadline');
});
