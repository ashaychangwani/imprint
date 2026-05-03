/**
 * Execute a parsed Playbook against a real Chromium via Playwright.
 *
 * Boots a fresh browser per run (long-lived browser is a v0.2 concern),
 * walks the steps, captures any matching XHR responses for the result
 * extraction, returns a ToolResult that mirrors the API replay shape.
 *
 * Locator priority within each step is preserved from the playbook
 * (typically text/aria first, CSS last). The first locator that
 * matches drives the action.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator as PWLocator, Page } from 'playwright';
import { extractAt } from './json-path.ts';
import { createLog } from './log.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { substituteString } from './runtime.ts';
import type { Locator, Playbook, PlaybookResult, PlaybookStep, WaitFor } from './types.ts';
import type { ToolResult } from './types.ts';

export interface RunPlaybookOptions {
  /** Path to playbook.yaml OR an already-parsed Playbook. */
  playbook: string | Playbook;
  params: Record<string, string | number | boolean>;
  /** Run with a visible browser window. Default false (headless). */
  headed?: boolean;
  /** Per-step timeout in ms. Default 15000. */
  stepTimeoutMs?: number;
  /**
   * If true, screenshot the page after EVERY step (not just failure)
   * and log the URL + path. Useful when iterating on a playbook and
   * you can't run --headed. Files land in the system tmp dir.
   */
  trace?: boolean;
  /**
   * Inject a Playwright Page for tests (skips browser launch). When
   * provided, the runner uses this page directly and the caller is
   * responsible for the browser lifecycle.
   */
  pageOverride?: Page;
}

const log = createLog('playbook');

