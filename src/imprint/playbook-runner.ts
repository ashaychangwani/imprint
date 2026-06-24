/** Execute a parsed Playbook against a real Chromium via Playwright. */

import { existsSync, readFileSync } from 'node:fs';
import {
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import type { Browser, BrowserContext, Frame, Locator as PWLocator, Page } from 'playwright';
import { extractAt } from './json-path.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { substituteString } from './runtime.ts';
import { getStealthChromium, getStealthExecutablePath } from './stealth-chromium.ts';
import type {
  Locator,
  Playbook,
  PlaybookCapture,
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
  /** Whole-playbook timeout in ms. Default unbounded for direct playbook runs. */
  maxDurationMs?: number;
  /** Timeout for diagnostic screenshots in ms. Default 5000. */
  screenshotTimeoutMs?: number;
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
  /** Harvest the browser context's cookies after a successful run and save them
   *  to the credential store. Set by the ladder for authenticate tools so a
   *  login playbook's freshly minted session is persisted for data tools. */
  persistCookies?: boolean;
}

const log = createLog('playbook');
const DEFAULT_STEP_TIMEOUT_MS = 30000;
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 5000;

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
  const stepTimeoutMs = positiveMs(opts.stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  const screenshotTimeoutMs = positiveMs(opts.screenshotTimeoutMs, DEFAULT_SCREENSHOT_TIMEOUT_MS);
  const deadlineAt =
    opts.maxDurationMs !== undefined ? Date.now() + positiveMs(opts.maxDurationMs, 1) : null;

  // Resolve the site once (used for cookie injection, credential resolution in
  // login playbooks, and post-run session persistence).
  const site = opts.site ?? inferSiteFromPath(opts.playbook);
  // Credential VALUES (username/password/etc.) for ${credential.X} placeholders
  // in typed field steps. Loaded from the store below; never logged.
  let credValues: Record<string, string> = {};

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  if (opts.pageOverride) {
    page = opts.pageOverride;
  } else {
    let chromium: typeof import('playwright').chromium;
    try {
      chromium = await getStealthChromium();
    } catch (innerErr) {
      return {
        ok: false,
        error: 'UNKNOWN',
        message: `Playwright not available: ${errMsg(innerErr)}. Run: bunx playwright install chromium`,
      };
    }
    try {
      // Use the same full Chrome binary as `imprint record` — NOT
      // chrome-headless-shell, which Akamai detects at the binary level
      // regardless of stealth-plugin JS patches.
      browser = await chromium.launch({
        headless: !opts.headed,
        executablePath: getStealthExecutablePath(),
      });
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
    // an authenticated flow (e.g., my-trips → reservation → seat map), and load
    // credential values for ${credential.X} placeholders in login playbooks.
    if (site) {
      try {
        const { loadSiteCredentials } = await import('./credential-store.ts');
        const view = await loadSiteCredentials(site);
        credValues = view.values ?? {};
        const playwrightCookies = view.cookies
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
          .filter((c) => c.name && c.value);
        if (playwrightCookies.length > 0) {
          await context.addCookies(playwrightCookies);
          log(`injected ${playwrightCookies.length} cookies for site ${site}`);
        }
        // Rehydrate persisted localStorage (Option B): a prior `initiate` run may
        // have minted per-origin localStorage (token blobs, session handles) that
        // a stateless `submit_otp` needs. `storageState()` only round-trips
        // localStorage, so we scope to that. addInitScript runs in every
        // frame/navigation, so guard by origin inside the script — each record's
        // setItem only fires on its own origin.
        const localStorageRecords = view.storage.filter((s) => s.kind === 'localStorage');
        if (localStorageRecords.length > 0) {
          const byOrigin = new Map<string, Array<{ key: string; value: string }>>();
          for (const rec of localStorageRecords) {
            const list = byOrigin.get(rec.origin) ?? [];
            list.push({ key: rec.key, value: rec.value });
            byOrigin.set(rec.origin, list);
          }
          for (const [origin, entries] of byOrigin) {
            await context.addInitScript(
              ({ origin: o, entries: e }) => {
                // Runs in the browser; type the needed globals locally since the
                // Node typecheck has no DOM lib.
                const w = globalThis as unknown as {
                  location: { origin: string };
                  localStorage: { setItem(k: string, v: string): void };
                };
                try {
                  if (w.location.origin !== o) return;
                  for (const { key, value } of e) w.localStorage.setItem(key, value);
                } catch {
                  /* storage may be unavailable (sandboxed frame) — skip */
                }
              },
              { origin, entries },
            );
          }
          log(`seeded ${localStorageRecords.length} localStorage keys for site ${site}`);
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
      const budgetMs = budgetedTimeoutMs(
        stepTimeoutMs,
        deadlineAt,
        `Playbook exceeded max duration before step ${lastStep}`,
      );
      log(`step ${i + 1}/${playbook.steps.length}: ${step.action}`);
      await withTimeout(
        executeStep(page, step, params, credValues, budgetMs),
        budgetMs,
        `Playbook step ${lastStep}/${playbook.steps.length} (${step.action})`,
      );
      if (opts.trace) {
        const traceShot = await screenshot(
          page,
          `${playbook.toolName}-trace`,
          lastStep,
          screenshotTimeoutMs,
        );
        log(`  url=${page.url()}`);
        if (traceShot) log(`  trace screenshot: ${traceShot}`);
      }
    }
    const bodyReadBudgetMs = budgetedTimeoutMs(
      stepTimeoutMs,
      deadlineAt,
      'Playbook exceeded max duration while reading captured responses',
    );
    await withTimeout(
      Promise.allSettled(pendingBodyReads),
      bodyReadBudgetMs,
      'Playbook captured-response drain',
    );
    const data = await extractResult(page, playbook.result, captured);
    // Best-effort 2FA-chain captures: pull named tokens (e.g. a single-use
    // SecurityCode minted during an OTP-send) out of the run so the ladder can
    // echo them as twoFactorContext for a later submit_otp. Missing captures are
    // skipped (not fatal) — the attempt still fires and fails honestly.
    if (playbook.captures && playbook.captures.length > 0) {
      Object.assign(data, extractPlaybookCaptures(playbook.captures, captured));
    }
    // Persist the post-run session for authenticate tools: the login playbook
    // just minted a fresh session in this browser, so harvest its cookies into
    // the credential store for downstream data tools to reuse. Gated by the
    // caller (the ladder sets this only for toolKind==='authenticate').
    if (opts.persistCookies && site && context) {
      try {
        const harvested = (await context.cookies()).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        if (harvested.length > 0) {
          const { saveSiteCookies } = await import('./credential-store.ts');
          await saveSiteCookies(site, harvested);
          log(`persisted ${harvested.length} session cookies for site ${site}`);
        }
        // Also harvest localStorage (Option B): serialize the post-login
        // per-origin localStorage so a later stateless `submit_otp` can rehydrate
        // the same session state. storageState() captures cookies + localStorage;
        // we already persist cookies above, so take only the localStorage here.
        // sessionStorage is not captured by storageState() — a documented gap.
        const state = await context.storageState();
        const storageRecords = state.origins.flatMap((o) =>
          o.localStorage.map((entry) => ({
            origin: o.origin,
            kind: 'localStorage' as const,
            key: entry.name,
            value: entry.value,
          })),
        );
        if (storageRecords.length > 0) {
          const { saveSiteStorage } = await import('./credential-store.ts');
          await saveSiteStorage(site, storageRecords);
          log(`persisted ${storageRecords.length} localStorage keys for site ${site}`);
        }
      } catch (err) {
        log(`failed to persist session cookies: ${errMsg(err)} (proceeding)`);
      }
    }
    return { ok: true, data };
  } catch (err) {
    const screenshotPath = await screenshot(page, playbook.toolName, lastStep, screenshotTimeoutMs);
    const suffix = screenshotPath ? `\nscreenshot: ${screenshotPath}` : '';
    const errStr = errMsg(err);
    // Classify the failure mode honestly: a missing locator, a step
    // timeout, or a `forResponse` wait that didn't resolve are
    // transient page-state signals (the DOM rendered differently than
    // the recording, or the page was slow). Those are NETWORK-class
    // signals, not tool-defect (BAD_RESPONSE) signals — the audit
    // gate's `tool_broken` classifier treats BAD_RESPONSE as a real
    // bug, which over-attributes drift to defects. Map known
    // transient-shape errors to NETWORK so they count as `infra`
    // (re-runnable) rather than `tool_broken` (permanent defect).
    const isTransient =
      /No locator matched|Timeout \d+ms exceeded|timed out after|exceeded max duration|forResponse|waiting for/i.test(
        errStr,
      );
    return {
      ok: false,
      error: isTransient ? 'NETWORK' : 'BAD_RESPONSE',
      message: `Playbook failed at step ${lastStep}: ${errStr}${suffix}`,
    };
  } finally {
    if (!opts.pageOverride) {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

async function screenshot(
  page: Page,
  toolName: string,
  stepNum: number,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(tmpdir(), `imprint-playbook-${toolName}-step${stepNum}-${ts}.png`);
    await withTimeout(page.screenshot({ path, fullPage: true }), timeoutMs, 'Playbook screenshot');
    return path;
  } catch {
    return null;
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function budgetedTimeoutMs(
  configuredMs: number,
  deadlineAt: number | null,
  errorMessage: string,
): number {
  if (deadlineAt === null) return configuredMs;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(errorMessage);
  return Math.max(1, Math.min(configuredMs, Math.floor(remainingMs)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const boundedMs = positiveMs(timeoutMs, 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${boundedMs}ms`)),
          boundedMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  credValues: Record<string, string>,
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
      const value = subst(step.value, params, credValues);
      // Detect element type so we dispatch the right action. `type` on a
      // <select> means "choose the option whose value/label matches" —
      // a recording can capture either action shape, and the audit-time
      // tool may also call type with a value that happens to land on a
      // select. Without this branch, fill()/pressSequentially() throw
      // "Element is not an input/textarea" and the whole playbook
      // aborts.
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === 'select') {
        // Try value first, fall back to label — match Playwright's own
        // selectOption semantics.
        try {
          await locator.selectOption({ value }, { timeout: timeoutMs });
        } catch {
          await locator.selectOption({ label: value }, { timeout: timeoutMs });
        }
        await applyWait(page, step.wait_for, locator, timeoutMs);
        return;
      }
      // Inputs / textareas: pressSequentially fires real input / keydown
      // / keyup events. React-style frameworks bind to synthetic events
      // that locator.fill() doesn't trigger — typing into an autocomplete
      // or debounced search field with fill() updates the input visually
      // but the framework's onChange handler never runs, so the dropdown
      // / XHR / next-step locator times out. The ~10ms-per-char internal
      // delay is negligible against page-load latency.
      if (step.clear !== false) {
        await locator.fill('', { timeout: timeoutMs });
      }
      await locator.pressSequentially(value, { timeout: timeoutMs });
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
 *
 * Searches the main frame first, then any child iframes. A great many real
 * login flows put critical controls inside iframes the page itself can't reach
 * with a plain `page.locator` — reCAPTCHA/hCaptcha widgets, embedded SSO/login
 * forms, hosted payment fields. Page-level locators silently never match those,
 * so the playbook stalls. We dedupe the main frame (it's reachable via `page`)
 * and divide the per-probe budget by the number of roots, so a page with NO
 * child frames (the common case) keeps its exact prior timing.
 */
async function firstMatching(
  page: Page,
  locators: Locator[],
  params: Record<string, string | number | boolean>,
  timeoutMs: number,
): Promise<PWLocator> {
  const childFrames = page.frames().filter((f) => f !== page.mainFrame());
  const roots: Array<Page | Frame> = [page, ...childFrames];
  const probeMs = Math.max(
    1000,
    Math.floor(timeoutMs / Math.max(locators.length * roots.length, 1)),
  );
  const errors: string[] = [];
  // Main frame first (preserves prior behavior), then each child frame.
  for (const root of roots) {
    const where = root === page ? '' : ' [iframe]';
    for (const loc of locators) {
      const visibleOnly = buildLocator(root, loc, params).locator('visible=true');
      try {
        await visibleOnly.first().waitFor({ state: 'visible', timeout: probeMs });
        return visibleOnly.first();
      } catch (err) {
        errors.push(`${describeLocator(loc)}${where}: ${errMsg(err)}`);
      }
    }
  }
  throw new Error(`No locator matched. Tried:\n  - ${errors.join('\n  - ')}`);
}

function buildLocator(
  root: Page | Frame,
  loc: Locator,
  params: Record<string, string | number | boolean>,
): PWLocator {
  switch (loc.by) {
    case 'role': {
      const opts = loc.name ? { name: loc.name } : undefined;
      // biome-ignore lint/suspicious/noExplicitAny: Playwright's role enum is opaque
      return root.getByRole(loc.value as any, opts);
    }
    case 'aria_label': {
      if (loc.value !== undefined) return root.getByLabel(loc.value, { exact: true });
      if (loc.value_pattern !== undefined) {
        const pattern = subst(loc.value_pattern, params);
        return root.locator(`[aria-label*="${escapeAttr(pattern)}" i]`);
      }
      throw new Error('aria_label locator requires value or value_pattern');
    }
    case 'text': {
      if (loc.value !== undefined) return root.getByText(loc.value, { exact: true });
      if (loc.value_pattern !== undefined) {
        const pattern = subst(loc.value_pattern, params);
        return root.getByText(new RegExp(escapeRegex(pattern), 'i'));
      }
      throw new Error('text locator requires value or value_pattern');
    }
    case 'id':
      return root.locator(`#${cssEscape(loc.value)}`);
    case 'css':
      return root.locator(loc.value);
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
    try {
      await page.waitForResponse(
        (resp) => re.test(resp.url()) && (!wait.method || resp.request().method() === wait.method),
        { timeout: wait.timeout_ms ?? timeoutMs },
      );
    } catch (err) {
      // A missed `wait_for: {xhr: ...}` is usually a soft signal: the
      // recorded action (typing into an autocomplete, clicking a tab)
      // happened, but the page didn't fire the exact XHR we matched on
      // — either the URL pattern drifted, the debounce window was
      // tighter than our wait, or the page chose a cached response. The
      // next playbook step has its own locator / wait_for and will fail
      // loudly if the page state is actually wrong. Letting the
      // playbook continue here gives it a real chance to recover
      // (observed on Costco's pickup-location autocomplete: typing
      // succeeded, the XHR just never fired before our 30s window).
      const msg = err instanceof Error ? err.message : String(err);
      // Re-throw closures / nav errors that aren't simple timeouts —
      // those signal real page breakdown.
      if (!/timeout|Timeout/.test(msg)) throw err;
    }
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

/** Best-effort 2FA-chain capture: for each declared capture, find the matching
 *  captured XHR (last wins) and extract the named value. Unmatched captures are
 *  skipped — Component D is best-effort, so a missing token degrades to an
 *  attempt that fails honestly rather than aborting the playbook. Exported for
 *  testing the capture contract symmetric with the workflow runtime. */
export function extractPlaybookCaptures(
  captures: PlaybookCapture[],
  captured: Array<{ url: string; method: string; status: number; body: string | null }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cap of captures) {
    try {
      const re = new RegExp(cap.url_pattern);
      const matches = captured.filter(
        (c) =>
          re.test(c.url) &&
          (!cap.method || c.method === cap.method) &&
          c.body !== null &&
          c.status < 400,
      );
      const last = matches.at(-1);
      if (!last || last.body === null) continue;
      let parsed: unknown = last.body;
      try {
        parsed = JSON.parse(last.body);
      } catch {
        /* keep raw string for '*'/'' extraction */
      }
      const value =
        cap.extract === '*' || cap.extract === '' ? parsed : extractAt(parsed, cap.extract);
      if (value !== undefined && value !== null) out[cap.name] = value;
    } catch {
      /* malformed pattern / extraction — skip this capture (best-effort) */
    }
  }
  return out;
}

/** Substitute ${X} / ${param.X} and ${credential.X}. The bare-name → param
 *  rewrite only touches dotless `${X}` (the `.` in `${credential.X}` keeps it
 *  intact), so credential placeholders flow straight through to
 *  substituteString, which resolves them from the credential store. Credentials
 *  are only ever passed for typed field VALUES (login playbooks), never URLs or
 *  locators. */
function subst(
  template: string,
  params: Record<string, string | number | boolean>,
  credValues: Record<string, string> = {},
): string {
  const mapped = template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, '${param.$1}');
  return substituteString(mapped, params, { site: '', cookies: [], values: credValues }, []);
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
