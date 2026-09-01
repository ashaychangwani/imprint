/**
 * Pure editable-plan snapshots for the master-driven teaching flow.
 *
 * The master supplies the complete desired plan. This module only validates
 * that snapshot and reports which compiled tools are affected by the change.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WorkflowSchema } from './types.ts';

const MASTER_TEACH_PLAN_VERSION = 1 as const;

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

/** Discovery may be uncertain; an accepted implementation may not be. */
export const ConcreteTeachingParameterSchema = TeachingParameterSchema.extend({
  type: z.enum(['string', 'number', 'boolean']),
  description: canonicalText(1, 600),
}).strict();

export const TeachingToolCandidateSchema = z
  .object({
    toolName: ToolNameSchema,
    description: canonicalText(1, 2_000),
    rationale: canonicalText(1, 4_000),
    confidence: z.number().min(0).max(1),
    requestSeqs: SeqListSchema,
    representativeSeqs: SeqListSchema,
    eventSeqs: SeqListSchema,
    expectedOutput: canonicalText(0, 2_000),
    likelyParams: z.array(TeachingParameterSchema).max(64),
    dependencySeqs: SeqListSchema,
    dependsOnTools: z.array(ToolNameSchema),
  })
  .strict();
export type TeachingToolCandidate = z.infer<typeof TeachingToolCandidateSchema>;
export type TeachingCandidateEvidence = Omit<TeachingToolCandidate, 'likelyParams'> & {
  likelyParams?: readonly TeachingParameter[];
};
interface TeachingCandidateIssue {
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
type TeachingCompileContext = z.infer<typeof TeachingCompileContextSchema>;

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

/**
 * The shipped detector proposes semantics; this handoff only removes a known
 * namespace mix-up where a model copies `narration[].seq` into `eventSeqs`.
 * The master still receives the complete discovery evidence and may revise
 * every candidate boundary. Every other invalid or unknown sequence remains
 * intact so the normal strict validation rejects it.
 */
export function groundDetectorCandidateForMaster(
  value: unknown,
  recording: {
    eventSeqs: ReadonlySet<number>;
    narrationSeqs: ReadonlySet<number>;
  },
): TeachingToolCandidate {
  const candidate = normalizeDetectorCandidateForMaster(value);
  return TeachingToolCandidateSchema.parse({
    ...candidate,
    eventSeqs: candidate.eventSeqs.filter(
      (seq) => recording.eventSeqs.has(seq) || !recording.narrationSeqs.has(seq),
    ),
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

export const ArtifactRequestProvenanceSchema = z
  .object({
    artifactRequestIndex: z.number().int().nonnegative(),
    recordingRequestSeq: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactRequestProvenance = z.infer<typeof ArtifactRequestProvenanceSchema>;

export const ArtifactRequestProvenanceListSchema = z
  .array(ArtifactRequestProvenanceSchema)
  .max(256)
  .superRefine((requests, ctx) => {
    requests.forEach((request, index) => {
      if (request.artifactRequestIndex !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'artifactRequestIndex'],
          message: 'artifact request indices must be contiguous and start at zero',
        });
      }
    });
  });

const ArtifactRequestIndexListSchema = z
  .array(z.number().int().nonnegative())
  .max(256)
  .refine(
    (indices) => new Set(indices).size === indices.length,
    'artifact request indices must be unique',
  );

const VerificationScalarSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean()]);
const VerificationRequestSeqListSchema = z.array(z.number().int().nonnegative()).max(256);

const ImplementationVerificationCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/, 'invalid verification case id'),
    check: z.enum(['replay', 'live']),
    /**
     * Replay bytes are meaningful only with the inputs represented by the
     * recording. Kept optional so existing stored plans remain readable, but a
     * missing origin is not an explicit unavailable declaration and cannot
     * waive replay proof.
     */
    parameterValueOrigin: z.enum(['recorded_baseline', 'synthetic_live', 'unavailable']).optional(),
    parameterValues: z
      .array(
        z
          .object({
            parameterName: canonicalText(1, 128),
            value: VerificationScalarSchema,
          })
          .strict(),
      )
      .max(64),
    expectedResult: canonicalText(1, 2_000),
    provenance: z
      .object({
        recordingRequestSeqs: VerificationRequestSeqListSchema,
        recordingEventSeqs: SeqListSchema,
        evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(32),
      })
      .strict(),
  })
  .strict()
  .superRefine((verificationCase, ctx) => {
    if (
      verificationCase.check === 'replay' &&
      verificationCase.parameterValueOrigin === 'synthetic_live'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameterValueOrigin'],
        message: 'replay parameters cannot be synthetic live values',
      });
    }
    if (
      verificationCase.check === 'live' &&
      verificationCase.parameterValueOrigin !== undefined &&
      verificationCase.parameterValueOrigin !== 'synthetic_live'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameterValueOrigin'],
        message: 'live verification parameters must be synthetic live values',
      });
    }
    if (
      verificationCase.parameterValueOrigin === 'unavailable' &&
      verificationCase.parameterValues.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameterValues'],
        message: 'unavailable replay baseline cannot declare parameter values',
      });
    }
    const parameters = new Set<string>();
    verificationCase.parameterValues.forEach(({ parameterName }, index) => {
      if (parameters.has(parameterName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameterValues', index, 'parameterName'],
          message: 'duplicate verification-case parameter',
        });
      }
      parameters.add(parameterName);
    });
    const refs = new Set<string>();
    verificationCase.provenance.evidenceRefs.forEach((ref, index) => {
      const key = canonicalTeachingPlanJson(ref);
      if (refs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provenance', 'evidenceRefs', index],
          message: 'duplicate verification-case evidence ref',
        });
      }
      refs.add(key);
    });
  });

