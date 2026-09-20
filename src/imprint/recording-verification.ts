/** Independent, offline evidence review. Never creates live challenge requests. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { z } from 'zod';
import { importModuleFresh } from './import-module-fresh.ts';
import { resolveProvider } from './llm.ts';
import {
  type MasterTeachAgentOptions,
  requestRecordingEvidenceStep,
} from './master-teach-agents.ts';
import type { ImplementationPlanPayload } from './master-teach-plan.ts';
import { boundedRunDeadline } from './provider-retry.ts';
import type { Session, Workflow } from './types.ts';

type Params = Record<string, string | number | boolean>;
export interface RecordingFixture {
  id: string;
  origin: 'recording' | 'live';
  requestSeqs: number[];
  parameters: Params;
  responses: unknown[];
  actual: unknown;
  freshnessChanges?: string;
}
export interface RecordingEvidenceReview {
  status: 'passed' | 'failed' | 'unverified';
  reason: string;
  reportPath?: string;
}
const FactsSchema = z
  .object({
    sourceId: z.string(),
    facts: z
      .array(z.object({ statement: z.string().min(1), quote: z.string().min(1) }).strict())
      .min(1)
      .max(12),
  })
  .strict();
const StepSchema = z
  .object({
    action: z.enum(['inspect', 'finish']),
    sourceId: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
    search: z.string().min(1).optional(),
    project: z.string().min(1).max(8_000).optional(),
    expectations: z.array(FactsSchema).max(16).optional(),
    status: z.enum(['passed', 'failed', 'unverified']).optional(),
    reason: z.string().min(1),
  })
  .strict();
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

/** Bounded pure-data inspection; no network, file handles, or parser module. */
export function projectEvidence(value: unknown, source: string): string {
  const script = new Script(`JSON.stringify((${source})(JSON.parse(raw)))`);
  return String(
    script.runInNewContext(
      { raw: JSON.stringify(value) },
      { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } },
    ) ?? 'null',
  );
}

/** Run exactly the parser entrypoint used by runtime, without network requests. */
export async function parseRecordedResponses(
  workflowPath: string,
  workflow: Workflow,
  responses: unknown[],
  parameters: Params,
): Promise<unknown> {
  const final = responses.at(-1) ?? null;
  if (!workflow.parserModule) return final;
  const parser = await importModuleFresh(resolve(dirname(workflowPath), workflow.parserModule));
  if (typeof parser.extract !== 'function') throw new Error('parser does not export extract');
  return await parser.extract(final, { params: parameters, responses });
}

export async function recordingFixtures(input: {
  workflowPath: string;
  workflow: Workflow;
  implementation: ImplementationPlanPayload;
  session: Session;
}): Promise<RecordingFixture[]> {
  const fixtures: RecordingFixture[] = [];
  for (const verification of input.implementation.verificationCases.filter(
    ({ check }) => check === 'replay',
  )) {
    const seqs =
      verification.recordedCall?.requestSeqs ?? verification.provenance.recordingRequestSeqs;
    if (!seqs.length)
      throw new Error(`Recording case ${verification.id} has no response sequences`);
    const responses = seqs.map((seq) => {
      const request = input.session.requests.find((request) => request.seq === seq);
      if (request?.response?.body === undefined)
        throw new Error(`Recording response ${seq} is unavailable`);
      try {
        return JSON.parse(request.response.body);
      } catch {
        return request.response.body;
      }
    });
    const parameters = Object.fromEntries(
      verification.parameterValues.map(({ parameterName, value }) => [parameterName, value]),
    );
    let actual: unknown;
    try {
      actual = await parseRecordedResponses(
        input.workflowPath,
        input.workflow,
        responses,
        parameters,
      );
    } catch (error) {
      actual = { parserError: error instanceof Error ? error.message : String(error) };
    }
    fixtures.push({
      id: verification.id,
      origin: 'recording',
      requestSeqs: seqs,
      parameters,
      responses,
      actual,
    });
  }
  return fixtures;
}

/** Derive fixed expectations using only raw sources, then reveal actual outputs.
 * The bounded inspection loop reads existing bytes; it cannot execute requests.
 */
