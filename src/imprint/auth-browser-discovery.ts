import { randomUUID } from 'node:crypto';
import type CDP from 'chrome-remote-interface';
import { z } from 'zod';
import type { CapturedRequest } from './types.ts';

export const AUTH_DISCOVERY_POOL_KEY = 'auth-browser-discovery';

/** Browser mechanics only; the auth agent chooses the page, controls and factor. */
export const AuthBrowserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }),
  z.object({ action: z.literal('navigate'), url: z.string().url() }),
  z.object({ action: z.literal('click'), selector: z.string().min(1) }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal('select'), selector: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal('press'), key: z.string().min(1) }),
  z.object({ action: z.literal('wait'), milliseconds: z.number().int().min(0).max(30_000) }),
]);
export type AuthBrowserAction = z.infer<typeof AuthBrowserActionSchema>;

export interface AuthBrowserObservation {
  sourceId: string;
  page: {
    url: string;
    title: string;
    bodyText: string;
    controls: Array<{
      selector: string;
      tag: string;
      type: string;
      name: string;
      text: string;
      disabled: boolean;
    }>;
    controlsTruncated: boolean;
  };
  requests: CapturedRequest[];
  captureErrors: Array<{ seq: number; message: string }>;
}

type Client = CDP.Client;

/** Kept attached between checkpoints, including while the human handles an OTP.
 * Request identity is allocated on send, never on response completion. */
export class AuthBrowserDiscovery {
  private readonly sourceId = randomUUID();
  private readonly started = Date.now();
  private sequence = 0;
  private readonly inflight = new Map<string, CapturedRequest>();
  private readonly changed = new Map<number, CapturedRequest>();
  private readonly bodyReads = new Set<Promise<void>>();
  private errors: AuthBrowserObservation['captureErrors'] = [];
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {
    client.Network.requestWillBeSent((event) => {
      if (this.closed) return;
      const previous = this.inflight.get(event.requestId);
      if (previous && event.redirectResponse) {
        previous.response = {
          status: event.redirectResponse.status,
          headers: headers(event.redirectResponse.headers),
          mimeType: event.redirectResponse.mimeType,
        };
        this.changed.set(previous.seq, previous);
      }
      if (!/^https?:/.test(event.request.url)) return;
      const request: CapturedRequest = {
        seq: this.sequence++,
        timestamp: Date.now() - this.started,
        method: event.request.method,
        url: event.request.url,
        headers: headers(event.request.headers),
        body: event.request.postData,
        resourceType: event.type ?? 'Other',
      };
      this.inflight.set(event.requestId, request);
      this.changed.set(request.seq, request);
      if (event.request.hasPostData && event.request.postData === undefined) {
        this.track(async () => {
          try {
            const body = await this.command(
              client.Network.getRequestPostData({ requestId: event.requestId }),
            );
            request.body = body.postData;
          } catch {
            this.errors.push({ seq: request.seq, message: 'Request body unavailable from CDP.' });
          }
          this.changed.set(request.seq, request);
        });
      }
    });
    client.Network.responseReceived((event) => {
      if (this.closed) return;
      const request = this.inflight.get(event.requestId);
      if (!request) return;
      request.response = {
        status: event.response.status,
        headers: headers(event.response.headers),
        mimeType: event.response.mimeType,
      };
      this.changed.set(request.seq, request);
    });
    client.Network.loadingFinished((event) => {
      if (this.closed) return;
      const request = this.inflight.get(event.requestId);
      if (!request) return;
      this.inflight.delete(event.requestId);
      this.track(async () => {
        try {
          const body = await this.command(
            client.Network.getResponseBody({ requestId: event.requestId }),
          );
          if (request.response) {
            request.response.body = body.base64Encoded
              ? Buffer.from(body.body, 'base64').toString('utf8')
              : body.body;
          }
        } catch {
          this.errors.push({ seq: request.seq, message: 'Response body unavailable from CDP.' });
        }
        this.changed.set(request.seq, request);
      });
    });
    client.Network.loadingFailed((event) => {
      if (this.closed) return;
      const request = this.inflight.get(event.requestId);
      if (!request) return;
      this.inflight.delete(event.requestId);
      this.errors.push({ seq: request.seq, message: event.errorText });
      this.changed.set(request.seq, request);
    });
  }

