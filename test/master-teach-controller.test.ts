import { describe, expect, it } from 'bun:test';
import type { ApiResearchResult } from '../src/imprint/api-research-agent.ts';
import { triageRequests } from '../src/imprint/compile.ts';
import {
  ParameterAdvisorLane,
  apiResearchCoversToolBoundary,
  apiResearchFailureMessage,
  compatibleFocusedPlannerIndexes,
  compileEveryToolInBuildWaves,
  failureReceiptBindingError,
  focusedPlanningFailureMessage,
  focusedPlanningStateSha256,
  implementationPlanRepairToolIds,
  prepareFullSessionForTeach,
  prepareSessionForTeach,
  promoteReviewedCompletion,
  providerForFreshTeach,
  revisionSeedArtifactNames,
  revisionStagingDir,
  runFocusedWaveOrchestration,
  runPlaybookInvocationWithDeadline,
  sameFinesseTarget,
  terminalStatusForError,
} from '../src/imprint/master-teach-controller.ts';
import {
  type EditableTeachingPlan,
  type EditableTeachingTool,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
} from '../src/imprint/master-teach-plan.ts';
import { ProviderUnavailableError, RunDeadline } from '../src/imprint/provider-retry.ts';
import type { Session } from '../src/imprint/types.ts';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('failure receipt freshness', () => {
  const currentBuildRef = { path: 'builds/current.json', sha256: SHA };
  const currentReceiptRef = {
    path: 'receipts/current.json',
    sha256: `sha256:${'b'.repeat(64)}`,
  };
  const current = {
    buildRef: currentBuildRef,
    currentReceiptRefs: [{ ref: currentReceiptRef }],
  };
  const failure = { toolId: 'search', stage: 'live' as const };
  const receipt = {
    ref: currentReceiptRef,
    toolId: 'search',
    check: 'live',
    buildRef: currentBuildRef,
  };

  it('accepts only an exact current build receipt', () => {
    expect(
      failureReceiptBindingError({ receipt, failure, currentToolState: current }),
    ).toBeUndefined();
  });

  it('rejects a historical build or superseded receipt before repair handoff', () => {
    expect(
      failureReceiptBindingError({
        receipt: {
          ...receipt,
          buildRef: { path: 'builds/old.json', sha256: `sha256:${'c'.repeat(64)}` },
        },
        failure,
        currentToolState: current,
      }),
    ).toContain('older build');
    expect(
      failureReceiptBindingError({
        receipt: {
          ...receipt,
          ref: { path: 'receipts/old.json', sha256: `sha256:${'d'.repeat(64)}` },
        },
        failure,
        currentToolState: current,
      }),
    ).toContain('no longer current');
  });

  it('accepts a group-level failure only for a receipt from that exact invocation', () => {
    const chainReceipt = { ...receipt, check: 'chain', chainEdgeId: 'route-b-kind' };
    expect(
      failureReceiptBindingError({
        receipt: chainReceipt,
        failure: {
          toolId: 'search',
          stage: 'chain',
          chainEdgeIds: ['route-b-id', 'route-b-kind'],
        },
        currentToolState: current,
      }),
    ).toBeUndefined();
    expect(
      failureReceiptBindingError({
        receipt: chainReceipt,
        failure: {
          toolId: 'search',
          stage: 'chain',
          chainEdgeIds: ['route-a-id', 'route-a-kind'],
        },
        currentToolState: current,
      }),
    ).toContain('does not match');
  });
});

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

describe('revision artifact seeds', () => {
  it('does not carry incompatible files across an API/browser strategy change', () => {
    expect(revisionSeedArtifactNames('api')).toEqual([
      'workflow.json',
      'parser.ts',
      'request-transform.ts',
    ]);
    expect(revisionSeedArtifactNames('playbook_fallback')).toEqual([
      'workflow.json',
      'playbook.yaml',
    ]);
    expect(revisionSeedArtifactNames('api', 'playbook_fallback')).toEqual([]);
    expect(revisionSeedArtifactNames('playbook_fallback', 'api')).toEqual([]);
  });
});

