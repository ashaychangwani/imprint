import { describe, expect, it } from 'bun:test';
import { resolve as pathResolve } from 'node:path';
import type { ResolvedTool } from '../src/imprint/tool-loader.ts';
import { selectGeneratedTool } from '../src/imprint/tool-selection.ts';

function fakeTool(site: string, toolName: string): ResolvedTool {
  return {
    site,
    dir: pathResolve('/tmp/imprint', site, toolName),
    workflow: {
      site,
      toolName,
      intent: { description: toolName },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/api', headers: {} }],
    },
    toolFn: async () => ({ ok: true, data: {} }),
  };
}

describe('selectGeneratedTool', () => {
  it('requires an explicit tool when a site has multiple generated tools', () => {
    const tools = [fakeTool('demo', 'search_items'), fakeTool('demo', 'list_orders')];

    expect(() => selectGeneratedTool({ site: 'demo', tools, purpose: 'cron' })).toThrow(
      /choose one for cron/,
    );
  });

  it('selects the tool implied by a config or output path', () => {
    const tools = [fakeTool('demo', 'search_items'), fakeTool('demo', 'list_orders')];

    const selected = selectGeneratedTool({
      site: 'demo',
      tools,
      purpose: 'probe',
      pathHint: pathResolve('/tmp/imprint/demo/list_orders/backends.json'),
      pathHintLabel: '--out',
    });

    expect(selected?.workflow.toolName).toBe('list_orders');
  });

  it('rejects conflicting path and tool selectors', () => {
    const tools = [fakeTool('demo', 'search_items'), fakeTool('demo', 'list_orders')];

    expect(() =>
      selectGeneratedTool({
        site: 'demo',
        tools,
        purpose: 'cron',
        toolName: 'search_items',
        pathHint: pathResolve('/tmp/imprint/demo/list_orders/cron.json'),
        pathHintLabel: '--config',
      }),
    ).toThrow(/belongs to "list_orders"/);
  });
});
