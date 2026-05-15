// Prevent test runs from emitting spans to a live Phoenix/OTel collector.
// Without this, any test that exercises traced code paths (e.g. agent.test.ts
// calling runAgentLoop) will create orphan spans in whatever collector the
// developer's shell has configured.
for (const key of [
  'PHOENIX_COLLECTOR_ENDPOINT',
  'PHOENIX_HOST',
  'PHOENIX_API_KEY',
  'IMPRINT_TRACE',
  'IMPRINT_TRACING',
  'OPENINFERENCE_TRACE',
]) {
  delete process.env[key];
}
