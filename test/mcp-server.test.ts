import { describe, expect, it } from 'bun:test';
import { buildJsonSchema, runSerializedBySite } from '../src/imprint/mcp-server.ts';
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
});
