/**
 * Pure editable-plan snapshots for the master-driven teaching flow.
 *
 * The master supplies the complete desired plan. This module only validates
 * that snapshot and reports which compiled tools are affected by the change.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MASTER_TEACH_PLAN_VERSION = 1 as const;

const Sha256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'expected sha256:<64 lowercase hex characters>');
const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/, 'invalid stable tool id');
const canonicalText = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value === value.trim(), 'leading or trailing whitespace is not canonical');
const RelativeRefPathSchema = canonicalText(1, 1_024).refine(
  (value) =>
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[a-zA-Z]:/.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  'expected a normalized workspace-relative path',
);
const SeqListSchema = z
  .array(z.number().int().nonnegative())
  .max(50_000)
  .refine((seqs) => new Set(seqs).size === seqs.length, 'sequence list must be unique');
const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);

/** Exact semantic wire shapes. They deliberately do not default, coerce, or strip. */
export const TeachingParameterSchema = z
  .object({
    name: canonicalText(1, 128),
    type: z.enum(['string', 'number', 'boolean']).nullable(),
    description: canonicalText(1, 600).nullable(),
  })
  .strict();
export type TeachingParameter = z.infer<typeof TeachingParameterSchema>;

export const TeachingToolCandidateSchema = z
  .object({
    toolName: ToolNameSchema,
    description: canonicalText(1, 2_000),
    rationale: canonicalText(1, 4_000),
    confidence: z.number().min(0).max(1),
    primary: z.boolean(),
    requestSeqs: SeqListSchema,
    representativeSeqs: SeqListSchema,
    eventSeqs: SeqListSchema,
    expectedOutput: canonicalText(0, 2_000),
    likelyParams: z.array(TeachingParameterSchema).max(64),
    dependencySeqs: SeqListSchema,
    dependsOnTools: z.array(ToolNameSchema).max(64),
  })
  .strict();
export type TeachingToolCandidate = z.infer<typeof TeachingToolCandidateSchema>;
export type TeachingCandidateEvidence = Omit<TeachingToolCandidate, 'likelyParams'> & {
  likelyParams?: readonly TeachingParameter[];
};
export interface TeachingCandidateIssue {
  path: Array<string | number>;
  message: string;
}

