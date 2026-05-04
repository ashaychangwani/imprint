/** `imprint doctor` — check that the environment can actually run imprint.
 *  Reports pass/fail per prerequisite plus a one-line fix when failed. */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { findChromium } from './chromium.ts';
import { VERSION } from './version.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export function doctor(): CheckResult[] {
  return [
    checkBun(),
    checkChromium(),
    checkPlaywrightChromium(),
    checkVertexProject(),
    checkVertexRegion(),
    checkPushOptional(),
  ];
}

function checkBun(): CheckResult {
  const v = process.versions.bun;
  if (!v) {
    return {
      name: 'Bun runtime',
      ok: false,
      detail: 'not detected (process.versions.bun is undefined)',
      fix: 'install Bun ≥ 1.3 from https://bun.sh',
    };
  }
  return { name: 'Bun runtime', ok: true, detail: `v${v}` };
}

function checkChromium(): CheckResult {
  try {
    const path = findChromium();
    return { name: 'Chromium binary', ok: true, detail: path };
  } catch (err) {
    return {
      name: 'Chromium binary',
      ok: false,
      detail: err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err),
      fix: 'run: bunx playwright install chromium',
    };
  }
}

function checkPlaywrightChromium(): CheckResult {
  // Playwright's bundled "Chrome for Testing" lives under ms-playwright/.
  // findChromium() prefers it, so this is mostly a duplicate signal — but
  // useful as a separate line so users see whether the Playwright path
  // specifically is set up (matters for stealth-fetch + playbook backends).
  const cacheRoots = [
    pathJoin(homedir(), 'Library/Caches/ms-playwright'),
    pathJoin(homedir(), '.cache/ms-playwright'),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    try {
      const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
      if (dirs.length > 0) {
        return {
          name: 'Playwright Chromium',
          ok: true,
          detail: `${dirs.length} install(s) at ${root}`,
        };
      }
    } catch {
      // ignore
    }
  }
  return {
    name: 'Playwright Chromium',
    ok: false,
    detail: 'no chromium-* install under ~/Library/Caches/ms-playwright or ~/.cache/ms-playwright',
    fix: 'run: bunx playwright install chromium  (needed for stealth-fetch + playbook)',
  };
}

function checkVertexProject(): CheckResult {
  const id = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!id) {
    return {
      name: 'Vertex project ID',
      ok: false,
      detail: 'ANTHROPIC_VERTEX_PROJECT_ID and GOOGLE_CLOUD_PROJECT both unset',
      fix: 'export ANTHROPIC_VERTEX_PROJECT_ID=<your-gcp-project>  (needed for `generate` + `compile-playbook`)',
    };
  }
  return { name: 'Vertex project ID', ok: true, detail: id };
}

function checkVertexRegion(): CheckResult {
  const region = process.env.CLOUD_ML_REGION ?? 'us-east5 (default)';
  return { name: 'Vertex region', ok: true, detail: region };
}

function checkPushOptional(): CheckResult {
  const pushover = !!(process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER);
  const ntfy = !!process.env.NTFY_URL;
  if (pushover || ntfy) {
    const which = [pushover && 'Pushover', ntfy && 'ntfy'].filter(Boolean).join(' + ');
    return { name: 'Push notifications', ok: true, detail: which };
  }
  return {
    name: 'Push notifications',
    ok: true, // optional — not a failure
    detail: 'none configured (cron will only push to stderr)',
    fix: 'set PUSHOVER_TOKEN+PUSHOVER_USER or NTFY_URL — see docs/notifications.md',
  };
}

export function reportDoctor(checks: CheckResult[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [`imprint v${VERSION} doctor`, ''];
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok) {
      allOk = false;
      if (c.fix) lines.push(`      → ${c.fix}`);
    } else if (c.fix) {
      // Optional check that's not configured; advise but don't fail.
      lines.push(`      hint: ${c.fix}`);
    }
  }
  lines.push('');
  lines.push(allOk ? 'All required checks passed.' : 'Some required checks failed — fix above.');
  return { ok: allOk, lines };
}
