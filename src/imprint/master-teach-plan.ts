/**
 * Pure editable-plan snapshots for the master-driven teaching flow.
 *
 * The master supplies the complete desired plan. This module only validates
 * that snapshot and reports which compiled tools are affected by the change.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SharedCompileContextSchema, ToolCandidateSchema } from './tool-candidates.ts';

export const MASTER_TEACH_PLAN_VERSION = 1 as const;

const Sha256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'expected sha256:<64 lowercase hex characters>');
const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'invalid stable tool id');
const RelativeRefPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[a-zA-Z]:/.test(value) &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'expected a normalized workspace-relative path',
  );
const StrictToolCandidateSchema = ToolCandidateSchema.strict();
const StrictSharedCompileContextSchema = SharedCompileContextSchema.strict();

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
    reason: z.string().trim().min(1),
  })
  .strict();
export type TeachingToolStrategy = z.infer<typeof TeachingToolStrategySchema>;

export const ImplementationPlanRefSchema = ContentAddressedRefSchema.extend({
  basedOnCompileInputsSha256: Sha256Schema,
}).strict();
export type ImplementationPlanRef = z.infer<typeof ImplementationPlanRefSchema>;

export const TeachingPlanDecisionSchema = z
  .object({
    timestamp: z.string().datetime(),
    outcome: z.enum(['initial', 'accepted', 'rejected', 'revised']),
    reason: z.string().trim().min(1),
    advisorRefs: z.array(ContentAddressedRefSchema).default([]),
    evidenceRefs: z.array(ContentAddressedRefSchema).default([]),
  })
  .strict();
export type TeachingPlanDecision = z.infer<typeof TeachingPlanDecisionSchema>;

export const EditableTeachingToolSchema = z
  .object({
    id: ToolIdSchema,
    candidate: StrictToolCandidateSchema,
    compileContext: StrictSharedCompileContextSchema,
    evidenceRefs: z.array(ContentAddressedRefSchema).min(1),
    strategy: TeachingToolStrategySchema.optional(),
    implementationPlan: ImplementationPlanRefSchema.optional(),
  })
  .strict();
export type EditableTeachingTool = z.infer<typeof EditableTeachingToolSchema>;

export const DesiredTeachingPlanSchema = z
  .object({
    site: z.string().trim().min(1),
    recordingSha256: Sha256Schema,
    sharedContext: StrictSharedCompileContextSchema,
    tools: z.array(EditableTeachingToolSchema).min(1),
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
  recordingSeqs: ReadonlySet<number>;
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
  recordingSeqs: ReadonlySet<number>,
): void {
  for (const seq of seqs) {
    if (!recordingSeqs.has(seq)) {
      throw new TeachingPlanValidationError(`${label} references unknown recording seq ${seq}`);
    }
  }
}

function dependencyIds(plan: DesiredTeachingPlan): Map<string, string[]> {
  const idByName = new Map(plan.tools.map((tool) => [tool.candidate.toolName, tool.id]));
  return new Map(
    plan.tools.map((tool) => [
      tool.id,
      tool.candidate.dependsOnTools.map((name) => {
        const id = idByName.get(name);
        if (!id) {
          throw new TeachingPlanValidationError(
            `tool "${tool.candidate.toolName}" depends on missing tool "${name}"`,
          );
        }
        return id;
      }),
    ]),
  );
}

function assertAcyclic(plan: DesiredTeachingPlan, dependencies: Map<string, string[]>): void {
  const state = new Map<string, 'visiting' | 'visited'>();
  const nameById = new Map(plan.tools.map((tool) => [tool.id, tool.candidate.toolName]));

  function visit(id: string, trail: string[]): void {
    if (state.get(id) === 'visited') return;
    if (state.get(id) === 'visiting') {
      const cycleStart = trail.indexOf(id);
      const cycle = [...trail.slice(cycleStart), id].map((item) => nameById.get(item) ?? item);
      throw new TeachingPlanValidationError(`tool dependency cycle: ${cycle.join(' -> ')}`);
    }
    state.set(id, 'visiting');
    for (const dependency of dependencies.get(id) ?? []) visit(dependency, [...trail, id]);
    state.set(id, 'visited');
  }

  for (const tool of plan.tools) visit(tool.id, []);
}

function validateDesiredTeachingPlan(
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
  const names = new Set<string>();
  assertKnownSeqs(
    'shared context',
    [...plan.sharedContext.loginRequestSeqs, ...plan.sharedContext.authRequestSeqs],
    validation.recordingSeqs,
  );

  for (const tool of plan.tools) {
    if (ids.has(tool.id)) throw new TeachingPlanValidationError(`duplicate tool id "${tool.id}"`);
    if (names.has(tool.candidate.toolName)) {
      throw new TeachingPlanValidationError(`duplicate tool name "${tool.candidate.toolName}"`);
    }
    ids.add(tool.id);
    names.add(tool.candidate.toolName);
    assertKnownSeqs(
      `tool "${tool.candidate.toolName}" compile context`,
      [...tool.compileContext.loginRequestSeqs, ...tool.compileContext.authRequestSeqs],
      validation.recordingSeqs,
    );
    assertKnownSeqs(
      `tool "${tool.candidate.toolName}"`,
      [
        ...tool.candidate.requestSeqs,
        ...tool.candidate.representativeSeqs,
        ...tool.candidate.eventSeqs,
        ...tool.candidate.dependencySeqs,
      ],
      validation.recordingSeqs,
    );
    if (tool.implementationPlan) {
      if (!tool.strategy) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" needs a strategy before accepting an implementation plan`,
        );
      }
      const compileInputsSha256 = teachingToolCompileInputsSha256(tool);
      if (tool.implementationPlan.basedOnCompileInputsSha256 !== compileInputsSha256) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" implementation plan is based on stale compile inputs`,
        );
      }
    }
  }

  const dependencies = dependencyIds(plan);
  assertAcyclic(plan, dependencies);
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
      sharedContext: plan.sharedContext,
      tools: plan.tools,
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

export function teachingToolCompileInputsSha256(tool: EditableTeachingTool): string {
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
    eventTimeRange: candidate.eventTimeRange,
    expectedOutput: candidate.expectedOutput,
    likelyParams: candidate.likelyParams,
    dependencySeqs: candidate.dependencySeqs,
    dependsOnTools: candidate.dependsOnTools,
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
      return teachingToolCompileInputsSha256(oldTool) !== teachingToolCompileInputsSha256(tool);
    })
    .map((tool) => tool.id)
    .sort();
  const recompileToolIds = desired.tools
    .filter((tool) => {
      const oldTool = oldById.get(tool.id);
      if (!oldTool) return true;
      return (
        teachingToolCompileInputsSha256(oldTool) !== teachingToolCompileInputsSha256(tool) ||
        oldTool.implementationPlan?.sha256 !== tool.implementationPlan?.sha256
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