export const ImplementationPlanPayloadSchema = z
  .object({
    version: z.literal(1),
    toolId: ToolIdSchema,
    strategyKind: z.enum(['api', 'playbook_fallback']),
    requestProvenance: ArtifactRequestProvenanceListSchema,
    parameterMappings: z
      .array(
        z
          .object({
            parameterName: canonicalText(1, 128),
            artifactRequestIndices: ArtifactRequestIndexListSchema,
            guidance: canonicalText(1, 1_000),
          })
          .strict(),
      )
      .max(64),
    responseDependencies: z
      .array(
        z
          .object({
            producerArtifactRequestIndex: z.number().int().nonnegative(),
            consumerArtifactRequestIndex: z.number().int().nonnegative(),
            responsePath: canonicalText(1, 512),
            consumerTarget: canonicalText(1, 512),
            guidance: canonicalText(1, 1_000),
          })
          .strict(),
      )
      .max(256),
    resultSources: z
      .array(
        z
          .object({
            artifactRequestIndex: z.number().int().nonnegative().nullable(),
            source: canonicalText(1, 1_000),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    outputGuidance: canonicalText(1, 2_000),
    verificationCases: z.array(ImplementationVerificationCaseSchema).min(1).max(32),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.strategyKind === 'api' && plan.requestProvenance.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestProvenance'],
        message: 'API implementation plans require recorded request provenance',
      });
    }
    if (plan.strategyKind === 'playbook_fallback' && plan.requestProvenance.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestProvenance'],
        message: 'playbook implementation plans cannot declare API request provenance',
      });
    }
    const requestCount = plan.requestProvenance.length;
    const checkIndex = (value: number, path: Array<string | number>) => {
      if (value >= requestCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `unknown artifact request index ${value}`,
        });
      }
    };
    const parameters = new Set<string>();
    plan.parameterMappings.forEach((mapping, mappingIndex) => {
      if (parameters.has(mapping.parameterName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameterMappings', mappingIndex, 'parameterName'],
          message: 'duplicate parameter mapping',
        });
      }
      mapping.artifactRequestIndices.forEach((requestIndex, index) =>
        checkIndex(requestIndex, [
          'parameterMappings',
          mappingIndex,
          'artifactRequestIndices',
          index,
        ]),
      );
      parameters.add(mapping.parameterName);
    });
    plan.responseDependencies.forEach((dependency, index) => {
      checkIndex(dependency.producerArtifactRequestIndex, [
        'responseDependencies',
        index,
        'producerArtifactRequestIndex',
      ]);
      checkIndex(dependency.consumerArtifactRequestIndex, [
        'responseDependencies',
        index,
        'consumerArtifactRequestIndex',
      ]);
      if (dependency.producerArtifactRequestIndex >= dependency.consumerArtifactRequestIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responseDependencies', index],
          message: 'a response dependency must come from an earlier artifact request',
        });
      }
    });
    plan.resultSources.forEach((source, index) => {
      if (source.artifactRequestIndex !== null) {
        checkIndex(source.artifactRequestIndex, ['resultSources', index, 'artifactRequestIndex']);
      }
    });
    const verificationCaseIds = new Set<string>();
    const verificationChecks = new Set<'replay' | 'live'>();
    let replayCaseCount = 0;
    const exactReplayProvenance = canonicalTeachingPlanJson(
      plan.requestProvenance.map(({ recordingRequestSeq }) => recordingRequestSeq),
    );
    plan.verificationCases.forEach((verificationCase, index) => {
      if (verificationCaseIds.has(verificationCase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verificationCases', index, 'id'],
          message: 'duplicate verification case id',
        });
      }
      verificationCaseIds.add(verificationCase.id);
      verificationChecks.add(verificationCase.check);
      if (verificationCase.check !== 'replay') return;
      replayCaseCount += 1;
      if (plan.strategyKind !== 'api') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verificationCases', index, 'check'],
          message: 'playbook implementation plans cannot declare replay verification cases',
        });
      }
      if (
        canonicalTeachingPlanJson(verificationCase.provenance.recordingRequestSeqs) !==
        exactReplayProvenance
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verificationCases', index, 'provenance', 'recordingRequestSeqs'],
          message: 'replay verification case must bind the exact request provenance',
        });
      }
    });
    if (!verificationChecks.has('live')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationCases'],
        message: 'implementation plans require at least one live verification case',
      });
    }
    if (plan.strategyKind === 'api' && replayCaseCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationCases'],
        message: 'API implementation plans require exactly one replay verification case',
      });
    }
  });
