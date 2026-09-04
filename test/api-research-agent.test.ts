import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiResearchBlockedError, researchApiMvpCall } from '../src/imprint/api-research-agent.ts';
import {
  type ApiResearchCandidate,
  ApiResearchHandoffSchema,
} from '../src/imprint/master-teach-agent-contracts.ts';
import {
  apiResearchCandidateSha256,
  apiResearchInputsSha256,
  parseApiResearchOutput,
} from '../src/imprint/master-teach-agents.ts';
import { teachingPlanContentSha256 as digest } from '../src/imprint/master-teach-plan.ts';
import { PromptEvidenceProjectionSchema } from '../src/imprint/master-teach-prompt-projections.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';

const recordingSha256 = `sha256:${'1'.repeat(64)}`;
const evidencePayload = { entries: [] };
const evidence = PromptEvidenceProjectionSchema.parse({
  ref: { path: 'objects/evidence.json', sha256: digest(evidencePayload) },
  payload: evidencePayload,
});
const candidateTool = {
  toolName: 'search_fixture',
  description: 'Search a fixture API',
  rationale: 'Recorded request 12 returns the fixture results.',
  confidence: 0.99,
  requestSeqs: [12],
  representativeSeqs: [12],
  eventSeqs: [],
  expectedOutput: 'Fixture records',
  likelyParams: [{ name: 'query', type: 'string' as const, description: 'Search text' }],
  dependencySeqs: [],
  dependsOnTools: [],
};
const baseTool = {
  id: 'search_fixture',
  candidate: candidateTool,
  compileContext: {
    loginRequestSeqs: [],
    credentialNames: [],
    tokenExtractionNotes: '',
    sharedHelperNotes: '',
    authRequestSeqs: [],
    authNotes: '',
  },
  evidenceRefs: [evidence.ref],
  strategy: { kind: 'api' as const, reason: 'A recorded API request exists.' },
};
const compileInputsSha256 = apiResearchInputsSha256(baseTool);
const tool = baseTool;
const run = {
  runId: 'research-run',
  site: 'fixture.invalid',
  recordingSha256,
};
const recordingIndex = { recordingSha256, requestSeqs: [12], eventSeqs: [] };
const apiCandidate = (
  variant: string,
  testBackend?: ApiResearchCandidate['testBackend'],
): ApiResearchCandidate => ({
  workflow: {
    toolName: 'search_fixture',
    intent: { description: 'Search fixture records' },
    parameters: [{ name: 'query', type: 'string', description: 'Search text' }],
    requests: [
      {
        method: 'GET',
        url: `https://fixture.invalid/search?q=\${param.query}&variant=${variant}`,
        headers: {},
        recordingRequestSeq: 12,
      },
    ],
    site: 'fixture.invalid',
  },
  parameterValues: { query: 'alpha' },
  ...(testBackend ? { testBackend } : {}),
});
const binding = {
  runId: run.runId,
  recordingSha256,
  toolName: tool.candidate.toolName,
  compileInputsSha256,
};

