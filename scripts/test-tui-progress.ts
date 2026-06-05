#!/usr/bin/env bun
/**
 * Diagnostic script: tests whether the multi-progress TUI renders correctly.
 *
 * Expected behavior: you should see exactly 3 lines (one per "tool"),
 * each updating in-place. If you see lines piling up instead, the
 * terminal doesn't support the escape sequences or something is wrong.
 *
 * Usage:
 *   bun scripts/test-tui-progress.ts            # default: CPL + truncate (current fix)
 *   bun scripts/test-tui-progress.ts --cpl-raw   # CPL without truncation (old broken)
 *   bun scripts/test-tui-progress.ts --cr        # carriage-return mode (single line)
 *   bun scripts/test-tui-progress.ts --decsc     # DEC save/restore (old approach)
 *
 * Run in different terminals (iTerm2, Terminal.app, Warp, VS Code, tmux)
 * to see which escape strategy works.
 */

const mode = process.argv[2] ?? '--cpl';
const isTTY = process.stderr.isTTY ?? false;

console.error(`\n--- TUI progress test ---`);
console.error(`Mode:     ${mode}`);
console.error(`stderr:   ${isTTY ? 'TTY' : 'NOT a TTY (piped/redirected)'}`);
console.error(`Terminal: ${process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown'}`);
console.error(`TERM:     ${process.env.TERM ?? 'unset'}`);
console.error(`Columns:  ${process.stderr.columns ?? 'unknown'}`);
console.error(`Rows:     ${process.stderr.rows ?? 'unknown'}`);
console.error('');
console.error(`You should see exactly 3 lines below, each updating in-place.`);
console.error(`If lines pile up (more than 3 visible), the mode is broken.\n`);

const tools = ['load_cafe_menu', 'place_food_order', 'add_item_to_cart'];
const activities = [
  'thinking',
  'reading API response',
  'searching response for anchors',
  'running command',
  'examining a request',
  'writing code',
  'verifying output',
];

let renderedCount = 0;

function redrawCPL(lines: string[], truncate: boolean): void {
  const cols = process.stderr.columns || 80;
  let buf = '';
  if (renderedCount > 0) {
    buf += `\x1b[${renderedCount}F`; // CSI CPL: cursor up N lines
  }
  buf += '\x1b[J'; // CSI ED: erase to end of screen
  for (const line of lines) {
    const full = `│  ${line}`;
    const out = truncate && full.length >= cols ? full.slice(0, cols - 1) : full;
    buf += `${out}\n`;
  }
  process.stderr.write(buf);
  renderedCount = lines.length;
}

function redrawDECSC(lines: string[]): void {
  if (renderedCount === 0) {
    process.stderr.write('\x1b7'); // DECSC: save cursor
  } else {
    process.stderr.write('\x1b8'); // DECRC: restore cursor
  }
  let buf = '\x1b[J'; // erase to end of screen
  for (const line of lines) {
    buf += `│  ${line}\n`;
  }
  process.stderr.write(buf);
  renderedCount = lines.length;
}

function redrawCR(lines: string[]): void {
  // Single-line mode: show only the first tool, overwrite with \r
  const line = lines[0] ?? '';
  const padded = line.padEnd(process.stderr.columns ?? 80);
  process.stderr.write(`\r│  ${padded}`);
  renderedCount = 1;
}

const redraw = (lines: string[]) => {
  if (mode === '--decsc') return redrawDECSC(lines);
  if (mode === '--cr') return redrawCR(lines);
  if (mode === '--cpl-raw') return redrawCPL(lines, false);
  return redrawCPL(lines, true); // default: CPL + truncate
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

const startTimes = tools.map(() => Date.now());
const toolStates = tools.map(() => 0); // index into activities

async function tick(): Promise<void> {
  const lines = tools.map((tool, i) => {
    const activity = activities[toolStates[i]];
    const elapsed = formatElapsed(Date.now() - startTimes[i]);
    return `[imprint teach] ${tool}: Compiling • ${activity} (${elapsed})`;
  });
  redraw(lines);
}

async function run(): Promise<void> {
  if (!isTTY) {
    console.error('WARNING: stderr is not a TTY. Escape sequences will not work.');
    console.error('Run this script directly in a terminal (not piped).\n');
  }

  const totalTicks = 30;
  for (let t = 0; t < totalTicks; t++) {
    await tick();
    // Randomly advance one tool's activity
    const toolIdx = t % tools.length;
    toolStates[toolIdx] = (toolStates[toolIdx] + 1) % activities.length;
    await Bun.sleep(200);
  }

  // Final state
  await tick();
  console.error(''); // newline after progress
  console.error(`\n--- Test complete ---`);
  console.error(
    `If you saw only 3 lines updating in place above, mode "${mode}" works in this terminal.`,
  );
  console.error(
    `If you saw ${totalTicks}+ lines piling up, mode "${mode}" is BROKEN in this terminal.\n`,
  );
}

run();