export type ImplementationPlanPayload = z.infer<typeof ImplementationPlanPayloadSchema>;

export type ReplayParameterValueOrigin = 'recorded_baseline' | 'unavailable';

/** Value-free replay-baseline metadata carried beside the content-addressed plan. */
export function implementationPlanReplayParameterValueOrigin(
  value: ImplementationPlanPayload,
): ReplayParameterValueOrigin | undefined {
  const origin = value.verificationCases.find(
    ({ check }) => check === 'replay',
  )?.parameterValueOrigin;
  return origin === 'recorded_baseline' || origin === 'unavailable' ? origin : undefined;
}

export function implementationPlanRequestProvenanceSha256(
  value: ImplementationPlanPayload | readonly ArtifactRequestProvenance[],
): string {
  const requests = 'requestProvenance' in value ? value.requestProvenance : value;
  return teachingPlanContentSha256(requests);
}

export const ImplementationPlanRefSchema = ContentAddressedRefSchema.extend({
  basedOnCompileInputsSha256: Sha256Schema,
  requestProvenanceSha256: Sha256Schema,
  replayParameterValueOrigin: z.enum(['recorded_baseline', 'unavailable']).optional(),
}).strict();
type ImplementationPlanRef = z.infer<typeof ImplementationPlanRefSchema>;

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

/**
 * The master chooses the build hierarchy. The host only checks that the
 * hierarchy is complete and respects the dependencies the master declared.
 */
const TeachingBuildWavesSchema = z.array(z.array(ToolIdSchema).min(1));
type TeachingBuildWaves = z.infer<typeof TeachingBuildWavesSchema>;

/**
 * Durable accounting for the detector's original operation inventory. Several
 * discoveries may merge into one public tool, and one discovery may split into
 * several tools. An unsupported detector proposal may be explicitly excluded;
 * an unresolved entry remains unfinished and cannot be promoted.
 */
const CandidateCoverageSchema = z
  .object({
    discoveryCandidateName: ToolNameSchema,
    plannedToolIds: z.array(ToolIdSchema),
    unresolvedReason: canonicalText(1, 2_000).nullable(),
    excludedReason: canonicalText(1, 2_000).nullable().optional(),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (new Set(coverage.plannedToolIds).size !== coverage.plannedToolIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannedToolIds'],
        message: 'candidate coverage tool ids must be unique',
      });
    }
    const planned = coverage.plannedToolIds.length > 0;
    const unresolved = coverage.unresolvedReason !== null;
    const excluded = coverage.excludedReason !== undefined && coverage.excludedReason !== null;
    if (Number(planned) + Number(unresolved) + Number(excluded) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedReason'],
        message:
          'candidate coverage requires exactly one of planned tools, an unresolved reason, or an excluded reason',
      });
    }
  });
type CandidateCoverage = z.infer<typeof CandidateCoverageSchema>;

