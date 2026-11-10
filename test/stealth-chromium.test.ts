import { describe, expect, it } from 'bun:test';
import {
  awaitPluginPageSetup,
  getStealthChromium,
  isStealthPluginAvailable,
} from '../src/imprint/stealth-chromium.ts';

describe('stealth plugin lifecycle', () => {
  it('waits for a fire-and-forget command and returns a browser-close failure to the hook caller', async () => {
    let rejectCommand: (error: Error) => void = () => {};
    const commands: string[] = [];
    const page = {
      _client: () => ({
        send: (method: string) => {
          commands.push(method);
          return new Promise<void>((_resolve, reject) => {
            rejectCommand = reject;
          });
        },
      }),
    };
    const plugin = awaitPluginPageSetup({
      async onPageCreated(target: typeof page) {
        target._client().send('Network.setUserAgentOverride');
      },
    });
    let finished = false;
    const pending = plugin.onPageCreated(page).then(() => {
      finished = true;
    });
    const observed = pending.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(commands).toEqual(['Network.setUserAgentOverride']);
    expect(finished).toBe(false);
    const failure = new Error('Target page, context or browser has been closed');
    rejectCommand(failure);
    expect(await observed).toBe(failure);
  });

  it('registers the stealth plugin once across concurrent loader calls', async () => {
    const loaders = await Promise.all(Array.from({ length: 12 }, () => getStealthChromium()));
    expect(loaders.every((launcher) => launcher === loaders[0])).toBe(true);
    expect(await isStealthPluginAvailable()).toBe(true);
    const { chromium } = await import('playwright-extra');
    expect(chromium.plugins.names.filter((name) => name === 'stealth')).toHaveLength(1);
  });
});
