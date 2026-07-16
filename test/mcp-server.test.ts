import { describe, expect, it } from 'bun:test';
import {
  AuthContinuationStore,
  buildJsonSchema,
  buildToolDescription,
  runSerializedBySite,
  selectMcpTools,
} from '../src/imprint/mcp-server.ts';
import type { Workflow, WorkflowParameter } from '../src/imprint/types.ts';

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

  it('surfaces finite parameter choices as a JSON Schema enum', () => {
    const params: WorkflowParameter[] = [
      {
        name: 'action',
        type: 'string',
        description: 'Compiled action.',
        default: 'begin',
        choices: ['begin', 'finish'],
      },
    ];
    const schema = buildJsonSchema(params);
    const props = schema.properties as
      | Record<string, { enum?: Array<string | number | boolean> } | undefined>
      | undefined;
    expect(props?.action?.enum).toEqual(['begin', 'finish']);
    expect(schema.required).toBeUndefined();
  });

  it('advertises auth continuation as an opaque token', () => {
    const schema = buildJsonSchema([], {
      authConfig: {
        entry: 'begin',
        actions: {
          begin: {
            parameters: [],
            steps: [{ request: 0, onError: 'fail' }],
            outcome: { type: 'success', evidence: [] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });
    const props = schema.properties as Record<string, { type?: string } | undefined>;
    expect(props.continuation?.type).toBe('string');
  });
});

describe('selectMcpTools', () => {
  const tools = [
    { workflow: { toolName: 'search_items' } },
    { workflow: { toolName: 'authenticate_otp' } },
  ];

  it('preserves normal MCP exposure when no allowlist is supplied', () => {
    expect(selectMcpTools(tools).map((tool) => tool.workflow.toolName)).toEqual([
      'search_items',
      'authenticate_otp',
    ]);
  });

  it('exposes only exact eligible names for a bounded audit session', () => {
    expect(selectMcpTools(tools, ['search_items']).map((tool) => tool.workflow.toolName)).toEqual([
      'search_items',
    ]);
  });
});

describe('buildToolDescription', () => {
  it('surfaces agent-authored capability limitations and omitted inputs', () => {
    const workflow = {
      intent: { description: 'Search rental cars' },
      limitations: [
        {
          feature: 'Vehicle-class filter',
          reason: 'The recording did not contain a grounded request field for this filter.',
          omittedParameters: ['vehicle_class'],
        },
      ],
    } as Workflow;

    const description = buildToolDescription(workflow);
    expect(description).toContain('Known limitations:');
    expect(description).toContain('Vehicle-class filter');
    expect(description).toContain('The recording did not contain');
    expect(description).toContain('Omitted inputs: vehicle_class');
  });
});

describe('AuthContinuationStore', () => {
  it('returns state only once to the declared tool and next action', () => {
    const store = new AuthContinuationStore();
    const token = store.issue({
      toolName: 'authenticate_fixture',
      nextAction: 'finish',
      state: { ticket: 'private-ticket' },
    });

    expect(store.consume(token, 'authenticate_fixture', 'finish')).toEqual({
      ticket: 'private-ticket',
    });
    expect(store.consume(token, 'authenticate_fixture', 'finish')).toBeUndefined();
  });

  it('rejects forged tokens and consumes tokens used for the wrong action', () => {
    const store = new AuthContinuationStore();
    const token = store.issue({
      toolName: 'authenticate_fixture',
      nextAction: 'finish',
      state: { ticket: 'private-ticket' },
    });

    expect(store.consume('forged', 'authenticate_fixture', 'finish')).toBeUndefined();
    expect(store.consume(token, 'authenticate_fixture', 'other')).toBeUndefined();
    expect(store.consume(token, 'authenticate_fixture', 'finish')).toBeUndefined();
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
