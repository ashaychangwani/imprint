import { describe, expect, it } from 'bun:test';
import { renderContractTestFile } from '../src/imprint/contract-test-generator.ts';
import type { ContractTestSpec } from '../src/imprint/contract-test-types.ts';

describe('renderContractTestFile', () => {
  const baseSpec: ContractTestSpec = {
    toolName: 'search_flights',
    baseParams: { origin: 'SJC', destination: 'SAN', trip_type: 1 },
    cases: [],
    generatedFrom: {
      likelyParams: [{ name: 'origin', type: 'string', description: 'Origin airport' }],
      narration: ['searched for flights'],
    },
  };

  it('renders a valid test file with imports and helpers', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      cases: [
        {
          name: 'baseline search returns results',
          category: 'response_shape',
          params: {},
          assertions: [
            { path: 'flights', check: 'array_not_empty', rationale: 'should return flights' },
          ],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain("import { expect, test } from 'bun:test'");
    expect(file).toContain("import { runWorkflowWithLadder } from 'imprint/backend-ladder'");
    expect(file).toContain('function resolve(');
    expect(file).toContain('async function run(');
    expect(file).toContain("test('baseline search returns results'");
  });

  it('renders all assertion types', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      cases: [
        {
          name: 'all assertion types',
          category: 'response_shape',
          params: {},
          assertions: [
            { path: 'flights', check: 'exists', rationale: 'exists' },
            { path: 'flights', check: 'type', expected: 'array', rationale: 'is array' },
            { path: 'count', check: 'type', expected: 'number', rationale: 'is number' },
            { path: 'name', check: 'contains', expected: 'SJC', rationale: 'contains' },
            { path: 'code', check: 'equals', expected: 'OK', rationale: 'equals' },
            { path: 'price', check: 'greater_than', expected: 0, rationale: 'positive' },
            { path: 'discount', check: 'less_than', expected: 100, rationale: 'under 100' },
            { path: 'results', check: 'array_not_empty', rationale: 'not empty' },
            { path: 'date', check: 'matches_regex', expected: '\\d{4}-\\d{2}', rationale: 'date' },
          ],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain('.toBeDefined()');
    expect(file).toContain('Array.isArray');
    expect(file).toContain('typeof');
    expect(file).toContain('.toContain(');
    expect(file).toContain('.toBe(');
    expect(file).toContain('.toBeGreaterThan(0)');
    expect(file).toContain('.toBeLessThan(100)');
    expect(file).toContain('.toMatch(');
  });

  it('escapes single quotes in test names', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      cases: [
        {
          name: "it's a test with quotes",
          category: 'response_shape',
          params: {},
          assertions: [{ path: 'x', check: 'exists', rationale: 'check' }],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain("it\\'s a test");
  });

  it('injects baseParams into the run helper', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      baseParams: { origin: 'LAX', adults: 2 },
      cases: [
        {
          name: 'test',
          category: 'response_shape',
          params: { origin: 'SFO' },
          assertions: [{ path: 'x', check: 'exists', rationale: 'check' }],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain('"origin":"LAX"');
    expect(file).toContain('"adults":2');
    expect(file).toContain('"origin":"SFO"');
  });

  it('renders multiple test cases', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      cases: [
        {
          name: 'test one',
          category: 'response_shape',
          params: {},
          assertions: [{ path: 'a', check: 'exists', rationale: 'first' }],
        },
        {
          name: 'test two',
          category: 'parameter_validation',
          params: { origin: 'LAX' },
          assertions: [{ path: 'b', check: 'exists', rationale: 'second' }],
        },
        {
          name: 'test three',
          category: 'edge_case',
          params: { stops: 0 },
          assertions: [{ path: 'c', check: 'exists', rationale: 'third' }],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain("test('test one'");
    expect(file).toContain("test('test two'");
    expect(file).toContain("test('test three'");
  });

  it('sets 45s timeout on each test', () => {
    const spec: ContractTestSpec = {
      ...baseSpec,
      cases: [
        {
          name: 'timeout test',
          category: 'response_shape',
          params: {},
          assertions: [{ path: 'x', check: 'exists', rationale: 'check' }],
        },
      ],
    };
    const file = renderContractTestFile(spec);
    expect(file).toContain('timeout: 45_000');
  });

  it('handles empty cases array', () => {
    const spec: ContractTestSpec = { ...baseSpec, cases: [] };
    const file = renderContractTestFile(spec);
    expect(file).toContain('function resolve(');
    expect(file).not.toContain("test('");
  });
});
