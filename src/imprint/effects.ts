import type { Workflow } from './types.ts';

export function isIrreversibleRequest(request: { effect?: string }): boolean {
  return request.effect === 'irreversible';
}

export function workflowHasIrreversibleEffect(workflow: Workflow): boolean {
  return workflow.requests.some(isIrreversibleRequest);
}