export async function runPlaybook(opts: RunPlaybookOptions): Promise<ToolResult> {
  // Convert every thrown error into a ToolResult so callers can rely on
  // a single return shape (matching the API replay path's contract).
  let playbook: Playbook;
  let params: Record<string, string | number | boolean>;
  try {
    playbook = await loadPlaybook(opts.playbook);
    params = coerceParams(opts.params, playbook);
  } catch (err) {
    return {
      ok: false,
      error: 'UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // Default step timeout is generous because some sites need real time
  // to settle (Akamai sensor JS, A/B test loaders, lazy bundles). 30s
  // beats the headache of "tight timeout, looks broken when it's not."
  const stepTimeoutMs = opts.stepTimeoutMs ?? 30000;

  // Either reuse the test-injected page or boot Chromium ourselves.
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  if (opts.pageOverride) {
    page = opts.pageOverride;
  } else {
    // Use playwright-extra + stealth plugin by default. Stealth patches
    // navigator.webdriver, plugin enumeration, languages, permissions,
    // WebGL vendor strings, and other tells that bot detectors (Akamai,
    // Cloudflare, DataDome, PerimeterX) check. Without it, vanilla
    // headless Playwright gets a 403 from any decent enterprise site.
    // Verified against Southwest: vanilla → 403 sensor block, stealth
    // → 200 with real flight data.
    let chromium: typeof import('playwright').chromium;
    try {
      const pwExtra = await import('playwright-extra');
      const stealthMod = await import('puppeteer-extra-plugin-stealth');
      const stealthFactory =
        (stealthMod as { default?: () => unknown }).default ??
        (stealthMod as unknown as () => unknown);
      pwExtra.chromium.use(stealthFactory() as never);
      chromium = pwExtra.chromium as unknown as typeof import('playwright').chromium;
    } catch (err) {
      // Fall back to vanilla playwright if the stealth deps aren't there
      // (e.g., a downstream user installs imprint without optional deps).
      // Bot-protected sites will likely fail in this mode.
      try {
        const pw = await import('playwright');
        chromium = pw.chromium;
      } catch (innerErr) {
        return {
          ok: false,
          error: 'UNKNOWN',
          message: `Playwright not available: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}. Run: bunx playwright install chromium`,
        };
      }
    }
    try {
      browser = await chromium.launch({ headless: !opts.headed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: 'UNKNOWN',
        message: `Could not launch Chromium: ${msg}. Run: bunx playwright install chromium`,
      };
    }
    context = await browser.newContext();
    page = await context.newPage();
  }

  // Capture body text eagerly inside the response handler — Playwright/CDP
  // garbage-collects response bodies aggressively, so a lazy callback that
  // tries to read text() at extraction time often fails with "no resource
  // with given identifier found." Reading inside the handler is safe.
  // Track the pending body-read promises so the result extraction can
  // await them all (otherwise a wait_for that fires before text()
  // resolves would extract from a partial captured list).
  const captured: Array<{
    url: string;
    method: string;
    status: number;
    body: string | null;
  }> = [];
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
        const traceShot = await dumpScreenshotOnFailure(
          page,
          `${playbook.toolName}-trace`,
          lastStep,
        );
        log(`  url=${page.url()}`);
        if (traceShot) log(`  trace screenshot: ${traceShot}`);
      }
    }
    // Drain any in-flight body reads before extracting — otherwise we
    // might miss the result XHR if its text() hasn't resolved yet.
    await Promise.allSettled(pendingBodyReads);
    const data = await extractResult(page, playbook.result, captured);
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Snapshot the page state at failure so the operator has something
    // concrete to look at (selector that didn't match, popover that
    // didn't open, etc). Lives in the system tmp dir; path is logged.
    const screenshotPath = await dumpScreenshotOnFailure(page, playbook.toolName, lastStep);
    const suffix = screenshotPath ? `\nscreenshot: ${screenshotPath}` : '';
    return {
      ok: false,
      error: 'BAD_RESPONSE',
      message: `Playbook failed at step ${lastStep}: ${msg}${suffix}`,
    };
  } finally {
    if (!opts.pageOverride) {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

async function dumpScreenshotOnFailure(
  page: Page,
  toolName: string,
  stepNum: number,
): Promise<string | null> {
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
  if (!existsSync(input)) throw new Error(`Playbook not found: ${input}`);
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
      throw new Error(`Missing required parameter: ${p.name}`);
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
      const url = subst(step.url, params);
      // SPAs (especially behind enterprise WAFs) keep persistent
      // connections alive so the default 'load' waitUntil hangs. Use
      // 'domcontentloaded' — the explicit wait_for handles the
      // semantic "page is ready" condition.
      await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      await applyWait(page, step.wait_for, undefined, timeoutMs);
      return;
    }
    case 'click': {
      const locator = await firstMatching(page, step.locators, params, timeoutMs);
      try {
        await locator.click({ timeout: timeoutMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Common pattern: a styled wrapper (role=checkbox, role=option,
        // or a positioned overlay) intercepts pointer events. Playwright
        // refuses to click in that case, but the click event bubbles —
        // dispatching with force:true lets the wrapper's handler fire.
        if (msg.includes('intercepts pointer events')) {
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
      const locator = await firstMatching(page, step.locators, params, timeoutMs);
      // Playwright doesn't expose form.submit(); press Enter on the form
      // or click a submit-typed descendant. Press Enter is the more
      // reliable cross-site behavior.
      await locator.press('Enter', { timeout: timeoutMs });
      await applyWait(page, step.wait_for, locator, timeoutMs);
      return;
    }
    case 'press': {
      // Page-level press dispatches to whatever has focus; useful for
      // dismissing overlays (Escape) or submitting a focused form (Enter).
      // Locator-scoped press focuses the element first.
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
 * Try each locator in priority order. Returns the first one that
 * resolves to a visible element within a short probe window. Throws
 * if none match.
 */
async function firstMatching(
  page: Page,
  locators: Locator[],
  params: Record<string, string | number | boolean>,
  timeoutMs: number,
): Promise<PWLocator> {
  // Probe each locator with a tight individual timeout — we want to
  // try fallbacks quickly, not spend the full step timeout on the
  // first locator that may have rotted between deploys.
  //
  // Filter to visible elements before picking .first(): many sites have
  // hidden duplicates (a hidden native <select> alongside a custom
  // autocomplete dropdown, for example). Without this filter, .first()
  // may pick a hidden mirror that never becomes visible and the wait
  // times out even though the visible match is right there.
  const probeMs = Math.max(1000, Math.floor(timeoutMs / Math.max(locators.length, 1)));
  const errors: string[] = [];
  for (const loc of locators) {
    const pwLocator = buildLocator(page, loc, params);
    const visibleOnly = pwLocator.locator('visible=true');
    try {
      await visibleOnly.first().waitFor({ state: 'visible', timeout: probeMs });
      return visibleOnly.first();
    } catch (err) {
      errors.push(`${describeLocator(loc)}: ${err instanceof Error ? err.message : String(err)}`);
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
    if (wait === 'networkidle') {
      await page.waitForLoadState('networkidle', { timeout: timeoutMs });
    } else if (wait === 'load') {
      await page.waitForLoadState('load', { timeout: timeoutMs });
    } else if (wait === 'visible') {
      if (ctxLocator) await ctxLocator.waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (wait === 'hidden') {
      if (ctxLocator) await ctxLocator.waitFor({ state: 'hidden', timeout: timeoutMs });
    }
    return;
  }
  if ('xhr' in wait) {
    const re = new RegExp(wait.xhr);
    const t = wait.timeout_ms ?? timeoutMs;
    await page.waitForResponse(
      (resp) => re.test(resp.url()) && (!wait.method || resp.request().method() === wait.method),
      { timeout: t },
    );
    return;
  }
  if ('sleep_ms' in wait) {
    await page.waitForTimeout(wait.sleep_ms);
    return;
  }
}

async function extractResult(
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
    // The result XHR fired but came back as an error — typically Akamai/
    // Cloudflare bot block (403) even from a real Chromium. Surface it
    // instead of silently returning empty data.
    if (last.status >= 400) {
      const hint =
        last.status === 403
          ? 'Likely bot detection — even headless Chromium can get flagged. Try --headed, or use a stealth-patched browser (rebrowser-patches / playwright-stealth).'
          : '';
      throw new Error(
        `Result XHR returned ${last.status} (${last.url}): ${last.body.slice(0, 300)}. ${hint}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(last.body);
    } catch {
      throw new Error(`Result XHR body was not JSON (${last.url}): ${last.body.slice(0, 200)}`);
    }
    const values = extractAt(parsed, result.extract);
    return { [result.return_as]: values, source_url: last.url };
  }
  // dom source
  const params = {} as Record<string, string | number | boolean>;
  const locator = await firstMatching(page, result.locators, params, 5000);
  const value =
    result.extract === 'text'
      ? await locator.textContent()
      : await locator.getAttribute(result.extract);
  return { [result.return_as]: value };
}

function subst(template: string, params: Record<string, string | number | boolean>): string {
  // Reuse workflow-runtime's substituter for ${param.X} consistency, but
  // this template uses bare ${X} — so wrap to translate. We accept BOTH
  // ${X} and ${param.X} for ergonomics.
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
  // Basic CSS identifier escaping. Playwright's #id selector tolerates
  // most chars but we sanitize to avoid breaking compound selectors.
  return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
