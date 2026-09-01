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
  expect(prompt).toContain('API workflow | contract → replay → live');
  expect(prompt).toContain('Browser playbook fallback | contract → live; replay is `N/A`');
  expect(prompt).toContain('Run the contract check again after every artifact edit.');
  expect(prompt).toContain('execution rungs have higher priority');
  expect(prompt).toContain('only when you are 100% certain');
  expect(prompt).toContain('recordingRequestSeq` is mandatory for every API artifact request');
  expect(prompt).toContain(
    'Start request construction from the complete recorded request template',
  );
  expect(prompt).toContain('call `compare_rendered_requests`');
  expect(prompt).toContain('partial facts to distinguish the request that was actually sent');
  expect(prompt).toContain('`expectedBytes` is the recorded request baseline');
  expect(prompt).toContain('`actualBytes` is the');
  expect(prompt).toContain('request rendered by the current artifact');
});

test('the playbook compiler remains site-neutral and follows the accepted auth and fallback plans', () => {
  expect(playbookPrompt).toContain('Every compatible API rung has');
  expect(playbookPrompt).toContain('Follow the accepted authentication plan.');
  expect(playbookPrompt).not.toMatch(/google|southwest|hotels|flights/i);
});
