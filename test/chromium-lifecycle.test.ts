import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../src/imprint/chromium.ts';

describe('Chromium profile ownership', () => {
  it('removes its temporary profile after concurrent close calls finish', async () => {
    const browser = await launchChromium({ headless: true });
    try {
      await browser.ready;
      expect(existsSync(browser.userDataDir)).toBe(true);
      writeFileSync(join(browser.userDataDir, 'fixture-cache'), 'disposable fixture');
      await Promise.all([browser.close(), browser.close()]);
      expect(existsSync(browser.userDataDir)).toBe(false);
      await browser.close();
    } finally {
      await browser.close();
    }
  }, 15_000);

  it('preserves an explicitly supplied persistent profile and its contents', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'fixture-persistent-chrome-'));
    const marker = join(profile, 'fixture-retained-state');
    writeFileSync(marker, 'fixture session state');
    const browser = await launchChromium({ headless: true, userDataDir: profile });
    try {
      await browser.ready;
      await browser.close();
      expect(readFileSync(marker, 'utf8')).toBe('fixture session state');
      expect(existsSync(profile)).toBe(true);
    } finally {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }, 15_000);

  it('cleans up a browser that exits before opening its CDP endpoint', async () => {
    const browser = await launchChromium({ headless: true, extraArgs: ['--version'] });
    await expect(browser.ready).rejects.toThrow('Chromium exited before CDP became ready');
    expect(existsSync(browser.userDataDir)).toBe(false);
    await browser.close();
  }, 15_000);

  it('cleans its owned profile when a probe host exits without calling close', async () => {
    const modulePath = new URL('../src/imprint/chromium.ts', import.meta.url).pathname;
    const source = `
      import {launchChromium} from ${JSON.stringify(modulePath)};
      const browser = await launchChromium({headless: true});
      await browser.ready;
      console.log(JSON.stringify({profile: browser.userDataDir}));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '--eval', source], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const result = JSON.parse(output.trim()) as { profile: string };
    expect(existsSync(result.profile)).toBe(false);
  }, 15_000);
});