  close(): void {
    this.closed = true;
    this.inflight.clear();
    this.changed.clear();
    this.errors = [];
  }

  async interact(
    action: AuthBrowserAction,
    clickExpression: (selector: string) => string,
  ): Promise<AuthBrowserObservation> {
    const { Input, Page } = this.client;
    if (action.action === 'navigate') {
      if (!/^https?:/.test(action.url)) throw new Error('Navigation requires an HTTP(S) URL.');
      const result = await this.command(Page.navigate({ url: action.url }));
      if (result.errorText) throw new Error(result.errorText);
    } else if (action.action === 'click') {
      const point = (await this.evaluate(clickExpression(action.selector))) as {
        x?: number;
        y?: number;
        diagnostic?: unknown;
      };
      if (point.x === undefined || point.y === undefined)
        throw new Error(`Click target unavailable: ${JSON.stringify(point.diagnostic)}`);
      await this.command(
        Input.dispatchMouseEvent({
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        }),
      );
      await this.command(
        Input.dispatchMouseEvent({
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        }),
      );
    } else if (action.action === 'fill' || action.action === 'select') {
      await this.evaluate(`(() => {
        const matches = document.querySelectorAll(${JSON.stringify(action.selector)});
        if (matches.length !== 1) throw new Error('Expected exactly one input control');
        const element = matches[0];
        if (element.matches(':disabled')) throw new Error('Control is disabled');
        element.focus();
        if (${JSON.stringify(action.action)} === 'select') {
          if (!(element instanceof HTMLSelectElement)) throw new Error('Control is not a select');
          element.value = ${JSON.stringify(action.value)};
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Control is not a text input');
          element.select();
        }
      })()`);
      if (action.action === 'fill') await this.command(Input.insertText({ text: action.value }));
    } else if (action.action === 'press') {
      const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 }[action.key];
      await this.command(
        Input.dispatchKeyEvent({
          type: 'keyDown',
          key: action.key,
          windowsVirtualKeyCode: code,
          ...(action.key === 'Enter' ? { text: '\r' } : {}),
        }),
      );
      await this.command(
        Input.dispatchKeyEvent({ type: 'keyUp', key: action.key, windowsVirtualKeyCode: code }),
      );
    }
    // This is an observation interval, not a claim that the page has settled.
    // The agent can inspect/wait again for slow responses or external actions.
    await new Promise((resolve) =>
      setTimeout(resolve, action.action === 'wait' ? action.milliseconds : 250),
    );
    const page = (await this.evaluate(`(() => {
      const selector = (element) => {
        if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) return '#' + CSS.escape(element.id);
        const parts = [];
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
          const peers = node.parentElement ? [...node.parentElement.children].filter(p => p.tagName === node.tagName) : [node];
          parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (peers.indexOf(node) + 1) + ')');
        }
        return parts.join(' > ');
      };
      const controls = [...document.querySelectorAll('input:not([type=hidden]),button,select,textarea,a[href],[role=button],[role=radio]')].filter(e => e.getClientRects().length);
      return {
        url: location.href, title: document.title, bodyText: (document.body?.innerText ?? '').slice(0, 20000),
        controls: controls.slice(0, 100).map(e => ({ selector: selector(e), tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '', name: e.getAttribute('name') || '', text: (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || '').slice(0, 300), disabled: e.matches(':disabled') })),
        controlsTruncated: controls.length > 100
      };
    })()`)) as AuthBrowserObservation['page'];
    await Promise.all([...this.bodyReads]);
    const requests = structuredClone([...this.changed.values()]);
    this.changed.clear();
    const captureErrors = this.errors;
    this.errors = [];
    return { sourceId: this.sourceId, page, requests, captureErrors };
  }

  private track(work: () => Promise<void>): void {
    const promise = work();
    this.bodyReads.add(promise);
    void promise.finally(() => this.bodyReads.delete(promise));
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = await this.command(
      this.client.Runtime.evaluate({ expression, returnByValue: true }),
    );
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.text || 'Browser interaction failed');
    return result.result.value;
  }

  private async command<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Browser discovery CDP command timed out')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function headers(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}
