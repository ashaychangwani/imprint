/** Independent, offline evidence review. Never creates live challenge requests. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { decodeBodyStructure } from './body-structure.ts';
import { abortableDelay } from './concurrency.ts';
import { projectEvidence } from './evidence-inspection.ts';
export { projectEvidence } from './evidence-inspection.ts';
import { importModuleFresh } from './import-module-fresh.ts';
import { resolveProvider } from './llm.ts';
import {
  type MasterTeachAgentOptions,
  requestRecordingEvidenceStep,
} from './master-teach-agents.ts';
import type { ImplementationPlanPayload } from './master-teach-plan.ts';
import {
  ProviderDeadlineError,
  boundedRunDeadline,
  providerControlError,
} from './provider-retry.ts';
import type { Session, Workflow } from './types.ts';

type Params = Record<string, string | number | boolean>;
export interface RecordingFixture {
  id: string;
  origin: 'recording' | 'live';
  requestSeqs: number[];
  parameters: Params;
  responses: unknown[];
  recordedRequests?: Array<{ seq: number; method: string; url: string; body?: string }>;
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
const ComparabilitySchema = z
  .object({ status: z.enum(['matched', 'unverified']), reason: z.string().min(1) })
  .strict();
const StepSchema = z
  .object({
    action: z.enum(['inspect', 'finish']),
    sourceId: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
    search: z.string().min(1).optional(),
    project: z.string().min(1).max(8_000).optional(),
    decode: z
      .union([z.boolean(), z.enum(['json', 'form-urlencoded', 'decimal-framed-json'])])
      .optional(),
    expectations: z.array(FactsSchema).max(16).optional(),
    comparability: ComparabilitySchema.optional(),
    status: z.enum(['passed', 'failed', 'unverified']).optional(),
    reason: z.string().min(1),
  })
  .strict();
const MAX_EVIDENCE_INSPECTIONS = 12;
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

/** Reuse the mechanical wire decoder; expose limits instead of guessing semantics. */
export function decodeEvidenceResponses(responses: unknown[], format: unknown = 'auto'): unknown[] {
  return responses.map((response, index) => {
    if (typeof response !== 'string') return { index, format: 'native', value: response };
    const decoded = decodeBodyStructure(response, format);
    if (!decoded.ok) return { index, error: decoded.error, code: decoded.code };
    const { sourceValue: _sourceValue, ...structure } = decoded.structure;
    return { index, ...structure };
  });
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
  matchingRequestSeqs?: readonly number[];
}): Promise<RecordingFixture[]> {
  const fixtures: RecordingFixture[] = [];
  for (const verification of input.implementation.verificationCases.filter(
    ({ check }) => check === 'replay',
  )) {
    const seqs =
      verification.recordedCall?.requestSeqs ?? verification.provenance.recordingRequestSeqs;
    if (
      input.matchingRequestSeqs !== undefined &&
      JSON.stringify(seqs) !== JSON.stringify(input.matchingRequestSeqs)
    )
      continue;
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
      recordedRequests: seqs.map((seq) => {
        const request = input.session.requests.find((request) => request.seq === seq);
        if (!request) throw new Error(`Recording request ${seq} is unavailable`);
        return { seq, method: request.method, url: request.url, body: request.body };
      }),
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
  evidenceMode?: 'paired' | 'live_only_missing_recording';
  directory: string;
  agent: MasterTeachAgentOptions;
  requestStep?: typeof requestRecordingEvidenceStep;
}): Promise<RecordingEvidenceReview> {
  const request = input.requestStep ?? requestRecordingEvidenceStep;
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const sources = input.fixtures.map(({ actual: _actual, ...fixture }) => fixture);
  const sourceKey = hash({
    contract: 'recording-evidence-v3',
    evidenceMode: input.evidenceMode ?? 'paired',
    operation: input.operation,
    sources,
  });
  const actualOutputs = input.fixtures.map(({ id, actual }) => ({ id, actual }));
  const actualKey = hash(actualOutputs);
  writeFileSync(
    join(input.directory, `${sourceKey}-${actualKey}.outputs.json`),
    JSON.stringify(actualOutputs),
  );
  const reportPath = join(input.directory, `${sourceKey}-${actualKey}.review.json`);
  if (existsSync(reportPath)) return JSON.parse(readFileSync(reportPath, 'utf8'));
  const finish = (review: RecordingEvidenceReview): RecordingEvidenceReview => {
    const result = {
      ...review,
      reason:
        input.evidenceMode === 'live_only_missing_recording' && review.status === 'passed'
          ? `Live-response parser review passed; the recorded response body was unavailable. ${review.reason}`
          : review.reason,
      reportPath,
    };
    writeFileSync(reportPath, JSON.stringify(result, null, 2));
    return result;
  };
  writeFileSync(join(input.directory, `${sourceKey}.sources.json`), JSON.stringify(sources));
  const sourcesComplete =
    input.evidenceMode === 'live_only_missing_recording'
      ? sources.length === 1 &&
        sources[0]?.origin === 'live' &&
        Boolean(sources[0]?.recordedRequests?.length)
      : sources.some(({ origin }) => origin === 'recording') &&
        sources.some(({ origin }) => origin === 'live');
  if (!sourcesComplete) {
    return finish({
      status: 'unverified',
      reason:
        input.evidenceMode === 'live_only_missing_recording'
          ? 'Live-only review requires one retained live response and its recorded request metadata.'
          : 'Both a recording case and matched live raw responses are required.',
    });
  }
  if (new Set(sources.map(({ id }) => id)).size !== sources.length)
    throw new Error('Duplicate evidence case id');
  const sourceTexts = new Map(sources.map((fixture) => [fixture.id, text(fixture.responses)]));
  // The preview wraps responses in JSON; literal wire bytes have different escaping.
  const citationTexts = new Map(
    sources.map(({ id, responses }) => [
      id,
      [text(responses), ...responses.filter((response) => typeof response === 'string')],
    ]),
  );
  const factsPath = join(input.directory, `${sourceKey}.expectations.json`);
  let expectations: z.infer<typeof FactsSchema>[] | undefined;
  if (existsSync(factsPath))
    expectations = z.array(FactsSchema).parse(JSON.parse(readFileSync(factsPath, 'utf8')));
  const analyzer =
    input.agent.analyzer ??
    resolveProvider({ provider: input.agent.provider, model: input.agent.model });
  const phaseAgent = () => {
    const deadlineMs = Math.min(
      input.agent.runDeadline?.deadlineMs ?? input.agent.deadlineMs ?? Number.POSITIVE_INFINITY,
      Date.now() + 300_000,
    );
    return {
      ...input.agent,
      analyzer,
      timeoutMs: undefined,
      deadlineMs,
      runDeadline: boundedRunDeadline(input.agent.runDeadline, deadlineMs),
    };
  };
  for (const phase of ['expectations', 'evaluation'] as const) {
    if (phase === 'expectations' && expectations) continue;
    // Raw-source inspection and parser evaluation each receive their own budget.
    // A phase deadline is a provider interruption, not a verdict on retained
    // evidence. Retry the same turn with its conversation and frozen facts.
    let agent = phaseAgent();
    let deadlineRetries = 0;
    const texts =
      phase === 'expectations'
        ? sourceTexts
        : new Map(input.fixtures.map(({ id, actual }) => [id, text(actual)]));
    let payload: unknown = {
      phase,
      evidenceMode: input.evidenceMode ?? 'paired',
      currentDate: new Date().toISOString().slice(0, 10),
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
    // Complex nested responses can need several corrected projections. Keep
    // reads bounded while allowing the reviewer to finish from full evidence.
    for (let turn = 0; turn <= MAX_EVIDENCE_INSPECTIONS; turn++) {
      let decision: z.infer<typeof StepSchema>;
      while (true) {
        try {
          decision = await request(
            payload,
            StepSchema,
            agent,
            `evidence:${sourceKey}:${phase}:${phase === 'evaluation' ? actualKey : ''}`,
          );
          break;
        } catch (error) {
          const control = providerControlError(error);
          if (
            !(control instanceof ProviderDeadlineError) ||
            control.scope !== 'phase' ||
            input.agent.signal?.aborted ||
            Date.now() >=
              (input.agent.runDeadline?.deadlineMs ??
                input.agent.deadlineMs ??
                Number.POSITIVE_INFINITY)
          )
            throw error;
          deadlineRetries++;
          appendFileSync(
            join(input.directory, `${sourceKey}-${actualKey}.retries.jsonl`),
            `${JSON.stringify({
              phase,
              turn,
              attempt: deadlineRetries,
              timestamp: new Date().toISOString(),
              reason: control.message,
            })}\n`,
          );
          await abortableDelay(
            Math.min(30_000, 1_000 * 2 ** Math.min(deadlineRetries - 1, 5)),
            input.agent.signal,
          );
          agent = phaseAgent();
        }
      }
      writeFileSync(
        join(input.directory, `${sourceKey}-${actualKey}.${phase}-${turn}.json`),
        JSON.stringify({ payload, decision }),
      );
      if (decision.action === 'inspect') {
        if (turn === MAX_EVIDENCE_INSPECTIONS) break;
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
              phase === 'expectations'
                ? decision.decode
                  ? decodeEvidenceResponses(
                      fixture?.responses ?? [],
                      typeof decision.decode === 'string' ? decision.decode : 'auto',
                    )
                  : fixture?.responses
                : fixture?.actual,
              decision.project,
            );
            payload = {
              phase,
              sourceId: decision.sourceId,
              projected: projected.slice(0, 32_000),
              characters: projected.length,
              truncated: projected.length > 32_000,
              remainingInspections: MAX_EVIDENCE_INSPECTIONS - 1 - turn,
            };
          } catch (error) {
            payload = {
              phase,
              sourceId: decision.sourceId,
              inspectionError: error instanceof Error ? error.message : String(error),
              remainingInspections: MAX_EVIDENCE_INSPECTIONS - 1 - turn,
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
            remainingInspections: MAX_EVIDENCE_INSPECTIONS - 1 - turn,
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
        if (decision.comparability?.status === 'unverified')
          return finish({ status: 'unverified', reason: decision.comparability.reason });
        const proposed = decision.expectations;
        const ids = proposed.map(({ sourceId }) => sourceId);
        const invalidCitations = proposed.flatMap(({ sourceId, facts }) =>
          facts.flatMap(({ quote }, index) =>
            citationTexts.get(sourceId)?.some((source) => source.includes(quote))
              ? []
              : [{ sourceId, factIndex: index, quote }],
          ),
        );
        if (
          ids.length !== sources.length ||
          new Set(ids).size !== ids.length ||
          sources.some(({ id }) => !ids.includes(id)) ||
          invalidCitations.length ||
          !decision.comparability
        ) {
          payload = {
            phase,
            validationError:
              'Independent expectations must cover each source once, cite literal raw evidence, and include an explicit comparability assessment. Decoded projections may use different escaping. Repair the proof against existing evidence; parser output is still hidden.',
            requiredSourceIds: sources.map(({ id }) => id),
            invalidCitations,
            remainingInspections: Math.max(0, MAX_EVIDENCE_INSPECTIONS - 1 - turn),
          };
          inspections.push(payload);
          if (input.agent.provider !== 'codex-cli')
            payload = { initial: initialPayload, inspections };
          continue;
        }
        expectations = proposed;
        writeFileSync(
          join(input.directory, `${sourceKey}.comparability.json`),
          JSON.stringify(decision.comparability, null, 2),
        );
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
