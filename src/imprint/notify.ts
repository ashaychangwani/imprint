/**
 * Notification hooks for the cron daemon. Multi-provider: every provider
 * configured via env vars fires on each call, so you can mirror to both
 * Pushover and ntfy if you want, or just pick one. With nothing
 * configured, `notify()` is a silent no-op.
 *
 * Failures are caught and logged so a flaky push provider can never
 * crash the cron loop.
 *
 * Providers:
 *
 *   Pushover  PUSHOVER_TOKEN + PUSHOVER_USER
 *             https://pushover.net/api  (paid app, $5 one-time per platform)
 *
 *   ntfy      NTFY_URL  (e.g. https://ntfy.sh/your-secret-topic-name)
 *             NTFY_TOKEN  (optional bearer token for protected topics)
 *             https://docs.ntfy.sh/publish/  (free public, self-hostable)
 */

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

export interface NotifyResult {
  /** True if the provider was configured AND the API accepted the message. */
  delivered: boolean;
  /** Set when delivery was attempted-but-failed, OR provider was skipped. */
  reason?: string;
}

const log = (msg: string): void => {
  process.stderr.write(`[imprint notify] ${msg}\n`);
};

/**
 * Dispatch a notification to every configured provider in parallel.
 * Returns a per-provider result map so callers can log diagnostics
 * without blocking on individual provider failures.
 */
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

export async function notifyPushover(
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    return { delivered: false, reason: 'PUSHOVER_TOKEN / PUSHOVER_USER not set' };
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

export async function notifyNtfy(
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const url = process.env.NTFY_URL;
  if (!url) {
    return { delivered: false, reason: 'NTFY_URL not set' };
  }

  // ntfy publishes by POST-ing the message body to /<topic>. Title and
  // priority ride along as headers. Bearer auth is only needed for
  // protected topics on self-hosted instances.
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
