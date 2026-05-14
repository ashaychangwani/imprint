/** YAML → Playbook (Zod-validated). */

import YAML from 'yaml';
import { type Playbook, PlaybookSchema } from './types.ts';

/**
 * Fix common LLM YAML mistakes before parsing. Lines where a scalar value
 * has mismatched or ambiguous quoting get wrapped in double quotes.
 */
function sanitizeYaml(yaml: string): string {
  return yaml.replace(/^(\s+\w+:\s+)(.+)$/gm, (_line, prefix: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('|') || trimmed.startsWith('>'))
      return _line;
    if (trimmed.startsWith("'") && !trimmed.endsWith("'")) {
      return `${prefix}"${trimmed.replace(/'/g, '').trim()}"`;
    }
    const singleQuoteCount = (trimmed.match(/'/g) || []).length;
    if (singleQuoteCount > 0 && singleQuoteCount % 2 !== 0) {
      return `${prefix}"${trimmed.replace(/'/g, '').trim()}"`;
    }
    return _line;
  });
}

export function parsePlaybook(yaml: string): Playbook {
  let raw: unknown;
  try {
    raw = YAML.parse(sanitizeYaml(yaml));
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