describe('optional finesse freshness', () => {
  const buildRef = { path: 'objects/json/build.json', sha256: SHA };
  const target = {
    buildRef,
    executionBindingSha256: `sha256:${'b'.repeat(64)}`,
  };

  it('stays current across unrelated plan revisions', () => {
    expect(
      sameFinesseTarget(target, {
        currentBuildRef: { ...buildRef },
        executionBindingSha256: target.executionBindingSha256,
      }),
    ).toBe(true);
  });

  it('becomes stale when the tool build or execution binding changes', () => {
    expect(
      sameFinesseTarget(target, {
        currentBuildRef: { ...buildRef, sha256: `sha256:${'c'.repeat(64)}` },
        executionBindingSha256: target.executionBindingSha256,
      }),
    ).toBe(false);
    expect(
      sameFinesseTarget(target, {
        currentBuildRef: { ...buildRef },
        executionBindingSha256: `sha256:${'d'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(sameFinesseTarget(target, undefined)).toBe(false);
  });

  it('caps optional parameter advisors at the core compile width', async () => {
    const lane = new ParameterAdvisorLane();
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const run = (id: number) =>
      lane.run(new AbortController().signal, async () => {
        started.push(id);
        await new Promise<void>((resolve) => releases.push(resolve));
        return id;
      });
    const attempts = [run(1), run(2), run(3)];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 2]);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 2, 3]);
    for (const release of releases) release();
    expect(await Promise.all(attempts)).toEqual([1, 2, 3]);
  });
});

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

describe('API research boundary reuse', () => {
  const researchFor = (tool: EditableTeachingTool): ApiResearchResult => ({
    researchInputsSha256: SHA,
    researchedBoundary: {
      requestSeqs: [1, 2],
      dependencySeqs: [],
    },
    candidate: {
      workflow: {
        toolName: tool.candidate.toolName,
        intent: { description: tool.candidate.description },
        parameters: [
          { name: 'query', type: 'string', description: 'Query to send.' },
          { name: 'mode', type: 'string', description: 'Optional researched breadth.' },
        ],
        requests: [
          {
            recordingRequestSeq: 1,
            method: 'GET',
            url: 'https://fixture.invalid/search',
            headers: {},
          },
        ],
        site: 'fixture-site',
      },
      parameterValues: { query: 'recorded', mode: 'broad' },
      testBackend: 'fetch',
    },
    workflow: {
      toolName: tool.candidate.toolName,
      intent: { description: tool.candidate.description },
      parameters: [
        { name: 'query', type: 'string', description: 'Query to send.' },
        { name: 'mode', type: 'string', description: 'Optional researched breadth.' },
      ],
      requests: [
        {
          recordingRequestSeq: 1,
          method: 'GET',
          url: 'https://fixture.invalid/search',
          headers: {},
        },
      ],
      site: 'fixture-site',
    },
    toolDir: '/tmp/fixture-research',
    summary: 'The recorded request returned real results.',
    observation: {
      id: 'fixture-observation',
      candidateSha256: SHA,
      executionMechanism: 'fetch',
      backendAttempts: [],
      responseObservations: [],
      result: { ok: true, preview: 'real result' },
    },
    parameters: { query: 'recorded', mode: 'broad' },
    backend: 'fetch',
  });

  it('reuses proof after planning narrows parameters or rewrites notes', () => {
    const tool = focusedTool(1);
    tool.strategy = { kind: 'api', reason: 'Use the proven request.' };
    tool.candidate.requestSeqs = [1, 2];
    tool.candidate.likelyParams = [
      { name: 'query', type: 'string', description: 'Public search query.' },
    ];
    tool.compileContext.sharedHelperNotes = 'Planner-authored implementation details.';
    expect(apiResearchCoversToolBoundary(tool, researchFor(tool))).toBeTrue();
  });

  it('requires fresh research for a new parameter or a discarded proven request', () => {
    const tool = focusedTool(1);
    tool.strategy = { kind: 'api', reason: 'Use the proven request.' };
    tool.candidate.requestSeqs = [1];
    tool.candidate.likelyParams = [
      { name: 'query', type: 'string', description: 'Public search query.' },
    ];
    const research = researchFor(tool);
    tool.candidate.likelyParams.push({
      name: 'unresearched',
      type: 'string',
      description: 'A new public input.',
    });
    expect(apiResearchCoversToolBoundary(tool, research)).toBeFalse();
    tool.candidate.likelyParams.pop();
    tool.candidate.requestSeqs = [2];
    expect(apiResearchCoversToolBoundary(tool, research)).toBeFalse();
  });
});

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

  it('surfaces host persistence failures instead of labeling them as artifact failures', async () => {
    const tools = [focusedTool(1), focusedTool(2), focusedTool(3)];
    const firstTool = tools[0];
    if (!firstTool) throw new Error('fixture expected a first tool');
    const attempted: string[] = [];
    await expect(
      compileEveryToolInBuildWaves(
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
            if (tool.id === firstTool.id) throw new Error('fixture journal write failed');
          },
        },
      ),
    ).rejects.toThrow('fixture journal write failed');

    expect(attempted).toEqual([firstTool.id]);
  });

  it('waits for sibling workers before surfacing a host persistence failure', async () => {
    const first = focusedTool(1);
    const sibling = focusedTool(2);
    let markSiblingStarted: (() => void) | undefined;
    const siblingStarted = new Promise<void>((resolve) => {
      markSiblingStarted = resolve;
    });
    let releaseSibling: (() => void) | undefined;
    const siblingRelease = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingSettled = false;
    let rejectionObserved = false;

    const invocation = compileEveryToolInBuildWaves(
      {
        tools: [first, sibling],
        buildWaves: [[first.id, sibling.id]],
      },
      {
        concurrency: 2,
        compileTool: async (tool) => {
          if (tool.id === sibling.id) {
            markSiblingStarted?.();
            await siblingRelease;
            siblingSettled = true;
          }
          return tool.id;
        },
        acceptCompiledTool: async (tool) => {
          if (tool.id !== first.id) return;
          await siblingStarted;
          throw new Error('fixture journal write failed');
        },
      },
    ).catch((error: unknown) => {
      rejectionObserved = true;
      throw error;
    });

    await siblingStarted;
    await Promise.resolve();
    expect(rejectionObserved).toBe(false);
    releaseSibling?.();
    await expect(invocation).rejects.toThrow('fixture journal write failed');
    expect(siblingSettled).toBe(true);
  });

  it('surfaces host filesystem failures instead of asking the master to repair artifacts', async () => {
    const tool = focusedTool(1);
    const hostError = Object.assign(new Error('fixture disk is full'), { code: 'ENOSPC' });

    await expect(
      compileEveryToolInBuildWaves(
        { tools: [tool], buildWaves: [[tool.id]] },
        {
          compileTool: async () => {
            throw hostError;
          },
        },
      ),
    ).rejects.toBe(hostError);
  });

  it('keeps a missing generated artifact in ordinary compile repair', async () => {
    const tool = focusedTool(1);
    const artifactError = Object.assign(new Error('fixture artifact is missing'), {
      code: 'ENOENT',
    });

    const result = await compileEveryToolInBuildWaves(
      { tools: [tool], buildWaves: [[tool.id]] },
      {
        compileTool: async () => {
          throw artifactError;
        },
      },
    );

    expect(result.completed).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ toolId: tool.id, stage: 'compile', error: artifactError }),
    ]);
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
      nonReadyTools: 2,
      runRoot: '/tmp/fresh-master-run',
      message: '2 planned focused build(s) failed.',
    });
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
  it('ignores prose, collection order, and ref paths in focused proposal state', () => {
    const first = focusedTool(1);
    const second = focusedTool(2);
    const plan: EditableTeachingPlan = {
      version: 1,
      revision: 2,
      site: 'fixture-site',
      recordingSha256: SHA,
      tools: [first, second],
      candidateCoverage: [first, second].map((tool) => ({
        discoveryCandidateName: tool.candidate.toolName,
        plannedToolIds: [tool.id],
        unresolvedReason: null,
      })),
      buildWaves: [[first.id], [second.id]],
      chainEdges: [],
      decision: {
        timestamp: '2026-01-01T00:00:00.000Z',
        outcome: 'revised',
        reason: 'First explanation.',
        advisorRefs: [],
        evidenceRefs: [],
      },
    };
    const compileInputsSha256 = teachingToolCompileInputsSha256(first, plan.chainEdges);
    const implementationPayload = { toolId: first.id, requestPlan: 'stable executable plan' };
    const implementationPlan = {
      path: 'objects/json/implementation-a.json',
      sha256: teachingPlanContentSha256(implementationPayload),
      basedOnCompileInputsSha256: compileInputsSha256,
      requestProvenanceSha256: SHA,
    };
    const proposal = {
      ref: { path: 'objects/json/proposal-a.json', sha256: SHA },
      payload: {
        binding: { compileInputsSha256 },
        tool: { ...first, implementationPlan },
        chainEdges: [
          {
            id: 'edge-b',
            producerToolId: second.id,
            producerResultPath: '[0].alternate_id',
            consumerToolId: first.id,
            consumerParameter: 'alternate_id',
          },
          {
            id: 'edge-a',
            producerToolId: second.id,
            producerResultPath: '[0].id',
            consumerToolId: first.id,
            consumerParameter: 'id',
          },
        ],
        implementationPlan: { ref: implementationPlan, payload: implementationPayload },
        reason: 'First proposal explanation.',
      },
    };
    const original = focusedPlanningStateSha256(plan, [first.id], [proposal] as never);

    const reorderedPlan = structuredClone(plan);
    reorderedPlan.revision += 1;
    reorderedPlan.decision.reason = 'A paraphrase that changes no executable input.';
    for (const tool of reorderedPlan.tools) {
      tool.candidate.rationale = `Paraphrased rationale for ${tool.id}.`;
      tool.candidate.confidence = 0.51;
    }
    reorderedPlan.tools.reverse();
    reorderedPlan.candidateCoverage.reverse();
    reorderedPlan.buildWaves.reverse();
    const pathChurnedProposal = structuredClone(proposal);
    pathChurnedProposal.ref.path = 'objects/json/proposal-b.json';
    pathChurnedProposal.payload.reason = 'A different proposal explanation.';
    pathChurnedProposal.payload.chainEdges.reverse();
    pathChurnedProposal.payload.implementationPlan.ref.path = 'objects/json/implementation-b.json';
    pathChurnedProposal.payload.tool.implementationPlan.path = 'objects/json/implementation-b.json';

    expect(
      focusedPlanningStateSha256(reorderedPlan, [first.id], [pathChurnedProposal] as never),
    ).toBe(original);

    const changedCompileInputs = structuredClone(reorderedPlan);
    const changedTool = changedCompileInputs.tools.find(({ id }) => id === first.id);
    if (!changedTool) throw new Error('missing focused fixture tool');
    changedTool.candidate.description = 'Materially changed compile input.';
    expect(
      focusedPlanningStateSha256(changedCompileInputs, [first.id], [proposal] as never),
    ).not.toBe(original);

    const changedImplementation = structuredClone(proposal);
    changedImplementation.payload.implementationPlan.payload.requestPlan =
      'materially changed executable plan';
    expect(focusedPlanningStateSha256(plan, [first.id], [changedImplementation] as never)).not.toBe(
      original,
    );

    const changedImplementationMetadata = structuredClone(proposal);
    changedImplementationMetadata.payload.implementationPlan.ref.requestProvenanceSha256 = `sha256:${'b'.repeat(64)}`;
    expect(
      focusedPlanningStateSha256(plan, [first.id], [changedImplementationMetadata] as never),
    ).not.toBe(original);
  });

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

  it('keeps exact per-tool API-research failures in the terminal message', () => {
    const message = apiResearchFailureMessage(
      [
        {
          toolId: 'search_flights',
          error: new Error('result.preview: expected 0..12000 UTF-8 bytes'),
        },
      ],
      5,
    );
    expect(message).toContain('pre-plan API research failed for 1 of 5 selected operations');
    expect(message).toContain('search_flights: result.preview');
    expect(message).toContain('expected 0..12000 UTF-8 bytes');
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

  it('keeps both plans when a concurrent consumer changes only chain wiring', () => {
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

    expect(compatibleFocusedPlannerIndexes([oldEdge], bundles)).toEqual([0, 1]);
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

  it('keeps all compatible work when two downstream links change', () => {
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

    expect(compatibleFocusedPlannerIndexes(currentEdges, bundles)).toEqual([0, 1, 2]);
  });

  it('keeps same-wave tools when a consumer proposes new chain wiring', () => {
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

    expect(compatibleFocusedPlannerIndexes([], bundles)).toEqual([0, 1]);
  });
});
