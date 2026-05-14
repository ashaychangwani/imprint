/**
 * Notification hooks for the cron daemon. Two concerns:
 *   - evaluateNotifyWhen: predicate engine ("price_below" etc).
 *   - notify / providers: deliver to Pushover + ntfy in parallel.
 *
 * Every configured provider fires on each call; nothing configured is
 * a silent no-op. Failures are caught and logged so a flaky provider
 * can't crash the cron loop. See docs/notifications.md for setup.
 */

import { extractNumbers } from './json-path.ts';
import { createLog } from './log.ts';
import type { NotifyWhen } from './types.ts';

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

interface NotifyResult {
  /** True if the provider was configured AND the API accepted the message. */
  delivered: boolean;
  /** Set when delivery was attempted-but-failed, OR provider was skipped. */
  reason?: string;
}

interface NotifyDecision {
  notify: boolean;
  /** Used as the push title when notify=true. */
  title?: string;
  /** Used as the push body when notify=true. */
  message?: string;
}

export function evaluateNotifyWhen(
  pred: NotifyWhen,
  data: unknown,
  toolName = 'workflow',
): NotifyDecision {
  switch (pred.type) {
    case 'price_below': {
      const paths = Array.isArray(pred.pricePath) ? pred.pricePath : [pred.pricePath];
      // Union the values from every path that matches — gracefully handles
      // tools that return different shapes from different backends.
      const prices: number[] = [];
      for (const p of paths) {
        try {
          prices.push(...extractNumbers(data, p));
        } catch {
          // Path didn't match this shape — try the next one. If ALL paths
          // throw, prices stays empty and we treat it as "no signal" below.
        }
      }
      if (prices.length === 0) return { notify: false }; // empty / misconfigured path
      const min = Math.min(...prices);
      if (min < pred.threshold) {
        return {
          notify: true,
          title: `imprint: price drop on ${toolName}`,
          message: `Lowest price $${min} (under your $${pred.threshold} threshold) — ${prices.length} option${prices.length === 1 ? '' : 's'} found.`,
        };
      }
      return { notify: false };
    }
  }
}

const log = createLog('notify');

/** Push to every configured provider in parallel; returns per-provider results. */
export async function notify(
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, NotifyResult>> {
  const [pushover, ntfy] = await Promise.all([
    notifyPushover(title, message, fetchImpl),
    notifyNtfy(title, message, fetchImpl),
  ]);
  return { pushover, ntfy };
}

async function notifyPushover(
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    return {
      delivered: false,
      reason:
        'PUSHOVER_TOKEN / PUSHOVER_USER not set (or set NTFY_URL for free push — see docs/notifications.md)',
    };
  }

  const body = new URLSearchParams({ token, user, title, message });
  try {
    const r = await fetchImpl(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '<no body>');
      log(`Pushover rejected: ${r.status} ${text}`);
      return { delivered: false, reason: `HTTP ${r.status}: ${text}` };
    }
    log(`notified Pushover: ${title}`);
    return { delivered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Pushover request failed: ${msg}`);
    return { delivered: false, reason: msg };
  }
}

async function notifyNtfy(
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const url = process.env.NTFY_URL;
  if (!url) {
    return {
      delivered: false,
      reason:
        'NTFY_URL not set (e.g. https://ntfy.sh/your-secret-topic — see docs/notifications.md)',
    };
  }

  // POST body to /<topic>; title + priority ride as headers; bearer auth
  // only needed for protected topics on self-hosted instances.
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    Title: title,
    Priority: 'high',
    Tags: 'warning',
  };
  const token = process.env.NTFY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const r = await fetchImpl(url, { method: 'POST', headers, body: message });
    if (!r.ok) {
      const text = await r.text().catch(() => '<no body>');
      log(`ntfy rejected: ${r.status} ${text}`);
      return { delivered: false, reason: `HTTP ${r.status}: ${text}` };
    }
    log(`notified ntfy: ${title}`);
    return { delivered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ntfy request failed: ${msg}`);
    return { delivered: false, reason: msg };
  }
}
