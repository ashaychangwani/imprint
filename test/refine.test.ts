import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRefinementContract,
  mergeRefinementVerificationPlan,
  promoteRefinement,
  refinementArtifactHash,
} from '../src/imprint/refine.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const workflow = () =>
  WorkflowSchema.parse({
    site: 'fixture',
    toolName: 'search',
    intent: { description: 'Search' },
    parameters: [{ name: 'query', type: 'string', description: 'Query', default: 'all' }],
    requests: [],
  });
describe('targeted refinement', () => {
  it('keeps prior regression cases and adds refinement cases to the strict audit', () => {
    const oldCase = { id: 'old', parameters: { query: 'recorded' } };
    const added = { id: 'extension', parameters: { query: 'recorded', limit: 2 } };
    const plan = mergeRefinementVerificationPlan(
      { recordingPath: '/original.json', cases: [oldCase], dependencies: [{ id: 'chain-1' }] },
      { recordingPath: '/additional.json', cases: [added], dependencies: [{ id: 'chain-2' }] },
    );
    expect(plan.cases).toEqual([{ recordingPath: '/original.json', ...oldCase }, added]);
    expect(plan.dependencies).toEqual([{ id: 'chain-1' }, { id: 'chain-2' }]);
    expect(oldCase).not.toHaveProperty('recordingPath');
    expect(() =>
      mergeRefinementVerificationPlan({ cases: [oldCase] }, { cases: [oldCase] }),
    ).toThrow('unique');
  });
  it('allows additive defaults and rejects deleted/retyped/new required parameters', () => {
    const before = workflow();
    const after = workflow();
    after.parameters.push({ name: 'limit', type: 'number', description: 'Limit', default: 10 });
    expect(() => assertRefinementContract(before, after)).not.toThrow();
    after.parameters[1] = { name: 'limit', type: 'number', description: 'Limit' };
    expect(() => assertRefinementContract(before, after)).toThrow('optional');
    after.parameters = [];
    expect(() => assertRefinementContract(before, after)).toThrow('query');
    after.parameters = [{ name: 'query', type: 'number', description: 'Query' }];
    expect(() => assertRefinementContract(before, after)).toThrow('query');
  });
  it('retains original artifacts and rolls back the entire replacement set on a promotion failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-refine-test-'));
    const siteDir = join(root, 'installed');
    const stagedSiteDir = join(root, 'staged');
    const originalHashes: Record<string, string> = {};
    for (const name of ['first', 'second']) {
      mkdirSync(join(siteDir, name), { recursive: true });
      writeFileSync(join(siteDir, name, 'parser.ts'), `original ${name}`);
      originalHashes[name] = refinementArtifactHash(join(siteDir, name));
    }
    mkdirSync(join(stagedSiteDir, 'first'), { recursive: true });
    writeFileSync(join(stagedSiteDir, 'first', 'parser.ts'), 'repaired');
    expect(() =>
      promoteRefinement({
        siteDir,
        stagedSiteDir,
        runRoot: root,
        runId: 'fixture',
        tools: ['first', 'second'],
        originalHashes,
      }),
    ).toThrow();
    for (const name of ['first', 'second'])
      expect(readFileSync(join(siteDir, name, 'parser.ts'), 'utf8')).toBe(`original ${name}`);
    expect(existsSync(join(root, 'failed-promotion', 'first', 'parser.ts'))).toBe(true);
  });
  it('refuses to replace a concurrently modified installed artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-refine-test-'));
    const siteDir = join(root, 'installed');
    mkdirSync(join(siteDir, 'search'), { recursive: true });
    writeFileSync(join(siteDir, 'search', 'parser.ts'), 'before');
    const originalHashes = { search: refinementArtifactHash(join(siteDir, 'search')) };
    writeFileSync(join(siteDir, 'search', 'parser.ts'), 'other change');
    expect(() =>
      promoteRefinement({
        siteDir,
        stagedSiteDir: join(root, 'staged'),
        runRoot: root,
        runId: 'fixture',
        tools: ['search'],
        originalHashes,
      }),
    ).toThrow('changed during refinement');
    expect(readFileSync(join(siteDir, 'search', 'parser.ts'), 'utf8')).toBe('other change');
  });
});
