/** Provider-neutral execution tool contract. */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  handler: (
    input: unknown,
    request?: { signal?: AbortSignal },
  ) => Promise<{ result: string; isError?: boolean }>;
}