describe('focused API research', () => {
  it('keeps request testing separate and hands only the proven request to compilation', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-'));
    const first = apiCandidate('diagnostic');
    const second = apiCandidate('working', 'cdp-replay');
    let agentTurn = 0;
    let execution = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) => {
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test baseline.' };
            if (agentTurn === 2) {
              expect(input.observations[0]?.result.preview).toContain('protocol error');
              return { binding, action: 'test', candidate: second, reason: 'Test repair.' };
            }
            const observed = input.observations[1];
            if (!observed) throw new Error('missing successful observation');
            return {
              binding,
              action: 'proven',
              candidate: second,
              basedOnObservationId: observed.id,
              reason: 'The response contains fixture records.',
            };
          },
          runApiTool: async ({ backend }) => {
            execution += 1;
            expect(backend).toBe(execution === 1 ? undefined : 'cdp-replay');
            return {
              executionMechanism: backend ?? 'fetch',
              result:
                execution === 1
                  ? { ok: true as const, data: 'protocol error: no records' }
                  : { ok: true as const, data: { items: [{ id: 'item-1' }] } },
            };
          },
        },
      });

      expect(agentTurn).toBe(3);
      expect(execution).toBe(2);
      expect(result.observation.candidateSha256).toBe(apiResearchCandidateSha256(second));
      expect(result.parameters).toEqual({ query: 'alpha' });
      expect(result.backend).toBe('cdp-replay');
      expect(JSON.parse(readFileSync(join(toolDir, 'workflow.json'), 'utf8'))).toEqual(
        second.workflow,
      );
      expect(existsSync(join(toolDir, 'parser.ts'))).toBe(false);
      expect(existsSync(join(toolDir, 'api-research.json'))).toBe(true);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('lets the retained researcher inspect another catalog request after a live test', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-inspect-'));
    const first = apiCandidate('needs-neighbor');
    const revised = apiCandidate('with-neighbor');
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/evidence-expanded.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    let turn = 0;
    let executions = 0;
    let inspected: readonly number[] = [];
    const retainedTurnDeltas: unknown[] = [];
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool,
        evidence,
        requestCatalog: [
          {
            recordingRequestSeq: 13,
            method: 'POST',
            urlShape: 'https://fixture.invalid/bootstrap',
            resourceType: 'fetch',
            responseStatus: 200,
            responseMimeType: 'application/json',
            requestBodyBytes: 24,
            responseBodyBytes: 48,
          },
        ],
        inspectRequests: (requestSeqs) => {
          inspected = requestSeqs;
          return { delta: expandedEvidence, accumulated: expandedEvidence };
        },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            turn += 1;
            if (turn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test the direct call.' };
            if (turn === 2) {
              expect(input.observations).toHaveLength(1);
              expect(input.requestCatalog?.[0]?.recordingRequestSeq).toBe(13);
              return {
                binding,
                action: 'inspect',
                requestedRequestSeqs: [13],
                reason: 'Inspect the neighboring bootstrap response before revising the call.',
              };
            }
            if (turn === 3) {
              expect(input.inspectedRequestSeqs).toEqual([13]);
              expect(input.evidence.ref.path).toBe(expandedEvidence.ref.path);
              return {
                binding,
                action: 'test',
                candidate: revised,
                reason: 'Test the request revised from the inspected bootstrap facts.',
              };
            }
            const observation = input.observations.at(-1);
            if (!observation) throw new Error('missing revised observation');
            return {
              binding,
              action: 'proven',
              candidate: revised,
              basedOnObservationId: observation.id,
              reason: 'The revised call returned the real records.',
            };
          },
          runApiTool: async () => {
            executions += 1;
            return {
              executionMechanism: 'fetch',
              result: {
                ok: true as const,
                data:
                  executions === 1 ? { bootstrap_required: true } : { items: [{ id: 'item-1' }] },
              },
            };
          },
        },
      });

      expect(inspected).toEqual([13]);
      expect(executions).toBe(2);
      expect(result.candidate).toEqual(revised);
      expect(
        retainedTurnDeltas.map((delta) =>
          delta === undefined ? undefined : (delta as { kind: string }).kind,
        ),
      ).toEqual([undefined, 'observation', 'inspection', 'observation']);
      expect(retainedTurnDeltas[1]).not.toHaveProperty('requestCatalog');
      expect(retainedTurnDeltas[1]).not.toHaveProperty('relevantEvidence');
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'inspection',
        inspectedRequestSeqs: [13],
        relevantEvidence: expandedEvidence,
      });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('sends each newly paged catalog and inspection exactly once', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-page-delta-'));
    const candidate = apiCandidate('paged-evidence');
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/paged-evidence.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    const firstCatalogEntry = {
      recordingRequestSeq: 12,
      method: 'GET',
      urlShape: 'https://fixture.invalid/search',
      resourceType: 'fetch',
      responseStatus: 200,
      responseMimeType: 'application/json',
      requestBodyBytes: 0,
      responseBodyBytes: 48,
    };
    const secondCatalogEntry = {
      ...firstCatalogEntry,
      recordingRequestSeq: 13,
      urlShape: 'https://fixture.invalid/bootstrap',
    };
    const retainedTurnDeltas: unknown[] = [];
    let turn = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool,
        evidence,
        requestCatalog: [firstCatalogEntry],
        requestCatalogPage: { offset: 0, totalEntries: 2, hasMore: true },
        loadNextRequestCatalogPage: (offset) => {
          expect(offset).toBe(1);
          return {
            entries: [secondCatalogEntry],
            page: { offset: 1, totalEntries: 2, hasMore: false },
          };
        },
        inspectRequests: (requestSeqs) => {
          expect(requestSeqs).toEqual([13]);
          return { delta: expandedEvidence, accumulated: expandedEvidence };
        },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (_input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            turn += 1;
            if (turn === 1)
              return { binding, action: 'catalog', reason: 'Read the next catalog page.' };
            if (turn === 2)
              return {
                binding,
                action: 'inspect',
                requestedRequestSeqs: [13],
                reason: 'Inspect the newly listed bootstrap request.',
              };
            if (turn === 3)
              return { binding, action: 'test', candidate, reason: 'Test the inspected request.' };
            const observation = _input.observations.at(-1);
            if (!observation) throw new Error('missing paged-evidence observation');
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: observation.id,
              reason: 'The inspected request returned fixture records.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
          }),
        },
      });

      expect(result.candidate).toEqual(candidate);
      expect(retainedTurnDeltas[0]).toBeUndefined();
      expect(retainedTurnDeltas[1]).toEqual({
        kind: 'catalog_page',
        requestCatalog: [secondCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 1, totalEntries: 2, hasMore: false },
      });
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'inspection',
        inspectedRequestSeqs: [13],
        relevantEvidence: expandedEvidence,
      });
      expect(retainedTurnDeltas[3]).toMatchObject({ kind: 'observation' });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('returns an exact repeated evidence inspection to master review', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-repeat-inspect-'));
    const expandedEvidence = PromptEvidenceProjectionSchema.parse({
      ref: { path: 'objects/repeated-inspection.json', sha256: digest(evidencePayload) },
      payload: evidencePayload,
    });
    let inspectCalls = 0;
    let blocked: ApiResearchBlockedError | undefined;
    try {
      try {
        await researchApiMvpCall({
          run,
          recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
          tool,
          evidence,
          requestCatalog: [
            {
              recordingRequestSeq: 13,
              method: 'POST',
              urlShape: 'https://fixture.invalid/bootstrap',
              resourceType: 'fetch',
              responseStatus: 200,
              responseMimeType: 'application/json',
              requestBodyBytes: 24,
              responseBodyBytes: 48,
            },
          ],
          inspectRequests: () => {
            inspectCalls += 1;
            return { delta: expandedEvidence, accumulated: expandedEvidence };
          },
          toolDir,
          agent: {},
          runDeadline: new RunDeadline(Date.now() + 60_000),
          dependencies: {
            requestStep: async () => ({
              binding,
              action: 'inspect',
              requestedRequestSeqs: [13],
              reason: 'Inspect the bootstrap request.',
            }),
            runApiTool: async () => {
              throw new Error('a repeated inspection must not execute a request');
            },
          },
        });
      } catch (error) {
        if (!(error instanceof ApiResearchBlockedError)) throw error;
        blocked = error;
      }
      expect(inspectCalls).toBe(1);
      expect(blocked?.message).toContain('already inspected');
      expect(blocked?.observations).toEqual([]);
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('returns bounded visible facts from a large rendered HTML response', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-html-'));
    const candidate = apiCandidate('rendered', 'cdp-replay');
    const request = candidate.workflow.requests[0];
    if (!request) throw new Error('missing rendered request fixture');
    candidate.workflow.requests[0] = {
      ...request,
      mode: 'navigate',
      navigation: { resultSelector: 'body' },
    };
    let agentTurn = 0;
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) => {
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate, reason: 'Test rendered result.' };
            const observation = input.observations[0];
            if (!observation) throw new Error('missing rendered observation');
            expect(Buffer.byteLength(observation.result.preview, 'utf8')).toBeLessThanOrEqual(
              12_000,
            );
            expect(observation.result.preview).toContain('[rendered HTML text]');
            expect(observation.result.preview).toContain('18 results Alaska Airlines $117');
            expect(observation.result.preview).not.toContain('opaque-script-noise');
            return {
              binding,
              action: 'proven',
              candidate,
              basedOnObservationId: observation.id,
              reason: 'The rendered page contains real result facts.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'cdp-replay',
            result: {
              ok: true as const,
              data: `<!doctype html><html><head><script>${'opaque-script-noise '.repeat(20_000)}</script></head><body><h1>18 results</h1><div>Alaska Airlines $117</div>${'é'.repeat(20_000)}</body></html>`,
            },
          }),
        },
      });

      expect(agentTurn).toBe(2);
      expect(result.backend).toBe('cdp-replay');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('rejects a proven handoff that differs from the cited tested bytes', () => {
    const tested = apiCandidate('tested');
    const changed = apiCandidate('changed');
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'proven',
          candidate: changed,
          basedOnObservationId: 'observation-1',
          reason: 'Claimed proven.',
        }),
        {
          run,
          recordingIndex,
          tool,
          evidence,
          observations: [
            {
              id: 'observation-1',
              candidateSha256: apiResearchCandidateSha256(tested),
              executionMechanism: 'fetch',
              backendAttempts: [],
              responseObservations: [],
              result: { ok: true, preview: '{"items":[{"id":"item-1"}]}' },
            },
          ],
        },
      ),
    ).toThrow('proven candidate differs from the tested request');
  });

  it('admits bounded inspection from any shown catalog page but rejects unknown requests', () => {
    const input = {
      run,
      recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
      tool,
      evidence,
      observations: [],
      requestCatalog: [
        {
          recordingRequestSeq: 13,
          method: 'GET',
          urlShape: 'https://fixture.invalid/neighbor',
          resourceType: 'fetch',
          responseStatus: 200,
          responseMimeType: 'application/json',
          requestBodyBytes: 0,
          responseBodyBytes: 48,
        },
      ],
      requestCatalogPage: { offset: 256, totalEntries: 300, hasMore: true },
    };
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'inspect',
          requestedRequestSeqs: [12],
          reason: 'Inspect a relevant request remembered from an earlier catalog page.',
        }),
        input,
      ).requestedRequestSeqs,
    ).toEqual([12]);
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'catalog',
          reason: 'Read the next compact catalog page.',
        }),
        input,
      ).action,
    ).toBe('catalog');
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'inspect',
          requestedRequestSeqs: [999],
          reason: 'Request evidence absent from this recording.',
        }),
        input,
      ),
    ).toThrow('request is absent from the recording');
  });

  it('keeps a working partial candidate and resumes it with a master follow-up', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-partial-'));
    const mvp = apiCandidate('mvp');
    const completed = apiCandidate('completed');
    const firstObservationId = 'working-mvp-observation';
    try {
      const partial = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input) =>
            input.observations.length === 0
              ? { binding, action: 'test', candidate: mvp, reason: 'Test the first MVP.' }
              : {
                  binding,
                  action: 'partial',
                  candidate: mvp,
                  basedOnObservationId: input.observations[0]?.id,
                  missingProof: ['Prove the public query controls the returned records.'],
                  reason: 'Core records work; alternate-query control is not proven yet.',
                },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-1' }] } },
          }),
        },
      });
      expect('status' in partial && partial.status).toBe('partial');
      if (!('status' in partial) || partial.status !== 'partial')
        throw new Error('fixture expected partial research');

      const previousProgress = {
        toolName: tool.candidate.toolName,
        researchInputsSha256: partial.researchInputsSha256,
        status: 'partial' as const,
        summary: partial.summary,
        candidate: partial.candidate,
        observation: { ...partial.observation, id: firstObservationId },
        missingProof: partial.missingProof,
      };
      const revisedTool = {
        ...tool,
        candidate: { ...tool.candidate, dependencySeqs: [13] },
      };
      const revisedCatalogEntry = {
        recordingRequestSeq: 13,
        method: 'GET',
        urlShape: 'https://fixture.invalid/bootstrap',
        resourceType: 'fetch',
        responseStatus: 200,
        responseMimeType: 'application/json',
        requestBodyBytes: 0,
        responseBodyBytes: 48,
      };
      let testedFollowUp = false;
      const followUpDeltas: unknown[] = [];
      const result = await researchApiMvpCall({
        run,
        recordingIndex: { ...recordingIndex, requestSeqs: [12, 13] },
        tool: revisedTool,
        evidence,
        followUp: {
          masterDirection: 'Test a different query and verify the returned record changes.',
          missingProof: partial.missingProof,
          relevantRequestSeqs: [12],
          siblingResearch: [],
        },
        previousProgress,
        requestCatalog: [revisedCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 0, totalEntries: 1, hasMore: false },
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            followUpDeltas.push(retainedTurnDelta);
            expect(input.researchPhase).toBe('follow_up');
            expect(input.followUp?.masterDirection).toContain('different query');
            expect(input.observations[0]?.id).toBe(firstObservationId);
            expect(input.previousProgress?.candidate).toEqual(mvp);
            expect(input.previousProgress?.observation?.id).toBe(firstObservationId);
            if (!testedFollowUp) {
              testedFollowUp = true;
              return {
                binding,
                action: 'test',
                candidate: completed,
                reason: 'Test the master-requested alternate query.',
              };
            }
            const observation = input.observations.at(-1);
            if (!observation) throw new Error('missing follow-up observation');
            return {
              binding,
              action: 'proven',
              candidate: completed,
              basedOnObservationId: observation.id,
              reason: 'The alternate query returned the corresponding records.',
            };
          },
          runApiTool: async () => ({
            executionMechanism: 'fetch',
            result: { ok: true as const, data: { items: [{ id: 'item-2' }] } },
          }),
        },
      });
      expect('status' in result).toBeFalse();
      expect(result.candidate).toEqual(completed);
      expect(followUpDeltas[0]).toMatchObject({
        kind: 'master_follow_up',
        followUp: {
          masterDirection: 'Test a different query and verify the returned record changes.',
        },
        currentTool: { candidate: { dependencySeqs: [13] } },
        requestCatalog: [revisedCatalogEntry],
        requestCatalogTruncated: false,
        requestCatalogPage: { offset: 0, totalEntries: 1, hasMore: false },
      });
      expect(followUpDeltas[0]).not.toHaveProperty('previousProgress');
      expect(followUpDeltas[1]).toMatchObject({ kind: 'observation' });
      expect(followUpDeltas[1]).not.toHaveProperty('requestCatalog');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('rejects partial research backed only by a failed transport observation', () => {
    const tested = apiCandidate('failed-partial');
    const failedObservation = {
      id: 'failed-observation',
      candidateSha256: apiResearchCandidateSha256(tested),
      executionMechanism: 'fetch',
      backendAttempts: [],
      responseObservations: [],
      result: { ok: false, error: 'REQUEST_FAILED', message: 'HTTP 500', preview: '' },
    };
    expect(() =>
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'partial',
          candidate: tested,
          basedOnObservationId: 'failed-observation',
          missingProof: ['The operation has not returned core records.'],
          reason: 'This request failed but is the best attempt so far.',
        }),
        {
          run,
          recordingIndex,
          tool,
          evidence,
          observations: [failedObservation],
        },
      ),
    ).toThrow('failed transport observation cannot support partial research');
    expect(() =>
      ApiResearchHandoffSchema.parse({
        toolName: tool.candidate.toolName,
        researchInputsSha256: compileInputsSha256,
        status: 'partial',
        summary: 'The failed call is the best current attempt.',
        candidate: tested,
        observation: failedObservation,
        missingProof: ['Core records are still missing.'],
      }),
    ).toThrow('partial API research must preserve a working candidate');
  });

  it('does not impose an arbitrary research-attempt limit before the run deadline', () => {
    const tested = apiCandidate('many-observations');
    const observations = Array.from({ length: 65 }, (_, index) => ({
      id: `observation-${index}`,
      candidateSha256: apiResearchCandidateSha256(tested),
      executionMechanism: 'fetch',
      backendAttempts: [],
      responseObservations: [],
      result: { ok: false, error: 'REQUEST_FAILED', message: `Attempt ${index}`, preview: '' },
    }));
    expect(
      parseApiResearchOutput(
        JSON.stringify({
          binding,
          action: 'blocked',
          reason: 'Every evidence-backed construction is exhausted at the shared deadline.',
        }),
        { run, recordingIndex, tool, evidence, observations },
      ).action,
    ).toBe('blocked');
  });

  it('returns a proposed blocker to the same researcher for self-review', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-block-review-'));
    const first = apiCandidate('failed');
    const second = apiCandidate('overlooked');
    let agentTurn = 0;
    let execution = 0;
    const retainedTurnDeltas: unknown[] = [];
    try {
      const result = await researchApiMvpCall({
        run,
        recordingIndex,
        tool,
        evidence,
        toolDir,
        agent: {},
        runDeadline: new RunDeadline(Date.now() + 60_000),
        dependencies: {
          requestStep: async (input, _agent, retainedTurnDelta) => {
            retainedTurnDeltas.push(retainedTurnDelta);
            agentTurn += 1;
            if (agentTurn === 1)
              return { binding, action: 'test', candidate: first, reason: 'Test baseline.' };
            if (agentTurn === 2)
              return { binding, action: 'blocked', reason: 'No request can work.' };
            if (agentTurn === 3) {
              expect(input.blockReview?.proposedReason).toBe('No request can work.');
              return {
                binding,
                action: 'test',
                candidate: second,
                reason: 'Self-review found an untested coherent candidate.',
              };
            }
            const observed = input.observations[1];
            if (!observed) throw new Error('missing self-review observation');
            return {
              binding,
              action: 'proven',
              candidate: second,
              basedOnObservationId: observed.id,
              reason: 'The overlooked candidate returned fixture records.',
            };
          },
          runApiTool: async () => {
            execution += 1;
            return {
              executionMechanism: 'fetch',
              result:
                execution === 1
                  ? { ok: true as const, data: 'protocol error: no records' }
                  : { ok: true as const, data: { items: [{ id: 'item-1' }] } },
            };
          },
        },
      });

      expect(agentTurn).toBe(4);
      expect(execution).toBe(2);
      expect(result.observation.candidateSha256).toBe(apiResearchCandidateSha256(second));
      expect(
        retainedTurnDeltas.map((delta) =>
          delta === undefined ? undefined : (delta as { kind: string }).kind,
        ),
      ).toEqual([undefined, 'observation', 'block_review', 'observation']);
      expect(retainedTurnDeltas[2]).toEqual({
        kind: 'block_review',
        blockReview: { proposedReason: 'No request can work.' },
      });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('preserves bounded structured failed attempts when research is factually blocked', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-blocked-facts-'));
    const failed = apiCandidate('failed-with-facts');
    let turn = 0;
    let blocked: ApiResearchBlockedError | undefined;
    try {
      try {
        await researchApiMvpCall({
          run,
          recordingIndex,
          tool,
          evidence,
          toolDir,
          agent: {},
          runDeadline: new RunDeadline(Date.now() + 60_000),
          dependencies: {
            requestStep: async (input) => {
              turn += 1;
              if (turn === 1) {
                return {
                  binding,
                  action: 'test',
                  candidate: failed,
                  reason: 'Test the recorded request before concluding anything.',
                };
              }
              if (turn === 2) {
                expect(input.observations[0]?.result.message).toBe('HTTP 403');
                return {
                  binding,
                  action: 'blocked',
                  reason: 'The recorded request is rejected and no distinct evidence remains.',
                };
              }
              expect(input.blockReview?.proposedReason).toContain('rejected');
              return {
                binding,
                action: 'blocked',
                reason: 'Self-review found no other evidence-backed request construction.',
              };
            },
            runApiTool: async () => ({
              executionMechanism: 'fetch',
              backendAttempts: [
                {
                  backend: 'fetch',
                  outcome: 'failed',
                  detail: 'HTTP 403',
                  durationMs: 7,
                },
              ],
              result: {
                ok: false as const,
                error: 'FORBIDDEN',
                message: 'HTTP 403',
              },
            }),
          },
        });
      } catch (error) {
        if (!(error instanceof ApiResearchBlockedError)) throw error;
        blocked = error;
      }

      expect(blocked).toBeDefined();
      expect(blocked?.observations).toHaveLength(1);
      expect(blocked?.observations[0]?.result).toEqual({
        ok: false,
        error: 'FORBIDDEN',
        message: 'HTTP 403',
        preview: '',
      });
      const handoff = ApiResearchHandoffSchema.parse({
        toolName: tool.candidate.toolName,
        researchInputsSha256: compileInputsSha256,
        status: 'blocked',
        summary: blocked?.message,
        observations: blocked?.observations,
      });
      expect(handoff.observations?.[0]?.backendAttempts[0]?.detail).toBe('HTTP 403');
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
});
