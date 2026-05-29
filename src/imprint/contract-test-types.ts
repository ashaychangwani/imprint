/** Types for the contract-test framework that runs in parallel with the compile agent. */

export interface ContractTestSpec {
  toolName: string;
  baseParams: Record<string, string | number | boolean>;
  cases: ContractTestCase[];
  generatedFrom: {
    likelyParams: Array<{ name: string; type?: string; description?: string }>;
    narration: string[];
  };
}

export interface ContractTestCase {
  name: string;
  category:
    | 'parameter_validation'
    | 'response_shape'
    | 'edge_case'
    | 'parameter_combination'
    | 'semantic_correctness';
  params: Record<string, string | number | boolean>;
  assertions: ContractAssertion[];
}

export interface ContractAssertion {
  /** Dot-notation accessor into result.data (e.g. "items", "items.0.price"). */
  path: string;
  check:
    | 'exists'
    | 'type'
    | 'contains'
    | 'equals'
    | 'greater_than'
    | 'less_than'
    | 'array_not_empty'
    | 'matches_regex';
  expected?: unknown;
  rationale: string;
}

export interface ContractTestResult {
  totalTests: number;
  passed: number;
  failed: number;
  failures: ContractTestFailure[];
  adjudicated: boolean;
}

export interface ContractTestFailure {
  testName: string;
  assertion: ContractAssertion;
  actual: unknown;
  expected: unknown;
  adjudication?: 'tool_broken' | 'test_wrong' | 'infra_failure';
  adjudicationReason?: string;
}
