import { afterEach, describe, expect, it } from 'bun:test';
import type { CdpBrowserFetch } from '../src/imprint/cdp-browser-fetch.ts';
import {
  prepareTeachBrowserContext,
  withTeachBrowserResources,
} from '../src/imprint/teach-browser-resources.ts';

const previousMode = process.env.IMPRINT_TEACH_LOW_MEMORY;
afterEach(() => {
  process.env.IMPRINT_TEACH_LOW_MEMORY = previousMode;
});
const browser = (close: () => Promise<void>) => ({ close }) as CdpBrowserFetch;

describe('low-memory teach live checks', () => {
  it('keeps normal caller-owned browser reuse unchanged', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = undefined;
    let closed = false;
    const pool = new Map([
      [
        'fixture',
        browser(async () => {
          closed = true;
        }),
      ],
    ]);
    await withTeachBrowserResources(pool, undefined, async (actual) => {
      expect(actual).toBe(pool);
    });
    expect(closed).toBe(false);
    expect(pool.size).toBe(1);
  });

  it('retains the same pass browser and evicts it before a different pass starts', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const order: string[] = [];
    let finish = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const callerPool = new Map<string, CdpBrowserFetch>();
    const first = withTeachBrowserResources(callerPool, undefined, async (pool) => {
      expect(pool).toBe(callerPool);
      order.push('first');
      pool?.set(
        'fixture',
        browser(async () => {
          order.push('closed');
        }),
      );
      entered();
      await wait;
    });
    await started;
    const second = withTeachBrowserResources(undefined, undefined, async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    finish();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'closed', 'second']);
    expect(callerPool.size).toBe(0);
  });

  it('reuses a warm browser for successive checks in the same pass', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const pool = new Map<string, CdpBrowserFetch>();
    let launches = 0;
    let closes = 0;
    const check = () =>
      withTeachBrowserResources(pool, undefined, async (actual) => {
        if (!actual?.get('fixture')) {
          launches++;
          actual?.set(
            'fixture',
            browser(async () => {
              closes++;
            }),
          );
        }
        return actual?.get('fixture');
      });
    const first = await check();
    expect(await check()).toBe(first);
    expect(launches).toBe(1);
    expect(closes).toBe(0);
    await withTeachBrowserResources(undefined, undefined, async () => {});
    expect(closes).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('bounds retained contexts without transferring them between passes', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const first = new Map<string, CdpBrowserFetch>();
    const second = new Map<string, CdpBrowserFetch>();
    const closed: string[] = [];
    await withTeachBrowserResources(first, undefined, async (pool) => {
      pool?.set(
        'old-url',
        browser(async () => {
          closed.push('old');
        }),
      );
      pool?.set(
        'current-url',
        browser(async () => {
          closed.push('current');
        }),
      );
    });
    expect(closed).toEqual(['old']);
    expect([...first.keys()]).toEqual(['current-url']);
    await withTeachBrowserResources(second, undefined, async (pool) => {
      expect(closed).toEqual(['old', 'current']);
      expect(pool).toBe(second);
      expect(pool?.size).toBe(0);
    });
    expect(first.size).toBe(0);
  });

  it('queued cancellation cannot close the active pass browser', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const pool = new Map<string, CdpBrowserFetch>();
    let release = () => {};
    let entered = () => {};
    let closed = false;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withTeachBrowserResources(pool, undefined, async (actual) => {
      actual?.set(
        'fixture',
        browser(async () => {
          closed = true;
        }),
      );
      entered();
      await hold;
    });
    await started;
    const abort = new AbortController();
    const cancelled = withTeachBrowserResources(pool, abort.signal, async () => {
      throw new Error('Must not run');
    });
    abort.abort(new Error('Fixture cancelled'));
    await expect(cancelled).rejects.toThrow('Fixture cancelled');
    expect(closed).toBe(false);
    release();
    await first;
    expect(pool.size).toBe(1);
    await withTeachBrowserResources(undefined, undefined, async () => {});
    expect(closed).toBe(true);
  });

  it('cancels queued work without launching it or blocking later work', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    let finish = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = withTeachBrowserResources(undefined, undefined, async () => {
      entered();
      await hold;
    });
    await started;
    const abort = new AbortController();
    let launched = false;
    const second = withTeachBrowserResources(undefined, abort.signal, async () => {
      launched = true;
    }).catch((error: unknown) => error);
    abort.abort(new Error('Fixture cancelled'));
    expect(await second).toBeInstanceOf(Error);
    expect(launched).toBe(false);
    let later = false;
    const third = withTeachBrowserResources(undefined, undefined, async () => {
      later = true;
    });
    await Promise.resolve();
    expect(later).toBe(false);
    finish();
    await Promise.all([first, third]);
    expect(later).toBe(true);
  });

  it('cleans up failed checks and releases the next check', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    let closed = false;
    await expect(
      withTeachBrowserResources(undefined, undefined, async (pool) => {
        pool?.set(
          'fixture',
          browser(async () => {
            closed = true;
          }),
        );
        throw new Error('Fixture network failure');
      }),
    ).rejects.toThrow('Fixture network failure');
    expect(closed).toBe(true);
    expect(await withTeachBrowserResources(undefined, undefined, async () => 'next')).toBe('next');
  });

  it('keeps a repairable result warm but drains an active cancelled check', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const pool = new Map<string, CdpBrowserFetch>();
    let closed = false;
    const result = await withTeachBrowserResources(pool, undefined, async (actual) => {
      actual?.set(
        'fixture',
        browser(async () => {
          closed = true;
        }),
      );
      return { ok: false, error: 'BAD_RESPONSE' };
    });
    expect(result.ok).toBe(false);
    expect(closed).toBe(false);
    const abort = new AbortController();
    await withTeachBrowserResources(pool, abort.signal, async (actual) => {
      expect(actual?.get('fixture')).toBeDefined();
      abort.abort();
    });
    expect(closed).toBe(true);
    expect(pool.size).toBe(0);
  });

  it('evicts a changed context before the replacement browser launches', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    const pool = new Map<string, CdpBrowserFetch>();
    const order: string[] = [];
    await withTeachBrowserResources(pool, undefined, async (actual) => {
      actual?.set(
        'A',
        browser(async () => {
          order.push('close A');
        }),
      );
    });
    await withTeachBrowserResources(pool, undefined, async (actual) => {
      await prepareTeachBrowserContext(actual, 'A');
      expect(order).toEqual([]);
      await prepareTeachBrowserContext(actual, 'B');
      order.push('launch B');
      expect(actual?.size).toBe(0);
      actual?.set(
        'B',
        browser(async () => {
          order.push('close B');
        }),
      );
    });
    expect(order).toEqual(['close A', 'launch B']);
    await withTeachBrowserResources(pool, undefined, async (actual) => {
      await prepareTeachBrowserContext(actual);
      order.push('launch standalone bootstrap');
      expect(actual?.size).toBe(0);
    });
    expect(order).toEqual(['close A', 'launch B', 'close B', 'launch standalone bootstrap']);
  });

  it('does not evict an auth or unbudgeted caller pool', async () => {
    process.env.IMPRINT_TEACH_LOW_MEMORY = '1';
    let closed = false;
    const pool = new Map([
      [
        'auth',
        browser(async () => {
          closed = true;
        }),
      ],
    ]);
    await prepareTeachBrowserContext(pool, 'different');
    expect(closed).toBe(false);
    expect(pool.size).toBe(1);
  });
});
