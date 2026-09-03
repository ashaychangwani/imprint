import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchApiMvpCall } from '../src/imprint/api-research-agent.ts';
import type { ApiResearchCandidate } from '../src/imprint/master-teach-agent-contracts.ts';
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
const binding = { runId: run.runId, recordingSha256, toolId: tool.id, compileInputsSha256 };

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

  it('returns a proposed blocker to the same researcher for self-review', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'imprint-api-research-block-review-'));
    const first = apiCandidate('failed');
    const second = apiCandidate('overlooked');
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
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
});
