import { cdpReplayPoolKey } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import type { ConcreteBackend } from './types.ts';

/** Lifecycle of the MCP server's tool-scoped CDP sessions and backend memo. */
export class McpCdpSessions {
  readonly pool = new Map<string, CdpBrowserFetch>();
  readonly winners = new Map<string, ConcreteBackend>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly idleMs = 5 * 60 * 1000) {}

  beginCall(site: string, toolName: string): void {
    const prefix = cdpReplayPoolKey(site, toolName, '');
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  finishCall(site: string, toolName: string): void {
    this.beginCall(site, toolName);
    const prefix = cdpReplayPoolKey(site, toolName, '');
    for (const [key, session] of this.pool) {
      if (!key.startsWith(prefix)) continue;
      const timer = setTimeout(() => {
        this.timers.delete(key);
        if (this.pool.get(key) !== session) return;
        this.pool.delete(key);
        this.winners.delete(`${site}:${toolName}`);
        void session.close().catch(() => {});
      }, this.idleMs);
      timer.unref();
      this.timers.set(key, timer);
    }
  }

  async closeTool(site: string, toolName: string): Promise<void> {
    this.beginCall(site, toolName);
    this.winners.delete(`${site}:${toolName}`);
    const prefix = cdpReplayPoolKey(site, toolName, '');
    const closing: Promise<void>[] = [];
    for (const [key, session] of this.pool) {
      if (!key.startsWith(prefix)) continue;
      this.pool.delete(key);
      closing.push(session.close().catch(() => {}));
    }
    await Promise.all(closing);
  }

  async closeAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const sessions = [...this.pool.values()];
    this.pool.clear();
    this.winners.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => {})));
  }
}
