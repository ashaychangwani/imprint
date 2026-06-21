// Isolated detect-candidates probe: runs ONLY the candidate-detection stage
// against a triaged session N times, to measure whether multi-tool segmentation
// is stable (vs the prior 3->1 collapse). No other pipeline stage runs.
//
// Usage: bun run scripts/probe-detect-candidates.ts <triaged-session.json> [runs]
import { readFileSync } from 'node:fs';
import { detectToolCandidates } from '../src/imprint/tool-candidates.ts';
import type { Session } from '../src/imprint/types.ts';

const sessionPath = process.argv[2];
const runs = Number(process.argv[3] ?? '5');
if (!sessionPath) {
  console.error('usage: bun run scripts/probe-detect-candidates.ts <triaged-session.json> [runs]');
  process.exit(1);
}

const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as Session;
console.log(`[probe] session=${sessionPath} site=${session.site} runs=${runs}`);

const summary: Array<{ run: number; count: number; tools: string[] }> = [];
for (let i = 1; i <= runs; i++) {
  const t0 = Date.now();
  try {
    const det = await detectToolCandidates(
      session,
      { provider: 'claude-cli' },
      { trustSessionScope: true },
    );
    const tools = det.candidates.map(
      (c) => `${c.toolName}${c.primary ? '*' : ''}[${c.requestSeqs.join(',')}]`,
    );
    summary.push({
      run: i,
      count: det.candidates.length,
      tools: det.candidates.map((c) => c.toolName),
    });
    console.log(
      `\n[probe] RUN ${i}: ${det.candidates.length} candidate(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
    for (const tool of tools) console.log(`         - ${tool}`);
  } catch (err) {
    console.log(`\n[probe] RUN ${i}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    summary.push({ run: i, count: -1, tools: [] });
  }
}

console.log('\n===== SUMMARY =====');
for (const s of summary) {
  console.log(
    `run ${s.run}: ${s.count < 0 ? 'ERROR' : `${s.count} tools`} → ${s.tools.join(', ')}`,
  );
}
const ok = summary.filter((s) => s.count >= 2).length;
console.log(`\nmulti-tool (>=2) runs: ${ok}/${summary.length}`);
