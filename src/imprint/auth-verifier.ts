/**
 * Live auth verification. The compile agent defines the auth program; this
 * class only preserves one browser session and continuation state while running
 * the requested actions.
 */

import {
  AUTH_DISCOVERY_POOL_KEY,
  type AuthBrowserAction,
  AuthBrowserActionSchema,
  type AuthBrowserObservation,
} from './auth-browser-discovery.ts';
import { runWorkflowWithLadder } from './backend-ladder.ts';
import {
  type CdpBrowserFetch,
  type CdpPageSnapshot,
  createCdpBrowserFetch,
} from './cdp-browser-fetch.ts';
import { abortSignalError, withAbortSignal } from './concurrency.ts';
import { redactFreeformText } from './freeform-redact.ts';
import { createLog } from './log.ts';
import type { CredentialStore } from './runtime.ts';

const log = createLog('auth-verify');

type LadderRunner = typeof runWorkflowWithLadder;
let ladderRunner: LadderRunner = runWorkflowWithLadder;

export function __setAuthVerifierLadderForTest(fn: LadderRunner | null): void {
  ladderRunner = fn ?? runWorkflowWithLadder;
}

export interface AuthActionResult {
  action: string;
  ok: boolean;
  error?: string;
  message?: string;
  nextAction?: string;
  continuation?: Record<string, unknown>;
  usedBackend: string;
  status?: number;
  responseBodyPreview?: string;
  durationMs: number;
  requestStageFacts?: Extract<import('./types.ts').ToolResult, { ok: false }>['requestStageFacts'];
  authExecution?: Extract<import('./types.ts').ToolResult, { ok: false }>['authExecution'];
  responseObservations?: Awaited<ReturnType<LadderRunner>>['responseObservations'];
}

interface AuthPageInspection {
  ok: boolean;
  message?: string;
  url?: string;
  title?: string;
  bodyText?: string;
  bodyTextTruncated?: boolean;
  cookies?: CdpPageSnapshot['cookies'];
}

export class AuthVerifier {
  private cdpPool = new Map<string, CdpBrowserFetch>();
  private readonly pendingPools = new Set<Map<string, CdpBrowserFetch>>();
  private readonly retiredPools = new Set<Map<string, CdpBrowserFetch>>();
  private readonly closedBrowsers = new WeakSet<CdpBrowserFetch>();
  private poolRelease: Promise<void> = Promise.resolve();
  private continuation: Record<string, unknown> | undefined;
  private readonly sensitiveValues = new Set<string>();
  private readonly abort = new AbortController();
  private lastAction?: Pick<AuthActionResult, 'action' | 'ok' | 'error' | 'nextAction' | 'status'>;

  /** Facts for a recovery turn; never expose carried state or browser values. */
  get state(): {
    browserActive: boolean;
    hasContinuation: boolean;
    lastAction?: Pick<AuthActionResult, 'action' | 'ok' | 'error' | 'nextAction' | 'status'>;
  } {
    return {
      browserActive: this.cdpPool.size > 0,
      hasContinuation: this.continuation !== undefined,
      lastAction: this.lastAction,
    };
  }

  constructor(
    private readonly workflowPath: string,
    private credentials: CredentialStore,
    private readonly discoveryUrl?: string,
  ) {
    this.rememberSensitiveValues(credentials.values);
  }

  /** Refresh future request inputs without discarding the live page or challenge. */
  updateCredentials(credentials: CredentialStore): void {
    if (this.abort.signal.aborted) throw abortSignalError(this.abort.signal);
    this.credentials = credentials;
    this.rememberSensitiveValues(credentials.values);
  }

