import { describe, expect, it } from 'bun:test';
import { buildJsonSchema } from '../src/imprint/mcp-server.ts';
import type { WorkflowParameter } from '../src/imprint/types.ts';

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