/** Shared contextual validation for detector evidence, boundary advice, and plans. */
export function teachingCandidateIssues(
  candidates: readonly TeachingCandidateEvidence[],
  requestSeqs: ReadonlySet<number>,
  eventSeqs: ReadonlySet<number>,
): TeachingCandidateIssue[] {
  const issues: TeachingCandidateIssue[] = [];
  const byName = new Map<string, TeachingCandidateEvidence>();
  candidates.forEach((candidate, candidateIndex) => {
    if (byName.has(candidate.toolName))
      issues.push({ path: [candidateIndex, 'toolName'], message: 'duplicate tool name' });
    if (new Set(candidate.dependsOnTools).size !== candidate.dependsOnTools.length)
      issues.push({ path: [candidateIndex, 'dependsOnTools'], message: 'duplicate dependency' });
    for (const field of ['requestSeqs', 'representativeSeqs', 'dependencySeqs'] as const)
      candidate[field].forEach((seq, index) => {
        if (!requestSeqs.has(seq))
          issues.push({
            path: [candidateIndex, field, index],
            message: `unknown recording seq ${seq}`,
          });
      });
    const ownedRequestSeqs = new Set(candidate.requestSeqs);
    candidate.representativeSeqs.forEach((seq, index) => {
      if (!ownedRequestSeqs.has(seq))
        issues.push({
          path: [candidateIndex, 'representativeSeqs', index],
          message: `representative seq ${seq} is absent from this candidate's requestSeqs`,
        });
    });
    candidate.eventSeqs.forEach((seq, index) => {
      if (!eventSeqs.has(seq))
        issues.push({
          path: [candidateIndex, 'eventSeqs', index],
          message: `unknown recording seq ${seq}`,
        });
    });
    const params = candidate.likelyParams?.map(({ name }) => name) ?? [];
    if (new Set(params).size !== params.length)
      issues.push({ path: [candidateIndex, 'likelyParams'], message: 'duplicate parameter' });
    byName.set(candidate.toolName, candidate);
  });
  candidates.forEach((candidate, candidateIndex) => {
    candidate.dependsOnTools.forEach((name, dependencyIndex) => {
      if (name === candidate.toolName || !byName.has(name))
        issues.push({
          path: [candidateIndex, 'dependsOnTools', dependencyIndex],
          message:
            name === candidate.toolName
              ? `tool "${candidate.toolName}" cannot depend on itself`
              : `tool "${candidate.toolName}" depends on missing tool "${name}"`,
        });
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      issues.push({ path: [], message: 'tool dependency cycle' });
      return;
    }
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOnTools ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of byName.keys()) visit(name);
  return issues;
}

export const TeachingCompileContextSchema = z
  .object({
    loginRequestSeqs: SeqListSchema,
    credentialNames: z.array(canonicalText(1, 128)).max(64),
    tokenExtractionNotes: z.string().max(4_000),
    sharedHelperNotes: z.string().max(4_000),
    authRequestSeqs: SeqListSchema,
    authNotes: z.string().max(4_000),
  })
  .strict();
export type TeachingCompileContext = z.infer<typeof TeachingCompileContextSchema>;

const DetectorParameterSchema = TeachingParameterSchema.extend({
  type: z.enum(['string', 'number', 'boolean']).nullable().optional(),
  description: canonicalText(1, 600).nullable().optional(),
}).strict();
const DetectorCandidateSchema = TeachingToolCandidateSchema.extend({
  likelyParams: z.array(DetectorParameterSchema).max(64),
  eventTimeRange: z
    .object({ startTimestamp: z.number(), endTimestamp: z.number() })
    .strict()
    .optional(),
}).strict();

/** Host ingress accepts shipped optional metadata and one timestamp field, never other junk. */
export function normalizeDetectorCandidateForMaster(value: unknown): TeachingToolCandidate {
  const {
    eventTimeRange: _eventTimeRange,
    likelyParams,
    ...candidate
  } = DetectorCandidateSchema.parse(value);
  return TeachingToolCandidateSchema.parse({
    ...candidate,
    likelyParams: likelyParams.map((parameter) => ({
      name: parameter.name,
      type: parameter.type ?? null,
      description: parameter.description ?? null,
    })),
  });
}

export function normalizeDetectorCompileContextForMaster(value: unknown): TeachingCompileContext {
  return TeachingCompileContextSchema.parse(value);
}

export const ContentAddressedRefSchema = z
  .object({
    path: RelativeRefPathSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type ContentAddressedRef = z.infer<typeof ContentAddressedRefSchema>;

export const TeachingToolStrategySchema = z
  .object({
    kind: z.enum(['api', 'playbook_fallback']),
    reason: canonicalText(1, 4_000),
  })
  .strict();
export type TeachingToolStrategy = z.infer<typeof TeachingToolStrategySchema>;

export const ImplementationPlanRefSchema = ContentAddressedRefSchema.extend({
  basedOnCompileInputsSha256: Sha256Schema,
}).strict();
export type ImplementationPlanRef = z.infer<typeof ImplementationPlanRefSchema>;

export const ChainEdgeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    producerToolId: ToolIdSchema,
    producerResultPath: canonicalText(1, 512),
    consumerToolId: ToolIdSchema,
    consumerParameter: canonicalText(1, 128),
  })
  .strict()
  .refine((edge) => edge.producerToolId !== edge.consumerToolId, {
    message: 'chain edge cannot be self-referential',
  });
export type ChainEdge = z.infer<typeof ChainEdgeSchema>;

export const TeachingPlanDecisionSchema = z
  .object({
    timestamp: z.string().datetime(),
    outcome: z.enum(['initial', 'accepted', 'rejected', 'revised']),
    reason: canonicalText(1, 4_000),
    advisorRefs: z.array(ContentAddressedRefSchema).default([]),
    evidenceRefs: z.array(ContentAddressedRefSchema).default([]),
  })
  .strict();
export type TeachingPlanDecision = z.infer<typeof TeachingPlanDecisionSchema>;

export const EditableTeachingToolSchema = z
  .object({
    id: ToolIdSchema,
    candidate: TeachingToolCandidateSchema,
    compileContext: TeachingCompileContextSchema,
    evidenceRefs: z.array(ContentAddressedRefSchema).min(1),
    strategy: TeachingToolStrategySchema.optional(),
    implementationPlan: ImplementationPlanRefSchema.optional(),
  })
  .strict();
export type EditableTeachingTool = z.infer<typeof EditableTeachingToolSchema>;

export const DesiredTeachingPlanSchema = z
  .object({
    site: canonicalText(1, 255),
    recordingSha256: Sha256Schema,
    tools: z.array(EditableTeachingToolSchema).max(32),
    chainEdges: z.array(ChainEdgeSchema).max(64),
  })
  .strict();
export type DesiredTeachingPlan = z.infer<typeof DesiredTeachingPlanSchema>;

export const EditableTeachingPlanSchema = DesiredTeachingPlanSchema.extend({
  version: z.literal(MASTER_TEACH_PLAN_VERSION),
  revision: z.number().int().positive(),
  decision: TeachingPlanDecisionSchema,
}).strict();
export type EditableTeachingPlan = z.infer<typeof EditableTeachingPlanSchema>;

export interface TeachingPlanValidation {
  site: string;
  recordingSha256: string;
  requestSeqs: ReadonlySet<number>;
  eventSeqs: ReadonlySet<number>;
}

export interface TeachingPlanRevisionResult {
  plan: EditableTeachingPlan;
  replanToolIds: string[];
  recompileToolIds: string[];
  reverifyToolIds: string[];
  addedToolIds: string[];
  removedToolIds: string[];
}

export class TeachingPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeachingPlanValidationError';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalTeachingPlanJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function teachingPlanContentSha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalTeachingPlanJson(value)).digest('hex')}`;
}

function assertKnownSeqs(
  label: string,
  seqs: readonly number[],
  knownSeqs: ReadonlySet<number>,
): void {
  for (const seq of seqs) {
    if (!knownSeqs.has(seq)) {
      throw new TeachingPlanValidationError(`${label} references unknown recording seq ${seq}`);
    }
  }
}

function dependencyIds(plan: DesiredTeachingPlan): Map<string, string[]> {
  const idByName = new Map(plan.tools.map((tool) => [tool.candidate.toolName, tool.id]));
  return new Map(
    plan.tools.map((tool) => [
      tool.id,
      tool.candidate.dependsOnTools.flatMap((name) => idByName.get(name) ?? []),
    ]),
  );
}

function validateChainEdges(plan: DesiredTeachingPlan): void {
  const tools = new Map(plan.tools.map((tool) => [tool.id, tool]));
  const ids = new Set<string>();
  const tuples = new Set<string>();
  for (const edge of plan.chainEdges) {
    const tuple = canonicalTeachingPlanJson([
      edge.producerToolId,
      edge.producerResultPath,
      edge.consumerToolId,
      edge.consumerParameter,
    ]);
    if (ids.has(edge.id) || tuples.has(tuple)) {
      throw new TeachingPlanValidationError(`duplicate chain edge "${edge.id}"`);
    }
    const producer = tools.get(edge.producerToolId);
    const consumer = tools.get(edge.consumerToolId);
    if (!producer || !consumer) {
      throw new TeachingPlanValidationError(`chain edge "${edge.id}" references unknown tool`);
    }
    if (!consumer.candidate.likelyParams.some(({ name }) => name === edge.consumerParameter)) {
      throw new TeachingPlanValidationError(
        `chain edge "${edge.id}" references unknown consumer parameter`,
      );
    }
    if (!consumer.candidate.dependsOnTools.includes(producer.candidate.toolName)) {
      throw new TeachingPlanValidationError(
        `chain edge "${edge.id}" is absent from the explicit tool dependency`,
      );
    }
    ids.add(edge.id);
    tuples.add(tuple);
  }
}

export function validateDesiredTeachingPlan(
  value: unknown,
  validation: TeachingPlanValidation,
): DesiredTeachingPlan {
  const plan = DesiredTeachingPlanSchema.parse(value);
  if (plan.site !== validation.site) {
    throw new TeachingPlanValidationError(
      `plan site "${plan.site}" does not match run site "${validation.site}"`,
    );
  }
  if (plan.recordingSha256 !== validation.recordingSha256) {
    throw new TeachingPlanValidationError('plan recording hash does not match the run recording');
  }
  const ids = new Set<string>();
  const requests = validation.requestSeqs;
  const events = validation.eventSeqs;
  const candidateIssue = teachingCandidateIssues(
    plan.tools.map(({ candidate }) => candidate),
    requests,
    events,
  )[0];
  if (candidateIssue) throw new TeachingPlanValidationError(candidateIssue.message);

  for (const tool of plan.tools) {
    if (ids.has(tool.id)) throw new TeachingPlanValidationError(`duplicate tool id "${tool.id}"`);
    ids.add(tool.id);
    assertKnownSeqs(
      `tool "${tool.candidate.toolName}" compile context`,
      [...tool.compileContext.loginRequestSeqs, ...tool.compileContext.authRequestSeqs],
      requests,
    );
    if (tool.implementationPlan) {
      if (!tool.strategy) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" needs a strategy before accepting an implementation plan`,
        );
      }
      const compileInputsSha256 = teachingToolCompileInputsSha256(tool, plan.chainEdges);
      if (tool.implementationPlan.basedOnCompileInputsSha256 !== compileInputsSha256) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" implementation plan is based on stale compile inputs`,
        );
      }
    }
  }

  validateChainEdges(plan);
  return plan;
}