export async function verifyRecordingEvidence(input: {
  operation: { name: string; description: string; expectedOutput: string };
  fixtures: RecordingFixture[];
  directory: string;
  agent: MasterTeachAgentOptions;
  requestStep?: typeof requestRecordingEvidenceStep;
}): Promise<RecordingEvidenceReview> {
  const request = input.requestStep ?? requestRecordingEvidenceStep;
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const sources = input.fixtures.map(({ actual: _actual, ...fixture }) => fixture);
  const sourceKey = hash({ operation: input.operation, sources });
  const actualOutputs = input.fixtures.map(({ id, actual }) => ({ id, actual }));
  const actualKey = hash(actualOutputs);
  writeFileSync(
    join(input.directory, `${sourceKey}-${actualKey}.outputs.json`),
    JSON.stringify(actualOutputs),
  );
  const reportPath = join(input.directory, `${sourceKey}-${actualKey}.review.json`);
  if (existsSync(reportPath)) return JSON.parse(readFileSync(reportPath, 'utf8'));
  const finish = (review: RecordingEvidenceReview): RecordingEvidenceReview => {
    const result = { ...review, reportPath };
    writeFileSync(reportPath, JSON.stringify(result, null, 2));
    return result;
  };
  writeFileSync(join(input.directory, `${sourceKey}.sources.json`), JSON.stringify(sources));
  if (
    !sources.some(({ origin }) => origin === 'recording') ||
    !sources.some(({ origin }) => origin === 'live')
  ) {
    return finish({
      status: 'unverified',
      reason: 'Both a recording case and matched live raw responses are required.',
    });
  }
  if (new Set(sources.map(({ id }) => id)).size !== sources.length)
    throw new Error('Duplicate evidence case id');
  const sourceTexts = new Map(sources.map((fixture) => [fixture.id, text(fixture.responses)]));
  const factsPath = join(input.directory, `${sourceKey}.expectations.json`);
  let expectations: z.infer<typeof FactsSchema>[] | undefined;
  if (existsSync(factsPath))
    expectations = z.array(FactsSchema).parse(JSON.parse(readFileSync(factsPath, 'utf8')));
  // Keep the existing shared deadline; evidence review may use at most five minutes.
  const deadlineMs = Math.min(
    input.agent.runDeadline?.deadlineMs ?? input.agent.deadlineMs ?? Number.POSITIVE_INFINITY,
    Date.now() + 300_000,
  );
  const agent = {
    ...input.agent,
    analyzer:
      input.agent.analyzer ??
      resolveProvider({ provider: input.agent.provider, model: input.agent.model }),
    timeoutMs: undefined,
    deadlineMs,
    runDeadline: boundedRunDeadline(input.agent.runDeadline, deadlineMs),
  };
  for (const phase of ['expectations', 'evaluation'] as const) {
    if (phase === 'expectations' && expectations) continue;
    const texts =
      phase === 'expectations'
        ? sourceTexts
        : new Map(input.fixtures.map(({ id, actual }) => [id, text(actual)]));
    let payload: unknown = {
      phase,
      operation: input.operation,
      ...(phase === 'evaluation' ? { expectations } : {}),
      sources: sources.map(({ responses: _responses, ...fixture }) => ({
        ...fixture,
        contentKind: phase === 'expectations' ? 'raw_responses' : 'parser_output',
        characters: texts.get(fixture.id)?.length,
        preview: texts.get(fixture.id)?.slice(0, 12_000),
        truncated: (texts.get(fixture.id)?.length ?? 0) > 12_000,
      })),
    };
    const initialPayload = payload;
    const inspections: unknown[] = [];
    let finished = false;
    for (let turn = 0; turn < 6; turn++) {
      const decision = await request(
        payload,
        StepSchema,
        agent,
        `evidence:${sourceKey}:${phase}:${phase === 'evaluation' ? actualKey : ''}`,
      );
      writeFileSync(
        join(input.directory, `${sourceKey}-${actualKey}.${phase}-${turn}.json`),
        JSON.stringify({ payload, decision }),
      );
      if (decision.action === 'inspect') {
        const body = texts.get(decision.sourceId ?? '');
        if (body === undefined)
          return finish({
            status: 'unverified',
            reason: 'Verifier requested an unavailable evidence source.',
          });
        if (decision.project) {
          const fixture = input.fixtures.find(({ id }) => id === decision.sourceId);
          try {
            const projected = projectEvidence(
              phase === 'expectations' ? fixture?.responses : fixture?.actual,
              decision.project,
            );
            payload = {
              phase,
              sourceId: decision.sourceId,
              projected: projected.slice(0, 32_000),
              characters: projected.length,
              truncated: projected.length > 32_000,
              remainingInspections: 5 - turn,
            };
          } catch (error) {
            payload = {
              phase,
              sourceId: decision.sourceId,
              inspectionError: error instanceof Error ? error.message : String(error),
              remainingInspections: 5 - turn,
            };
          }
        } else {
          const start = decision.search
            ? body.indexOf(decision.search, decision.offset ?? 0)
            : (decision.offset ?? 0);
          payload = {
            phase,
            sourceId: decision.sourceId,
            offset: start,
            characters: body.length,
            text: start < 0 ? '' : body.slice(start, start + 32_000),
            remainingInspections: 5 - turn,
          };
        }
        inspections.push(payload);
        if (input.agent.provider !== 'codex-cli')
          payload = { initial: initialPayload, inspections };
        continue;
      }
      if (phase === 'expectations') {
        if (decision.status === 'unverified' || !decision.expectations)
          return finish({ status: 'unverified', reason: decision.reason });
        expectations = decision.expectations;
        const ids = expectations.map(({ sourceId }) => sourceId);
        if (
          ids.length !== sources.length ||
          new Set(ids).size !== ids.length ||
          sources.some(({ id }) => !ids.includes(id)) ||
          expectations.some(({ sourceId, facts }) =>
            facts.some(({ quote }) => !sourceTexts.get(sourceId)?.includes(quote)),
          )
        ) {
          return finish({
            status: 'unverified',
            reason: 'Independent expectations must cover each source and cite exact raw evidence.',
          });
        }
        writeFileSync(factsPath, JSON.stringify(expectations, null, 2));
        finished = true;
        break;
      }
      return finish({ status: decision.status ?? 'unverified', reason: decision.reason });
    }
    if (!finished)
      return finish({
        status: 'unverified',
        reason: 'Evidence inspection budget exhausted; no additional live requests were made.',
      });
  }
  return finish({ status: 'unverified', reason: 'Evidence evaluation did not finish.' });
}
