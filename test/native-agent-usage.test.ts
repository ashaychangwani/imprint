import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeAgentUsage } from '../src/imprint/native-agent-usage.ts';

it('accounts for root, child and grandchild once, excluding unrelated and forked usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-usage-'));
  const start = '2026-01-01T00:01:00Z';
  const write = (id: string, parent: string | undefined, tokens: number | undefined) => {
    const lines = [
      {
        type: 'session_meta',
        payload: {
          id,
          instructions: 'fixture'.repeat(5_000),
          timestamp: start,
          source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli',
        },
      },
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999 } } },
      },
      ...(tokens === undefined
        ? []
        : [
            {
              timestamp: start,
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: {
                  total_token_usage: {
                    input_tokens: tokens,
                    cached_input_tokens: 2,
                    output_tokens: 3,
                  },
                },
              },
            },
          ]),
    ];
    writeFileSync(join(root, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'));
  };
  try {
    write('root', undefined, 10);
    write('child', 'root', 20);
    write('grandchild', 'child', 30);
    write('unfinished', 'root', undefined);
    write('unrelated', undefined, 900);
    const usage = await readNativeAgentUsage('root', [root]);
    expect(usage.rootFound).toBeTrue();
    expect(usage.threads).toHaveLength(4);
    expect(usage.threads.reduce((sum, thread) => sum + (thread.inputTokens ?? 0), 0)).toBe(60);
    expect(usage.threads.find(({ id }) => id === 'unfinished')?.measurement).toBe('missing');
    expect(
      usage.threads.every(({ cacheCreationInputTokens }) => cacheCreationInputTokens === null),
    ).toBeTrue();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('adds request usage across provider restarts and ignores repeated counter snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-usage-reset-'));
  const timestamp = '2026-01-01T00:00:00Z';
  const token = (total: number, last: number) => ({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: { input_tokens: last },
      },
    },
  });
  try {
    writeFileSync(
      join(root, 'root.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'root', timestamp, source: 'cli' } },
        token(10, 10),
        token(30, 20),
        token(30, 20),
        token(15, 15),
        token(40, 25),
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    const usage = await readNativeAgentUsage('root', [root]);
    expect(usage.threads[0]?.inputTokens).toBe(70);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
