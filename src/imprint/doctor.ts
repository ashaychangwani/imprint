/** `imprint doctor` — check that the environment can actually run imprint.
 *  Reports pass/fail per prerequisite plus a one-line fix when failed. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    checkLLMProvider(),
    checkPushOptional(),
    checkClaudeCode(),
    checkHermes(),
    checkOpenClaw(),
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

function checkLLMProvider(): CheckResult {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasVertex = !!(process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
  const hasClaude = !!Bun.which('claude');
  const hasCodex = !!Bun.which('codex');
  const hasCursor = !!Bun.which('cursor');

  if (hasApiKey) {
    return { name: 'LLM provider', ok: true, detail: 'Anthropic API (ANTHROPIC_API_KEY set)' };
  }
  if (hasVertex) {
    const id = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
    return { name: 'LLM provider', ok: true, detail: `Vertex AI (project: ${id})` };
  }
  if (hasClaude) {
    return { name: 'LLM provider', ok: true, detail: 'Claude Code CLI (claude on PATH)' };
  }
  if (hasCodex) {
    return { name: 'LLM provider', ok: true, detail: 'Codex CLI (codex on PATH)' };
  }
  if (hasCursor) {
    return { name: 'LLM provider', ok: true, detail: 'Cursor CLI (cursor on PATH)' };
  }

  return {
    name: 'LLM provider',
    ok: false,
    detail: 'no provider detected',
    fix: 'set ANTHROPIC_API_KEY, ANTHROPIC_VERTEX_PROJECT_ID, or install Claude Code / Codex / Cursor CLI',
  };
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

function checkClaudeCode(): CheckResult {
  // Look for ~/.claude/settings.json
  const configPath = pathJoin(homedir(), '.claude', 'settings.json');
  if (!existsSync(configPath)) {
    return {
      name: 'Claude Code',
      ok: true,
      detail: 'not detected',
      fix: 'install Claude Code, then run `imprint teach <site>` to connect',
    };
  }
  // Check if any imprint-* MCP servers are registered
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const servers = config?.mcpServers ?? {};
    const imprintServers = Object.keys(servers).filter((k) => k.startsWith('imprint-'));
    if (imprintServers.length > 0) {
      return {
        name: 'Claude Code',
        ok: true,
        detail: `${imprintServers.length} imprint tool(s): ${imprintServers.join(', ')}`,
      };
    }
    return {
      name: 'Claude Code',
      ok: true,
      detail: 'installed, no imprint tools registered',
      fix: 'run `imprint teach <site>` to record a workflow and connect it',
    };
  } catch {
    return {
      name: 'Claude Code',
      ok: true,
      detail: 'installed (could not parse settings)',
    };
  }
}

function checkHermes(): CheckResult {
  const configPath = pathJoin(homedir(), '.hermes', 'config.yaml');
  if (!existsSync(configPath)) {
    return {
      name: 'Hermes Agent',
      ok: true,
      detail: 'not detected',
    };
  }
  return {
    name: 'Hermes Agent',
    ok: true,
    detail: `config at ${configPath}`,
    fix: 'run `imprint teach <site>` and select Hermes to connect',
  };
}

function checkOpenClaw(): CheckResult {
  const configPath = pathJoin(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(configPath)) {
    return {
      name: 'OpenClaw',
      ok: true,
      detail: 'not detected',
    };
  }
  return {
    name: 'OpenClaw',
    ok: true,
    detail: `config at ${configPath}`,
    fix: 'run `imprint teach <site>` and select OpenClaw to connect',
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
