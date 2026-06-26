import { describe, expect, it } from 'bun:test';
import type { BuildPlan } from '../src/imprint/build-plan.ts';
import { formatToolPlan } from '../src/imprint/compile-agent-types.ts';
import type { ToolCandidate } from '../src/imprint/tool-candidates.ts';
import { buildToolPlanPayload } from '../src/imprint/tool-plan.ts';
import type { Session } from '../src/imprint/types.ts';

describe('formatToolPlan', () => {
  it('returns empty string for undefined or blank input', () => {
    expect(formatToolPlan(undefined)).toBe('');
    expect(formatToolPlan('')).toBe('');
    expect(formatToolPlan('   \n  ')).toBe('');
  });

  it('wraps a non-empty plan with the IMPLEMENTATION PLAN header', () => {
    const out = formatToolPlan('### Parameters\n- origin → query `from` in seq 12');
    expect(out).toContain('IMPLEMENTATION PLAN');
    expect(out).toContain('### Parameters');
    expect(out).toContain('origin → query `from` in seq 12');
  });
});

describe('buildToolPlanPayload', () => {
  function session(): Session {
    return {
      site: 'demo',
      startedAt: '2026-05-04T00:00:00.000Z',
      url: 'https://example.com/start',
      imprintVersion: '0.1.0',
      requests: [
        {
          seq: 10,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/flights?from=SFO&to=JFK&sig=ABCDEF',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: '{"flights":[{"id":1}]}',
          },
        },
        {
          seq: 11,
          timestamp: 200,
          method: 'POST',
          url: 'https://example.com/api/token',
          headers: {},
          body: '{"client":"web"}',
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            mimeType: 'application/json',
            body: '{"token":"t-123"}',
          },
        },
        {
          seq: 99,
          timestamp: 300,
          method: 'GET',
          url: 'https://tracker.example.net/pixel',
          headers: {},
          resourceType: 'Image',
          response: { status: 200, headers: {}, mimeType: 'image/gif', body: '' },
        },
      ],
      events: [],
      narration: [{ seq: 1, timestamp: 50, text: 'searching flights' }],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
  }

  function candidate(): ToolCandidate {
    return {
      toolName: 'search_flights',
      description: 'search flights between two airports',
      rationale: 'x',
      confidence: 0.9,
      primary: true,
      requestSeqs: [10],
      representativeSeqs: [],
      eventSeqs: [],
      expectedOutput: 'list of flights',
      likelyParams: [{ name: 'origin', type: 'string', description: 'origin airport' }],
      dependencySeqs: [11],
    };
  }

  function buildPlan(): BuildPlan {
    return {
      sharedModules: [
        {
          path: '_shared/sign.ts',
          kind: 'request-transform',
          purpose: 'sign request URLs',
          exportSignatures: ['export function signUrl(url: string): string'],
          spec: 'reproduce the sig param',
          sourceSeqs: [10],
          dependsOn: [],
        },
      ],
      perTool: [
        {
          toolName: 'search_flights',
          usesSharedModules: ['_shared/sign.ts'],
          loadBearingSeqs: [10],
          parserGuidance: 'extract flights from response.flights[]',
          paramChecklist: ['origin', 'destination'],
          authRecipe: {
            required: false,
            loginRequestSeqs: [],
            credentialNames: [],
            captures: [],
            notes: '',
          },
          emitsTokens: [],
          tokenParams: [],
          requiredInputs: [],
        },
      ],
    };
  }

  it('scopes requests to the tool seqs (candidate ∪ dependency ∪ loadBearing) and drops noise', () => {
    const payload = buildToolPlanPayload({
      session: session(),
      candidate: candidate(),
      buildPlan: buildPlan(),
      sharedModules: [{ path: '_shared/sign.ts', kind: 'request-transform', verified: true }],
    });
    const seqs = payload.requests.flatMap((r) => [r.seq, ...(r.repeatedSeqs ?? [])]);
    expect(seqs).toContain(10); // candidate seq
    expect(seqs).toContain(11); // dependency seq
    expect(seqs).not.toContain(99); // tracker pixel out of scope
  });

  it('carries the tool param checklist + parser guidance from the build plan slice', () => {
    const payload = buildToolPlanPayload({
      session: session(),
      candidate: candidate(),
      buildPlan: buildPlan(),
      sharedModules: [{ path: '_shared/sign.ts', kind: 'request-transform', verified: true }],
    });
    expect(payload.planGuidance?.paramChecklist).toEqual(['origin', 'destination']);
    expect(payload.planGuidance?.parserGuidance).toContain('response.flights[]');
  });

  it('attaches verified assigned shared modules with their import paths', () => {
    const payload = buildToolPlanPayload({
      session: session(),
      candidate: candidate(),
      buildPlan: buildPlan(),
      sharedModules: [{ path: '_shared/sign.ts', kind: 'request-transform', verified: true }],
    });
    expect(payload.assignedModules.map((m) => m.importPath)).toEqual(['../_shared/sign.ts']);
  });

  it('omits unverified shared modules', () => {
    const payload = buildToolPlanPayload({
      session: session(),
      candidate: candidate(),
      buildPlan: buildPlan(),
      sharedModules: [{ path: '_shared/sign.ts', kind: 'request-transform', verified: false }],
    });
    expect(payload.assignedModules).toEqual([]);
  });

  it('works without a build plan (no shared modules, no guidance)', () => {
    const payload = buildToolPlanPayload({ session: session(), candidate: candidate() });
    expect(payload.planGuidance).toBeUndefined();
    expect(payload.assignedModules).toEqual([]);
    // Still scopes to candidate + dependency seqs.
    const seqs = payload.requests.flatMap((r) => [r.seq, ...(r.repeatedSeqs ?? [])]);
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).not.toContain(99);
  });

  it('echoes the tool identity into the payload', () => {
    const payload = buildToolPlanPayload({ session: session(), candidate: candidate() });
    expect(payload.tool.toolName).toBe('search_flights');
    expect(payload.tool.likelyParams.map((p) => p.name)).toEqual(['origin']);
  });
});
