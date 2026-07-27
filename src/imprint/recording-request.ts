import type { CapturedRequest, WorkflowRequest } from './types.ts';

const TEMPLATE_PLACEHOLDER = /\$\{[^}]+\}/g;
const EMPTY_REDACTION = /\[REDACTED:v3:id=\d+:len=0\]/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a concrete recorded value against a workflow template without
 * interpreting or substituting the dynamic values themselves. */
function templateMatchesRecorded(template: string, recorded: string): boolean {
  // Structured redaction preserves the original length. A sensitive field
  // whose recorded value was empty is therefore still represented by a
  // marker, even though the executable workflow must send the empty string.
  const groundedRecorded = recorded.replace(EMPTY_REDACTION, '');
  if (template === groundedRecorded) return true;
  let cursor = 0;
  let pattern = '^';
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    pattern += '.*?';
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (cursor === 0) return false;
  pattern += `${escapeRegExp(template.slice(cursor))}$`;
  return new RegExp(pattern).test(groundedRecorded);
}

export function recordedRequestMatchesWorkflow(
  recorded: Pick<CapturedRequest, 'method' | 'url' | 'body'>,
  workflow: Pick<WorkflowRequest, 'method' | 'url' | 'body'>,
): boolean {
  return (
    recorded.method.toUpperCase() === workflow.method.toUpperCase() &&
    templateMatchesRecorded(workflow.url, recorded.url) &&
    (workflow.body === undefined
      ? recorded.body === undefined || recorded.body === ''
      : recorded.body !== undefined && templateMatchesRecorded(workflow.body, recorded.body))
  );
}
