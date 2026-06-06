/**
 * demo-teach.ts — a faithful, screen-recordable replay of a real `imprint teach` run.
 *
 * Every beat, glyph, and number below is taken verbatim from a real
 * `imprint teach google-flights` run (6 recordings -> 4 tools), rendered with the
 * same @clack/prompts visual language the live CLI uses (┌ │ ◇ ● ◆ ◒◐◓◑). Timing is
 * compressed (~30s vs the real ~hour) but the shape is identical, so a screen
 * recording of this is a faithful representation of how `imprint teach` looks.
 *
 *   bun scripts/demo-teach.ts              # animate (record this)
 *   DEMO_SPEED=2 bun scripts/demo-teach.ts # 2x faster
 *   bun scripts/demo-teach.ts --static     # print the final frame, no animation
 *
 * To (re)generate the GIF used in the README + website: `vhs scripts/demo-teach.tape`.
 */
const SPEED = Number(process.env.DEMO_SPEED ?? '1') || 1;
const STATIC = process.argv.includes('--static');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m', yellow: '\x1b[33m', gray: '\x1b[90m',
};
const SPIN = ['◒', '◐', '◓', '◑'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / SPEED));
const out = (s: string) => process.stdout.write(s);
const CLEAR = '\r\x1b[2K';

/** Lines that make up the final committed frame (for --static / the website). */
const committed: string[] = [];
function commit(line = '') {
  committed.push(line);
}

// ── plain-text version of each committed line (no ANSI) for the website ──
function plain(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

async function typeCmd(cmd: string) {
  const line = `${C.dim}${C.reset} `;
  if (!STATIC) {
    out(`${C.gray}${C.reset}${C.dim}$${C.reset} `);
    for (const ch of cmd) { out(C.bold + ch + C.reset); await sleep(26); }
    out('\n'); await sleep(450);
  }
  commit(`$ ${cmd}`);
}

async function line(text: string, pause = 120) {
  if (!STATIC) { out(text + '\n'); await sleep(pause); }
  commit(plain(text));
}

async function spin(label: string, ms: number, commitLine: string, counter?: [number, number]) {
  if (!STATIC) {
    const end = Date.now() + ms / SPEED;
    let i = 0;
    while (Date.now() < end) {
      const f = SPIN[i % SPIN.length];
      let s = `${C.cyan}${f}${C.reset}  ${label}`;
      if (counter) {
        const [a, b] = counter;
        const cur = Math.min(b, a + Math.floor((b - a) * (1 - (end - Date.now()) / (ms / SPEED))));
        s += ` ${C.dim}${cur}/${b}${C.reset}`;
      }
      out(CLEAR + s);
      i++;
      await sleep(85);
    }
    out(CLEAR + commitLine + '\n');
    await sleep(90);
  }
  commit(plain(commitLine));
}

const SUBSTATES = [
  'thinking', 'inspecting session', 'reading API response', 'examining a request',
  'searching response for anchors', 'writing artifact', 'running command', 'running tests', 'using done',
];
async function compileTool(name: string, ms: number) {
  if (!STATIC) {
    const end = Date.now() + ms / SPEED;
    const start = Date.now();
    let i = 0;
    while (Date.now() < end) {
      const f = SPIN[i % SPIN.length];
      const sub = SUBSTATES[Math.floor(i / 4) % SUBSTATES.length];
      const secs = Math.floor((Date.now() - start) / 1000) + Math.floor((name.length * 37) % 90); // fake a realistic mm:ss
      const mmss = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      out(`${CLEAR}${C.cyan}${f}${C.reset}  ${C.dim}${name}${C.reset} • ${sub} ${C.dim}(${mmss})${C.reset}`);
      i++;
      await sleep(90);
    }
    out(`${CLEAR}${C.green}◆${C.reset}  ${name} compiled.\n`);
    await sleep(120);
  }
  commit(`◆  ${name} compiled.`);
}

async function run() {
  // Clear the screen + scrollback so a recorder (vhs) never captures the
  // launch line (e.g. `bun scripts/demo-teach.ts`) — the GIF opens clean.
  if (!STATIC) { out('\x1b[2J\x1b[3J\x1b[H'); await sleep(500); }

  await typeCmd('imprint teach google-flights');
  await line('');
  await line(`${C.cyan}┌${C.reset}  ${C.bold}imprint teach${C.reset} ${C.dim}— teaching your agent to use google-flights${C.reset}`);
  await line(`${C.dim}│${C.reset}`);
  await line(`${C.magenta}●${C.reset}  Auto-combining 6 session(s) for "google-flights".`);
  await line(`${C.green}◇${C.reset}  Combined 6 sessions ${C.dim}(1044 requests, 26 narrations).${C.reset}`);
  await line(`${C.green}◇${C.reset}  Redacted 0 value(s) across 0 request(s) and 31 cookie(s).`);
  await spin('Replaying recording', 1600, `${C.magenta}●${C.reset}  Dual-pass diff: ${C.bold}1103 ephemeral values${C.reset} ${C.dim}(980 minted · 123 server-derived).${C.reset}`, [1, 271]);
  await line(`${C.green}◇${C.reset}  Replay complete.`);
  await spin('Triaging requests', 1300, `${C.green}◇${C.reset}  Triaged 285 requests → 9 candidate endpoints.`);
  await spin('Detecting candidate tools', 1500, `${C.green}◇${C.reset}  Detected ${C.bold}4 candidate tools${C.reset}.`);

  // compile-step header (clack left-rail style — aligns cleanly in plain text too)
  const box = [
    `${C.green}◇${C.reset}  ${C.bold}Compile step${C.reset}`,
    `${C.dim}│${C.reset}  Provider: ${C.cyan}claude-cli${C.reset} · Model: ${C.cyan}claude-opus-4-8${C.reset} · concurrency ${C.cyan}2${C.reset}`,
    `${C.dim}│${C.reset}  ${C.dim}4 agents reverse-engineer the tools, build _shared once,${C.reset}`,
    `${C.dim}│${C.reset}  ${C.dim}write the MCP server, run live verification on the real API.${C.reset}`,
    `${C.dim}│${C.reset}`,
  ];
  for (const b of box) await line(b, 90);

  await spin('Building shared modules under _shared/', 1700, `${C.green}◇${C.reset}  Built 2 shared modules ${C.dim}(batchexecute, flights_request).${C.reset}`);

  // per-tool compile (concurrency 2 in reality; replayed as a clean active region)
  await compileTool('lookup_airport', 2200);
  await compileTool('search_flights', 3200);
  await compileTool('get_flight_calendar_prices', 2600);
  await compileTool('get_flight_booking_details', 3000);

  await line(`${C.green}◆${C.reset}  ${C.bold}Compile summary: 4/4 tools compiled${C.reset} ${C.dim}— every tool live-verified.${C.reset}`);
  await line(`${C.dim}│${C.reset}`);
  await line(`${C.cyan}└${C.reset}  ${C.green}${C.bold}Done!${C.reset} 4 tools ready → registered as MCP server ${C.cyan}imprint-google-flights${C.reset}.`);
  if (!STATIC) out('\n');
}

await run();

if (STATIC) {
  out(committed.join('\n') + '\n');
}
