/**
 * Walk a list of backends in order, escalating on FORBIDDEN and satisfiable
 * STATE_MISSING; other errors return immediately. fetch-bootstrap is a gated
 * API-replay adapter, not a default DOM fallback rung: auto only reaches it
 * for workflows that declare bootstrap/captures or STATE_MISSING says browser
 * bootstrap can satisfy the missing state.
 */

import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { type Page, chromium } from 'playwright';
import { RuntimeCookieJar } from './cookie-jar.ts';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import { type CredentialStore, loadCredentialStore, substituteString } from './runtime.ts';
import { type StealthFetch, createStealthFetch } from './stealth-fetch.ts';
import type { ResolvedTool } from './tool-loader.ts';
import type {
  BootstrapCapture,
  ConcreteBackend,
  ReplayBackend,
  StateCapability,
  StateMissingItem,
  ToolResult,
  Workflow,
} from './types.ts';

interface LadderResult {
  result: ToolResult;
  usedBackend: ConcreteBackend;
  /** One entry per rung that was tried. */
  attempts: Array<{
    backend: ConcreteBackend;
    outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
    detail: string;
    durationMs: number;
  }>;
}

const log = createLog('backend');

const DEFAULT_LADDER: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];

/** Expand a replayBackend choice into a concrete ladder. 'auto' prefers
 *  the probed order (if any), else the default. Explicit choice → single rung. */
export function resolveLadder(
  backend: ReplayBackend,
  cachedPreferredOrder?: ConcreteBackend[],
): ConcreteBackend[] {
  if (backend === 'auto') {
    return cachedPreferredOrder && cachedPreferredOrder.length > 0
      ? cachedPreferredOrder
      : DEFAULT_LADDER;
  }
  return [backend];
}

/** First non-FORBIDDEN result wins; last FORBIDDEN returned if every rung escalates. */
export async function runWithLadder(
  ladder: ConcreteBackend[],
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
  assetRoot: string,
  stealthCache: Map<string, StealthFetch>,
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const effectiveLadder = effectiveAutoLadder(ladder, tool.workflow);
  const attempts: LadderResult['attempts'] = [];
  let lastResult: ToolResult | null = null;

  for (const backend of effectiveLadder) {
    if (backend === 'playbook' && !existsSync(playbookPath(assetRoot, tool.site, tool.dir))) {
      attempts.push({
        backend,
        outcome: 'unavailable',
        detail: 'no playbook.yaml',
        durationMs: 0,
      });
      log(`${backend}: skipped (prerequisite missing)`);
      continue;
    }

    const t0 = Date.now();
    log(`trying ${backend}…`);
    let result: ToolResult;
    try {
      switch (backend) {
        case 'fetch':
          result = await tool.toolFn(params);
          break;
        case 'fetch-bootstrap':
          result = await runFetchBootstrap(tool, params);
          break;
        case 'stealth-fetch': {
          const sf = ensureStealthFetch(tool, stealthCache);
          result = await tool.toolFn(params, { fetchImpl: sf.fetchImpl });
          break;
        }
        case 'playbook':
          result = await runPlaybook({
            playbook: playbookPath(assetRoot, tool.site, tool.dir),
            params,
            site: tool.site,
          });
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: 'UNKNOWN', message: `${backend} threw: ${msg}` };
    }
    const durationMs = Date.now() - t0;
    lastResult = result;

    if (result.ok) {
      attempts.push({ backend, outcome: 'ok', detail: `succeeded in ${durationMs}ms`, durationMs });
      log(`${backend}: OK in ${durationMs}ms`);
      return { result, usedBackend: backend, attempts };
    }

    if (result.error === 'FORBIDDEN') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(`${backend}: FORBIDDEN in ${durationMs}ms — escalating`);
      continue;
    }

    if (result.error === 'STATE_MISSING') {
      const next = nextEscalationBackend(effectiveLadder, backend);
      if (next && stateMissingSatisfiableBy(next, result.missing ?? [])) {
        attempts.push({
          backend,
          outcome: 'escalate',
          detail: `${result.error}: ${result.message.slice(0, 120)}`,
          durationMs,
        });
        log(`${backend}: STATE_MISSING in ${durationMs}ms — escalating to ${next}`);
        continue;
      }
    }

    // Non-FORBIDDEN errors don't escalate — different backend can't fix
    // AUTH_EXPIRED, NETWORK, RATE_LIMITED.
    attempts.push({
      backend,
      outcome: 'failed',
      detail: `${result.error}: ${result.message.slice(0, 120)}`,
      durationMs,
    });
    log(`${backend}: ${result.error} in ${durationMs}ms — non-escalatable, returning`);
    return { result, usedBackend: backend, attempts };
  }

  // Every backend either escalated (FORBIDDEN) or was unavailable.
  if (!lastResult) {
    return {
      result: {
        ok: false,
        error: 'UNKNOWN',
        message: `Every backend in the ladder was unavailable: ${effectiveLadder.join(', ')}. For "auto" mode, ensure at least workflow.json exists; for the playbook rung, run \`imprint compile-playbook\` first.`,
      },
      usedBackend: effectiveLadder[effectiveLadder.length - 1] ?? 'fetch',
      attempts,
    };
  }
  log(
    `every backend escalated; returning last error from ${effectiveLadder[effectiveLadder.length - 1]}`,
  );
  return {
    result: lastResult,
    usedBackend: effectiveLadder[effectiveLadder.length - 1] ?? 'fetch',
    attempts,
  };
}

