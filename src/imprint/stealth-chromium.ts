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
