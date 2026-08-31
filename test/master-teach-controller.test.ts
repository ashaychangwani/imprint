import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { triageRequests } from '../src/imprint/compile.ts';
import {
  apiReplayFacts,
  compatibleFocusedPlannerIndexes,
  compileEveryToolInBuildWaves,
  focusedPlanningFailureMessage,
  implementationPlanRepairToolIds,
  prepareFullSessionForTeach,
  prepareSessionForTeach,
  promoteReviewedCompletion,
  providerForFreshTeach,
  revisionStagingDir,
  runFocusedWaveOrchestration,
  runPlaybookInvocationWithDeadline,
  terminalStatusForError,
} from '../src/imprint/master-teach-controller.ts';
import {
  type EditableTeachingPlan,
  type EditableTeachingTool,
  type ImplementationPlanPayload,
  teachingToolCompileInputsSha256,
} from '../src/imprint/master-teach-plan.ts';
import { ProviderUnavailableError, RunDeadline } from '../src/imprint/provider-retry.ts';
import type { Session, Workflow } from '../src/imprint/types.ts';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('fresh teach provider selection', () => {
  it('uses Codex end to end when --agent codex is explicit', () => {
    expect(providerForFreshTeach({ agent: 'codex' })).toBe('codex-cli');
  });

  it('lets an explicit provider override --agent codex', () => {
    expect(providerForFreshTeach({ agent: 'codex', provider: 'anthropic-api' })).toBe(
      'anthropic-api',
    );
  });
});

function replaySession(request: Session['requests'][number]): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://fixture.invalid',
    imprintVersion: '0.6.6',
    requests: [request],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function replayImplementation(
  parameterValueOrigin: 'recorded_baseline' | 'synthetic_live' | 'unavailable' | undefined,
  parameterValues: ImplementationPlanPayload['verificationCases'][number]['parameterValues'],
): ImplementationPlanPayload {
  return {
    version: 1,
    toolId: 'fixture-tool',
    strategyKind: 'api',
    requestProvenance: [{ artifactRequestIndex: 0, recordingRequestSeq: 7 }],
    parameterMappings: parameterValues.map(({ parameterName }) => ({
      parameterName,
      artifactRequestIndices: [0],
      guidance: 'Use the public value in the request.',
    })),
    responseDependencies: [],
    resultSources: [{ artifactRequestIndex: 0, source: 'Return the response.' }],
    outputGuidance: 'Return the fixture response.',
    verificationCases: [
      {
        id: 'recorded_replay',
        check: 'replay',
        ...(parameterValueOrigin === undefined ? {} : { parameterValueOrigin }),
        parameterValues,
        expectedResult: 'Return the recorded fixture response.',
        provenance: {
          recordingRequestSeqs: [7],
          recordingEventSeqs: [],
          evidenceRefs: [{ path: 'evidence/replay.json', sha256: SHA }],
        },
      },
      {
        id: 'live_fixture',
        check: 'live',
        parameterValueOrigin: 'synthetic_live',
        parameterValues,
        expectedResult: 'Return the live fixture response.',
        provenance: {
          recordingRequestSeqs: [7],
          recordingEventSeqs: [],
          evidenceRefs: [{ path: 'evidence/replay.json', sha256: SHA }],
        },
      },
    ],
  };
}

function focusedTool(index: number, dependencyNames: string[] = []): EditableTeachingTool {
  const toolName = `tool_${index}`;
  return {
    id: toolName,
    candidate: {
      toolName,
      description: `Focused tool ${index}`,
      rationale: `Recording evidence for focused tool ${index}`,
      confidence: 1,
      requestSeqs: [index],
      representativeSeqs: [index],
      eventSeqs: [],
      expectedOutput: `Result ${index}`,
      likelyParams: [],
      dependencySeqs: [],
      dependsOnTools: dependencyNames,
    },
    compileContext: {
      loginRequestSeqs: [],
      credentialNames: [],
      tokenExtractionNotes: '',
      sharedHelperNotes: '',
      authRequestSeqs: [],
      authNotes: '',
    },
    evidenceRefs: [{ path: `evidence/tool-${index}.json`, sha256: SHA }],
  };
}

