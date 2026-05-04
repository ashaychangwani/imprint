/** YAML → Playbook (Zod-validated). */

import YAML from 'yaml';
import { type Playbook, PlaybookSchema } from './types.ts';

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
