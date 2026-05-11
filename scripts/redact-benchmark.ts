import { performance } from 'node:perf_hooks';
import { redactSession } from '../src/imprint/redact.ts';
import type { Session } from '../src/imprint/types.ts';

const REQUESTS = 400;
const ITERATIONS = 20;

const jwt = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
].join('.');

const session: Session = {
  site: 'benchmark',
  startedAt: '2026-05-10T00:00:00.000Z',
  url: 'https://example.com/',
  imprintVersion: '0.1.0',
  requests: Array.from({ length: REQUESTS }, (_, seq) => ({
    seq,
    timestamp: seq,
    method: seq % 4 === 0 ? 'POST' : 'GET',
    url:
      seq % 97 === 0
        ? `https://example.com/reset/${jwt}?color=blue`
        : `https://example.com/api/items/${seq}?color=blue`,
    headers:
      seq % 8 === 0
        ? { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
    body:
      seq % 131 === 0
        ? JSON.stringify({
            note: `Contact fixture-${seq}@example.com or 555-123-4567`,
            version: 'v1.2.3',
          })
        : undefined,
    resourceType: seq % 2 === 0 ? 'XHR' : 'Fetch',
    response: {
      status: 200,
      headers: {},
      mimeType: seq % 149 === 0 ? 'text/plain' : 'application/json',
      body:
        seq % 149 === 0
          ? `Support reply for fixture-${seq}@example.com. DATABASE_URL=postgres://user:pass@localhost:5432/app`
          : JSON.stringify({ ok: true, id: seq }),
    },
  })),
  events: [
    {
      seq: REQUESTS + 1,
      timestamp: REQUESTS + 1,
      type: 'ws-received',
      detail: JSON.stringify({ payloadDataPreview: 'socket email fixture@example.com' }),
    },
  ],
  narration: [],
  cookieSnapshots: [],
};

function measure(label: string, freeform: boolean): number {
  for (let i = 0; i < 5; i++) {
    redactSession(session, { freeform });
  }
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    redactSession(session, { freeform });
  }
  const duration = performance.now() - start;
  console.log(`${label}: ${duration.toFixed(1)}ms`);
  return duration;
}

const structuredOnly = measure('structured-only', false);
const hybrid = measure('hybrid', true);
const overhead = structuredOnly === 0 ? 0 : (hybrid - structuredOnly) / structuredOnly;

console.log(`overhead: ${(overhead * 100).toFixed(1)}% (target: <= 20% on typical sessions)`);
