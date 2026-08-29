import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { buildCompileTools, externalVerification } from '../src/imprint/compile-tools.ts';
import type { Session } from '../src/imprint/types.ts';

const session: Session = {
  site: 'neutral-browser',
  startedAt: '2026-08-29T00:00:00.000Z',
  url: 'https://example.test/',
  imprintVersion: '0.6.6',
  requests: [],
  events: [],
  narration: [],
  cookieSnapshots: [],
  storageSnapshots: [],
};

const workflow = {
  toolName: 'open_results',
  intent: { description: 'Open the results page.' },
  parameters: [{ name: 'query', type: 'string', description: 'Text to search for.' }],
  requests: [],
  site: session.site,
};

const playbook = `toolName: open_results
summary: Open the results page.
parameters:
  - name: query
    type: string
    description: Text to search for.
steps:
  - action: navigate
    url: "https://example.test/search?q=\${query}"
    wait_for: networkidle
result:
  source: dom
  locators:
    - by: css
      value: "body"
  extract: text
  return_as: results
`;

function withToolDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-playbook-contract-'));
  writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow), 'utf8');
  writeFileSync(pathJoin(dir, 'playbook.yaml'), playbook, 'utf8');
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('accepted compile strategy file contract', () => {
  it('lets a fallback compiler write playbook files but not API files', async () => {
    await withToolDir(async (dir) => {
      const tools = buildCompileTools(session, dir, '/tmp/session.json', {
        strategyKind: 'playbook_fallback',
      });
      const write = tools.find(({ name }) => name === 'write_file');
      if (!write) throw new Error('write_file tool missing');

      const browser = await write.handler({ relativePath: 'playbook.yaml', content: playbook });
      const api = await write.handler({
        relativePath: 'parser.ts',
        content: 'export const extract = () => null;',
      });

      expect(browser.isError).not.toBe(true);
      expect(api.isError).toBe(true);
      expect(String(api.result)).toContain('not allowed');
    });
  });

  it('keeps the API compiler allowlist unchanged and rejects playbook files', async () => {
    await withToolDir(async (dir) => {
      const tools = buildCompileTools(session, dir, '/tmp/session.json', {
        strategyKind: 'api',
      });
      const write = tools.find(({ name }) => name === 'write_file');
      if (!write) throw new Error('write_file tool missing');

      const parser = await write.handler({
        relativePath: 'parser.ts',
        content: 'export const extract = () => null;',
      });
      const browser = await write.handler({ relativePath: 'playbook.yaml', content: playbook });

      expect(parser.isError).not.toBe(true);
      expect(browser.isError).toBe(true);
    });
  });

  it('accepts a schema-valid request-free browser pair without API artifacts', async () => {
    await withToolDir(async (dir) => {
      const result = await externalVerification(dir, session, '/tmp/session.json', {
        expectedToolName: workflow.toolName,
        strategyKind: 'playbook_fallback',
      });

      expect(result.failures).toEqual([]);
      expect(result.integrationEvidence).toEqual([]);
    });
  });

  it('reports focused browser profile mismatches', async () => {
    await withToolDir(async (dir) => {
      writeFileSync(
        pathJoin(dir, 'workflow.json'),
        JSON.stringify({
          ...workflow,
          requests: [{ method: 'GET', url: 'https://example.test/results', headers: {} }],
        }),
        'utf8',
      );
      writeFileSync(
        pathJoin(dir, 'playbook.yaml'),
        playbook
          .replace('toolName: open_results', 'toolName: wrong_tool')
          .replace('type: string', 'type: number'),
        'utf8',
      );
      writeFileSync(pathJoin(dir, 'parser.ts'), 'export const extract = () => null;', 'utf8');

      const result = await externalVerification(dir, session, '/tmp/session.json', {
        expectedToolName: workflow.toolName,
        strategyKind: 'playbook_fallback',
      });
      const failures = result.failures.join('\n');

      expect(failures).toContain('requires a request-free workflow.json');
      expect(failures).toContain('playbook.toolName "wrong_tool"');
      expect(failures).toContain('has type "number"');
      expect(failures).toContain('parser.ts is an API artifact');
    });
  });

  it('does not weaken the API artifact requirements', async () => {
    await withToolDir(async (dir) => {
      const result = await externalVerification(dir, session, '/tmp/session.json', {
        expectedToolName: workflow.toolName,
        strategyKind: 'api',
      });
      const failures = result.failures.join('\n');

      expect(failures).toContain('playbook.yaml does not match the accepted api strategy');
      expect(failures).toContain('parser.ts was not written');
      expect(failures).toContain('parser.test.ts was not written');
      expect(failures).toContain('integration.test.ts was not written');
    });
  });
});
