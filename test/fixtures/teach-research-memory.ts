import { teachingPlanContentSha256 } from '../../src/imprint/master-teach-plan.ts';
import { TeachResearchMemory } from '../../src/imprint/teach-research-memory.ts';

export function memoryFixture(runId = 'fixture-run') {
  const objects = new Map<string, unknown>();
  return new TeachResearchMemory(runId, {
    put(value) {
      const sha256 = teachingPlanContentSha256(value);
      objects.set(sha256, structuredClone(value));
      return { path: `objects/json/${sha256.slice(7)}.json`, sha256 };
    },
    read(ref) {
      if (!objects.has(ref.sha256)) throw new Error('Unknown fixture object');
      return structuredClone(objects.get(ref.sha256));
    },
  });
}
