#!/usr/bin/env bun
/**
 * Diagnostic: call runWorkflowWithLadder N times sequentially against a real
 * anti-bot endpoint (Southwest LFC) and log which backends are tried on each
 * call. Demonstrates whether the memo path preserves cdp-replay as a fallback
 * when stealth-fetch burns out.
 *
 * Usage: bun run scripts/test-ladder-fallback.ts [calls=5]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  __resetCompileWinningBackendForTest,
  runWorkflowWithLadder,
} from '../src/imprint/backend-ladder.ts';
import { loadCredentialStore } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const N = Number(process.argv[2] ?? 5);
const wfPath = `${homedir()}/.imprint/southwest-reteach/get_low_fare_calendar/workflow.json`;

if (!readFileSync(wfPath, 'utf8')) {
  console.error(`workflow not found at ${wfPath}`);
  process.exit(1);
}

const wf = JSON.parse(readFileSync(wfPath, 'utf8')) as Workflow;
const credentials = (await loadCredentialStore(wf.site)) ?? undefined;

const params = {
  origination_airport_code: 'SJC',
  destination_airport_code: 'SAN',
  departure_date: '2026-07-01',
  trip_type: 'oneway',
  currency_code: 'USD',
  adult_passengers_count: 1,
  return_date: '',
};

__resetCompileWinningBackendForTest();

console.log(`\n${'═'.repeat(70)}`);
console.log(`Ladder fallback test: ${N} sequential calls to get_low_fare_calendar`);
console.log(`${'═'.repeat(70)}\n`);

for (let i = 1; i <= N; i++) {
  console.log(`\n── Call ${i}/${N} ──`);
  const t0 = Date.now();
  const { result, usedBackend, attempts } = await runWorkflowWithLadder({
    workflowPath: wfPath,
    params,
    credentials,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  result: ${result.ok ? 'OK' : `FAIL (${result.ok ? '' : result.error})`}`);
  console.log(`  backend: ${usedBackend}`);
  console.log(`  elapsed: ${elapsed}s`);
  console.log(`  attempts: ${attempts.map((a) => `${a.backend}:${a.outcome}`).join(' → ')}`);
  if (!result.ok) {
    console.log(`  error: ${result.message.slice(0, 150)}`);
  }
}

console.log(`\n${'═'.repeat(70)}`);
console.log('Done');
process.exit(0);
