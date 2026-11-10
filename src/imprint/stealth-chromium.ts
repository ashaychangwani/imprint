import { ensurePlaywrightChromiumInstalled } from './chromium.ts';

interface CompatCdpClient {
  send(method: string, parameters?: unknown): Promise<unknown>;
}
interface CompatPage {
  _client(): CompatCdpClient;
}
interface PageSetupPlugin {
  onPageCreated(page: CompatPage): Promise<void>;
}

/** Keep a plugin's fire-and-forget CDP calls inside its caught lifecycle hook. */
export function awaitPluginPageSetup<T extends PageSetupPlugin>(plugin: T): T {
  const original = plugin.onPageCreated.bind(plugin);
  plugin.onPageCreated = async (page) => {
    const commands: Promise<unknown>[] = [];
    const guardedPage = new Proxy(page, {
      get(target, property, receiver) {
        if (property !== '_client') return Reflect.get(target, property, receiver);
        return () => {
          const client = target._client();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== 'send')
                return Reflect.get(clientTarget, clientProperty, clientReceiver);
              return (method: string, parameters?: unknown) => {
                const command = clientTarget.send(method, parameters);
                // Observe immediately, even if the hook yields before it returns.
                void command.catch(() => {});
                commands.push(command);
                return command;
              };
            },
          });
        };
      },
    });
    try {
      await original(guardedPage);
    } finally {
      await Promise.all(commands);
    }
  };
  return plugin;
}

let chromiumPromise: Promise<typeof import('playwright').chromium> | undefined;
let stealthAvailable = false;

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
  chromiumPromise ??= loadStealthChromium();
  return await chromiumPromise;
}

async function loadStealthChromium(): Promise<typeof import('playwright').chromium> {
  try {
    const pwExtra = await import('playwright-extra');
    const stealthMod = await import('puppeteer-extra-plugin-stealth');
    const stealthFactory =
      (stealthMod as { default?: () => unknown }).default ??
      (stealthMod as unknown as () => unknown);
    // This upstream evasion does not await client.send. Playwright-extra catches
    // rejected hook promises, so attach the command to that hook rather than
    // allowing a browser-close race to become an unhandled rejection.
    const userAgentModule = await import(
      // @ts-expect-error The upstream evasion does not publish TypeScript declarations.
      'puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js'
    );
    const userAgentFactory = userAgentModule.default as (options: unknown) => PageSetupPlugin;
    pwExtra.chromium.plugins.setDependencyResolution('stealth/evasions/user-agent-override', ((
      options: unknown,
    ) => awaitPluginPageSetup(userAgentFactory(options))) as never);
    pwExtra.chromium.use(stealthFactory() as never);
    stealthAvailable = true;
    return pwExtra.chromium as unknown as typeof import('playwright').chromium;
  } catch {
    const pw = await import('playwright');
    return pw.chromium;
  }
}

/**
 * True when the puppeteer-extra stealth plugin is installed and WILL be applied
 * by getStealthChromium() (i.e. we're not on the vanilla-Playwright fallback).
 *
 * Callers use this to avoid stacking a manual `navigator.webdriver` patch on top
 * of the plugin's: the stealth plugin removes the property the way a real Chrome
 * does (it simply lacks `webdriver`), whereas a redundant
 * `Object.defineProperty(navigator,'webdriver',{get:()=>false})` leaves a
 * non-native property descriptor that is ITSELF a fingerprinting tell. So the
 * manual patch should only run on the vanilla fallback, where it's the only
 * protection. Import resolution is cached, so probing here is cheap.
 */
export async function isStealthPluginAvailable(): Promise<boolean> {
  await getStealthChromium();
  return stealthAvailable;
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
 * Throws if Chromium cannot be installed or started; callers translate the
 * error into their own result shape.
 */
export function getStealthExecutablePath(): string | undefined {
  return ensurePlaywrightChromiumInstalled({
    log: (message) => process.stderr.write(`[imprint] ${message}\n`),
  }).path;
}
