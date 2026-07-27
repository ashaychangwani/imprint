/**
 * Replay a session in a fresh browser while capturing full request/response
 * data for dual-pass diff analysis.
 *
 * Two replay strategies:
 * 1. replayRawSession() — replays raw DOM events (click/type/navigate) from
 *    the original recording. Used for the site-level dual-pass before triage.
 * 2. replayAndCapture() — replays a compiled playbook via playbook-runner.ts.
 *    Kept for potential future use but no longer part of the teach pipeline.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { createLog } from './log.ts';
import type { CapturedReplayRequest } from './session-diff.ts';
import { getStealthChromium, getStealthExecutablePath } from './stealth-chromium.ts';
import type { CapturedEvent, Session } from './types.ts';

const log = createLog('replay-capture');

const isReplayDebug = (): boolean => process.env.IMPRINT_REPLAY_DEBUG === '1';
let replayDebugPath: string | null = null;

function replayLog(msg: string): void {
  if (!isReplayDebug()) return;
  if (!replayDebugPath) {
    replayDebugPath = pathJoin(tmpdir(), `imprint-replay-debug-${Date.now()}.log`);
    writeFileSync(
      replayDebugPath,
      `[imprint replay-debug] started at ${new Date().toISOString()}\n`,
    );
    log(`replay debug log: ${replayDebugPath}`);
  }
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(replayDebugPath, line);
}

interface ReplayCaptureResult {
  ok: boolean;
  requests: CapturedReplayRequest[];
  error?: string;
}

// ─── Raw session replay ─────────────────────────────────────────────────────

interface RawReplayOptions {
  session: Session;
  site: string;
  headed?: boolean;
  onProgress?: (current: number, total: number, captured: number) => void;
}

const CREDENTIAL_PLACEHOLDER = /^\$\{credential\.([A-Za-z0-9_.-]+)\}$/;

/** Resolve only a complete credential placeholder. Embedded or missing
 * placeholders are rejected so replay never types placeholder text or a partial
 * secret interpolation into the page. */
export function resolveReplayEventValue(
  value: string,
  credentials: Record<string, string>,
): string | null {
  const match = CREDENTIAL_PLACEHOLDER.exec(value);
  if (match) {
    const name = match[1];
    return name && Object.hasOwn(credentials, name) ? (credentials[name] ?? null) : null;
  }
  return value.includes('${credential.') ? null : value;
}

/**
 * Replay the raw DOM events from an original recording in a fresh browser,
 * capturing all network requests. This is the site-level dual-pass strategy:
 * one replay of the entire session, not per-tool.
 */
