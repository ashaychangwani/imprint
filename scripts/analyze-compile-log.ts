#!/usr/bin/env bun
/**
 * Analyze a compile-log.json to understand, turn by turn, where the compile
 * agent spent its time.
 *
 * The log is the claude-cli stream-json event log: an array of entries with
 *   { type: 'assistant'|'user'|'system'|'result', message?, timestamp?, ... }
 * Assistant entries carry message.content blocks (thinking/text/tool_use);
 * user entries carry the tool_result AND a `timestamp` — so per-turn wall
 * durations are the delta between consecutive tool_result timestamps. Tool
 * names are MCP-prefixed (mcp__imprint-compile__run_bash → run_bash).
 *
 * (Older logs used { role, content } directly; both shapes are handled.)
 *
 * Usage: bun run scripts/analyze-compile-log.ts <path-to-compile-log.json> [--full]
 *        bun run scripts/analyze-compile-log.ts --site <site> [--tool <tool>] [--full]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

interface RawEntry {
  type?: string;
  role?: string;
  message?: { content?: unknown };
  content?: unknown;
  timestamp?: string;
}

interface Turn {
  index: number;
  tool: string;
  preview: string;
  durationMs: number | null;
  resultText: string;
}

/** Normalize an entry to { role, blocks, ts } across both log shapes. */
function normalize(entry: RawEntry): { role: string; blocks: unknown[]; ts: number | null } {
  const role = entry.type ?? entry.role ?? '';
  let blocks: unknown[] = [];
  if (entry.message && Array.isArray((entry.message as { content?: unknown }).content)) {
    blocks = (entry.message as { content: unknown[] }).content;
  } else if (Array.isArray(entry.content)) {
    blocks = entry.content;
  }
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;
  return { role, blocks, ts };
}

function stripMcp(name: string): string {
  return name.replace(/^mcp__.*?__/, '');
}

function previewOf(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  if (tool === 'run_bash') return String(i.command ?? i.cmd ?? '').replace(/\s+/g, ' ').slice(0, 80);
  if (tool === 'write_file') return String(i.relativePath ?? i.path ?? i.file ?? '');
  if (tool === 'read_request' || tool === 'read_response_body')
    return `seq=${i.seq ?? i.sequence ?? '?'}`;
  if (tool === 'search_response_body')
    return `seq=${i.seq ?? '?'} q="${String(i.query ?? '').slice(0, 30)}"`;
  if (tool === 'run_tests') return String(i.file ?? i.path ?? '');
  if (tool === 'done' || tool === 'give_up') return String((i.summary ?? '') as string).slice(0, 50);
  return JSON.stringify(i).slice(0, 50);
}