  async runAction(
    action: string,
    parameters: Record<string, string | number | boolean> = {},
    options: { freshSession?: boolean; cleanSession?: boolean; signal?: AbortSignal } = {},
  ): Promise<AuthActionResult> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.abort.signal])
      : this.abort.signal;
    if (signal.aborted) throw abortSignalError(signal);
    await withAbortSignal(() => this.poolRelease, signal);
    if (options.freshSession || options.cleanSession) await this.reset();
    this.rememberSensitiveValues(parameters);
    const previousContinuation = this.continuation;
    const pool = this.cdpPool;
    const startedAt = Date.now();
    // A cancelled ladder can still be unwinding an uninterruptible CDP await.
    // Detach its map before returning to the caller: no later action may borrow
    // a browser that the older ladder can still close or evict.
    const abort = (): void => {
      if (this.cdpPool === pool) {
        this.lastAction = { action, ok: false, error: 'CANCELLED' };
      }
      void this.retirePool(pool);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      signal.removeEventListener('abort', abort);
      throw abortSignalError(signal);
    }
    this.pendingPools.add(pool);
    let ladder: Awaited<ReturnType<LadderRunner>>;
    try {
      ladder = await withAbortSignal(
        () =>
          Promise.resolve()
            .then(() => {
              if (signal.aborted) throw abortSignalError(signal);
              return ladderRunner({
                workflowPath: this.workflowPath,
                params: { ...parameters, action },
                credentials: options.cleanSession
                  ? { ...this.credentials, cookies: [], storage: [] }
                  : this.credentials,
                cdpPool: pool,
                forceBackend: 'cdp-replay',
                initialState: previousContinuation,
                signal,
              });
            })
            .finally(async () => {
              if (signal.aborted || pool !== this.cdpPool) await this.closePool(pool);
              this.pendingPools.delete(pool);
              this.retiredPools.delete(pool);
            }),
        signal,
      );
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) throw abortSignalError(signal);
    if (pool !== this.cdpPool)
      throw new DOMException('Authentication action context was replaced', 'AbortError');
    const durationMs = Date.now() - startedAt;
    const result = ladder.result;

    if (result.ok) {
      this.continuation = undefined;
    } else if (result.continuation !== undefined) {
      this.continuation = result.continuation;
    } else {
      this.continuation = previousContinuation;
    }

    const actionResult: AuthActionResult = {
      action,
      ok: result.ok,
      error: result.ok ? undefined : this.sanitize(result.error),
      message: result.ok ? undefined : this.sanitize(result.message),
      nextAction: result.ok ? undefined : this.sanitizeOptional(result.nextAction),
      continuation: result.ok ? undefined : this.continuation,
      usedBackend: ladder.usedBackend,
      status: result.ok ? undefined : result.status,
      responseBodyPreview: result.ok
        ? undefined
        : this.sanitizeOptional(result.responseBodyPreview),
      durationMs,
      requestStageFacts: result.ok ? undefined : result.requestStageFacts,
      authExecution:
        result.ok || !result.authExecution
          ? undefined
          : {
              ...result.authExecution,
              ...(result.authExecution.lastFailure
                ? {
                    lastFailure: {
                      error: this.sanitize(result.authExecution.lastFailure.error),
                      message: this.sanitize(result.authExecution.lastFailure.message),
                    },
                  }
                : {}),
            },
      responseObservations: ladder.responseObservations?.map(
        ({ redactedBodyPreview: _preview, ...facts }) => ({
          ...facts,
          ...(facts.contentType ? { contentType: this.sanitize(facts.contentType) } : {}),
          ...(facts.topLevelKeys
            ? { topLevelKeys: facts.topLevelKeys.map((key) => this.sanitize(key)) }
            : {}),
        }),
      ),
    };
    this.lastAction = {
      action,
      ok: actionResult.ok,
      error: actionResult.error,
      nextAction: actionResult.nextAction,
      status: actionResult.status,
    };
    log(
      `action=${JSON.stringify(action)} backend=${ladder.usedBackend} ok=${result.ok}${
        result.ok ? '' : ` error=${result.error}`
      } in ${durationMs}ms`,
    );
    return actionResult;
  }

  async inspectPage(
    options: { maxChars?: number; includeCookies?: boolean; signal?: AbortSignal } = {},
  ): Promise<AuthPageInspection> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.abort.signal])
      : this.abort.signal;
    if (signal.aborted) throw abortSignalError(signal);
    const browser = Array.from(this.cdpPool.values()).at(-1);
    if (!browser) {
      return { ok: false, message: 'No active verification browser session exists.' };
    }
    const inspectPage = browser.inspectPage;
    if (!inspectPage) {
      return { ok: false, message: 'The active verification browser cannot inspect pages.' };
    }

    const maxChars = Math.max(256, Math.min(20_000, Math.floor(options.maxChars ?? 8_000)));
    const snapshot = await withAbortSignal(() => inspectPage.call(browser), signal);
    const bodyText = this.sanitize(snapshot.bodyText);
    return {
      ok: true,
      url: this.sanitize(snapshot.url),
      title: this.sanitize(snapshot.title),
      bodyText: bodyText.slice(0, maxChars),
      bodyTextTruncated: bodyText.length > maxChars,
      ...(options.includeCookies === false
        ? {}
        : {
            cookies: snapshot.cookies.map((cookie) => ({
              name: cookie.name,
              value: this.sanitizeOptional(cookie.value),
              domain: cookie.domain,
              path: cookie.path,
              expires: cookie.expires,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: cookie.sameSite,
            })),
          }),
    };
  }

  async interactBrowser(
    input: AuthBrowserAction,
    callerSignal?: AbortSignal,
  ): Promise<AuthBrowserObservation> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.abort.signal])
      : this.abort.signal;
    if (signal.aborted) throw abortSignalError(signal);
    await withAbortSignal(() => this.poolRelease, signal);
    const action = AuthBrowserActionSchema.parse(input);
    if ('value' in action) {
      const credential = /^\$\{credential\.([^}]+)\}$/.exec(action.value);
      if (credential) {
        const value = this.credentials.values[credential[1] ?? ''];
        if (value === undefined)
          throw new Error('The requested credential is unavailable; ask the human for it.');
        action.value = value;
      }
      if (action.action === 'fill' || credential) this.rememberSensitiveValues(action.value);
    }
    const pool = this.cdpPool;
    let browser = Array.from(pool.values()).at(-1);
    if (!browser) {
      const url = action.action === 'navigate' ? action.url : this.discoveryUrl;
      if (!url)
        throw new Error('No verification browser exists; supply a discovery navigation URL.');
      browser = createCdpBrowserFetch({
        baseUrl: url,
        bootstrapUrl: url,
        headed: true,
        seedCookies: this.credentials.cookies,
        seedStorage: this.credentials.storage,
      });
      pool.set(AUTH_DISCOVERY_POOL_KEY, browser);
    }
    const interactBrowser = browser.interactBrowser?.bind(browser);
    if (!interactBrowser)
      throw new Error('The active verification browser cannot perform discovery.');
    const abort = (): void => {
      void this.retirePool(pool);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw abortSignalError(signal);
      const observation = await withAbortSignal(() => interactBrowser(action), signal);
      if (pool !== this.cdpPool || signal.aborted) throw abortSignalError(signal);
      const replacements = new Map(
        Object.entries(this.credentials.values).map(([name, value]) => [
          value,
          `\${credential.${name}}`,
        ]),
      );
      const protect = (value: unknown): unknown => {
        if (typeof value === 'string')
          return this.sanitize(redactFreeformText(value, replacements).redacted);
        if (Array.isArray(value)) return value.map(protect);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, protect(item)]),
          );
        return value;
      };
      return protect(observation) as AuthBrowserObservation;
    } catch (error) {
      if (signal.aborted) throw abortSignalError(signal);
      throw new Error(this.sanitize(error instanceof Error ? error.message : String(error)));
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async drain(): Promise<void> {
    this.abort.abort(new DOMException('Authentication verifier closed', 'AbortError'));
    await this.reset();
    await Promise.allSettled(Array.from(this.retiredPools, (pool) => this.closePool(pool)));
    this.sensitiveValues.clear();
    this.lastAction = undefined;
  }

  private async reset(): Promise<void> {
    await this.retirePool(this.cdpPool);
    await this.poolRelease;
  }

  private retirePool(pool: Map<string, CdpBrowserFetch>): Promise<void> {
    if (this.cdpPool === pool) {
      this.cdpPool = new Map();
      this.continuation = undefined;
    }
    this.retiredPools.add(pool);
    const release = this.closePool(pool);
    this.poolRelease = Promise.allSettled([this.poolRelease, release]).then(() => {});
    if (!this.pendingPools.has(pool)) void release.then(() => this.retiredPools.delete(pool));
    return release;
  }

  private async closePool(pool: Map<string, CdpBrowserFetch>): Promise<void> {
    const browsers = new Set(pool.values());
    pool.clear();
    await Promise.allSettled(
      Array.from(browsers, async (browser) => {
        if (this.closedBrowsers.has(browser)) return;
        this.closedBrowsers.add(browser);
        await browser.close();
      }),
    );
  }

  private rememberSensitiveValues(value: unknown, seen = new Set<object>()): void {
    if (typeof value === 'string') {
      this.rememberSensitiveValue(value);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;

    seen.add(value);
    for (const nested of Object.values(value)) this.rememberSensitiveValues(nested, seen);
  }

  private rememberSensitiveValue(value: string): void {
    if (value.length < 3) return;
    this.sensitiveValues.add(value);

    const encoded = encodeURIComponent(value);
    const lowercaseEncoded = encoded.replace(/%[0-9A-F]{2}/g, (encodedByte) =>
      encodedByte.toLowerCase(),
    );
    this.sensitiveValues.add(encoded);
    this.sensitiveValues.add(encoded.replace(/%20/g, '+'));
    this.sensitiveValues.add(lowercaseEncoded);
    this.sensitiveValues.add(lowercaseEncoded.replace(/%20/g, '+'));
    this.sensitiveValues.add(JSON.stringify(value).slice(1, -1));
    this.sensitiveValues.add(
      Array.from(value, (character) =>
        /[a-z0-9]/i.test(character) ? character : `&#${character.codePointAt(0) ?? 0};`,
      ).join(''),
    );
    this.sensitiveValues.add(
      Array.from(value, (character) =>
        /[a-z0-9]/i.test(character)
          ? character
          : `&#x${(character.codePointAt(0) ?? 0).toString(16)};`,
      ).join(''),
    );
  }

  private sanitize(value: string): string {
    let sanitized = value;
    const secrets = Array.from(this.sensitiveValues).sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
    return sanitized;
  }

  private sanitizeOptional(value: string | undefined): string | undefined {
    return value === undefined ? undefined : this.sanitize(value);
  }
}
