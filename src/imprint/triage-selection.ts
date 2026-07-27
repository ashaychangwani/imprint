import { z } from 'zod';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import type { Session } from './types.ts';

export const SharedTriageSelectionSchema = z.object({
  selectedSeqs: z.array(z.number().int().nonnegative()),
  irreversibleSeqs: z.array(z.number().int().nonnegative()).optional(),
});

export type SharedTriageSelection = z.infer<typeof SharedTriageSelectionSchema>;

export function minimalSharedTriageSelection(triage: SharedTriageSelection): SharedTriageSelection {
  return {
    selectedSeqs: triage.selectedSeqs,
    irreversibleSeqs: triage.irreversibleSeqs ?? [],
  };
}

export function applySharedTriageSelection(
  session: Session,
  triage: SharedTriageSelection,
  context: { candidate?: ToolCandidate; sharedContext?: SharedCompileContext } = {},
): Session {
  const preserveSeqs = new Set([
    ...(context.candidate?.requestSeqs ?? []),
    ...(context.candidate?.dependencySeqs ?? []),
    ...(context.sharedContext?.loginRequestSeqs ?? []),
  ]);
  const selectedSeqs = new Set([...triage.selectedSeqs, ...preserveSeqs]);
  const irreversibleSeqs = new Set(
    (triage.irreversibleSeqs ?? []).filter((seq) => selectedSeqs.has(seq)),
  );

  return {
    ...session,
    requests: session.requests
      .filter((request) => selectedSeqs.has(request.seq))
      .map((request) =>
        irreversibleSeqs.has(request.seq)
          ? { ...request, effect: 'irreversible' as const }
          : request,
      ),
  };
}