function analyzeLog(entries: RawEntry[], logPath: string, full: boolean) {
  const toolName = logPath.split('/').at(-2) ?? '(unknown)';

  // 1. Collect tool_use blocks (in order) and a map of tool_use_id -> result ts/text.
  const toolUses: Array<{ name: string; input: Record<string, unknown>; id: string }> = [];
  const resultById = new Map<string, { ts: number | null; text: string }>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let sawInlineData = false;

  for (const entry of entries) {
    const { role, blocks, ts } = normalize(entry);
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }
    for (const block of blocks) {
      if (typeof block !== 'object' || !block) continue;
      const b = block as Record<string, unknown>;
      if (role === 'assistant' && b.type === 'tool_use') {
        toolUses.push({
          name: stripMcp(String(b.name ?? '')),
          input: (b.input as Record<string, unknown>) ?? {},
          id: String(b.id ?? ''),
        });
      } else if (b.type === 'text' && typeof b.text === 'string' && /inline ?data/i.test(b.text)) {
        sawInlineData = true;
      } else if (role === 'user' && b.type === 'tool_result') {
        const text =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((x) => (x as { text?: string })?.text ?? '').join('')
              : '';
        resultById.set(String(b.tool_use_id ?? ''), { ts, text });
      }
    }
  }

  // 2. Build the turn timeline with per-turn wall durations (delta between
  //    consecutive tool_result timestamps).
  const turns: Turn[] = [];
  let prevTs: number | null = null;
  toolUses.forEach((tu, idx) => {
    const res = resultById.get(tu.id) ?? { ts: null, text: '' };
    const durationMs = res.ts !== null && prevTs !== null ? res.ts - prevTs : null;
    if (res.ts !== null) prevTs = res.ts;
    turns.push({
      index: idx + 1,
      tool: tu.name,
      preview: previewOf(tu.name, tu.input),
      durationMs,
      resultText: res.text,
    });
  });

  // 3. Aggregate stats.
  const byTool = new Map<string, number>();
  for (const t of turns) byTool.set(t.tool, (byTool.get(t.tool) ?? 0) + 1);
  const doneTurns = turns.filter((t) => t.tool === 'done');
  // A `done` that is followed by more tool calls was REJECTED; the last is the
  // accepted one (if the compile shipped).
  const doneRejected = doneTurns.filter((t) => t.index < (turns.at(-1)?.index ?? 0)).length;
  const errors: string[] = [];
  for (const t of turns) {
    if (/STATE_MISSING|FORBIDDEN|AUTH_EXPIRED|RATE_LIMITED/.test(t.resultText)) {
      errors.push(`turn ${t.index} (${t.tool}): ${t.resultText.slice(0, 120)}`);
    }
  }
  const integrationTurns = turns.filter(
    (t) => t.tool === 'run_bash' && /integration\.test\.ts|runWorkflowWithLadder/.test(t.preview),
  );
  const integrationMs = integrationTurns.reduce((a, t) => a + (t.durationMs ?? 0), 0);
  const totalMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;
  const exploration = (byTool.get('read_request') ?? 0) + (byTool.get('read_response_body') ?? 0) + (byTool.get('search_response_body') ?? 0);

  const fmt = (ms: number | null) => (ms === null ? '   ?' : `${Math.round(ms / 1000)}s`);

  // 4. Print.
  console.log(`\n${'═'.repeat(72)}`);
  console.log(
    `Tool: ${toolName}   (${turns.length} tool-calls · ${(totalMs / 60000).toFixed(1)} min · ${doneTurns.length} done attempt(s))`,
  );
  console.log(`${'─'.repeat(72)}`);
  const breakdown = [...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`  Tool-call breakdown:  ${breakdown}`);
  console.log(
    `  Exploration: ${exploration} (${turns.length ? Math.round((exploration / turns.length) * 100) : 0}%)  ·  done: ${doneTurns.length} (${doneRejected} rejected, ${Math.max(0, doneTurns.length - doneRejected)} final)  ·  inlineData referenced: ${sawInlineData}`,
  );
  if (integrationTurns.length) {
    console.log(
      `  Live integration/chain runs: ${integrationTurns.length} totalling ${fmt(integrationMs)} (includes the 25s anti-flag request pacing)`,
    );
  }
  if (errors.length) {
    console.log(`\n  Backend errors in tool results (${errors.length}):`);
    for (const e of errors.slice(0, 6)) console.log(`    • ${e}`);
  }

  // Top time sinks.
  const ranked = [...turns].filter((t) => t.durationMs !== null).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  console.log('\n  Top time sinks:');
  for (const t of ranked.slice(0, 8)) {
    const rej = t.tool === 'done' && t.index < (turns.at(-1)?.index ?? 0) ? ' (REJECTED)' : '';
    console.log(`    ${fmt(t.durationMs).padStart(5)}  turn ${String(t.index).padStart(2)}  ${t.tool}${rej}  ${t.preview}`);
  }

  // Full timeline (always, when --full; otherwise first/last block is unhelpful — show all if <= 60).
  if (full || turns.length <= 60) {
    console.log('\n  Full per-turn timeline (Δ = wall time to produce that result):');
    for (const t of turns) {
      const rej = t.tool === 'done' && t.index < (turns.at(-1)?.index ?? 0) ? ' (REJECTED)' : '';
      console.log(`    ${String(t.index).padStart(2)} ${fmt(t.durationMs).padStart(5)}  ${t.tool.padEnd(20)} ${t.preview}${rej}`);
    }
  } else {
    console.log(`\n  (${turns.length} turns — pass --full for the complete per-turn timeline)`);
  }
}

function loadLog(path: string): RawEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.messages ?? parsed.conversation ?? parsed.log ?? []);
}

// Main
const args = process.argv.slice(2);
const full = args.includes('--full');

if (args[0] === '--site' || args.length === 0 || (args[0]?.startsWith('--') && args[0] !== '--full')) {
  const siteIdx = args.indexOf('--site');
  const site = siteIdx >= 0 ? (args[siteIdx + 1] ?? 'panw-canteen') : 'panw-canteen';
  const toolFilter = args.indexOf('--tool') >= 0 ? args[args.indexOf('--tool') + 1] : undefined;
  const siteDir = pathJoin(homedir(), '.imprint', site);

  if (!existsSync(siteDir)) {
    console.error(`Site directory not found: ${siteDir}`);
    process.exit(1);
  }

  const dirs = readdirSync(siteDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'sessions')
    .map((d) => d.name);

  for (const dir of dirs) {
    if (toolFilter && !dir.includes(toolFilter)) continue;
    const logPath = pathJoin(siteDir, dir, '.compile-log.json');
    if (!existsSync(logPath)) continue;
    try {
      analyzeLog(loadLog(logPath), logPath, full);
    } catch (err) {
      console.error(`Error reading ${logPath}: ${err}`);
    }
  }
} else {
  const logPath = args.find((a) => !a.startsWith('--'));
  if (!logPath || !existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }
  analyzeLog(loadLog(logPath), logPath, full);
}
