/**
 * Reproduce southwest's ~75-90s/call audit latency in isolation.
 *
 * Mirrors the mcp-server's invocation exactly: discoverTools + loadBackendsCache
 * for the preferred order, a PERSISTENT per-site stealthCache + cdpPool, then N
 * sequential runWithLadder calls — the same path the audit drives through the
 * imprint-audit-southwest MCP server. Prints per-call wall-clock + the backend
 * that served it, so we can see whether the cost is a re-bootstrap every call
 * (cache miss) vs a one-time mint that later calls reuse.
 *
 * Usage: IMPRINT_DEBUG=1 bun run scripts/repro-southwest-latency.ts [tool] [N]
 */
import { resolveLadder, runWithLadder } from '../src/imprint/backend-ladder.ts';
import type { CdpBrowserFetch } from '../src/imprint/cdp-browser-fetch.ts';
import { imprintHomeDir } from '../src/imprint/paths.ts';
import { loadBackendsCache } from '../src/imprint/probe-backends.ts';
import type { StealthFetch } from '../src/imprint/stealth-fetch.ts';
import { discoverTools } from '../src/imprint/tool-loader.ts';
import type { ConcreteBackend } from '../src/imprint/types.ts';

const site = 'southwest';
const toolName = process.argv[2] ?? 'get_low_fare_calendar';
const N = Number(process.argv[3] ?? 3);

const assetRoot = imprintHomeDir();
const discovered = await discoverTools(assetRoot, site, '[repro]');
const base = discovered.find((t) => t.workflow.toolName === toolName);
if (!base) {
  console.error(`tool ${toolName} not found for ${site}`);
  process.exit(2);
}
// Mirror runMcpServer: attach the probed preferred backend order from the cache.
const preferredOrder = loadBackendsCache(base.site, assetRoot, base.dir)?.preferredOrder;
// biome-ignore lint/suspicious/noExplicitAny: runWithLadder only reads workflow/dir/site/preferredOrder
const tool = { ...base, preferredOrder } as any;
console.log(`tool=${toolName} preferredOrder=${tool.preferredOrder?.join(' → ') ?? '(none)'}`);

const params: Record<string, string | number | boolean> = {
  origination_airport_code: 'SJC',
  destination_airport_code: 'SAN',
  departure_date: '2026-07-15',
  trip_type: 'oneway',
  adult_passengers_count: 1,
  currency_code: 'USD',
};

const stealthCache = new Map<string, StealthFetch>();
const cdpPool = new Map<string, CdpBrowserFetch>();
// Mirror the mcp-server: a per-session winner memo whose lifetime tracks cdpPool.
const winnerCache = new Map<string, ConcreteBackend>();

for (let i = 1; i <= N; i++) {
  const ladder = resolveLadder('auto', tool.preferredOrder);
  const t0 = Date.now();
  const { result, usedBackend, attempts } = await runWithLadder(
    ladder,
    tool,
    params,
    assetRoot,
    stealthCache,
    { cdpPool, winnerCache },
  );
  const ms = Date.now() - t0;
  const trail = attempts.map((a) => `${a.backend}:${a.outcome}/${a.durationMs}ms`).join(' → ');
  console.log(
    `\n>>> call ${i}: ${ms}ms backend=${usedBackend} ok=${result.ok}${result.ok ? '' : ` error=${result.error}`}\n    attempts: ${trail}`,
  );
}

for (const cf of cdpPool.values()) await cf.close().catch(() => {});
process.exit(0);