export const DesiredTeachingPlanSchema = z
  .object({
    site: canonicalText(1, 255),
    recordingSha256: Sha256Schema,
    tools: z.array(EditableTeachingToolSchema),
    candidateCoverage: z.array(CandidateCoverageSchema),
    buildWaves: TeachingBuildWavesSchema,
    chainEdges: z.array(ChainEdgeSchema),
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
  /** Original detector inventory. Required by the foreground master flow. */
  discoveryCandidateNames?: readonly string[];
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

/**
 * Produce an initial, dependency-only wave suggestion. This is deliberately
 * not authoritative: the master may choose any other grouping that passes
 * {@link validateDesiredTeachingPlan}.
 */
export function proposeDependencyBuildWaves(
  tools: readonly EditableTeachingTool[],
): TeachingBuildWaves {
  const idByName = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const tool of tools) {
    if (seenIds.has(tool.id)) {
      throw new TeachingPlanValidationError(`duplicate tool id "${tool.id}"`);
    }
    if (idByName.has(tool.candidate.toolName)) {
      throw new TeachingPlanValidationError(`duplicate tool name "${tool.candidate.toolName}"`);
    }
    seenIds.add(tool.id);
    idByName.set(tool.candidate.toolName, tool.id);
  }

  const dependencies = new Map<string, Set<string>>();
  for (const tool of tools) {
    const producerIds = new Set<string>();
    for (const dependencyName of tool.candidate.dependsOnTools) {
      const producerId = idByName.get(dependencyName);
      if (!producerId) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" depends on missing tool "${dependencyName}"`,
        );
      }
      if (producerId === tool.id) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" cannot depend on itself`,
        );
      }
      producerIds.add(producerId);
    }
    dependencies.set(tool.id, producerIds);
  }

  const completed = new Set<string>();
  let remaining = tools.map(({ id }) => id);
  const waves: string[][] = [];
  while (remaining.length > 0) {
    const wave = remaining.filter((toolId) =>
      [...(dependencies.get(toolId) ?? [])].every((producerId) => completed.has(producerId)),
    );
    if (wave.length === 0) {
      throw new TeachingPlanValidationError('tool dependency cycle');
    }
    waves.push(wave);
    for (const toolId of wave) completed.add(toolId);
    const scheduled = new Set(wave);
    remaining = remaining.filter((toolId) => !scheduled.has(toolId));
  }
  return waves;
}

function validateBuildWaves(plan: DesiredTeachingPlan): void {
  const toolById = new Map(plan.tools.map((tool) => [tool.id, tool]));
  const waveByToolId = new Map<string, number>();
  for (const [waveIndex, wave] of plan.buildWaves.entries()) {
    for (const toolId of wave) {
      if (!toolById.has(toolId)) {
        throw new TeachingPlanValidationError(
          `build wave ${waveIndex + 1} references unknown tool "${toolId}"`,
        );
      }
      if (waveByToolId.has(toolId)) {
        throw new TeachingPlanValidationError(
          `tool "${toolId}" appears more than once in build waves`,
        );
      }
      waveByToolId.set(toolId, waveIndex);
    }
  }

  for (const tool of plan.tools) {
    const consumerWave = waveByToolId.get(tool.id);
    if (consumerWave === undefined) {
      throw new TeachingPlanValidationError(
        `tool "${tool.id}" is missing from the master build waves`,
      );
    }
    for (const dependencyName of tool.candidate.dependsOnTools) {
      const producer = plan.tools.find(
        (candidate) => candidate.candidate.toolName === dependencyName,
      );
      if (!producer) continue;
      const producerWave = waveByToolId.get(producer.id);
      if (producerWave === undefined || producerWave >= consumerWave) {
        throw new TeachingPlanValidationError(
          `tool "${tool.id}" must be in a later build wave than dependency "${producer.id}"`,
        );
      }
    }
  }
}