export function validateEditableTeachingPlan(
  value: unknown,
  validation: TeachingPlanValidation,
): EditableTeachingPlan {
  const plan = EditableTeachingPlanSchema.parse(value);
  validateDesiredTeachingPlan(
    {
      site: plan.site,
      recordingSha256: plan.recordingSha256,
      tools: plan.tools,
      chainEdges: plan.chainEdges,
    },
    validation,
  );
  return plan;
}

export function createEditableTeachingPlan(
  desiredPlan: DesiredTeachingPlan,
  options: { decision: TeachingPlanDecision },
  validation: TeachingPlanValidation,
): EditableTeachingPlan {
  const desired = validateDesiredTeachingPlan(desiredPlan, validation);
  const decision = TeachingPlanDecisionSchema.parse(options.decision);
  if (decision.outcome !== 'initial') {
    throw new TeachingPlanValidationError('the first plan decision must have outcome "initial"');
  }
  return EditableTeachingPlanSchema.parse({
    ...desired,
    version: MASTER_TEACH_PLAN_VERSION,
    revision: 1,
    decision,
  });
}

export function teachingToolCompileInputsSha256(
  tool: EditableTeachingTool,
  chainEdges: readonly ChainEdge[] = [],
): string {
  const candidate = tool.candidate;
  return teachingPlanContentSha256({
    compileContext: tool.compileContext,
    strategy: tool.strategy?.kind,
    toolName: candidate.toolName,
    description: candidate.description,
    evidenceSha256s: [...new Set(tool.evidenceRefs.map((ref) => ref.sha256))].sort(),
    requestSeqs: candidate.requestSeqs,
    representativeSeqs: candidate.representativeSeqs,
    eventSeqs: candidate.eventSeqs,
    expectedOutput: candidate.expectedOutput,
    likelyParams: candidate.likelyParams,
    dependencySeqs: candidate.dependencySeqs,
    dependsOnTools: candidate.dependsOnTools,
    chainEdges: chainEdges
      .filter(({ consumerToolId }) => consumerToolId === tool.id)
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function consumerGraph(...plans: DesiredTeachingPlan[]): Map<string, Set<string>> {
  const consumers = new Map<string, Set<string>>();
  for (const plan of plans) {
    const dependencies = dependencyIds(plan);
    for (const [consumerId, producerIds] of dependencies) {
      for (const producerId of producerIds) {
        const values = consumers.get(producerId) ?? new Set<string>();
        values.add(consumerId);
        consumers.set(producerId, values);
      }
    }
  }
  return consumers;
}

function transitiveConsumers(
  seedIds: Iterable<string>,
  graph: Map<string, Set<string>>,
): Set<string> {
  const affected = new Set(seedIds);
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const producerId = queue[index];
    if (producerId === undefined) continue;
    for (const consumerId of graph.get(producerId) ?? []) {
      if (affected.has(consumerId)) continue;
      affected.add(consumerId);
      queue.push(consumerId);
    }
  }
  return affected;
}

export function reviseEditableTeachingPlan(
  currentValue: EditableTeachingPlan,
  completeDesiredPlan: DesiredTeachingPlan,
  options: { expectedRevision: number; decision: TeachingPlanDecision },
  validation: TeachingPlanValidation,
): TeachingPlanRevisionResult {
  const current = validateEditableTeachingPlan(currentValue, validation);
  if (options.expectedRevision !== current.revision) {
    throw new TeachingPlanValidationError(
      `plan revision conflict: expected ${options.expectedRevision}, current ${current.revision}`,
    );
  }
  const desired = validateDesiredTeachingPlan(completeDesiredPlan, validation);
  if (desired.site !== current.site) {
    throw new TeachingPlanValidationError('site cannot change between plan revisions');
  }
  if (desired.recordingSha256 !== current.recordingSha256) {
    throw new TeachingPlanValidationError('recording hash cannot change between plan revisions');
  }
  const decision = TeachingPlanDecisionSchema.parse(options.decision);
  if (decision.outcome === 'initial') {
    throw new TeachingPlanValidationError('a revised plan decision cannot have outcome "initial"');
  }

  const oldById = new Map(current.tools.map((tool) => [tool.id, tool]));
  const newById = new Map(desired.tools.map((tool) => [tool.id, tool]));
  const addedToolIds = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const removedToolIds = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const replanToolIds = desired.tools
    .filter((tool) => {
      const oldTool = oldById.get(tool.id);
      if (!oldTool) return true;
      return (
        teachingToolCompileInputsSha256(oldTool, current.chainEdges) !==
        teachingToolCompileInputsSha256(tool, desired.chainEdges)
      );
    })
    .map((tool) => tool.id)
    .sort();
  const recompileToolIds = desired.tools
    .filter((tool) => {
      const oldTool = oldById.get(tool.id);
      if (!oldTool) return true;
      return (
        teachingToolCompileInputsSha256(oldTool, current.chainEdges) !==
          teachingToolCompileInputsSha256(tool, desired.chainEdges) ||
        canonicalTeachingPlanJson(oldTool.implementationPlan) !==
          canonicalTeachingPlanJson(tool.implementationPlan)
      );
    })
    .map((tool) => tool.id)
    .sort();

  const affected = transitiveConsumers(
    [...recompileToolIds, ...removedToolIds],
    consumerGraph(current, desired),
  );
  const reverifyToolIds = [...affected].filter((id) => newById.has(id)).sort();
  const plan = EditableTeachingPlanSchema.parse({
    ...desired,
    version: MASTER_TEACH_PLAN_VERSION,
    revision: current.revision + 1,
    decision,
  });

  return {
    plan,
    replanToolIds,
    recompileToolIds,
    reverifyToolIds,
    addedToolIds,
    removedToolIds,
  };
}