function effectiveAutoLadder(ladder: ConcreteBackend[], workflow: Workflow): ConcreteBackend[] {
  if (ladder.length <= 1 || ladder.includes('fetch-bootstrap')) return ladder;
  if (!workflowNeedsBootstrap(workflow)) return ladder;
  const fetchIdx = ladder.indexOf('fetch');
  if (fetchIdx === -1) return ladder;
  const next = [...ladder];
  next.splice(fetchIdx + 1, 0, 'fetch-bootstrap');
  return next;
}

function workflowNeedsBootstrap(workflow: Workflow): boolean {
  if (workflow.bootstrap) return true;
  return workflow.requests.some((r) =>
    (r.captures ?? []).some(
      (c) => c.capability === 'browser_bootstrap' || c.capability === 'stealth_bootstrap',
    ),
  );
}

function nextEscalationBackend(
  ladder: ConcreteBackend[],
  backend: ConcreteBackend,
): ConcreteBackend | null {
  const idx = ladder.indexOf(backend);
  if (idx < 0) return null;
  for (const next of ladder.slice(idx + 1)) {
    if (next !== 'playbook') return next;
  }
  return null;
}

function stateMissingSatisfiableBy(backend: ConcreteBackend, missing: StateMissingItem[]): boolean {
  const required = missing.filter((m) => m.required !== false);
  if (required.length === 0) return false;
  return required.every((m) => capabilitySatisfiedBy(backend, m.capability));
}

function capabilitySatisfiedBy(backend: ConcreteBackend, capability: StateCapability): boolean {
  if (backend === 'fetch-bootstrap') {
    return capability === 'browser_bootstrap' || capability === 'stealth_bootstrap';
  }
  if (backend === 'stealth-fetch') return capability === 'stealth_bootstrap';
  return false;
}