function validateCandidateCoverage(
  plan: DesiredTeachingPlan,
  discoveryCandidateNames?: readonly string[],
): void {
  const plannedToolIds = new Set(plan.tools.map(({ id }) => id));
  const seen = new Set<string>();
  for (const coverage of plan.candidateCoverage) {
    if (seen.has(coverage.discoveryCandidateName)) {
      throw new TeachingPlanValidationError(
        `duplicate candidate coverage for "${coverage.discoveryCandidateName}"`,
      );
    }
    seen.add(coverage.discoveryCandidateName);
    for (const toolId of coverage.plannedToolIds) {
      if (!plannedToolIds.has(toolId)) {
        throw new TeachingPlanValidationError(
          `candidate coverage for "${coverage.discoveryCandidateName}" references unknown tool "${toolId}"`,
        );
      }
    }
  }
  if (!discoveryCandidateNames) return;
  const expected = new Set(discoveryCandidateNames);
  if (expected.size !== discoveryCandidateNames.length) {
    throw new TeachingPlanValidationError('original discovery candidate names must be unique');
  }
  for (const name of expected) {
    if (!seen.has(name)) {
      throw new TeachingPlanValidationError(`candidate coverage is missing "${name}"`);
    }
  }
  for (const name of seen) {
    if (!expected.has(name)) {
      throw new TeachingPlanValidationError(
        `candidate coverage references unknown discovery "${name}"`,
      );
    }
  }
}

