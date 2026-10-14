import { afterEach, describe, expect, it } from 'bun:test';
import { cdpReplayPoolKey } from '../src/imprint/backend-ladder.ts';
import type { CdpBrowserFetch } from '../src/imprint/cdp-browser-fetch.ts';
import { McpCdpSessions } from '../src/imprint/mcp-cdp-sessions.ts';

const pools: McpCdpSessions[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.closeAll()));
});

function pool(idleMs = 10): McpCdpSessions {
  const value = new McpCdpSessions(idleMs);
  pools.push(value);
  return value;
}

function browser() {
  let closes = 0;
  let closed!: () => void;
  const closing = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const session: CdpBrowserFetch = {
    fetchImpl: fetch,
    ensureBootstrapped: async () => [],
    mintJar: async () => {
      throw new Error('No browser is launched by this lifecycle test');
    },
    close: async () => {
      closes++;
      closed();
    },
  };
  return { session, closing, closes: () => closes };
}

describe('MCP CDP session lifecycle', () => {
  it('idle-closes the completed tool and its memo while retaining a sibling', async () => {
    const sessions = pool();
    const first = browser();
    const sibling = browser();
    const firstKey = cdpReplayPoolKey('fixture', 'first', 'https://fixture.test/start');
    const siblingKey = cdpReplayPoolKey('fixture', 'second', 'https://fixture.test/start');
    sessions.pool.set(firstKey, first.session);
    sessions.pool.set(siblingKey, sibling.session);
    sessions.winners.set('fixture:first', 'cdp-replay');
    sessions.winners.set('fixture:second', 'fetch');

    sessions.finishCall('fixture', 'first');
    await first.closing;

    expect(sessions.pool.has(firstKey)).toBe(false);
    expect(sessions.pool.get(siblingKey)).toBe(sibling.session);
    expect(sessions.winners.has('fixture:first')).toBe(false);
    expect(sessions.winners.get('fixture:second')).toBe('fetch');
    expect(sibling.closes()).toBe(0);
  });

  it('keeps a session open during a new call and rearms idle cleanup afterward', async () => {
    const sessions = pool();
    const first = browser();
    sessions.pool.set(cdpReplayPoolKey('fixture', 'first', 'https://fixture.test/'), first.session);
    sessions.finishCall('fixture', 'first');
    sessions.beginCall('fixture', 'first');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.closes()).toBe(0);

    sessions.finishCall('fixture', 'first');
    await first.closing;
    expect(first.closes()).toBe(1);
  });

  it('timeout cleanup closes every bootstrap context for only the timed-out tool', async () => {
    const sessions = pool();
    const first = browser();
    const alternate = browser();
    const sibling = browser();
    const firstKey = cdpReplayPoolKey('fixture', 'first', 'https://fixture.test/one');
    const alternateKey = cdpReplayPoolKey('fixture', 'first', 'https://fixture.test/two');
    const siblingKey = cdpReplayPoolKey('fixture', 'first_other', 'https://fixture.test/one');
    sessions.pool.set(firstKey, first.session);
    sessions.pool.set(alternateKey, alternate.session);
    sessions.pool.set(siblingKey, sibling.session);
    sessions.winners.set('fixture:first', 'cdp-replay');
    sessions.winners.set('fixture:first_other', 'cdp-replay');
    sessions.finishCall('fixture', 'first');

    await sessions.closeTool('fixture', 'first');

    expect(first.closes()).toBe(1);
    expect(alternate.closes()).toBe(1);
    expect(sibling.closes()).toBe(0);
    expect([...sessions.pool.keys()]).toEqual([siblingKey]);
    expect([...sessions.winners.keys()]).toEqual(['fixture:first_other']);
  });

  it('shutdown clears all sessions and pending timers, including failed close operations', async () => {
    const sessions = pool();
    const first = browser();
    sessions.pool.set(cdpReplayPoolKey('fixture', 'first', 'https://fixture.test/'), first.session);
    sessions.pool.set(cdpReplayPoolKey('fixture', 'second', 'https://fixture.test/'), {
      ...first.session,
      close: async () => {
        throw new Error('fixture close failure');
      },
    });
    sessions.winners.set('fixture:first', 'cdp-replay');
    sessions.finishCall('fixture', 'first');
    await sessions.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessions.pool.size).toBe(0);
    expect(sessions.winners.size).toBe(0);
    expect(first.closes()).toBe(1);
  });
});
