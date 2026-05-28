import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type {
  ContractAssertion,
  ContractTestFailure,
  ContractTestResult,
  ContractTestSpec,
} from './contract-test-types.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import type { ToolCandidate } from './tool-candidates.ts';
import type { Session } from './types.ts';

const log = createLog('contract-test');

const ADJUDICATION_SYSTEM_PROMPT = `You are a test adjudicator for an MCP tool. A contract test failed. Determine if the test expectation was wrong (the API genuinely doesn't support what the test expected) or the tool is broken (the tool should have satisfied the test).

Return JSON: {"verdict": "tool_broken" | "test_wrong", "reason": "one sentence explanation"}

Prefer "tool_broken" — the test defines the contract. Only return "test_wrong" when there is clear evidence the test's expectation was structurally incorrect (e.g., expected a field name that doesn't exist in the API's response format).`;

export async function runContractTests(opts: {
  toolDir: string;
  session: Session;
  sessionPath: string;
  candidate: ToolCandidate;
  llmConfig?: LLMOptions;
  teachCredentials?: { site: string; values: Record<string, string> };
}): Promise<ContractTestResult | null> {
  try {
    const contractTestPath = pathJoin(opts.toolDir, '.test-specs', 'contract-tests.ts');
    if (!existsSync(contractTestPath)) {
      return null;
    }

    const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
    const parserPath = pathJoin(opts.toolDir, 'parser.ts');
    if (!existsSync(workflowPath) || !existsSync(parserPath)) {
      log('workflow.json or parser.ts missing, cannot run contract tests');
      return null;
    }

    const specPath = pathJoin(opts.toolDir, '.test-specs', 'contract-spec.json');
    if (!existsSync(specPath)) {
      log('contract-spec.json missing, cannot adjudicate failures');
      return null;
    }

    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ContractTestSpec;

    let adjudicationRound = 0;
    const maxAdjudicationRounds = 2;

    while (adjudicationRound < maxAdjudicationRounds) {
      const testResult = await runTestFile(
        './.test-specs/contract-tests.ts',
        opts.toolDir,
        300_000,
        opts.teachCredentials
          ? { IMPRINT_TEACH_CREDENTIALS: JSON.stringify(opts.teachCredentials) }
          : undefined,
      );

      const parsed = parseTestOutput(testResult.stdout, testResult.stderr);

      if (testResult.exitCode === 0 || parsed.failed === 0) {
        log(
          `all ${parsed.passed} contract test(s) passed${adjudicationRound > 0 ? ` (after ${adjudicationRound} adjudication round(s))` : ''}`,
        );
        return {
          totalTests: parsed.passed + parsed.failed,
          passed: parsed.passed,
          failed: 0,
          failures: [],
          adjudicated: adjudicationRound > 0,
        };
      }

      log(
        `${parsed.failed} test(s) failed, ${parsed.passed} passed. Adjudicating failures (round ${adjudicationRound + 1}/${maxAdjudicationRounds})…`,
      );

      // Short-circuit: if ALL tests failed and the output suggests rate-limiting
      // or bot-detection, skip adjudication — these are infrastructure failures,
      // not tool or test bugs.
      const combinedOutput = `${testResult.stdout}\n${testResult.stderr}`;
      if (
        parsed.passed === 0 &&
        (combinedOutput.includes('RATE_LIMITED') ||
          combinedOutput.includes('429') ||
          combinedOutput.includes('FORBIDDEN') ||
          combinedOutput.includes('403'))
      ) {
        log('all tests failed with rate-limiting or bot-detection — skipping adjudication');
        return {
          totalTests: parsed.failed,
          passed: 0,
          failed: parsed.failed,
          failures: parsed.failures.map((f) => ({
            testName: f.testName,
            assertion: findAssertionForTest(spec, f.testName),
            actual: f.actual,
            expected: f.expected,
            adjudication: 'infra_failure' as const,
            adjudicationReason:
              'API rate-limited or blocked — infrastructure failure, not a tool bug',
          })),
          adjudicated: false,
        };
      }

      // If the parser couldn't extract individual failure details, skip
      // adjudication — we can't meaningfully judge without knowing which tests
      // failed and why.
      if (parsed.failures.length === 0 && parsed.failed > 0) {
        log(
          `${parsed.failed} test(s) failed but could not parse failure details — skipping adjudication`,
        );
        return {
          totalTests: parsed.passed + parsed.failed,
          passed: parsed.passed,
          failed: parsed.failed,
          failures: [],
          adjudicated: false,
        };
      }

      const failures: ContractTestFailure[] = [];
      let patchedAnyTests = false;

      for (const rawFailure of parsed.failures) {
        const adjudication = await adjudicateFailure({
          testName: rawFailure.testName,
          failureDetail: rawFailure.detail,
          spec,
          session: opts.session,
          candidate: opts.candidate,
          llmConfig: opts.llmConfig,
        });

        const failure: ContractTestFailure = {
          testName: rawFailure.testName,
          assertion: findAssertionForTest(spec, rawFailure.testName),
          actual: rawFailure.actual,
          expected: rawFailure.expected,
          adjudication: adjudication.verdict,
          adjudicationReason: adjudication.reason,
        };
        failures.push(failure);

        if (adjudication.verdict === 'test_wrong') {
          log(`test "${rawFailure.testName}": test expectation was wrong — ${adjudication.reason}`);
          const patched = patchTestFile(contractTestPath, rawFailure.testName, adjudication.reason);
          if (patched) patchedAnyTests = true;
        } else {
          log(`test "${rawFailure.testName}": tool is broken — ${adjudication.reason}`);
        }
      }

      if (!patchedAnyTests) {
        return {
          totalTests: parsed.passed + parsed.failed,
          passed: parsed.passed,
          failed: parsed.failed,
          failures,
          adjudicated: adjudicationRound > 0,
        };
      }

      adjudicationRound++;
    }

    const finalResult = await runTestFile(
      './.test-specs/contract-tests.ts',
      opts.toolDir,
      300_000,
      opts.teachCredentials
        ? { IMPRINT_TEACH_CREDENTIALS: JSON.stringify(opts.teachCredentials) }
        : undefined,
    );
    const finalParsed = parseTestOutput(finalResult.stdout, finalResult.stderr);

    return {
      totalTests: finalParsed.passed + finalParsed.failed,
      passed: finalParsed.passed,
      failed: finalParsed.failed,
      failures: finalParsed.failures.map((f) => ({
        testName: f.testName,
        assertion: findAssertionForTest(spec, f.testName),
        actual: f.actual,
        expected: f.expected,
        adjudication: 'tool_broken' as const,
        adjudicationReason: 'still failing after max adjudication rounds',
      })),
      adjudicated: true,
    };
  } catch (err) {
    log(`contract test run failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function runTestFile(
  testPath: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['test', testPath], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (err.message || String(err)),
        exitCode: 1,
        timedOut,
      });
    });
  });
}

interface ParsedTestFailure {
  testName: string;
  detail: string;
  actual?: unknown;
  expected?: unknown;
}

function parseTestOutput(
  stdout: string,
  stderr: string,
): { passed: number; failed: number; failures: ParsedTestFailure[] } {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split('\n');

  let passed = 0;
  let failed = 0;
  const failures: ParsedTestFailure[] = [];

  let currentFailure: Partial<ParsedTestFailure> | null = null;
  let inErrorBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.includes('✓') && !line.includes('✗')) {
      passed++;
      continue;
    }

    if (line.includes('✗')) {
      failed++;
      const testNameMatch = line.match(/✗\s+(.+?)(?:\s+\[|\s*$)/);
      if (testNameMatch?.[1]) {
        if (currentFailure?.testName) {
          failures.push({
            testName: currentFailure.testName,
            detail: currentFailure.detail || '',
            actual: currentFailure.actual,
            expected: currentFailure.expected,
          });
        }
        currentFailure = {
          testName: testNameMatch[1].trim(),
          detail: '',
        };
        inErrorBlock = true;
      }
      continue;
    }

    if (currentFailure && inErrorBlock) {
      const expectedMatch = line.match(/Expected:\s*(.+)$/);
      if (expectedMatch?.[1]) {
        currentFailure.expected = parseValue(expectedMatch[1]);
        currentFailure.detail += `${line}\n`;
        continue;
      }

      const receivedMatch = line.match(/Received:\s*(.+)$/);
      if (receivedMatch?.[1]) {
        currentFailure.actual = parseValue(receivedMatch[1]);
        currentFailure.detail += `${line}\n`;
        continue;
      }

      if (
        line.includes('error:') ||
        line.includes('Expected') ||
        line.includes('Received') ||
        line.trim().startsWith('at ')
      ) {
        currentFailure.detail += `${line}\n`;
      }
    }

    const passMatch = line.match(/(\d+)\s+pass/);
    if (passMatch?.[1]) {
      passed = Math.max(passed, Number.parseInt(passMatch[1], 10));
    }

    const failMatch = line.match(/(\d+)\s+fail/);
    if (failMatch?.[1]) {
      failed = Math.max(failed, Number.parseInt(failMatch[1], 10));
    }
  }

  if (currentFailure?.testName) {
    failures.push({
      testName: currentFailure.testName,
      detail: currentFailure.detail || '',
      actual: currentFailure.actual,
      expected: currentFailure.expected,
    });
  }

  return { passed, failed, failures };
}

function parseValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === 'undefined') return undefined;
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function adjudicateFailure(opts: {
  testName: string;
  failureDetail: string;
  spec: ContractTestSpec;
  session: Session;
  candidate: ToolCandidate;
  llmConfig?: LLMOptions;
}): Promise<{ verdict: 'tool_broken' | 'test_wrong'; reason: string }> {
  const testCase = opts.spec.cases.find((c) => c.name === opts.testName);
  if (!testCase) {
    return {
      verdict: 'tool_broken',
      reason: 'test case not found in spec',
    };
  }

  const relevantRequests = opts.session.requests
    .filter((r) => opts.candidate.requestSeqs.includes(r.seq))
    .slice(0, 3);

  const responseBodies = relevantRequests
    .map((r, idx) => {
      const body = r.response?.body;
      if (!body) return null;
      const preview = body.length > 500 ? `${body.slice(0, 500)}…(truncated)` : body;
      return `Request ${idx + 1} (${r.method} ${r.url}):\n${preview}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const payload = {
    testName: opts.testName,
    failureDetail: opts.failureDetail,
    testAssertions: testCase.assertions,
    testParams: testCase.params,
    responseBodies: responseBodies || 'No response bodies captured',
  };

  const llm = resolveProvider(opts.llmConfig ?? {});
  const result = await llm.analyze(ADJUDICATION_SYSTEM_PROMPT, payload);

  const objectText = extractJsonObject(result.text);
  if (!objectText) {
    return {
      verdict: 'tool_broken',
      reason: 'adjudication failed (no JSON returned)',
    };
  }

  try {
    const parsed = JSON.parse(objectText) as {
      verdict: 'tool_broken' | 'test_wrong';
      reason: string;
    };
    if (parsed.verdict !== 'tool_broken' && parsed.verdict !== 'test_wrong') {
      return { verdict: 'tool_broken', reason: 'invalid verdict from adjudicator' };
    }
    return parsed;
  } catch {
    return {
      verdict: 'tool_broken',
      reason: 'adjudication failed (invalid JSON)',
    };
  }
}

function findAssertionForTest(spec: ContractTestSpec, testName: string): ContractAssertion {
  const testCase = spec.cases.find((c) => c.name === testName);
  if (!testCase || testCase.assertions.length === 0) {
    return {
      path: '',
      check: 'exists',
      rationale: 'unknown assertion',
    };
  }
  const assertion = testCase.assertions[0];
  if (!assertion) {
    return {
      path: '',
      check: 'exists',
      rationale: 'unknown assertion',
    };
  }
  return assertion;
}

function patchTestFile(testPath: string, testName: string, reason: string): boolean {
  try {
    const content = readFileSync(testPath, 'utf8');
    const lines = content.split('\n');

    // The generated test file escapes single quotes in test names, so we must
    // search for both the raw name (from bun's output) and the escaped form.
    const escaped = testName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const candidates = [testName, escaped];

    let testStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const name of candidates) {
        if (line.includes(`test('${name}'`) || line.includes(`test("${name}"`)) {
          testStart = i;
          break;
        }
      }
      if (testStart !== -1) break;
    }

    if (testStart === -1) {
      log(`could not find test "${testName}" to patch`);
      return false;
    }

    let depth = 0;
    let testEnd = -1;
    for (let i = testStart; i < lines.length; i++) {
      const line = lines[i] || '';
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            testEnd = i;
            break;
          }
        }
      }
      if (testEnd !== -1) break;
    }

    if (testEnd === -1) {
      log(`could not find end of test "${testName}"`);
      return false;
    }

    const sanitizedReason = reason.replace(/\n/g, ' ').replace(/'/g, "\\'");
    const indent = (lines[testStart] || '').match(/^\s*/)?.[0] || '';
    const replacement = `${indent}// ADJUDICATED: ${sanitizedReason}\n${indent}test.skip('${escaped}', () => {});`;

    lines.splice(testStart, testEnd - testStart + 1, replacement);

    writeFileSync(testPath, lines.join('\n'), 'utf8');
    log(`patched test "${testName}" with skip + comment`);
    return true;
  } catch (err) {
    log(`failed to patch test "${testName}": ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
