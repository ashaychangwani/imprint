import { findChromium } from './chromium.ts';

/**
 * Shared loader for Playwright's chromium with the stealth plugin applied.
 *
 * Stealth patches navigator.webdriver, plugin enumeration, WebGL vendor
 * strings, and other headless-Chrome telltales that anti-bot services
 * (Akamai, Cloudflare, PerimeterX) detect. Vanilla headless Playwright
 * gets tarpitted or 403'd by these services; the stealth-patched chromium
 * loads the same pages in seconds.
 *
 * Falls back to vanilla `playwright` if `playwright-extra` /
 * `puppeteer-extra-plugin-stealth` are not installed (preserves the
 * graceful-degrade behavior of the original duplicated loaders in
 * playbook-runner, replay-capture, and backend-ladder).
 *
 * Throws if no Playwright is available at all — callers translate the
 * thrown error into their own result shape.
 */
export async function getStealthChromium(): Promise<typeof import('playwright').chromium> {
  try {
    const pwExtra = await import('playwright-extra');
    const stealthMod = await import('puppeteer-extra-plugin-stealth');
    const stealthFactory =
      (stealthMod as { default?: () => unknown }).default ??
      (stealthMod as unknown as () => unknown);
    pwExtra.chromium.use(stealthFactory() as never);
    return pwExtra.chromium as unknown as typeof import('playwright').chromium;
  } catch {
    const pw = await import('playwright');
    return pw.chromium;
  }
}

/**
 * Path to the same Chromium binary `imprint record` uses for the user's
 * recording session — Playwright's bundled "Google Chrome for Testing"
 * (full Chrome build), the system Chrome on macOS, or a Linux distro
 * Chrome/Chromium package, in that order of preference.
 *
 * Why this matters: by default Playwright's `chromium.launch({ headless: true })`
 * picks `chrome-headless-shell` — a separate stripped-down binary that
 * Akamai / Cloudflare / PerimeterX class anti-bot services detect at the
 * binary/TLS-fingerprint layer regardless of how thoroughly the JS-level
 * `navigator.webdriver` etc. are patched by the stealth plugin. The
 * recording browser uses the FULL Chrome binary and Akamai trusts it; the
 * replay browser using chrome-headless-shell looks like a bot. Using the
 * SAME binary for both eliminates the binary asymmetry.
 *
 * Returns `undefined` if no Chromium can be located — callers should let
 * Playwright fall back to whatever default it finds.
 */
export function getStealthExecutablePath(): string | undefined {
  try {
    return findChromium();
  } catch {
    return undefined;
  }
}
