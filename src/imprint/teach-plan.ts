/** Shared-module reference pattern, mirrors build-plan.ts SHARED_MODULE_PATH_RE. */
const SHARED_MODULE_REF_RE = /_shared\/[A-Za-z0-9._-]+\.ts/g;

/** Append a correction note to a tool's free-text `parserGuidance` for any shared
 *  module the guidance still names but that was NOT verified/built (and therefore
 *  pruned). Without this, the planner's prose (e.g. "Call decodeBatchExecute from
 *  _shared/batchexecute.ts") reaches the compile LLM via read_build_plan and tells
 *  it to import a module that was never written. Pure + unit-testable; appends
 *  rather than rewrites, so still-valid guidance is preserved. */
export function correctGuidanceForPrunedModules(
  guidance: string,
  verifiedPaths: ReadonlySet<string>,
): string {
  const referenced = new Set(guidance.match(SHARED_MODULE_REF_RE) ?? []);
  const pruned = [...referenced].filter((p) => !verifiedPaths.has(p));
  if (pruned.length === 0) return guidance;
  const notes = pruned
    .map(
      (p) =>
        `NOTE: shared module ${p} was NOT built — implement its logic inline in this tool's parser.ts; do not import it.`,
    )
    .join('\n');
  return guidance ? `${guidance}\n\n${notes}` : notes;
}
