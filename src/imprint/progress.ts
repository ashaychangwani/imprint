/** Shared rendering helpers for compile-agent progress events.
 *  Used by the `imprint generate` CLI handler and `imprint teach` spinner
 *  so both surfaces describe the agent's activity the same human-friendly way. */

import type { CompileAgentProgress } from './compile-agent.ts';

const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  read_session_summary: 'inspecting session',
  read_request: 'examining a request',
  read_response_body: 'reading API response',
  search_response_body: 'searching response for anchors',
  write_file: 'writing artifact',
  read_file: 'reading file',
  run_bash: 'running command',
  run_tests: 'running tests',
};

export function describeAgentActivity(p: CompileAgentProgress): string {
  if (p.phase === 'thinking') return 'thinking';
  return FRIENDLY_TOOL_NAMES[p.toolName ?? ''] ?? `using ${p.toolName ?? 'tool'}`;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
