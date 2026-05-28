/** Execute a parsed Playbook against a real Chromium via Playwright. */

import { existsSync, readFileSync } from 'node:fs';
import {
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import type { Browser, BrowserContext, Locator as PWLocator, Page } from 'playwright';
import { extractAt } from './json-path.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { substituteString } from './runtime.ts';
import type {
  Locator,
  Playbook,
  PlaybookResult,
  PlaybookStep,
  ToolResult,
  WaitFor,
} from './types.ts';

interface RunPlaybookOptions {
  /** Path to playbook.yaml OR an already-parsed Playbook. */
  playbook: string | Playbook;
  params: Record<string, string | number | boolean>;
  /** Run with a visible browser window. Default false (headless). */
  headed?: boolean;
  /** Per-step timeout in ms. Default 30000. */
  stepTimeoutMs?: number;
  /** Screenshot after every step (not just on failure). */
  trace?: boolean;
  /** Inject a Playwright Page for tests. */
  pageOverride?: Page;
  /** Site key — used to look up persisted cookies in the credential store
   *  and inject them into the browser context before navigation. Required
   *  for authenticated playbooks. Callers (backend-ladder, the `playbook`
   *  CLI verb) should pass it explicitly so this works regardless of
   *  whether the skill lives under `~/.imprint/`, `~/.hermes/skills/`,
   *  `~/.openclaw/skills/`, or anywhere else. */
  site?: string;
}

const log = createLog('playbook');

export async function runPlaybook(opts: RunPlaybookOptions): Promise<ToolResult> {
  let playbook: Playbook;
  let params: Record<string, string | number | boolean>;
  try {
    playbook = await loadPlaybook(opts.playbook);
    params = coerceParams(opts.params, playbook);
  } catch (err) {
    return { ok: false, error: 'UNKNOWN', message: errMsg(err) };
  }
  // Generous default — Akamai sensor JS, A/B loaders, lazy bundles all
  // need real time to settle. Tight timeouts make broken sites look
  // worse than they are.
  const stepTimeoutMs = opts.stepTimeoutMs ?? 30000;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  if (opts.pageOverride) {
    page = opts.pageOverride;
  } else {
    // playwright-extra + stealth plugin patches navigator.webdriver,
    // plugin enumeration, WebGL vendor strings, etc. Vanilla headless
    // Playwright eats a 403 from any decent enterprise site (verified:
    // Southwest 403 → 200 with stealth).
    let chromium: typeof import('playwright').chromium;
    try {
      const pwExtra = await import('playwright-extra');
      const stealthMod = await import('puppeteer-extra-plugin-stealth');
      const stealthFactory =
        (stealthMod as { default?: () => unknown }).default ??
        (stealthMod as unknown as () => unknown);
      pwExtra.chromium.use(stealthFactory() as never);
      chromium = pwExtra.chromium as unknown as typeof import('playwright').chromium;
    } catch {
      try {
        const pw = await import('playwright');
        chromium = pw.chromium;
      } catch (innerErr) {
        return {
          ok: false,
          error: 'UNKNOWN',
          message: `Playwright not available: ${errMsg(innerErr)}. Run: bunx playwright install chromium`,
        };
      }
    }
    try {
      browser = await chromium.launch({ headless: !opts.headed });
    } catch (err) {
      return {
        ok: false,
        error: 'UNKNOWN',
        message: `Could not launch Chromium: ${errMsg(err)}. Run: bunx playwright install chromium`,
      };
    }
    context = await browser.newContext();
    page = await context.newPage();

    // Inject credentials.cookies into the browser so the playbook can navigate
    // an authenticated flow (e.g., my-trips → reservation → seat map). Prefer
    // the explicit opts.site. Fall back to path inference only when the caller
    // hasn't supplied one and the playbook lives under IMPRINT_HOME.
    const site = opts.site ?? inferSiteFromPath(opts.playbook);
    if (site) {
      try {
        const { loadSiteCredentials } = await import('./credential-store.ts');
        const view = await loadSiteCredentials(site);
        const playwrightCookies = view.cookies
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
          .filter((c) => c.name && c.value);
        if (playwrightCookies.length > 0) {
          await context.addCookies(playwrightCookies);
          log(`injected ${playwrightCookies.length} cookies for site ${site}`);
        }
      } catch (err) {
        log(`failed to inject cookies: ${errMsg(err)} (proceeding without)`);
      }
    }
  }

  // Read body text inside the response handler — Playwright/CDP GCs
  // response bodies aggressively, so a lazy text() at extraction time
  // often fails with "no resource with given identifier found." Track
  // pending reads so extraction waits for them all.
  const captured: Array<{ url: string; method: string; status: number; body: string | null }> = [];
  const pendingBodyReads: Array<Promise<unknown>> = [];
  let lastStep = 0;

  try {
    page.on('response', (resp) => {
      const url = resp.url();
      const method = resp.request().method();
      const status = resp.status();
      const p = resp
        .text()
        .then((body) => captured.push({ url, method, status, body }))
        .catch(() => captured.push({ url, method, status, body: null }));
      pendingBodyReads.push(p);
    });

    for (const [i, step] of playbook.steps.entries()) {
      lastStep = i + 1;
      log(`step ${i + 1}/${playbook.steps.length}: ${step.action}`);
      await executeStep(page, step, params, stepTimeoutMs);
      if (opts.trace) {
        const traceShot = await screenshot(page, `${playbook.toolName}-trace`, lastStep);
        log(`  url=${page.url()}`);
        if (traceShot) log(`  trace screenshot: ${traceShot}`);
      }
    }
    await Promise.allSettled(pendingBodyReads);
    const data = await extractResult(page, playbook.result, captured);
    return { ok: true, data };
  } catch (err) {
    const screenshotPath = await screenshot(page, playbook.toolName, lastStep);
    const suffix = screenshotPath ? `\nscreenshot: ${screenshotPath}` : '';
    return {
      ok: false,
      error: 'BAD_RESPONSE',
      message: `Playbook failed at step ${lastStep}: ${errMsg(err)}${suffix}`,
    };
  } finally {
    if (!opts.pageOverride) {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

async function screenshot(page: Page, toolName: string, stepNum: number): Promise<string | null> {
  try {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(tmpdir(), `imprint-playbook-${toolName}-step${stepNum}-${ts}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}

async function loadPlaybook(input: string | Playbook): Promise<Playbook> {
  if (typeof input !== 'string') return input;
  if (!existsSync(input)) {
    throw new Error(
      `Playbook not found: ${input}\n→ run \`imprint compile-playbook <session.json>\` to create one.`,
    );
  }
  return parsePlaybook(readFileSync(input, 'utf8'));
}

function coerceParams(
  params: Record<string, string | number | boolean>,
  playbook: Playbook,
): Record<string, string | number | boolean> {
  const merged: Record<string, string | number | boolean> = {};
  for (const p of playbook.parameters) {
    if (params[p.name] !== undefined) {
      merged[p.name] = params[p.name] as string | number | boolean;
    } else if (p.default !== undefined) {
      merged[p.name] = p.default;
    } else {
      throw new Error(
        `Missing required parameter: ${p.name}\n→ pass --param ${p.name}=<value> on the CLI, or set it in cron.json.`,
      );
    }
  }
  return merged;
}

async function executeStep(
  page: Page,
  step: PlaybookStep,
  params: Record<string, string | number | boolean>,
  timeoutMs: number,
): Promise<void> {
  switch (step.action) {
    case 'navigate': {
      // 'domcontentloaded' instead of 'load' — SPAs behind enterprise
      // WAFs keep persistent connections alive so 'load' hangs forever.
      // Explicit wait_for handles "page is ready" semantics.
      await page.goto(subst(step.url, params), {
        timeout: timeoutMs,
        waitUntil: 'domcontentloaded',
      });
      await applyWait(page, step.wait_for, undefined, timeoutMs);
      return;
    }
    case 'click': {
      const locator = await firstMatching(page, step.locators, params, timeoutMs);
      try {
        await locator.click({ timeout: timeoutMs });
      } catch (err) {
        // Styled wrappers (role=checkbox/option, positioned overlays)
        // often intercept pointer events. force:true bubbles the event
        // through to the wrapper's handler.
        if (errMsg(err).includes('intercepts pointer events')) {
          await locator.click({ timeout: timeoutMs, force: true });
        } else {
          throw err;
        }
      }
      await applyWait(page, step.wait_for, locator, timeoutMs);
      return;
    }
    case 'type': {
      const locator = await firstMatching(page, step.locators, params, timeoutMs);
      const value = subst(step.value, params);
      if (step.clear === false) {
        await locator.pressSequentially(value, { timeout: timeoutMs });
      } else {
        await locator.fill(value, { timeout: timeoutMs });
      }
      await applyWait(page, step.wait_for, locator, timeoutMs);
      return;
    }
    case 'submit': {
      // Press Enter on the focused form — more reliable cross-site than
      // clicking a submit-typed descendant.
      const locator = await firstMatching(page, step.locators, params, timeoutMs);
      await locator.press('Enter', { timeout: timeoutMs });
      await applyWait(page, step.wait_for, locator, timeoutMs);
      return;
    }
    case 'press': {
      let focusedLocator: PWLocator | undefined;
      if (step.locators && step.locators.length > 0) {
        focusedLocator = await firstMatching(page, step.locators, params, timeoutMs);
        await focusedLocator.press(step.key, { timeout: timeoutMs });
      } else {
        await page.keyboard.press(step.key);
      }
      await applyWait(page, step.wait_for, focusedLocator, timeoutMs);
      return;
    }
    case 'wait':
      await applyWait(page, step.wait_for, undefined, timeoutMs);
      return;
  }
}

/**
 * Try each locator in priority order with a tight per-locator timeout.
 * Filter to visible elements before .first() — many sites have hidden
 * mirrors (e.g. a hidden native <select> alongside a custom dropdown).
 */
async function firstMatching(
  page: Page,
  locators: Locator[],
  params: Record<string, string | number | boolean>,
  timeoutMs: number,
): Promise<PWLocator> {
  const probeMs = Math.max(1000, Math.floor(timeoutMs / Math.max(locators.length, 1)));
  const errors: string[] = [];
  for (const loc of locators) {
    const visibleOnly = buildLocator(page, loc, params).locator('visible=true');
    try {
      await visibleOnly.first().waitFor({ state: 'visible', timeout: probeMs });
      return visibleOnly.first();
    } catch (err) {
      errors.push(`${describeLocator(loc)}: ${errMsg(err)}`);
    }
  }
  throw new Error(`No locator matched. Tried:\n  - ${errors.join('\n  - ')}`);
}

function buildLocator(
  page: Page,
  loc: Locator,
  params: Record<string, string | number | boolean>,
): PWLocator {
  switch (loc.by) {
    case 'role': {
      const opts = loc.name ? { name: loc.name } : undefined;
      // biome-ignore lint/suspicious/noExplicitAny: Playwright's role enum is opaque
      return page.getByRole(loc.value as any, opts);
    }
    case 'aria_label': {
      if (loc.value !== undefined) return page.getByLabel(loc.value, { exact: true });
      if (loc.value_pattern !== undefined) {
        const pattern = subst(loc.value_pattern, params);
        return page.locator(`[aria-label*="${escapeAttr(pattern)}" i]`);
      }
      throw new Error('aria_label locator requires value or value_pattern');
    }
    case 'text': {
      if (loc.value !== undefined) return page.getByText(loc.value, { exact: true });
      if (loc.value_pattern !== undefined) {
        const pattern = subst(loc.value_pattern, params);
        return page.getByText(new RegExp(escapeRegex(pattern), 'i'));
      }
      throw new Error('text locator requires value or value_pattern');
    }
    case 'id':
      return page.locator(`#${cssEscape(loc.value)}`);
    case 'css':
      return page.locator(loc.value);
  }
}

function describeLocator(loc: Locator): string {
  switch (loc.by) {
    case 'role':
      return `role=${loc.value}${loc.name ? ` name="${loc.name}"` : ''}`;
    case 'aria_label':
      return `aria_label=${loc.value ?? loc.value_pattern}`;
    case 'text':
      return `text=${loc.value ?? loc.value_pattern}`;
    case 'id':
      return `id=${loc.value}`;
    case 'css':
      return `css=${loc.value}`;
  }
}

async function applyWait(
  page: Page,
  wait: WaitFor | undefined,
  ctxLocator: PWLocator | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!wait) return;
  if (typeof wait === 'string') {
    if (wait === 'networkidle' || wait === 'load') {
      await page.waitForLoadState(wait, { timeout: timeoutMs });
    } else if ((wait === 'visible' || wait === 'hidden') && ctxLocator) {
      await ctxLocator.waitFor({ state: wait, timeout: timeoutMs });
    }
    return;
  }
  if ('xhr' in wait) {
    const re = new RegExp(wait.xhr);
    await page.waitForResponse(
      (resp) => re.test(resp.url()) && (!wait.method || resp.request().method() === wait.method),
      { timeout: wait.timeout_ms ?? timeoutMs },
    );
    return;
  }
  if ('sleep_ms' in wait) {
    await page.waitForTimeout(wait.sleep_ms);
  }
}

/** Exported for testing — drives the XHR-body extraction contract that
 *  must stay symmetric with the workflow runtime (runtime.ts:279-285).
 */
export async function extractResult(
  page: Page,
  result: PlaybookResult,
  captured: Array<{ url: string; method: string; status: number; body: string | null }>,
): Promise<Record<string, unknown>> {
  if (result.source === 'xhr') {
    const re = new RegExp(result.url_pattern);
    const matches = captured.filter(
      (c) => re.test(c.url) && (!result.method || c.method === result.method) && c.body !== null,
    );
    const last = matches.at(-1);
    if (!last || last.body === null) {
      throw new Error(`No captured XHR matched ${result.url_pattern} (with a readable body)`);
    }
    if (last.status >= 400) {
      const hint =
        last.status === 403
          ? ' Likely bot detection — try --headed, or capture a fresh recording.'
          : '';
      throw new Error(
        `Result XHR returned ${last.status} (${last.url}): ${last.body.slice(0, 300)}.${hint}`,
      );
    }
    // Mirror runtime.ts (workflow path) semantics: try JSON first, but fall
    // back to the raw body string when parsing fails. Many APIs return
    // non-JSON envelopes that a downstream parser knows how to decode —
    // Google XSSI prefix (`)]}'`), chunked batchexecute payloads, JSONP
    // callbacks, protobuf-over-HTTP, etc. Throwing here would bypass the
    // parser entirely; passing the raw bytes lets the parser do its job and
    // keeps the playbook fallback's contract symmetric with the workflow
    // path.
    let parsed: unknown = last.body;
    try {
      parsed = JSON.parse(last.body);
    } catch {
      // Path-based extraction (`items[].id`) needs a structured value to
      // navigate, so we still fail loudly in that case. Whole-body
      // extraction (`extract === '*'`) is the contract that says "the
      // parser owns the bytes," so we pass them through.
      if (result.extract !== '*' && result.extract !== '') {
        throw new Error(`Result XHR body was not JSON (${last.url}): ${last.body.slice(0, 200)}`);
      }
    }
    if (result.extract === '*' || result.extract === '') {
      return { [result.return_as]: parsed, source_url: last.url };
    }
    return { [result.return_as]: extractAt(parsed, result.extract), source_url: last.url };
  }
  // dom source
  const locator = await firstMatching(page, result.locators, {}, 5000);
  const value =
    result.extract === 'text'
      ? await locator.textContent()
      : await locator.getAttribute(result.extract);
  return { [result.return_as]: value };
}

/** Substitute ${X} or ${param.X} (we accept both for ergonomics). */
function subst(template: string, params: Record<string, string | number | boolean>): string {
  const mapped = template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, '${param.$1}');
  return substituteString(mapped, params, { site: '', cookies: [], values: {} }, []);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function cssEscape(s: string): string {
  return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Fallback for callers that don't pass opts.site explicitly.
 *  Only fires for the `<IMPRINT_HOME>/<site>/<tool>/playbook.yaml` layout. */
function inferSiteFromPath(playbookInput: string | Playbook): string | null {
  if (typeof playbookInput !== 'string') return null;
  const root = imprintHomeDir();
  const target = pathResolve(playbookInput);
  const relative = pathRelative(root, target);
  if (relative.startsWith('..') || pathIsAbsolute(relative)) return null;
  const [site] = relative.split('/');
  return site || null;
}