async function runFetchBootstrap(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
): Promise<ToolResult> {
  if (!tool.workflow.bootstrap) {
    return {
      ok: false,
      error: 'STATE_MISSING',
      message: 'fetch-bootstrap requires workflow.bootstrap metadata.',
      missing: [
        {
          name: 'workflow.bootstrap',
          source: 'workflow',
          capability: 'browser_bootstrap',
          required: true,
          failure: 'producer_unavailable',
          message: 'workflow.bootstrap is missing',
        },
      ],
      remediation: 'Regenerate or edit workflow.json with bootstrap metadata.',
    };
  }

  const credentials = (await loadCredentialStore(tool.site)) ?? {
    site: tool.site,
    cookies: [],
    values: {},
    storage: [],
  };
  const bootstrapUrl = substituteString(tool.workflow.bootstrap.url, params, credentials, []);
  const initialState: Record<string, unknown> = {};
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    if (credentials.cookies.length > 0) {
      await context.addCookies(
        credentials.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.hostOnly ? undefined : c.domain,
          url: c.hostOnly ? cookieUrlFor(c, bootstrapUrl) : undefined,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: sameSiteForPlaywright(c.sameSite),
        })),
      );
    }
    if ((credentials.storage ?? []).length > 0) {
      await context.addInitScript((records) => {
        const browserGlobal = globalThis as unknown as {
          location: { origin: string };
          localStorage: { setItem(key: string, value: string): void };
        };
        for (const record of records as Array<{
          origin: string;
          kind: 'localStorage' | 'sessionStorage';
          key: string;
          value: string;
        }>) {
          if (record.kind !== 'localStorage') continue;
          if (browserGlobal.location.origin !== record.origin) continue;
          browserGlobal.localStorage.setItem(record.key, record.value);
        }
      }, credentials.storage ?? []);
    }
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    await page.goto(bootstrapUrl, {
      waitUntil: tool.workflow.bootstrap.waitUntil ?? 'domcontentloaded',
      timeout: tool.workflow.bootstrap.timeoutMs ?? 30_000,
    });
    if (tool.workflow.bootstrap.waitMs) await page.waitForTimeout(tool.workflow.bootstrap.waitMs);

    const html = await page.content();
    for (const capture of tool.workflow.bootstrap.captures ?? []) {
      let value: unknown;
      try {
        value = await evaluateBootstrapCapture(capture, page, html);
      } catch (err) {
        if (capture.required === false) continue;
        return bootstrapCaptureMissingResult(
          capture,
          `Bootstrap capture "${capture.name}" (${capture.source}) failed: ${err instanceof Error ? err.message : String(err)}`,
          'producer_ran_value_absent',
        );
      }
      if (value !== undefined && value !== null && value !== '') {
        initialState[capture.name] = value;
      } else if (capture.required !== false && capture.source !== 'cookie') {
        return bootstrapCaptureMissingResult(
          capture,
          `Required bootstrap capture "${capture.name}" (${capture.source}) did not produce a value.`,
          'producer_ran_value_absent',
        );
      }
    }

    const cookies = await context.cookies();
    const bootstrappedCredentials: CredentialStore = {
      ...credentials,
      cookies: [
        ...credentials.cookies,
        ...cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          hostOnly: !c.domain.startsWith('.'),
        })),
      ],
    };
    const jar = new RuntimeCookieJar(bootstrappedCredentials.cookies);
    for (const capture of tool.workflow.bootstrap.captures ?? []) {
      if (capture.source !== 'cookie') continue;
      const lookup = jar.lookup(capture.cookie, capture.url ?? bootstrapUrl, {
        url: capture.url,
        domain: capture.domain,
        path: capture.path,
        sameSite: capture.sameSite,
        allowHttpOnlyProjection: capture.allowHttpOnlyProjection,
      });
      if (lookup.ok) initialState[capture.name] = lookup.cookie.value;
      else if (capture.required !== false) {
        return bootstrapCaptureMissingResult(
          capture,
          lookup.reason === 'ambiguous'
            ? `Bootstrap cookie capture "${capture.name}" is ambiguous; add url/domain/path constraints.`
            : lookup.reason === 'httponly'
              ? `Bootstrap cookie capture "${capture.name}" targets HttpOnly cookie "${capture.cookie}" without allowHttpOnlyProjection.`
              : `Bootstrap cookie capture "${capture.name}" did not find cookie "${capture.cookie}".`,
          lookup.reason === 'ambiguous' ? 'ambiguous_cookie' : 'producer_ran_value_absent',
        );
      }
    }
    return await tool.toolFn(params, {
      credentials: bootstrappedCredentials,
      initialState,
    });
  } catch (err) {
    const stateMissing = bootstrapFailureStateMissingResult(
      tool.workflow,
      `fetch-bootstrap could not produce required bootstrap state: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (stateMissing) return stateMissing;
    return {
      ok: false,
      error: 'NETWORK',
      message: `fetch-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function bootstrapFailureStateMissingResult(
  workflow: Workflow,
  message: string,
): ToolResult | null {
  const captures = (workflow.bootstrap?.captures ?? []).filter(
    (capture) => capture.required !== false,
  );
  if (captures.length === 0) return null;
  return {
    ok: false,
    error: 'STATE_MISSING',
    message,
    missing: captures.map((capture) =>
      bootstrapMissingItem(capture, message, 'producer_unavailable'),
    ),
    remediation: remediationForBootstrapCapabilities(captures.map((capture) => capture.capability)),
  };
}

function bootstrapCaptureMissingResult(
  capture: BootstrapCapture,
  message: string,
  failure: StateMissingItem['failure'],
): ToolResult {
  return {
    ok: false,
    error: 'STATE_MISSING',
    message,
    missing: [bootstrapMissingItem(capture, message, failure)],
    remediation: remediationForBootstrapCapabilities([capture.capability]),
  };
}

function bootstrapMissingItem(
  capture: BootstrapCapture,
  message: string,
  failure: StateMissingItem['failure'],
): StateMissingItem {
  return {
    name: capture.name,
    source: bootstrapCaptureSource(capture),
    capability: capture.capability,
    required: true,
    failure,
    message,
  };
}

function bootstrapCaptureSource(capture: BootstrapCapture): StateMissingItem['source'] {
  if (capture.source === 'cookie') return 'cookie';
  if (capture.source === 'local_storage' || capture.source === 'session_storage') return 'storage';
  return 'state';
}

function remediationForBootstrapCapabilities(capabilities: StateCapability[]): string {
  return capabilities.includes('stealth_bootstrap')
    ? 'Run through stealth-fetch so Imprint can mint bot-defense/browser state before API replay.'
    : 'Run through fetch-bootstrap, or update workflow.bootstrap so Imprint can mint browser state before API replay.';
}

async function evaluateBootstrapCapture(
  capture: BootstrapCapture,
  page: Page,
  html: string,
): Promise<unknown> {
  switch (capture.source) {
    case 'html_regex': {
      const match = html.match(new RegExp(capture.pattern));
      return match?.[capture.group ?? 1];
    }
    case 'dom_attribute':
      return await page
        .locator(capture.selector)
        .first()
        .getAttribute(capture.attribute, { timeout: capture.timeoutMs ?? 5000 });
    case 'dom_text':
      return await page
        .locator(capture.selector)
        .first()
        .textContent({ timeout: capture.timeoutMs ?? 5000 });
    case 'local_storage':
      return await page.evaluate(
        ({ origin, key }) => {
          const browserGlobal = globalThis as unknown as {
            location: { origin: string };
            localStorage: { getItem(key: string): string | null };
          };
          return browserGlobal.location.origin === origin
            ? browserGlobal.localStorage.getItem(key)
            : null;
        },
        { origin: capture.origin, key: capture.key },
      );
    case 'session_storage':
      return await page.evaluate(
        ({ origin, key }) => {
          const browserGlobal = globalThis as unknown as {
            location: { origin: string };
            sessionStorage: { getItem(key: string): string | null };
          };
          return browserGlobal.location.origin === origin
            ? browserGlobal.sessionStorage.getItem(key)
            : null;
        },
        { origin: capture.origin, key: capture.key },
      );
    case 'cookie':
      return undefined;
  }
}

function sameSiteForPlaywright(
  sameSite: string | undefined,
): 'Strict' | 'Lax' | 'None' | undefined {
  if (!sameSite) return undefined;
  const lower = sameSite.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'lax') return 'Lax';
  if (lower === 'none') return 'None';
  return undefined;
}

function cookieUrlFor(cookie: { domain: string; secure?: boolean }, fallback: string): string {
  try {
    const u = new URL(fallback);
    u.hostname = cookie.domain.replace(/^\./, '');
    u.protocol = cookie.secure ? 'https:' : u.protocol;
    return u.toString();
  } catch {
    return `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}/`;
  }
}

/** Per-site stealth fetcher; bootstrap pays its ~12s once per process. */
function ensureStealthFetch(tool: ResolvedTool, cache: Map<string, StealthFetch>): StealthFetch {
  const cached = cache.get(tool.site);
  if (cached) return cached;
  const sf = createStealthFetch({ baseUrl: pickBaseUrl(tool) });
  cache.set(tool.site, sf);
  return sf;
}

/** First request URL's origin — Akamai binds sensor tokens to that
 *  origin, and the origin is always literal (substitutions only appear
 *  after the domain in well-formed workflows). */
function pickBaseUrl(tool: ResolvedTool): string {
  const firstRequest = tool.workflow.requests[0];
  if (!firstRequest) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — stealth-fetch needs at least one request URL.\n→ re-record the session; recording probably stopped before any XHR fired.`,
    );
  }
  const m = firstRequest.url.match(/^(https?:\/\/[^/]+)/);
  if (m?.[1]) return m[1];
  throw new Error(
    `Could not derive bootstrap origin from URL: ${firstRequest.url}\n→ check workflow.json — the first request URL must start with https://<domain>.`,
  );
}

function playbookPath(assetRoot: string, site: string, toolDir?: string): string {
  if (toolDir) return pathResolve(toolDir, 'playbook.yaml');
  return pathResolve(assetRoot, site, 'playbook.yaml');
}
