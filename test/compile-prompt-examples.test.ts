import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import ts from 'typescript';
import { parsePlaybook } from '../src/imprint/playbook-parser.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const prompt = readFileSync(pathJoin(import.meta.dir, '..', 'prompts', 'compile-agent.md'), 'utf8');
const playbookPrompt = readFileSync(
  pathJoin(import.meta.dir, '..', 'prompts', 'playbook-compilation.md'),
  'utf8',
);
const apiResearchPrompt = readFileSync(
  pathJoin(import.meta.dir, '..', 'prompts', 'master-teach-api-researcher.md'),
  'utf8',
);

function canonicalExample(name: string, language: string): string {
  const marker = `<!-- canonical-example:${name} -->`;
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex < 0) throw new Error(`missing ${marker}`);
  const afterMarker = prompt.slice(markerIndex + marker.length);
  const match = new RegExp(`^\\s*\`\`\`${language}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``).exec(
    afterMarker,
  );
  if (!match?.[1]) throw new Error(`missing ${language} fence after ${marker}`);
  return match[1];
}

function exportedFunction(sourceText: string, fileName: string, name: string): boolean {
  const diagnostics =
    ts.transpileModule(sourceText, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
    }).diagnostics ?? [];
  expect(diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error)).toEqual(
    [],
  );
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  return source.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword),
  );
}

test('canonical API workflow parses with the production schema', () => {
  const workflow = WorkflowSchema.parse(JSON.parse(canonicalExample('api-workflow.json', 'json')));
  expect(workflow.site).toBe('example-catalog');
  expect(workflow.parameters.map(({ name }) => name)).toEqual(['query', 'limit']);
  expect(workflow.requests.map(({ recordingRequestSeq }) => recordingRequestSeq)).toEqual([41, 47]);
  expect(workflow.parserModule).toBe('./parser.ts');
  expect(workflow.requestTransformModule).toBe('./request-transform.ts');
});

test('canonical browser workflow and playbook parse with production schemas', () => {
  const workflow = WorkflowSchema.parse(
    JSON.parse(canonicalExample('browser-workflow.json', 'json')),
  );
  const playbook = parsePlaybook(canonicalExample('playbook.yaml', 'yaml'));
  expect(workflow.requests).toEqual([]);
  expect(playbook.toolName).toBe(workflow.toolName);
  expect(playbook.parameters).toEqual(workflow.parameters);
  expect(playbook.steps.length).toBeGreaterThan(1);
  expect(playbook.result.source).toBe('dom');
});

test('canonical TypeScript artifacts are syntactically valid named exports', () => {
  expect(
    exportedFunction(canonicalExample('parser.ts', 'typescript'), 'parser.ts', 'extract'),
  ).toBe(true);
  expect(
    exportedFunction(
      canonicalExample('request-transform.ts', 'typescript'),
      'request-transform.ts',
      'transform',
    ),
  ).toBe(true);
});

test('the pinned contract states applicability, edit invalidation, and playbook priority', () => {
  expect(prompt).toMatch(/API workflow\s+\| contract → live/);
  expect(prompt).toMatch(/Browser playbook fallback\s+\| contract → live/);
  expect(prompt).toContain('Run the contract check again after every artifact edit.');
  expect(prompt).toContain('execution rungs have higher priority');
  expect(prompt).toContain('only when you are 100% certain');
  expect(prompt).toContain('recordingRequestSeq` is mandatory for every API artifact request');
  expect(prompt).toContain(
    'Start request construction from the complete recorded request template',
  );
  expect(prompt).toContain('`compare_rendered_requests` is an on-demand diagnostic');
  expect(prompt).toContain('not a publication gate');
  expect(prompt).toContain('a later preparation error may leave the whole diagnostic');
  expect(prompt).toContain('semantically equivalent encodings can make exact bytes differ');
  expect(prompt).toContain('Exact recorded bytes are an on-demand diagnostic');
  expect(prompt).toContain('it does not require universal byte equality');
  expect(prompt).toContain('`toolPlan.revision.masterGuidance`');
  expect(prompt).toContain('`toolPlan.revision.priorAttempt`');
  expect(prompt).toContain('identifies the older source plan/build being revised');
  expect(prompt).toContain('It never contacts the site or runs `integration.test.ts`');
  expect(prompt).toContain(
    'A `render_failed` result means only that this diagnostic did not complete',
  );
  expect(prompt).toContain('`mode` chooses transport');
  expect(prompt).toContain('it cannot switch a fetch request into browser mode');
  expect(prompt).toContain('`capability` declares the minimum mechanism');
  expect(prompt).toContain('affects which existing runtime transports are eligible');
  expect(prompt).toMatch(/does\s+not infer the capture's meaning/);
  expect(prompt).toContain('rotating or dynamic data alone is not evidence');
  expect(prompt).toContain('`run_tests` never executes `integration.test.ts`');
  expect(prompt).toContain('the master runs the live call afterward');
  expect(prompt).not.toContain('When parser tests pass, call `done`');
  expect(prompt).not.toContain('Get parser tests passing first, then call `done`');
  expect(prompt).toContain('Write integration.test.ts with the accepted baseline case');
  expect(prompt).toMatch(
    /use\s+`search_requests` to find matching calls across the entire combined/i,
  );
  expect(prompt).toMatch(/Coherent does not\s+mean every field has the same lifetime/i);
  expect(prompt).toMatch(/One failed\s+generator shape does not disprove other shapes/i);
  expect(prompt).not.toContain('Do not expand beyond three without new evidence.');
});

test('the playbook compiler remains site-neutral and follows the accepted auth and fallback plans', () => {
  expect(playbookPrompt).toContain('Every compatible API rung has');
  expect(playbookPrompt).toContain('Follow the accepted authentication plan.');
  expect(playbookPrompt).not.toMatch(/google|southwest|hotels|flights/i);
});

test('API research stays separate, retained, site-neutral, and ahead of compilation', () => {
  expect(apiResearchPrompt).toContain('smallest credible live API call before the compiler');
  expect(apiResearchPrompt).toContain('same retained conversation');
  expect(apiResearchPrompt).toContain('`candidate.testBackend` controls only this research test');
  expect(apiResearchPrompt).toContain('Choosing a rung is your evidence-backed decision');
  expect(apiResearchPrompt).toContain('The parser-free workflow still has the complete API');
  expect(apiResearchPrompt).toContain('A top-level `bootstrap`');
  expect(apiResearchPrompt).toContain('`${state.NAME}`');
  expect(apiResearchPrompt).toContain('`${generated.epoch_ms}`');
  expect(apiResearchPrompt).toMatch(/does not change\s+the accepted `requests` count/);
  expect(apiResearchPrompt).toContain('export function transform(');
  expect(apiResearchPrompt).toContain('responses: unknown[]');
  expect(apiResearchPrompt).toContain('params: Params = {}');
  expect(apiResearchPrompt).toContain('It does not receive one wrapper object');
  expect(apiResearchPrompt).toContain('Do not look at the');
  expect(apiResearchPrompt).toContain('Do not choose or recommend playbook here.');
  expect(apiResearchPrompt).not.toMatch(/google|southwest|hotels|flights/i);
  expect(prompt).toContain('separate retained request specialist has already produced');
  expect(prompt).toContain('Preserve that request construction');
});
