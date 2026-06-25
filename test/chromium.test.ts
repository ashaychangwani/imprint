import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  defaultPlaywrightBrowsersPath,
  findChromium,
  shouldDisableChromiumSandbox,
} from '../src/imprint/chromium.ts';

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(pathJoin(tmpdir(), 'imprint-chromium-home-'));
  const oldHome = process.env.HOME;
  const oldChromiumPath = process.env.CHROMIUM_PATH;
  const oldPlaywrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.HOME = home;
  process.env.PLAYWRIGHT_BROWSERS_PATH = pathJoin(home, '.cache', 'ms-playwright');
  Reflect.deleteProperty(process.env, 'CHROMIUM_PATH');
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
    else process.env.HOME = oldHome;
    if (oldChromiumPath === undefined) Reflect.deleteProperty(process.env, 'CHROMIUM_PATH');
    else process.env.CHROMIUM_PATH = oldChromiumPath;
    if (oldPlaywrightBrowsersPath === undefined) {
      Reflect.deleteProperty(process.env, 'PLAYWRIGHT_BROWSERS_PATH');
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = oldPlaywrightBrowsersPath;
    }
  }
}

describe('findChromium', () => {
  it('finds Playwright Chromium installed in the current linux64 cache layout', () => {
    withTempHome((home) => {
      const chrome = pathJoin(
        home,
        '.cache',
        'ms-playwright',
        'chromium-1223',
        'chrome-linux64',
        'chrome',
      );
      mkdirSync(pathJoin(chrome, '..'), { recursive: true });
      writeFileSync(chrome, '');

      expect(findChromium()).toBe(chrome);
    });
  });
});

describe('defaultPlaywrightBrowsersPath', () => {
  it('prefers HERMES_HOME over an inherited PLAYWRIGHT_BROWSERS_PATH', () => {
    const oldHermesHome = process.env.HERMES_HOME;
    const oldPlaywrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HERMES_HOME = '/opt/data';
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/hermes/.playwright';
    try {
      expect(defaultPlaywrightBrowsersPath()).toBe('/opt/data/.cache/ms-playwright');
    } finally {
      if (oldHermesHome === undefined) Reflect.deleteProperty(process.env, 'HERMES_HOME');
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldPlaywrightBrowsersPath === undefined)
        Reflect.deleteProperty(process.env, 'PLAYWRIGHT_BROWSERS_PATH');
      else process.env.PLAYWRIGHT_BROWSERS_PATH = oldPlaywrightBrowsersPath;
    }
  });
});

describe('shouldDisableChromiumSandbox', () => {
  it('lets container operators force no-sandbox for locked-down Linux hosts', () => {
    const oldValue = process.env.IMPRINT_CHROMIUM_NO_SANDBOX;
    process.env.IMPRINT_CHROMIUM_NO_SANDBOX = '1';
    try {
      expect(shouldDisableChromiumSandbox()).toBe(true);
    } finally {
      if (oldValue === undefined)
        Reflect.deleteProperty(process.env, 'IMPRINT_CHROMIUM_NO_SANDBOX');
      else process.env.IMPRINT_CHROMIUM_NO_SANDBOX = oldValue;
    }
  });
});
