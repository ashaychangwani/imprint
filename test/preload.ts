// Prevent test runs from emitting spans to a live Phoenix/OTel collector.
// Two layers of defense:
// 1. Delete env vars so isTracingEnabled() returns false in most code paths.
// 2. suppressTracingInit() prevents register() from installing a global OTEL
//    exporter, even if a tracing test temporarily sets IMPRINT_TRACE=1 and a
//    concurrent test thread calls traced() during that window. Without this,
//    Bun's shared process.env across test threads creates a race condition.
import { suppressTracingInit } from '../src/imprint/tracing.ts';

suppressTracingInit();

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
