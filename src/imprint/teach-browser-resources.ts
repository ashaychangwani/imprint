import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { abortSignalError, withAbortSignal } from './concurrency.ts';

let previousCheck: Promise<void> = Promise.resolve();
// The pass owns its pool and drains it on exit. A weak reference lets the host
// evict an idle pass without extending its lifetime or sharing its browser.
let retainedPool: WeakRef<Map<string, CdpBrowserFetch>> | undefined;
const activeBudgetPools = new WeakSet<Map<string, CdpBrowserFetch>>();

/** Evict idle contexts before a transport launches its next browser. Omitting
 * the key reserves the budget for a transport that does not use the CDP pool. */
export async function prepareTeachBrowserContext(
  pool: Map<string, CdpBrowserFetch> | undefined,
  selectedKey?: string,
): Promise<void> {
  if (!pool || !activeBudgetPools.has(pool)) return;
  const keep = selectedKey === undefined ? undefined : pool.get(selectedKey);
  const older = new Set<CdpBrowserFetch>();
  for (const [key, browser] of pool) {
    if (browser === keep) continue;
    pool.delete(key);
    older.add(browser);
  }
  await Promise.allSettled([...older].map((browser) => browser.close()));
}

async function drain(pool: Map<string, CdpBrowserFetch>): Promise<void> {
  const browsers = [...new Set(pool.values())];
  pool.clear();
  await Promise.allSettled(browsers.map((browser) => browser.close()));
}

async function retainLatestBrowser(pool: Map<string, CdpBrowserFetch>): Promise<void> {
  const latest = [...pool.entries()].at(-1);
  if (!latest) return;
  const older = new Set<CdpBrowserFetch>();
  for (const [key, browser] of pool) {
    if (browser === latest[1]) continue;
    pool.delete(key);
    older.add(browser);
  }
  await Promise.allSettled([...older].map((browser) => browser.close()));
}

/** Optional host resource limit; agent scheduling and auth checkpoints are unchanged. */
export async function withTeachBrowserResources<T>(
  callerPool: Map<string, CdpBrowserFetch> | undefined,
  signal: AbortSignal | undefined,
  work: (pool: Map<string, CdpBrowserFetch> | undefined) => Promise<T>,
): Promise<T> {
  if (process.env.IMPRINT_TEACH_LOW_MEMORY !== '1') return await work(callerPool);

  const ahead = previousCheck;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  previousCheck = ahead.then(() => held);
  const pool = callerPool ?? new Map<string, CdpBrowserFetch>();
  let admitted = false;
  let completed = false;
  try {
    await withAbortSignal(() => ahead, signal);
    if (signal?.aborted) throw abortSignalError(signal);
    admitted = true;
    const previous = retainedPool?.deref();
    if (previous && previous !== pool) await drain(previous);
    retainedPool = undefined;
    activeBudgetPools.add(pool);
    const result = await work(pool);
    completed = true;
    return result;
  } finally {
    try {
      if (admitted) {
        activeBudgetPools.delete(pool);
        if (callerPool && completed && !signal?.aborted) {
          await retainLatestBrowser(pool);
          retainedPool = new WeakRef(pool);
        } else {
          await drain(pool);
        }
      }
    } finally {
      release();
    }
  }
}