describe('master-owned focused build waves', () => {
  it('bounds an injected playbook invocation that ignores cancellation', async () => {
    let childSignal: AbortSignal | undefined;
    const startedAt = Date.now();
    let failure: unknown;

    try {
      await runPlaybookInvocationWithDeadline(
        {
          timeoutMs: 20,
          cleanupGraceMs: 15,
          label: 'fixture chain check',
        },
        async (signal) => {
          childSignal = signal;
          return await new Promise<never>(() => {});
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(childSignal?.aborted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('TimeoutError');
    expect((failure as Error).message).toContain('fixture chain check');
  });

  it('does not accept a playbook result that arrives after its deadline', async () => {
    let returned: string | undefined;
    let failure: unknown;
    try {
      returned = await runPlaybookInvocationWithDeadline(
        {
          timeoutMs: 10,
          cleanupGraceMs: 35,
          label: 'late fixture check',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 'late success';
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(returned).toBeUndefined();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('TimeoutError');
    expect((failure as Error).message).toContain('late fixture check');
  });

  it('mechanically keeps every request in the authoritative teaching scope', () => {
    const session = {
      site: 'fixture-site',
      startedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://fixture.invalid',
      imprintVersion: '0.6.6',
      requests: [{ seq: 3 }, { seq: 8 }, { seq: 13 }],
      events: [
        { seq: 21, type: 'ws-sent' },
        { seq: 22, type: 'click' },
      ],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    } as unknown as Session;

    const prepared = prepareFullSessionForTeach(session);
    expect(prepared.session).toBe(session);
    expect(prepared.selectedSeqs).toEqual([3, 8, 13]);
    expect(prepared.replaySafeSeqs).toEqual([3, 8, 13]);
    expect(prepared.irreversibleSeqs).toEqual([]);
    expect(prepared.coveredOutboundEventSeqs).toEqual([21]);
  });

  it('reuses semantic triage with credential and auth-adjacent requests preserved', async () => {
    const session: Session = {
      site: 'fixture-site',
      startedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://fixture.invalid',
      imprintVersion: '0.6.6',
      requests: [
        {
          seq: 3,
          timestamp: 100,
          method: 'POST',
          url: 'https://fixture.invalid/login',
          headers: {},
          body: '{"username":"${credential.username}"}',
          resourceType: 'Fetch',
        },
        {
          seq: 8,
          timestamp: 150,
          method: 'POST',
          url: 'https://fixture.invalid/mfa/challenge',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 13,
          timestamp: 300,
          method: 'GET',
          url: 'https://fixture.invalid/api/items',
          headers: {},
          resourceType: 'XHR',
        },
      ],
      events: [],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const selectedSession: Session = { ...session, requests: session.requests.slice(2) };
    const triageResult = {
      session: selectedSession,
      selectedSeqs: [13],
      replaySafeSeqs: [3, 8, 13],
      irreversibleSeqs: [],
      coveredOutboundEventSeqs: [],
      irreversibleEventSeqs: [],
      consideredCount: 3,
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 20,
    };
    const llmConfig = { provider: 'codex-cli' as const, model: 'fixture-model' };
    const signal = new AbortController().signal;
    const runDeadline = new RunDeadline(Date.now() + 60_000);
    let triageCalled = false;

    const prepared = await prepareSessionForTeach(
      session,
      llmConfig,
      { signal, deadlineMs: runDeadline.deadlineMs, runDeadline },
      async (triageSession, config, context, options) => {
        triageCalled = true;
        expect(triageSession).toBe(session);
        expect(config).toBe(llmConfig);
        if (!context) throw new Error('Expected semantic triage context');
        expect(context.sharedContext).toEqual({
          loginRequestSeqs: [3],
          credentialNames: [],
          tokenExtractionNotes: '',
          sharedHelperNotes: '',
          authRequestSeqs: [3, 8],
          authNotes: '',
        });
        expect(context.signal).toBe(signal);
        expect(context.deadlineMs).toBe(runDeadline.deadlineMs);
        expect(context.runDeadline).toBe(runDeadline);
        expect(options).toEqual({ effectClassification: 'skip' });
        return triageResult;
      },
    );

    expect(prepared).toBe(triageResult);
    expect(triageCalled).toBe(true);
  });

  it('runs only shipped relevance selection for master candidate preparation', async () => {
    const session: Session = {
      site: 'fixture-site',
      startedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://fixture.invalid',
      imprintVersion: '0.6.6',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://fixture.invalid/api/items',
          headers: {},
          resourceType: 'XHR',
        },
      ],
      events: [
        {
          seq: 2,
          timestamp: 150,
          type: 'ws-sent',
          detail: '{"fixture":true}',
        },
      ],
      narration: [],
      cookieSnapshots: [],
      storageSnapshots: [],
    };
    const modes: string[] = [];

    const prepared = await prepareSessionForTeach(
      session,
      { provider: 'codex-cli' },
      {},
      (triageSession, config, context, options) =>
        triageRequests(triageSession, config, context, {
          ...options,
          analyzer: {
            async analyze(_systemPrompt, payload) {
              modes.push((payload as { mode: string }).mode);
              return {
                text: '{"keep":[1],"irreversible":[],"irreversibleEvents":[]}',
                inputTokens: 7,
                outputTokens: 3,
                durationMs: 11,
                stopReason: null,
              };
            },
          },
        }),
    );

    expect(modes).toEqual(['relevance']);
    expect(prepared.selectedSeqs).toEqual([1]);
    expect(prepared.replaySafeSeqs).toEqual([]);
    expect(prepared.coveredOutboundEventSeqs).toEqual([]);
    expect(prepared.session.triage).toBeUndefined();
    expect(prepared.inputTokens).toBe(7);
    expect(prepared.outputTokens).toBe(3);
    expect(prepared.durationMs).toBe(11);
  });

  it('compiles every one of 41 planned tools and waits for dependencies first', async () => {
    const producers = Array.from({ length: 21 }, (_, index) => focusedTool(index));
    const consumers = Array.from({ length: 20 }, (_, offset) =>
      focusedTool(offset + 21, [`tool_${offset}`]),
    );
    const plan = {
      tools: [...producers, ...consumers],
      buildWaves: [producers.map(({ id }) => id), consumers.map(({ id }) => id)],
    };
    const attempted: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let unfinishedProducers = producers.length;

    const result = await compileEveryToolInBuildWaves(plan, {
      concurrency: 3,
      compileTool: async (tool, waveIndex) => {
        if (waveIndex === 1) expect(unfinishedProducers).toBe(0);
        attempted.push(tool.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        if (waveIndex === 0) unfinishedProducers -= 1;
        return tool.id;
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.completed).toHaveLength(41);
    expect(new Set(attempted)).toEqual(new Set(plan.tools.map(({ id }) => id)));
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(3);
  });

  it('accepts a producer MVP before starting its dependent compile', async () => {
    const producer = focusedTool(1);
    const consumer = focusedTool(2, [producer.candidate.toolName]);
    const events: string[] = [];
    let producerAccepted = false;

    const result = await compileEveryToolInBuildWaves(
      {
        tools: [producer, consumer],
        buildWaves: [[producer.id], [consumer.id]],
      },
      {
        compileTool: async (tool) => {
          events.push(`compile:${tool.id}`);
          if (tool.id === consumer.id) expect(producerAccepted).toBe(true);
          return tool.id;
        },
        acceptCompiledTool: async (tool) => {
          events.push(`accept:${tool.id}`);
          await Promise.resolve();
          if (tool.id === producer.id) producerAccepted = true;
        },
      },
    );

    expect(result.failures).toEqual([]);
    expect(result.completed.map(({ tool }) => tool.id)).toEqual([producer.id, consumer.id]);
    expect(events).toEqual([
      `compile:${producer.id}`,
      `accept:${producer.id}`,
      `compile:${consumer.id}`,
      `accept:${consumer.id}`,
    ]);
  });

  it('still attempts later MVP compiles when accepting an earlier artifact fails', async () => {
    const tools = [focusedTool(1), focusedTool(2), focusedTool(3)];
    const attempted: string[] = [];
    const result = await compileEveryToolInBuildWaves(
      {
        tools,
        buildWaves: tools.map(({ id }) => [id]),
      },
      {
        compileTool: async (tool) => {
          attempted.push(tool.id);
          return tool.id;
        },
        acceptCompiledTool: (tool) => {
          if (tool.id === tools[0]?.id) throw new Error('fixture MVP contract failed');
        },
      },
    );

    expect(attempted).toEqual(tools.map(({ id }) => id));
    expect(result.completed.map(({ tool }) => tool.id)).toEqual(tools.slice(1).map(({ id }) => id));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual(
      expect.objectContaining({ toolId: tools[0]?.id, stage: 'contract' }),
    );
  });

  it('settles every tool before returning an honest failed terminal status', async () => {
    const tools = Array.from({ length: 45 }, (_, index) => focusedTool(index));
    const plan = {
      tools,
      buildWaves: [
        tools.slice(0, 15).map(({ id }) => id),
        tools.slice(15, 30).map(({ id }) => id),
        tools.slice(30).map(({ id }) => id),
      ],
    };
    const attempted: string[] = [];
    const result = await runFocusedWaveOrchestration(
      plan,
      {
        concurrency: 4,
        compileTool: async (tool) => {
          attempted.push(tool.id);
          if (tool.id === 'tool_2' || tool.id === 'tool_33') {
            throw new Error(`focused failure: ${tool.id}`);
          }
          return tool.id;
        },
      },
      '/tmp/fresh-master-run',
    );

    expect(attempted).toHaveLength(45);
    expect(new Set(attempted)).toEqual(new Set(tools.map(({ id }) => id)));
    expect(result.builds.completed).toHaveLength(43);
    expect(result.builds.failures.map(({ toolId }) => toolId).sort()).toEqual([
      'tool_2',
      'tool_33',
    ]);
    expect(result.terminal).toEqual({
      status: 'failed',
      readyTools: 43,
      failedTools: 2,
      runRoot: '/tmp/fresh-master-run',
      message: '2 planned focused build(s) failed.',
    });
  });
});

describe('master API replay facts', () => {
  it('does not compare synthetic or unavailable inputs with recorded bytes', async () => {
    const workflow: Workflow = {
      toolName: 'fixture_tool',
      intent: { description: 'Fixture replay' },
      site: 'fixture-site',
      parameters: [{ name: 'query', type: 'string', description: 'Query' }],
      requests: [
        {
          recordingRequestSeq: 7,
          method: 'GET',
          url: 'https://fixture.invalid/search?q=${param.query}',
          headers: {},
        },
      ],
    };
    const session = replaySession({
      seq: 7,
      timestamp: 1,
      method: 'GET',
      url: 'https://fixture.invalid/search?q=recorded',
      headers: {},
      resourceType: 'xhr',
      response: { status: 200, headers: {}, body: '{"ok":true}' },
    });

    const unavailableFacts = await apiReplayFacts({
      compiled: {
        workflow,
        workflowPath: '/unused/workflow.json',
        toolDir: '/unused',
      },
      implementation: replayImplementation('unavailable', []),
      session,
    });
    const legacySyntheticFacts = await apiReplayFacts({
      compiled: {
        workflow,
        workflowPath: '/unused/workflow.json',
        toolDir: '/unused',
      },
      implementation: replayImplementation(undefined, [
        { parameterName: 'query', value: 'synthetic-value' },
      ]),
      session,
    });

    for (const facts of [unavailableFacts, legacySyntheticFacts]) {
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        kind: 'request_comparison',
        status: 'not_checked',
      });
    }
  });

  it('compares the concrete URL and body emitted by the request transform', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-master-replay-transform-'));
    try {
      const workflowPath = pathJoin(root, 'workflow.json');
      const workflow: Workflow = {
        toolName: 'fixture_tool',
        intent: { description: 'Fixture replay' },
        site: 'fixture-site',
        parameters: [{ name: 'query', type: 'string', description: 'Query' }],
        requestTransformModule: './request-transform.ts',
        requests: [
          {
            recordingRequestSeq: 7,
            method: 'POST',
            url: 'https://fixture.invalid/search',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        ],
      };
      mkdirSync(root, { recursive: true });
      writeFileSync(workflowPath, JSON.stringify(workflow));
      writeFileSync(
        pathJoin(root, 'request-transform.ts'),
        `export function transform(method, url) {
          return { method, url: url + '?q=wrong', body: '{"query":"wrong"}' };
        }`,
      );
      const session = replaySession({
        seq: 7,
        timestamp: 1,
        method: 'POST',
        url: 'https://fixture.invalid/search?q=recorded',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"recorded"}',
        resourceType: 'xhr',
        response: { status: 200, headers: {}, body: '{"ok":true}' },
      });

      const facts = await apiReplayFacts({
        compiled: { workflow, workflowPath, toolDir: root },
        implementation: replayImplementation('recorded_baseline', [
          { parameterName: 'query', value: 'recorded' },
        ]),
        session,
      });

      expect(facts[0]).toMatchObject({
        kind: 'request_comparison',
        status: 'failed',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails replay when offline rendering returns an error', async () => {
    const workflow: Workflow = {
      toolName: 'fixture_tool',
      intent: { description: 'Fixture replay' },
      site: 'fixture-site',
      parameters: [],
      requests: [
        {
          recordingRequestSeq: 7,
          method: 'GET',
          url: 'https://fixture.invalid/search',
          headers: {},
          captures: [
            {
              name: 'required_value',
              required: true,
              capability: 'ordinary_http',
              source: 'json',
              path: 'missing',
            },
          ],
        },
      ],
    };
    const session = replaySession({
      seq: 7,
      timestamp: 1,
      method: 'GET',
      url: 'https://fixture.invalid/search',
      headers: {},
      resourceType: 'xhr',
      response: { status: 200, headers: {}, body: '{"other":true}' },
    });

    const facts = await apiReplayFacts({
      compiled: {
        workflow,
        workflowPath: '/unused/workflow.json',
        toolDir: '/unused',
      },
      implementation: replayImplementation(undefined, []),
      session,
    });

    expect(facts.map(({ status }) => status)).toEqual(['not_checked', 'failed']);
    expect(facts.at(-1)).toMatchObject({ kind: 'host_error' });
  });

  it('uses deterministic credential placeholders instead of current stored values', async () => {
    const workflow: Workflow = {
      toolName: 'fixture_tool',
      intent: { description: 'Fixture replay' },
      site: 'fixture-site',
      parameters: [],
      requests: [
        {
          recordingRequestSeq: 7,
          method: 'GET',
          url: 'https://fixture.invalid/private',
          headers: { 'x-api-key': '${credential.api_key}' },
        },
      ],
    };
    const session = replaySession({
      seq: 7,
      timestamp: 1,
      method: 'GET',
      url: 'https://fixture.invalid/private',
      headers: { 'x-api-key': '[REDACTED:v3:id=1:len=12]' },
      resourceType: 'xhr',
      response: { status: 200, headers: {}, body: '{"ok":true}' },
    });

    const facts = await apiReplayFacts({
      compiled: { workflow, workflowPath: '/unused/workflow.json', toolDir: '/unused' },
      implementation: replayImplementation(undefined, []),
      session,
      credentialNames: ['api_key'],
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: 'request_comparison', status: 'passed' });
  });
});

describe('reviewed promotion lifecycle', () => {
  it('does not mark the journal completed when promotion fails', async () => {
    const events: string[] = [];
    const journal = {
      recordCompletionReview: () => {
        events.push('review');
      },
      finish: () => {
        events.push('finish');
      },
    };
    await expect(
      promoteReviewedCompletion({
        journal: journal as never,
        reviewInput: {} as never,
        review: {} as never,
        promote: async () => {
          events.push('promote');
          throw new Error('promotion failed');
        },
      }),
    ).rejects.toThrow('promotion failed');
    expect(events).toEqual(['review', 'promote']);
  });

  it('marks completion only after promotion succeeds', async () => {
    const events: string[] = [];
    await promoteReviewedCompletion({
      journal: {
        recordCompletionReview: () => {
          events.push('review');
        },
        finish: () => {
          events.push('finish');
        },
      } as never,
      reviewInput: {} as never,
      review: {} as never,
      promote: async () => {
        events.push('promote');
      },
    });
    expect(events).toEqual(['review', 'promote', 'finish']);
  });
});

describe('master repair revisions', () => {
  it('gives every plan revision a clean tool directory', () => {
    expect(revisionStagingDir('/run/staging', 3, 'search_items')).toBe(
      '/run/staging/revision-3/search_items',
    );
    expect(revisionStagingDir('/run/staging', 4, 'search_items')).toBe(
      '/run/staging/revision-4/search_items',
    );
  });

  it('preserves provider and cancellation status through fan-out errors', () => {
    expect(
      terminalStatusForError(
        new AggregateError([
          new Error('another focused task failed'),
          new ProviderUnavailableError(new Error('capacity unavailable')),
        ]),
      ),
    ).toBe('provider_unavailable');
    expect(
      terminalStatusForError(
        new AggregateError([
          new Error('another focused task failed'),
          new DOMException('', 'AbortError'),
        ]),
      ),
    ).toBe('cancelled');
  });

  it('keeps the exact per-tool focused-planner failure in the terminal message', () => {
    const message = focusedPlanningFailureMessage(
      [
        {
          toolId: 'search_hotels',
          error: new Error(
            'focused planner returned invalid output after one repair: binding.toolId: stale binding',
          ),
        },
      ],
      1,
    );
    expect(message).toContain('focused planning failed for 1 of 1 tools');
    expect(message).toContain('search_hotels: focused planner returned invalid output');
    expect(message).toContain('binding.toolId: stale binding');
  });

  it('focused-plans every missing or compile-input-stale final tool', () => {
    const current = focusedTool(1);
    const stale = focusedTool(2);
    const missing = focusedTool(3);
    current.strategy = {
      kind: 'api',
      reason: 'Recorded request is replayable.',
    };
    stale.strategy = { kind: 'api', reason: 'Recorded request is replayable.' };
    current.implementationPlan = {
      path: 'objects/current.json',
      sha256: SHA,
      basedOnCompileInputsSha256: teachingToolCompileInputsSha256(current, []),
      requestProvenanceSha256: SHA,
    };
    stale.implementationPlan = {
      path: 'objects/stale.json',
      sha256: SHA,
      basedOnCompileInputsSha256: `sha256:${'b'.repeat(64)}`,
      requestProvenanceSha256: SHA,
    };
    const plan: EditableTeachingPlan = {
      version: 1,
      revision: 2,
      site: 'fixture-site',
      recordingSha256: SHA,
      tools: [current, stale, missing],
      candidateCoverage: [current, stale, missing].map((tool) => ({
        discoveryCandidateName: tool.candidate.toolName,
        plannedToolIds: [tool.id],
        unresolvedReason: null,
      })),
      buildWaves: [[current.id, stale.id, missing.id]],
      chainEdges: [],
      decision: {
        timestamp: '2026-01-01T00:00:00.000Z',
        outcome: 'revised',
        reason: 'Fixture repair revision.',
        advisorRefs: [],
        evidenceRefs: [],
      },
    };

    expect(implementationPlanRepairToolIds(plan)).toEqual([stale.id, missing.id]);
  });

  it('defers a producer plan when a concurrent consumer changes its output obligation', () => {
    const producer = focusedTool(1);
    const consumer = focusedTool(2, [producer.candidate.toolName]);
    consumer.candidate.likelyParams = [
      { name: 'item_id', type: 'string', description: 'Identifier from the producer.' },
    ];
    const oldEdge = {
      id: 'producer-item',
      producerToolId: producer.id,
      producerResultPath: '[0].item_id',
      consumerToolId: consumer.id,
      consumerParameter: 'item_id',
    };
    const newEdge = { ...oldEdge, producerResultPath: '[0].canonical_item_id' };
    const bundles = [
      {
        evidence: {} as never,
        output: { tool: producer, chainEdges: [] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(producer, [oldEdge]),
      },
      {
        evidence: {} as never,
        output: { tool: consumer, chainEdges: [newEdge] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(consumer, [newEdge]),
      },
    ];

    expect(compatibleFocusedPlannerIndexes([oldEdge], bundles)).toEqual([1]);
    const producerBundle = bundles[0];
    if (!producerBundle) throw new Error('missing producer planner fixture');
    expect(
      compatibleFocusedPlannerIndexes(
        [newEdge],
        [
          {
            ...producerBundle,
            authoredCompileInputsSha256: teachingToolCompileInputsSha256(producer, [newEdge]),
          },
        ],
      ),
    ).toEqual([0]);
  });

  it('keeps compatible upstream work when two downstream links change', () => {
    const first = focusedTool(1);
    const second = focusedTool(2, [first.candidate.toolName]);
    const third = focusedTool(3, [second.candidate.toolName]);
    second.candidate.likelyParams = [
      { name: 'first_id', type: 'string', description: 'Identifier from the first tool.' },
    ];
    third.candidate.likelyParams = [
      { name: 'second_id', type: 'string', description: 'Identifier from the second tool.' },
    ];
    const oldFirstEdge = {
      id: 'first-to-second',
      producerToolId: first.id,
      producerResultPath: '[0].first_id',
      consumerToolId: second.id,
      consumerParameter: 'first_id',
    };
    const oldSecondEdge = {
      id: 'second-to-third',
      producerToolId: second.id,
      producerResultPath: '[0].second_id',
      consumerToolId: third.id,
      consumerParameter: 'second_id',
    };
    const newFirstEdge = { ...oldFirstEdge, producerResultPath: '[0].canonical_first_id' };
    const newSecondEdge = { ...oldSecondEdge, producerResultPath: '[0].canonical_second_id' };
    const currentEdges = [oldFirstEdge, oldSecondEdge];
    const bundles = [
      {
        evidence: {} as never,
        output: { tool: first, chainEdges: [] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(first, currentEdges),
      },
      {
        evidence: {} as never,
        output: { tool: second, chainEdges: [newFirstEdge] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(second, [
          newFirstEdge,
          oldSecondEdge,
        ]),
      },
      {
        evidence: {} as never,
        output: { tool: third, chainEdges: [newSecondEdge] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(third, [
          oldFirstEdge,
          newSecondEdge,
        ]),
      },
    ];

    expect(compatibleFocusedPlannerIndexes(currentEdges, bundles)).toEqual([0, 2]);
  });

  it('keeps a same-wave consumer that proposes a new producer dependency', () => {
    const producer = focusedTool(1);
    const consumer = focusedTool(2, [producer.candidate.toolName]);
    consumer.candidate.likelyParams = [
      { name: 'item_id', type: 'string', description: 'Identifier from the producer.' },
    ];
    const newEdge = {
      id: 'new-producer-item',
      producerToolId: producer.id,
      producerResultPath: '[0].item_id',
      consumerToolId: consumer.id,
      consumerParameter: 'item_id',
    };
    const bundles = [
      {
        evidence: {} as never,
        output: { tool: consumer, chainEdges: [newEdge] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(consumer, [newEdge]),
      },
      {
        evidence: {} as never,
        output: { tool: producer, chainEdges: [] } as never,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(producer, []),
      },
    ];

    expect(compatibleFocusedPlannerIndexes([], bundles)).toEqual([0]);
  });
});
