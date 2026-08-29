/**
 * Live auth verification. The compile agent defines the auth program; this
 * class only preserves one browser session and continuation state while running
 * the requested actions.
 */

import { runWorkflowWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch, CdpPageSnapshot } from './cdp-browser-fetch.ts';
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
  private readonly cdpPool = new Map<string, CdpBrowserFetch>();
  private continuation: Record<string, unknown> | undefined;
  private readonly sensitiveValues = new Set<string>();

  constructor(
    private readonly workflowPath: string,
    private readonly credentials: CredentialStore,
  ) {
    this.rememberSensitiveValues(credentials.values);
    for (const cookie of credentials.cookies) this.rememberSensitiveValues(cookie.value);
    for (const storage of credentials.storage ?? []) this.rememberSensitiveValues(storage.value);
  }

  async runAction(
    action: string,
    parameters: Record<string, string | number | boolean> = {},
    options: { freshSession?: boolean; cleanSession?: boolean; signal?: AbortSignal } = {},
  ): Promise<AuthActionResult> {
    if (options.signal?.aborted) throw abortSignalError(options.signal);
    if (options.freshSession || options.cleanSession) await this.reset();
    this.rememberSensitiveValues(parameters);
    const previousContinuation = this.continuation;
    const startedAt = Date.now();
    const ladder = await ladderRunner({
      workflowPath: this.workflowPath,
      params: { ...parameters, action },
      credentials: options.cleanSession
        ? { ...this.credentials, cookies: [], storage: [] }
        : this.credentials,
      cdpPool: this.cdpPool,
      forceBackend: 'cdp-replay',
      initialState: this.continuation,
      signal: options.signal,
    });
    const durationMs = Date.now() - startedAt;
    const result = ladder.result;

    for (const browser of this.cdpPool.values()) {
      if (!browser.snapshotCookies) continue;
      try {
        for (const cookie of await browser.snapshotCookies()) {
          this.rememberSensitiveValues(cookie.value);
        }
      } catch {
        // A failed browser will be handled by the ladder's liveness policy.
      }
    }

    if (result.ok) {
      this.continuation = undefined;
    } else if (result.continuation !== undefined) {
      this.continuation = result.continuation;
    } else {
      this.continuation = previousContinuation;
    }
    this.rememberSensitiveValues(this.continuation);

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
    const browser = Array.from(this.cdpPool.values()).at(-1);
    if (!browser) {
      return { ok: false, message: 'No active verification browser session exists.' };
    }
    const inspectPage = browser.inspectPage;
    if (!inspectPage) {
      return { ok: false, message: 'The active verification browser cannot inspect pages.' };
    }

    const maxChars = Math.max(256, Math.min(20_000, Math.floor(options.maxChars ?? 8_000)));
    const snapshot = await withAbortSignal(() => inspectPage.call(browser), options.signal);
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

  async drain(): Promise<void> {
    await this.reset();
  }

  private async reset(): Promise<void> {
    for (const browser of this.cdpPool.values()) {
      await browser.close().catch(() => {});
    }
    this.cdpPool.clear();
    this.continuation = undefined;
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
    let sanitized = redactFreeformText(value).redacted;
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
