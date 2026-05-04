/** `imprint check` — sanity-check a captured session.json or .jsonl
 *  for obvious gaps (no requests, no narration, no end markers). */

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { assembleFromJsonl } from './session-writer.ts';
import { type Session, SessionSchema } from './types.ts';

interface CheckResult {
  ok: boolean;
  warnings: string[];
  summary: string;
}

export function checkSession(path: string): CheckResult {
  if (!existsSync(path)) {
    return { ok: false, warnings: [`File not found: ${path}`], summary: '' };
  }

  let session: Session;
  try {
    if (extname(path) === '.jsonl') {
      session = assembleFromJsonl(path);
    } else {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      session = SessionSchema.parse(raw);
    }
  } catch (err) {
    return {
      ok: false,
      warnings: [`Failed to parse: ${err instanceof Error ? err.message : String(err)}`],
      summary: '',
    };
  }

  const warnings: string[] = [];

  // Categorize requests.
  const xhr = session.requests.filter((r) => /xhr|fetch/i.test(r.resourceType));
  const docs = session.requests.filter((r) => r.resourceType === 'Document');
  const posts = session.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  const errors = session.requests.filter(
    (r) => r.response?.status !== undefined && r.response.status >= 400,
  );
  const successes = session.requests.filter(
    (r) => r.response?.status !== undefined && r.response.status >= 200 && r.response.status < 300,
  );

  // Categorize events.
  const navs = session.events.filter((e) => e.type === 'navigation');
  const clicks = session.events.filter((e) => e.type === 'click');
  const inputs = session.events.filter((e) => e.type === 'input' || e.type === 'change');
  const submits = session.events.filter((e) => e.type === 'submit');

  const cookies = session.cookieSnapshots ?? [];
  const startCookies = cookies.find((c) => c.label === 'start');
  const endCookies = cookies.find((c) => c.label === 'end');

  const lastEventTs = Math.max(
    0,
    ...session.requests.map((r) => r.timestamp),
    ...session.events.map((e) => e.timestamp),
  );
  const durationS = (lastEventTs / 1000).toFixed(1);

  // Heuristic warnings.
  if (session.requests.length === 0) {
    warnings.push('No network requests captured. Recorder may have started after page load.');
  }
  if (session.narration.length === 0) {
    warnings.push('No narration captured. The LLM intent detection works best with narration.');
  }
  if (clicks.length === 0 && submits.length === 0) {
    warnings.push(
      'No clicks or form submits captured. Did the injector fail to load? (Check session for [IMPRINT] sentinel.)',
    );
  }
  if (posts.length === 0) {
    warnings.push(
      "No POST/PUT/DELETE requests captured. If this was a booking flow, the booking POST didn't fire — capture is likely incomplete.",
    );
  }
  if (!startCookies) {
    warnings.push('No start-of-session cookie snapshot. Auth state at recording start is unknown.');
  }
  if (!endCookies) {
    warnings.push(
      'No end-of-session cookie snapshot. The recorder may have crashed before clean shutdown.',
    );
  }
  if (errors.length > successes.length && errors.length > 3) {
    warnings.push(
      `More 4xx/5xx responses (${errors.length}) than 2xx (${successes.length}). Auth or anti-bot may be blocking the workflow.`,
    );
  }
  if (lastEventTs < 5000 && session.requests.length > 0) {
    warnings.push('Session is shorter than 5 seconds. Are you sure the workflow completed?');
  }

  const summary = [
    `site:        ${session.site}`,
    `duration:    ${durationS}s`,
    `requests:    ${session.requests.length} (${docs.length} doc, ${xhr.length} xhr, ${posts.length} POST/PUT/DELETE)`,
    `responses:   ${successes.length} 2xx, ${errors.length} 4xx/5xx`,
    `events:      ${navs.length} nav, ${clicks.length} click, ${inputs.length} input, ${submits.length} submit`,
    `narration:   ${session.narration.length} lines`,
    `cookies:     ${startCookies ? `${startCookies.cookies.length} at start` : 'no start snapshot'}, ${
      endCookies ? `${endCookies.cookies.length} at end` : 'no end snapshot'
    }`,
  ].join('\n  ');

  return {
    ok: warnings.length === 0,
    warnings,
    summary,
  };
}

export function reportCheck(path: string, result: CheckResult): void {
  console.log(`[imprint] check ${path}`);
  console.log('');
  console.log(`  ${result.summary}`);
  console.log('');
  if (result.warnings.length === 0) {
    console.log('  ✓ no warnings — capture looks complete');
    console.log('');
    console.log('next step:');
    console.log(`  imprint redact ${path}    # scrub credentials before LLM analysis`);
  } else {
    console.log(`  ⚠ ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}:`);
    for (const w of result.warnings) {
      console.log(`    • ${w}`);
    }
  }
  console.log('');
}
