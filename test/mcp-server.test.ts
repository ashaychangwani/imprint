import { describe, expect, it } from 'bun:test';
import {
  applyExecutionFallbacks,
  buildJsonSchema,
  buildSiteSpacingMap,
  runSerializedBySite,
  shouldSkipBootstrapSplice,
  withPreferredFallbacks,
} from '../src/imprint/mcp-server.ts';
import type { WorkflowParameter } from '../src/imprint/types.ts';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushQueueStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('buildJsonSchema', () => {
  it('appends a producer-source hint to a sourcedFrom param description', () => {
    const params: WorkflowParameter[] = [
      {
        name: 'hotel_id',
        type: 'string',
        description: 'Identifier of the hotel.',
        sourcedFrom: { tool: 'search_hotels', field: 'hotel_id' },
      },
    ];
    const schema = buildJsonSchema(params);
    const props = schema.properties as Record<string, { description: string } | undefined>;
    const desc = props.hotel_id?.description ?? '';
    expect(desc).toContain('Identifier of the hotel.');
    expect(desc).toContain('`search_hotels`');
    expect(desc).toContain('`hotel_id`');
    expect(desc.toLowerCase()).toContain('reuse');
  });

  it('leaves a plain param description untouched and marks defaulted params optional', () => {
    const params: WorkflowParameter[] = [
      { name: 'query', type: 'string', description: 'Search text.' },
      { name: 'limit', type: 'number', description: 'Max results.', default: 10 },
    ];
    const schema = buildJsonSchema(params);
    const props = schema.properties as Record<string, { description: string } | undefined>;
    expect(props.query?.description).toBe('Search text.');
    // `query` has no default → required; `limit` has a default → optional.
    expect(schema.required).toEqual(['query']);
  });
});

describe('shouldSkipBootstrapSplice', () => {
  it('keeps the cdp-replay fallback when runtime learning starts at fetch-bootstrap', () => {
    expect(shouldSkipBootstrapSplice(['fetch-bootstrap'])).toBe(false);
    expect(shouldSkipBootstrapSplice(['fetch-bootstrap', 'stealth-fetch'])).toBe(false);
  });

  it('preserves exact preferred orders that do not need the bootstrap splice', () => {
    expect(shouldSkipBootstrapSplice(undefined)).toBe(false);
    expect(shouldSkipBootstrapSplice([])).toBe(false);
    expect(shouldSkipBootstrapSplice(['cdp-replay'])).toBe(true);
    expect(shouldSkipBootstrapSplice(['stealth-fetch'])).toBe(true);
  });
});

describe('withPreferredFallbacks', () => {
  it('adds browser-backed fallbacks behind a learned fetch-bootstrap preference', () => {
    expect(withPreferredFallbacks(['fetch-bootstrap'], ['fetch-bootstrap'])).toEqual([
      'fetch-bootstrap',
      'cdp-replay',
      'stealth-fetch',
    ]);
  });

  it('adds stealth-fetch behind a learned cdp-replay preference', () => {
    expect(withPreferredFallbacks(['cdp-replay'], ['cdp-replay'])).toEqual([
      'cdp-replay',
      'stealth-fetch',
    ]);
  });

  it('leaves other preferred ladders unchanged', () => {
    expect(withPreferredFallbacks(['stealth-fetch'], ['stealth-fetch'])).toEqual(['stealth-fetch']);
  });
});

describe('applyExecutionFallbacks', () => {
  it('drops playbook from multi-rung auto ladders when the workflow opts out', () => {
    expect(
      applyExecutionFallbacks(['fetch-bootstrap', 'cdp-replay', 'playbook'], {
        skipPlaybookFallback: true,
      }),
    ).toEqual(['fetch-bootstrap', 'cdp-replay']);
  });

  it('keeps explicit single-rung playbook ladders intact', () => {
    expect(applyExecutionFallbacks(['playbook'], { skipPlaybookFallback: true })).toEqual([
      'playbook',
    ]);
  });
});

describe('buildSiteSpacingMap', () => {
  it('uses the largest declared spacing across tools for the same site', () => {
    const spacing = buildSiteSpacingMap([
      { site: 'google-flights', workflow: { execution: { minCallSpacingMs: 2000 } } },
      { site: 'google-flights', workflow: {} },
      { site: 'southwest', workflow: { execution: { minCallSpacingMs: 500 } } },
    ]);
    expect(spacing.get('google-flights')).toBe(2000);
    expect(spacing.get('southwest')).toBe(500);
  });
});

describe('runSerializedBySite', () => {
  it('serializes concurrent work for the same site', async () => {
    const queues = new Map<string, Promise<void>>();
    const firstGate = deferred();
    const events: string[] = [];

    const first = runSerializedBySite(queues, 'google-flights', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = runSerializedBySite(queues, 'google-flights', async () => {
      events.push('second:start');
      return 'second';
    });

    await flushQueueStart();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queues.has('google-flights')).toBe(false);
  });

  it('does not block work for a different site', async () => {
    const queues = new Map<string, Promise<void>>();
    const firstGate = deferred();
    const events: string[] = [];

    const first = runSerializedBySite(queues, 'google-flights', async () => {
      events.push('google:start');
      await firstGate.promise;
      events.push('google:end');
      return 'google';
    });
    const second = runSerializedBySite(queues, 'southwest', async () => {
      events.push('southwest:start');
      return 'southwest';
    });

    await expect(second).resolves.toBe('southwest');
    expect(events).toEqual(['google:start', 'southwest:start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('google');
    expect(events).toEqual(['google:start', 'southwest:start', 'google:end']);
  });

  it('keeps the queue moving after a failed task', async () => {
    const queues = new Map<string, Promise<void>>();
    const events: string[] = [];

    const first = runSerializedBySite(queues, 'google-flights', async () => {
      events.push('first:start');
      throw new Error('boom');
    });
    const second = runSerializedBySite(queues, 'google-flights', async () => {
      events.push('second:start');
      return 'second';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'second:start']);
    expect(queues.has('google-flights')).toBe(false);
  });

  it('waits between same-site calls when a workflow declares MCP pacing', async () => {
    const queues = new Map<string, Promise<void>>();
    const lastFinishedAt = new Map<string, number>([['google-flights', 1_000]]);
    const sleeps: number[] = [];
    let now = 1_400;

    await expect(
      runSerializedBySite(
        queues,
        'google-flights',
        async () => {
          now = 4_000;
          return 'done';
        },
        {
          minCallSpacingMs: 2_000,
          lastFinishedAt,
          now: () => now,
          sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
          },
        },
      ),
    ).resolves.toBe('done');

    expect(sleeps).toEqual([1_600]);
    expect(lastFinishedAt.get('google-flights')).toBe(4_000);
  });
});