export function unresolvedCandidateCoverage(plan: DesiredTeachingPlan): CandidateCoverage[] {
  return plan.candidateCoverage.filter(
    ({ plannedToolIds, excludedReason }) =>
      plannedToolIds.length === 0 && (excludedReason === undefined || excludedReason === null),
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

function assertConcretePublicParameters(tool: EditableTeachingTool): void {
  for (const parameter of tool.candidate.likelyParams) {
    if (parameter.type === null) {
      throw new TeachingPlanValidationError(
        `public parameter "${parameter.name}" needs a concrete scalar type before accepting an implementation plan`,
      );
    }
    if (parameter.description === null) {
      throw new TeachingPlanValidationError(
        `public parameter "${parameter.name}" needs a nonempty description before accepting an implementation plan`,
      );
    }
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
      assertConcretePublicParameters(tool);
      const compileInputsSha256 = teachingToolCompileInputsSha256(tool, plan.chainEdges);
      if (tool.implementationPlan.basedOnCompileInputsSha256 !== compileInputsSha256) {
        throw new TeachingPlanValidationError(
          `tool "${tool.candidate.toolName}" implementation plan is based on stale compile inputs`,
        );
      }
    }
  }

  validateBuildWaves(plan);
  validateCandidateCoverage(plan, validation.discoveryCandidateNames);
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
      candidateCoverage: plan.candidateCoverage,
      buildWaves: plan.buildWaves,
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
    toolId: tool.id,
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
      .flatMap((edge) => {
        if (edge.consumerToolId === tool.id) return [edge];
        if (edge.producerToolId !== tool.id) return [];
        const { consumerParameter: _consumerParameter, ...producerObligation } = edge;
        return [producerObligation];
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function validateImplementationPlanForTool(
  value: unknown,
  tool: EditableTeachingTool,
  knownRecordingRequestSeqs: ReadonlySet<number>,
  knownRecordingEventSeqs: ReadonlySet<number> = new Set(tool.candidate.eventSeqs),
): ImplementationPlanPayload {
  const plan = ImplementationPlanPayloadSchema.parse(value);
  if (plan.toolId !== tool.id) {
    throw new TeachingPlanValidationError('implementation plan belongs to another tool');
  }
  if (!tool.strategy || plan.strategyKind !== tool.strategy.kind) {
    throw new TeachingPlanValidationError('implementation plan strategy does not match the tool');
  }
  if (
    tool.implementationPlan &&
    tool.implementationPlan.replayParameterValueOrigin !==
      implementationPlanReplayParameterValueOrigin(plan)
  ) {
    throw new TeachingPlanValidationError(
      'implementation plan replay parameter origin does not match its reference',
    );
  }
  assertConcretePublicParameters(tool);
  for (const request of plan.requestProvenance) {
    if (!knownRecordingRequestSeqs.has(request.recordingRequestSeq)) {
      throw new TeachingPlanValidationError(
        `implementation plan references unknown recording seq ${request.recordingRequestSeq}`,
      );
    }
  }
  const expectedParameters = tool.candidate.likelyParams.map(({ name }) => name).sort();
  const actualParameters = plan.parameterMappings.map(({ parameterName }) => parameterName).sort();
  if (
    canonicalTeachingPlanJson(expectedParameters) !== canonicalTeachingPlanJson(actualParameters)
  ) {
    throw new TeachingPlanValidationError(
      'implementation plan parameter mappings do not match the public parameters',
    );
  }
  const declarations = new Map(
    tool.candidate.likelyParams.map((parameter) => [parameter.name, parameter]),
  );
  const authorizedEvidence = new Set(
    tool.evidenceRefs.map((ref) => canonicalTeachingPlanJson(ref)),
  );
  for (const verificationCase of plan.verificationCases) {
    const suppliedParameters = verificationCase.parameterValues
      .map(({ parameterName }) => parameterName)
      .sort();
    const baselineUnavailable =
      verificationCase.check === 'replay' &&
      verificationCase.parameterValueOrigin === 'unavailable';
    if (
      !baselineUnavailable &&
      canonicalTeachingPlanJson(suppliedParameters) !==
        canonicalTeachingPlanJson(expectedParameters)
    ) {
      throw new TeachingPlanValidationError(
        `verification case "${verificationCase.id}" parameter values do not match the public parameters`,
      );
    }
    for (const { parameterName, value } of verificationCase.parameterValues) {
      const declaration = declarations.get(parameterName);
      const valueType =
        typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
      if (!declaration || declaration.type !== valueType) {
        throw new TeachingPlanValidationError(
          `verification case "${verificationCase.id}" value for "${parameterName}" does not match its public scalar type`,
        );
      }
    }
    for (const seq of verificationCase.provenance.recordingRequestSeqs) {
      if (!knownRecordingRequestSeqs.has(seq)) {
        throw new TeachingPlanValidationError(
          `verification case "${verificationCase.id}" references unknown recording request seq ${seq}`,
        );
      }
    }
    for (const seq of verificationCase.provenance.recordingEventSeqs) {
      if (!knownRecordingEventSeqs.has(seq)) {
        throw new TeachingPlanValidationError(
          `verification case "${verificationCase.id}" references unknown recording event seq ${seq}`,
        );
      }
    }
    for (const ref of verificationCase.provenance.evidenceRefs) {
      if (!authorizedEvidence.has(canonicalTeachingPlanJson(ref))) {
        throw new TeachingPlanValidationError(
          `verification case "${verificationCase.id}" references evidence outside tool.evidenceRefs; copy the supplied authorized evidence refs exactly`,
        );
      }
    }
  }
  return plan;
}

/** Mechanical build gate: the emitted workflow must preserve accepted request provenance exactly. */
export function validateBuildWorkflowProvenance(
  workflowValue: unknown,
  implementationPlanValue: unknown,
): z.infer<typeof WorkflowSchema> {
  const workflow = WorkflowSchema.parse(workflowValue);
  const implementationPlan = ImplementationPlanPayloadSchema.parse(implementationPlanValue);
  const expected = implementationPlan.requestProvenance;
  if (workflow.requests.length !== expected.length) {
    throw new TeachingPlanValidationError(
      `${implementationPlan.strategyKind} workflow has ${workflow.requests.length} requests but accepted provenance has ${expected.length}`,
    );
  }
  for (const [artifactRequestIndex, request] of workflow.requests.entries()) {
    const provenance = expected[artifactRequestIndex];
    if (!provenance || provenance.artifactRequestIndex !== artifactRequestIndex) {
      throw new TeachingPlanValidationError(
        `accepted provenance is missing artifact request index ${artifactRequestIndex}`,
      );
    }
    if (request.recordingRequestSeq === undefined) {
      throw new TeachingPlanValidationError(
        `workflow request ${artifactRequestIndex} is missing recordingRequestSeq`,
      );
    }
    if (request.recordingRequestSeq !== provenance.recordingRequestSeq) {
      throw new TeachingPlanValidationError(
        `workflow request ${artifactRequestIndex} records seq ${request.recordingRequestSeq} but accepted provenance requires ${provenance.recordingRequestSeq}`,
      );
    }
  }
  return workflow;
}

export function bindImplementationPlanRef(
  contentRef: ContentAddressedRef,
  payloadValue: unknown,
  basedOnCompileInputsSha256: string,
): ImplementationPlanRef {
  const payload = ImplementationPlanPayloadSchema.parse(payloadValue);
  if (contentRef.sha256 !== teachingPlanContentSha256(payload)) {
    throw new TeachingPlanValidationError('implementation plan content ref hash mismatch');
  }
  const replayParameterValueOrigin = implementationPlanReplayParameterValueOrigin(payload);
  return ImplementationPlanRefSchema.parse({
    ...contentRef,
    basedOnCompileInputsSha256,
    requestProvenanceSha256: implementationPlanRequestProvenanceSha256(payload),
    ...(replayParameterValueOrigin ? { replayParameterValueOrigin } : {}),
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
