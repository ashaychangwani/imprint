import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { ContractTestSpec } from './contract-test-types.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import type { Session } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const log = createLog('contract-test');

export async function generateContractTestSpecs(opts: {
  candidate: ToolCandidate;
  session: Session;
  sharedContext?: SharedCompileContext;
  llmConfig?: LLMOptions;
  toolDir: string;
}): Promise<ContractTestSpec | null> {
  try {
    const { candidate, session, llmConfig, toolDir } = opts;
    log(`generating contract test specs for ${candidate.toolName}`);

    const payload = buildContractTestPayload(candidate, session);
    const promptPath = pathJoin(PROMPTS_DIR, 'contract-test-generation.md');
    if (!existsSync(promptPath)) {
      log(`contract test generation prompt not found at ${promptPath}, skipping`);
      return null;
    }

    const systemPrompt = readFileSync(promptPath, 'utf8');
    const provider = resolveProvider(llmConfig ?? {});
    const result = await provider.analyze(systemPrompt, JSON.stringify(payload));

    const objectText = extractJsonObject(result.text);
    if (!objectText) {
      log('contract test generator did not return a JSON object, skipping');
      return null;
    }

    let spec: ContractTestSpec;
    try {
      spec = JSON.parse(objectText);
    } catch (err) {
      log(
        `failed to parse contract test spec: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const testSpecDir = pathJoin(toolDir, '.test-specs');
    if (!existsSync(testSpecDir)) {
      mkdirSync(testSpecDir, { recursive: true });
    }

    const specPath = pathJoin(testSpecDir, 'contract-spec.json');
    writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
    log(`spec generated: ${spec.cases.length} test cases`);

    const testFile = renderContractTestFile(spec);
    const testFilePath = pathJoin(testSpecDir, 'contract-tests.ts');
    writeFileSync(testFilePath, testFile, 'utf8');
    log(`wrote test file: ${testFilePath}`);

    return spec;
  } catch (err) {
    log(`contract test generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildContractTestPayload(candidate: ToolCandidate, session: Session): unknown {
  const narration = session.narration.map((n) => n.text);

  const likelyParamsWithValues = candidate.likelyParams.map((param) => {
    const distinctValues = extractDistinctValues(param.name, candidate.requestSeqs, session);
    return {
      name: param.name,
      type: param.type,
      description: param.description,
      distinctValues,
    };
  });

  const responseSamples = candidate.requestSeqs
    .map((seq) => {
      const request = session.requests.find((r) => r.seq === seq);
      if (!request || !request.response) return null;
      return {
        seq,
        status: request.response.status,
        mimeType: request.response.mimeType,
        bodyPreview: request.response.body?.slice(0, 4096),
      };
    })
    .filter(Boolean);

  return {
    toolName: candidate.toolName,
    description: candidate.description,
    narration,
    likelyParams: likelyParamsWithValues,
    responseSamples,
  };
}

function extractDistinctValues(
  paramName: string,
  requestSeqs: number[],
  session: Session,
): unknown[] {
  const values = new Set<unknown>();
  const MAX_DISTINCT = 5;

  for (const seq of requestSeqs) {
    const request = session.requests.find((r) => r.seq === seq);
    if (!request || !request.body) continue;

    try {
      const parsed = JSON.parse(request.body);
      const found = findValueInObject(parsed, paramName);
      for (const value of found) {
        if (value != null) {
          values.add(value);
          if (values.size >= MAX_DISTINCT) break;
        }
      }
    } catch {
      continue;
    }

    if (values.size >= MAX_DISTINCT) break;
  }

  return Array.from(values);
}

function findValueInObject(obj: unknown, key: string): unknown[] {
  const results: unknown[] = [];

  if (obj == null || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findValueInObject(item, key));
    }
    return results;
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === key) {
      results.push(v);
    } else if (v != null && typeof v === 'object') {
      results.push(...findValueInObject(v, key));
    }
  }

  return results;
}

export function renderContractTestFile(spec: ContractTestSpec): string {
  const lines: string[] = [
    `import { expect, test } from 'bun:test';`,
    `import { dirname } from 'node:path';`,
    `import { fileURLToPath } from 'node:url';`,
    `import { runWorkflowWithLadder } from 'imprint/backend-ladder';`,
    `import { loadCredentialStore } from 'imprint/runtime';`,
    `import type { Workflow } from 'imprint/types';`,
    `import workflowJson from '../workflow.json' with { type: 'json' };`,
    '',
    'const WORKFLOW = workflowJson as unknown as Workflow;',
    'const __dirname = dirname(fileURLToPath(import.meta.url));',
    '',
    'function resolve(obj: unknown, path: string): unknown {',
    '  let current: unknown = obj;',
    `  for (const key of path.split('.')) {`,
    `    if (current == null || typeof current !== 'object') return undefined;`,
    '    current = (current as Record<string, unknown>)[key];',
    '  }',
    '  return current;',
    '}',
    '',
    'async function run(overrides: Record<string, string | number | boolean>) {',
    `  const params = { ...${JSON.stringify(spec.baseParams)}, ...overrides };`,
    '  const credentials = (await loadCredentialStore(WORKFLOW.site)) ?? undefined;',
    '  const { result } = await runWorkflowWithLadder({',
    `    workflowPath: __dirname + '/../workflow.json',`,
    '    params,',
    '    credentials,',
    '  });',
    '  expect(result.ok).toBe(true);',
    '  if (!result.ok) throw new Error(`Workflow failed: ${result.error}`);',
    '  return result.data;',
    '}',
    '',
  ];

  for (const testCase of spec.cases) {
    lines.push(`test('${escapeForSingleQuotedString(testCase.name)}', async () => {`);
    lines.push(`  const data = await run(${JSON.stringify(testCase.params)});`);

    for (const assertion of testCase.assertions) {
      lines.push('');
      lines.push(`  // ${assertion.rationale}`);
      lines.push(renderAssertion(assertion));
    }

    lines.push('}, { timeout: 45_000 });');
    lines.push('');
  }

  return lines.join('\n');
}

function escapeForSingleQuotedString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderAssertion(assertion: {
  path: string;
  check: string;
  expected?: unknown;
  rationale: string;
}): string {
  const resolveCall = `resolve(data, '${escapeForSingleQuotedString(assertion.path)}')`;

  switch (assertion.check) {
    case 'exists':
      return `  expect(${resolveCall}).toBeDefined();`;

    case 'type':
      if (assertion.expected === 'array') {
        return `  expect(Array.isArray(${resolveCall})).toBe(true);`;
      }
      return `  expect(typeof ${resolveCall}).toBe(${JSON.stringify(assertion.expected)});`;

    case 'contains':
      if (typeof assertion.expected === 'string') {
        return `  expect(String(${resolveCall})).toContain(${JSON.stringify(assertion.expected)});`;
      }
      return `  expect(${resolveCall}).toContain(${JSON.stringify(assertion.expected)});`;

    case 'equals':
      return `  expect(${resolveCall}).toBe(${JSON.stringify(assertion.expected)});`;

    case 'greater_than':
      return `  expect(Number(${resolveCall})).toBeGreaterThan(${JSON.stringify(assertion.expected)});`;

    case 'less_than':
      return `  expect(Number(${resolveCall})).toBeLessThan(${JSON.stringify(assertion.expected)});`;

    case 'array_not_empty':
      return `  expect((${resolveCall} as unknown[]).length).toBeGreaterThan(0);`;

    case 'matches_regex':
      return `  expect(String(${resolveCall})).toMatch(new RegExp(${JSON.stringify(assertion.expected)}));`;

    default:
      return `  // Unknown check: ${assertion.check}`;
  }
}