export async function replayRawSession(opts: RawReplayOptions): Promise<ReplayCaptureResult> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  let chromium: typeof import('playwright').chromium;
  try {
    chromium = await getStealthChromium();
  } catch (innerErr) {
    return { ok: false, requests: [], error: `Playwright not available: ${errMsg(innerErr)}` };
  }

  try {
    replayLog(`launching browser (headed=${!!opts.headed})`);
    browser = await chromium.launch({
      headless: !opts.headed,
      executablePath: getStealthExecutablePath(),
    });
  } catch (err) {
    replayLog(`browser launch failed: ${errMsg(err)}`);
    return { ok: false, requests: [], error: `Could not launch Chromium: ${errMsg(err)}` };
  }

  const captured: CapturedReplayRequest[] = [];
  let seq = 0;
  const startTime = Date.now();
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    replayLog('browser context + page created');

    // Inject credentials if available
    let credentialValues: Record<string, string> = {};
    try {
      const { loadSiteCredentials } = await import('./credential-store.ts');
      const view = await loadSiteCredentials(opts.site);
      credentialValues = view.values;
      const playwrightCookies = view.cookies
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
        .filter((c) => c.name && c.value);
      if (playwrightCookies.length > 0) {
        await context.addCookies(playwrightCookies);
        replayLog(`injected ${playwrightCookies.length} cookies`);
        log(`injected ${playwrightCookies.length} cookies`);
      }
    } catch {
      // No credentials — fine for unauthenticated flows
    }

    // Hook request/response capture (same as replayAndCapture)
    let reqId = 0;
    const requestMeta = new Map<
      string,
      { method: string; url: string; headers: Record<string, string>; body?: string }
    >();
    page.on('request', (req) => {
      const id = `${reqId++}`;
      requestMeta.set(id, {
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        body: req.postData() ?? undefined,
      });
      (req as unknown as Record<string, string>).__replayCaptureId = id;
    });

    const pendingReads: Promise<void>[] = [];
    page.on('response', (resp) => {
      const req = resp.request();
      const id = (req as unknown as Record<string, string>).__replayCaptureId;
      const meta = id ? requestMeta.get(id) : undefined;
      const currentSeq = seq++;
      const method = meta?.method ?? req.method();
      const url = meta?.url ?? resp.url();
      const headers = meta?.headers ?? req.headers();
      const body = meta?.body;
      const readP = resp
        .text()
        .then((respBody) => {
          captured.push({
            seq: currentSeq,
            timestamp: Date.now() - startTime,
            method,
            url,
            headers,
            body,
            resourceType: req.resourceType(),
            response: {
              status: resp.status(),
              headers: resp.headers(),
              body: respBody,
              mimeType: resp.headers()['content-type']?.split(';')[0]?.trim(),
            },
          });
        })
        .catch(() => {
          captured.push({
            seq: currentSeq,
            timestamp: Date.now() - startTime,
            method,
            url,
            headers,
            body,
            resourceType: req.resourceType(),
            response: {
              status: resp.status(),
              headers: resp.headers(),
              body: undefined,
            },
          });
        });
      pendingReads.push(readP);
    });

    // Replay each DOM event from the original recording
    const replayableEvents = opts.session.events.filter(
      (e) =>
        e.type === 'navigation' ||
        e.type === 'click' ||
        e.type === 'input' ||
        e.type === 'change' ||
        e.type === 'submit',
    );

    replayLog(
      `total session events: ${opts.session.events.length}, replayable: ${replayableEvents.length}`,
    );
    let prevTimestamp = replayableEvents[0]?.timestamp ?? 0;

    for (let i = 0; i < replayableEvents.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by loop condition
      const event = replayableEvents[i]!;

      // Use timestamp delta as minimum delay between events
      const delta = Math.max(0, event.timestamp - prevTimestamp);
      if (delta > 100 && i > 0) {
        const wait = Math.min(delta, 3000);
        replayLog(`  waiting ${wait}ms (original delta ${delta}ms)`);
        await page.waitForTimeout(wait);
      }
      prevTimestamp = event.timestamp;

      replayLog(`event ${i + 1}/${replayableEvents.length}: type=${event.type} seq=${event.seq}`);

      await replayEvent(page, event, credentialValues);
      replayLog(`  event ${i + 1} done (captured ${captured.length} requests so far)`);
      opts.onProgress?.(i + 1, replayableEvents.length, captured.length);
    }

    // Allow final network requests to settle, but never block forever: on a
    // large recording a single hung response-body read can stall allSettled
    // indefinitely (there is no outer timeout on the replay stage). Cap the
    // wait and proceed with whatever bodies are ready — replay-diff is
    // best-effort, so partial captures are acceptable.
    const SETTLE_TIMEOUT_MS = 15_000;
    replayLog('waiting for networkidle...');
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
    await Promise.race([
      Promise.allSettled(pendingReads),
      new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
    ]);
    captured.sort((a, b) => a.seq - b.seq);

    replayLog(`replay complete: captured ${captured.length} requests total`);
    log(`captured ${captured.length} requests during raw session replay`);
    return { ok: true, requests: captured };
  } catch (err) {
    replayLog('replay stopped after a browser operation failed');
    return { ok: false, requests: captured, error: errMsg(err) };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function replayEvent(
  page: Page,
  event: CapturedEvent,
  credentials: Record<string, string>,
): Promise<void> {
  if (event.type === 'navigation') {
    const url = typeof event.detail === 'string' ? event.detail : String(event.detail);
    if (!url.startsWith('http')) {
      replayLog('  skip non-http navigation');
      return;
    }
    replayLog('  navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    replayLog('  navigation complete');
    return;
  }

  const d = parseEventDetail(event.detail);
  if (!d) {
    replayLog('  skip: could not parse event detail');
    return;
  }

  if (event.type === 'click') {
    const loc = buildLocatorFromEvent(page, d);
    if (!loc) {
      replayLog('  skip click: no locator');
      return;
    }
    replayLog('  clicking');
    try {
      // Fast visibility check — don't wait 10s for elements that aren't there
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) {
        replayLog('  skip click: element not visible');
        return;
      }
      await loc.click({ timeout: 3_000, force: false });
      replayLog('  click succeeded');
    } catch {
      replayLog('  click failed, retrying with force');
      try {
        await loc.click({ timeout: 2_000, force: true });
        replayLog('  force-click succeeded');
      } catch {
        replayLog('  force-click also failed');
      }
    }
    return;
  }

  if (event.type === 'input' || event.type === 'change') {
    const loc = buildLocatorFromEvent(page, d);
    if (!loc || !d.value) {
      replayLog(`  skip ${event.type}: no locator or no value`);
      return;
    }
    const resolvedValue = resolveReplayEventValue(d.value, credentials);
    if (resolvedValue === null) {
      replayLog(`  skip ${event.type}: credential placeholder could not be resolved safely`);
      return;
    }
    const tag = (d.tag ?? '').toLowerCase();
    const type = (d.type ?? '').toLowerCase();
    replayLog(`  ${event.type}: tag=${tag} type=${type}`);
    try {
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) {
        replayLog(`  skip ${event.type}: element not visible`);
        return;
      }
      if (tag === 'select' || type === 'select-one') {
        await loc.selectOption(resolvedValue, { timeout: 3_000 });
      } else {
        await loc.fill(resolvedValue, { timeout: 3_000 });
      }
      replayLog(`  ${event.type} succeeded`);
    } catch {
      replayLog(`  ${event.type} failed`);
    }
    return;
  }

  if (event.type === 'submit') {
    replayLog('  submit');
    const loc = d.selector ? page.locator(d.selector) : null;
    if (loc) {
      try {
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) {
          replayLog('  skip submit: form not visible');
          return;
        }
        await loc.press('Enter', { timeout: 3_000 });
        replayLog('  submit succeeded');
      } catch {
        replayLog('  submit failed');
      }
    }
    return;
  }
}

interface EventDetail {
  tag?: string;
  id?: string;
  name?: string;
  type?: string;
  text?: string;
  ariaLabel?: string;
  href?: string;
  selector?: string;
  value?: string;
}

function parseEventDetail(detail: string | unknown): EventDetail | null {
  if (typeof detail === 'string') {
    try {
      return JSON.parse(detail);
    } catch {
      return null;
    }
  }
  if (typeof detail === 'object' && detail !== null) {
    return detail as EventDetail;
  }
  return null;
}

function buildLocatorFromEvent(page: Page, d: EventDetail): Locator | null {
  // Priority chain: id → name → ariaLabel → text → css selector
  if (d.id) {
    return page.locator(`[id="${d.id}"]`).first();
  }
  if (d.name) {
    return page.locator(`[name="${d.name}"]`).first();
  }
  if (d.ariaLabel) {
    return page.getByLabel(d.ariaLabel).first();
  }
  if (d.text && d.tag) {
    const tag = d.tag.toLowerCase();
    // For buttons/links, use text-based locator
    if (tag === 'button' || tag === 'a') {
      return page.getByRole(tag === 'button' ? 'button' : 'link', { name: d.text }).first();
    }
  }
  if (d.selector) {
    return page.locator(d.selector).first();
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
