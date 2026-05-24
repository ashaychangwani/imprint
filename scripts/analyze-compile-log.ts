#!/usr/bin/env bun
/**
 * Analyze a compile-log.json to understand where the agent spent its time.
 * Usage: bun run scripts/analyze-compile-log.ts <path-to-compile-log.json>
 *        bun run scripts/analyze-compile-log.ts --site <site> [--tool <tool>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';

interface LogEntry {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
  timestamp?: string;
}

interface ToolUse {
  type: 'tool_use';
  name: string;
  id: string;
  input: unknown;
}

interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

function loadLog(path: string): LogEntry[] {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function analyzeLog(entries: LogEntry[], logPath: string) {
  const toolName = logPath.split('/').at(-2) ?? '(unknown)';

  let totalToolCalls = 0;
  let readRequestCalls = 0;
  let readResponseBodyCalls = 0;
  let searchResponseBodyCalls = 0;
  let writeFileCalls = 0;
  let runBashCalls = 0;
  let runTestsCalls = 0;
  let doneCalls = 0;
  let giveUpCalls = 0;
  let assistantTurns = 0;
  let usedInlineData = false;

  const toolCallTimeline: Array<{ turn: number; tool: string; inputPreview: string }> = [];
  const writeFiles: string[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    if (entry.role !== 'assistant') continue;
    assistantTurns++;

    const content = entry.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || !block) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_use') {
        totalToolCalls++;
        const name = b.name as string;
        const input = b.input as Record<string, unknown>;

        let inputPreview = '';
        if (name === 'read_request') {
          readRequestCalls++;
          inputPreview = `seq=${input?.seq}`;
        } else if (name === 'read_response_body') {
          readResponseBodyCalls++;
          inputPreview = `seq=${input?.seq}`;
        } else if (name === 'search_response_body') {
          searchResponseBodyCalls++;
          inputPreview = `seq=${input?.seq} q="${String(input?.query ?? '').slice(0, 30)}"`;
        } else if (name === 'write_file') {
          writeFileCalls++;
          const path = String(input?.relativePath ?? '');
          writeFiles.push(path);
          inputPreview = path;
        } else if (name === 'run_bash') {
          runBashCalls++;
          inputPreview = String(input?.command ?? '').slice(0, 60);
        } else if (name === 'run_tests') {
          runTestsCalls++;
        } else if (name === 'done') {
          doneCalls++;
        } else if (name === 'give_up') {
          giveUpCalls++;
        }

        toolCallTimeline.push({ turn: assistantTurns, tool: name, inputPreview });
      }

      // Check if assistant mentions inlineData
      if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.includes('inlineData') || b.text.includes('inline data')) {
          usedInlineData = true;
        }
      }
    }
  }

  // Check for errors in tool results
  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const content = entry.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || !block) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') {
        const c = String(b.content ?? '');
        if (c.includes('STATE_MISSING') || c.includes('FORBIDDEN') || c.includes('AUTH_EXPIRED')) {
          errors.push(c.slice(0, 150));
        }
      }
    }
  }

  // Check if read_session_summary result contains inlineData
  let sessionSummaryHasInlineData = false;
  let sessionSummarySize = 0;
  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const content = entry.content;
    if (typeof content === 'string' && content.includes('inlineData')) {
      sessionSummaryHasInlineData = true;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block) {
          const b = block as Record<string, unknown>;
          const c = String(b.content ?? '');
          if (c.includes('inlineData')) {
            sessionSummaryHasInlineData = true;
            if (c.includes('read_session_summary') || c.includes('loadBearingRequests')) {
              sessionSummarySize = c.length;
            }
          }
        }
      }
    }
  }

  // Print analysis
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Tool: ${toolName}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Assistant turns: ${assistantTurns}`);
  console.log(`  Total tool calls: ${totalToolCalls}`);
  console.log(`  Session summary has inlineData: ${sessionSummaryHasInlineData}`);
  if (sessionSummarySize) console.log(`  Session summary size: ${(sessionSummarySize / 1024).toFixed(1)}KB`);
  console.log(`  Agent referenced inlineData: ${usedInlineData}`);
  console.log('');
  console.log('  Tool call breakdown:');
  console.log(`    read_session_summary: 1 (always first)`);
  console.log(`    read_request:         ${readRequestCalls}`);
  console.log(`    read_response_body:   ${readResponseBodyCalls}`);
  console.log(`    search_response_body: ${searchResponseBodyCalls}`);
  console.log(`    write_file:           ${writeFileCalls} (${writeFiles.join(', ')})`);
  console.log(`    run_bash:             ${runBashCalls}`);
  console.log(`    run_tests:            ${runTestsCalls}`);
  console.log(`    done:                 ${doneCalls}`);
  if (giveUpCalls) console.log(`    give_up:              ${giveUpCalls}`);
  console.log('');

  const explorationCalls = readRequestCalls + readResponseBodyCalls + searchResponseBodyCalls;
  const pct = totalToolCalls > 0 ? ((explorationCalls / totalToolCalls) * 100).toFixed(0) : '0';
  console.log(`  Exploration calls (read_request + read_response + search): ${explorationCalls} (${pct}% of total)`);

  if (errors.length > 0) {
    console.log(`\n  Errors encountered (${errors.length}):`);
    for (const err of errors.slice(0, 5)) {
      console.log(`    • ${err}`);
    }
  }

  // Timeline summary: first 10 and last 10 tool calls
  if (toolCallTimeline.length > 0) {
    console.log('\n  First 10 tool calls:');
    for (const tc of toolCallTimeline.slice(0, 10)) {
      console.log(`    [turn ${tc.turn}] ${tc.tool}${tc.inputPreview ? ` — ${tc.inputPreview}` : ''}`);
    }
    if (toolCallTimeline.length > 20) {
      console.log(`    ... (${toolCallTimeline.length - 20} more) ...`);
    }
    if (toolCallTimeline.length > 10) {
      console.log('  Last 10 tool calls:');
      for (const tc of toolCallTimeline.slice(-10)) {
        console.log(`    [turn ${tc.turn}] ${tc.tool}${tc.inputPreview ? ` — ${tc.inputPreview}` : ''}`);
      }
    }
  }
}

// Main
const args = process.argv.slice(2);

if (args[0] === '--site' || args.length === 0) {
  const site = args[1] ?? 'panw-canteen';
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
      const entries = loadLog(logPath);
      analyzeLog(entries, logPath);
    } catch (err) {
      console.error(`Error reading ${logPath}: ${err}`);
    }
  }
} else {
  const logPath = args[0];
  if (!logPath || !existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }
  const entries = loadLog(logPath);
  analyzeLog(entries, logPath);
}
