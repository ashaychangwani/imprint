/**
 * YAML ↔ Playbook conversion. Parser is just `YAML.parse` + Zod —
 * the playbook format mirrors the schema directly so there's no
 * lossy structural translation.
 *
 * Pre-refactor this was a 425-line hand-rolled markdown state machine
 * (H3 step blocks, bullet attribute parsing, comma-separated locator
 * syntax). The format change to YAML deletes all of that without
 * losing any expressiveness — both humans and the LLM compiler can
 * write either format equally well.
 */

import YAML from 'yaml';
import { type Playbook, PlaybookSchema } from './types.ts';

/**
 * Parse a playbook YAML document. Throws with the underlying YAML or
 * Zod error message — both are already informative enough.
 */
export function parsePlaybook(yaml: string): Playbook {
  let raw: unknown;
  try {
    raw = YAML.parse(yaml);
  } catch (err) {
    throw new Error(
      `Playbook YAML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = PlaybookSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Playbook failed schema validation:\n${issues}`);
  }
  return parsed.data;
}
