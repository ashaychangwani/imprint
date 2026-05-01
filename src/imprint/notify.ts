/**
 * Pushover hook for the cron daemon. Reads PUSHOVER_TOKEN (app token)
 * and PUSHOVER_USER (user/group key) from the environment. If either is
 * unset, notification is a no-op — operators who don't want push
 * notifications simply don't set the env vars.
 *
 * Failures are caught and logged so a flaky push provider can never
 * crash the cron loop.
 *
 * Token setup: https://pushover.net/api — create an app to get
 * PUSHOVER_TOKEN, then your user key is on the dashboard.
 */

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

export interface NotifyResult {
  /** True if the env vars were set AND the API accepted the message. */
  delivered: boolean;
  /** Set when delivered=false and we tried to deliver. */
  reason?: string;
}

const log = (msg: string): void => {
  process.stderr.write(`[imprint notify] ${msg}\n`);
};

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
