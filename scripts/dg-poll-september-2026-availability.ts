/**
 * Poll Discover & Go for September 2026 availability.
 *
 * Required env:
 *   DG_EPASS_COOKIE='ePASS=...; ePASSRememberMe=...'
 *   DG_CSRF_TOKEN='...'
 *   DG_EPASS_PATRON_ID='...'
 *
 * Optional env:
 *   DG_POLL_MS=1000
 *   DG_REQUEST_TIMEOUT_MS=15000
 */

const DONE_MESSAGE = Array.from({ length: 1000 }, () => 'DONE').join(' ');

const cookie = Bun.env.DG_EPASS_COOKIE;
const csrfToken = Bun.env.DG_CSRF_TOKEN;
const patronID = Bun.env.DG_EPASS_PATRON_ID;
const pollMs = Number(Bun.env.DG_POLL_MS ?? '1000');
const requestTimeoutMs = Number(Bun.env.DG_REQUEST_TIMEOUT_MS ?? '15000');

if (!cookie || !csrfToken || !patronID) {
  console.error(
    [
      'Missing required environment variables.',
      "Run with: DG_EPASS_COOKIE='ePASS=...; ePASSRememberMe=...' DG_CSRF_TOKEN='...' DG_EPASS_PATRON_ID='...' bun run scripts/dg-poll-september-2026-availability.ts",
    ].join('\n'),
  );
  process.exit(1);
}

if (!Number.isFinite(pollMs) || pollMs <= 0) {
  console.error('DG_POLL_MS must be a positive number.');
  process.exit(1);
}

if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
  console.error('DG_REQUEST_TIMEOUT_MS must be a positive number.');
  process.exit(1);
}

function sanitizedError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [cookie, csrfToken, patronID]) {
    message = message.split(secret).join('[REDACTED]');
  }
  return message.length <= 500 ? message : `${message.slice(0, 500)}…`;
}

function buildUrl(): string {
  const url = new URL('https://sandiego.discoverandgo.net/epass_server.php');
  url.search = new URLSearchParams({
    dataType: 'json',
    method: 'OfferDatesAvailability',
    functionFile: 'Attractions',
    language: 'en',
    attractionID: '275',
    offerID: '1188',
    year: '2026',
    month: '9',
    csrf_token: csrfToken,
  }).toString();

  return url.toString();
}

function findDatesArray(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.dates)) {
    return record.dates;
  }

  for (const nested of Object.values(record)) {
    const dates = findDatesArray(nested);
    if (dates) {
      return dates;
    }
  }

  return null;
}

async function pollOnce(): Promise<boolean> {
  const response = await fetch(buildUrl(), {
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      Connection: 'keep-alive',
      Cookie: cookie,
      Referer: 'https://sandiego.discoverandgo.net/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'x-epass-clientID': '1',
      'x-epass-clientKey': '335e26134a53d4e23e4bed13517b7303',
      'x-epass-libraryID': '63',
      'x-epass-patronID': patronID,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  const payload: unknown = await response.json();
  const dates = findDatesArray(payload);
  const timestamp = new Date().toISOString();

  if (!dates) {
    console.log(`${timestamp} no dates array found`);
    return false;
  }

  console.log(`${timestamp} dates.length=${dates.length}`);
  if (dates.length === 0) {
    return false;
  }

  console.log(DONE_MESSAGE);
  return true;
}

let consecutiveFailures = 0;
while (true) {
  try {
    if (await pollOnce()) {
      process.exit(0);
    }
    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures++;
    console.error(`${new Date().toISOString()} ${sanitizedError(error)}`);
  }

  const retryMs = Math.min(60_000, pollMs * 2 ** Math.min(consecutiveFailures, 6));
  await Bun.sleep(retryMs);
}
