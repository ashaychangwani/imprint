/**
 * Tests for the shared tool-discovery used by both `mcp-server` and `cron`.
 *
 * Builds a temporary examples/ tree on disk so we exercise the real
 * dynamic-import path. Each test gets its own tmpdir to keep import
 * caches from colliding.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { discoverTools, findToolFunction, toCamelCase } from '../src/imprint/tool-loader.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-discover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeExample(name: string, source: string): void {
  const dir = pathResolve(root, name, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathResolve(dir, 'index.ts'), source, 'utf8');
}

const goodSource = `
export const WORKFLOW = {
  toolName: 'do_thing',
  intent: { description: 'do a thing' },
  parameters: [],
  requests: [],
  site: 'good',
};
export async function doThing() {
  return { ok: true, data: { fine: true } };
}
`;

describe('toCamelCase', () => {
  it.each([
    ['book_discoverandgo_museum_pass', 'bookDiscoverandgoMuseumPass'],
    ['echo', 'echo'],
    ['DO_THING', 'doThing'],
  ])('%s → %s', (input, expected) => {
    expect(toCamelCase(input)).toBe(expected);
  });
});

describe('findToolFunction', () => {
  it('returns the function exported under the camelCase form of toolName', () => {
    const fn = async () => ({ ok: true as const, data: null });
    const mod = { WORKFLOW: { toolName: 'echo_test' } as never, echoTest: fn };
    expect(findToolFunction(mod)).toBe(fn);
  });

  it('returns null when the function is missing', () => {
    const mod = { WORKFLOW: { toolName: 'missing_fn' } as never };
    expect(findToolFunction(mod)).toBeNull();
  });

  it('returns null when the export is not callable', () => {
    const mod = { WORKFLOW: { toolName: 'not_a_fn' } as never, notAFn: 'oops' };
    expect(findToolFunction(mod)).toBeNull();
  });
});

describe('discoverTools', () => {
  it('returns [] when the examples dir does not exist', async () => {
    const out = await discoverTools(pathResolve(root, 'does-not-exist'));
    expect(out).toEqual([]);
  });

  it('returns [] when the examples dir is empty', async () => {
    const out = await discoverTools(root);
    expect(out).toEqual([]);
  });

  it('discovers a valid example and exposes its workflow + function', async () => {
    writeExample('good', goodSource);
    const out = await discoverTools(root);
    expect(out).toHaveLength(1);
    const tool = out[0];
    if (!tool) throw new Error('expected one tool');
    expect(tool.site).toBe('good');
    expect(tool.dir).toBe(pathResolve(root, 'good', 'good'));
    expect(tool.workflow.toolName).toBe('do_thing');
    expect(typeof tool.toolFn).toBe('function');
  });

  it('skips directories without an index.ts', async () => {
    mkdirSync(pathResolve(root, 'no-index', 'missing-tool'), { recursive: true });
    writeExample('good', goodSource);
    const out = await discoverTools(root);
    expect(out.map((t) => t.site)).toEqual(['good']);
  });

  it('skips entries whose module is missing the WORKFLOW export', async () => {
    writeExample(
      'no-workflow',
      'export async function whatever() { return { ok: true, data: 0 }; }',
    );
    writeExample('good', goodSource);
    const out = await discoverTools(root);
    expect(out.map((t) => t.site)).toEqual(['good']);
  });

  it('skips entries whose tool function is missing', async () => {
    writeExample(
      'no-fn',
      `export const WORKFLOW = { toolName: 'do_thing', intent: {description:''}, parameters: [], requests: [], site: 'no-fn' };`,
    );
    writeExample('good', goodSource);
    const out = await discoverTools(root);
    expect(out.map((t) => t.site)).toEqual(['good']);
  });

  it('honors the `only` filter', async () => {
    writeExample(
      'alpha',
      goodSource
        .replace("toolName: 'do_thing'", "toolName: 'alpha_thing'")
        .replace('doThing', 'alphaThing')
        .replace("site: 'good'", "site: 'alpha'"),
    );
    writeExample(
      'beta',
      goodSource
        .replace("toolName: 'do_thing'", "toolName: 'beta_thing'")
        .replace('doThing', 'betaThing')
        .replace("site: 'good'", "site: 'beta'"),
    );
    const out = await discoverTools(root, 'beta');
    expect(out).toHaveLength(1);
    const tool = out[0];
    if (!tool) throw new Error('expected one tool');
    expect(tool.site).toBe('beta');
  });

  it('repairs stale wrappers that import an old repo runtime path', async () => {
    const dir = pathResolve(root, 'stale', 'stale_tool');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pathResolve(dir, 'workflow.json'),
      JSON.stringify(
        {
          toolName: 'stale_tool',
          intent: { description: 'repair stale wrapper' },
          parameters: [],
          requests: [],
          site: 'stale',
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      pathResolve(dir, 'index.ts'),
      `
import { executeWorkflow } from '../../../deleted-workspace/src/imprint/runtime.ts';
export const WORKFLOW = { toolName: 'stale_tool', intent: { description: '' }, parameters: [], requests: [], site: 'stale' };
export async function staleTool() {
  return executeWorkflow({ workflow: WORKFLOW, params: {} });
}
`,
      'utf8',
    );

    const out = await discoverTools(root);

    expect(out.map((tool) => tool.workflow.toolName)).toEqual(['stale_tool']);
    expect(readFileSync(pathResolve(dir, 'index.ts'), 'utf8')).toContain("'imprint/runtime'");
  });

  it('does not repair hand-written fixtures with type-only legacy imports', async () => {
    const dir = pathResolve(root, 'echo', 'echo_test');
    mkdirSync(dir, { recursive: true });
    const indexPath = pathResolve(dir, 'index.ts');
    writeFileSync(
      indexPath,
      `
import type { Workflow } from '../../../deleted-workspace/src/imprint/types.ts';

export const WORKFLOW: Workflow = {
  toolName: 'echo_test',
  intent: { description: 'echo' },
  parameters: [],
  requests: [],
  site: 'echo',
};

export async function echoTest() {
  return { ok: true, data: {} };
}
`,
      'utf8',
    );
    const stderrWrite = process.stderr.write;
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const out = await discoverTools(root);
      expect(out.map((tool) => tool.workflow.toolName)).toEqual(['echo_test']);
    } finally {
      process.stderr.write = stderrWrite;
    }
    expect(stderr.join('')).not.toContain('could not repair stale generated wrapper');
    expect(readFileSync(indexPath, 'utf8')).toContain('deleted-workspace/src/imprint/types.ts');
  });
});
