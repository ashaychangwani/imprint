import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { VERSION } from './version.ts';

const PACKAGE_NAME = 'imprint-mcp';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  error?: string;
}

export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return null;
    return { current: VERSION, latest, updateAvailable: semver.gt(latest, VERSION) };
  } catch {
    return null;
  }
}

const IS_COMPILED = typeof (globalThis as Record<string, unknown>).__IMPRINT_VERSION__ === 'string';

export async function performUpdate(): Promise<UpdateResult> {
  const check = await checkForUpdate();
  if (!check) {
    return { ok: false, from: VERSION, to: VERSION, error: 'could not reach npm registry' };
  }
  if (!check.updateAvailable) {
    return { ok: true, from: VERSION, to: VERSION };
  }

  const result = IS_COMPILED
    ? spawnSync(
        'bash',
        [
          '-c',
          'curl -fsSL https://raw.githubusercontent.com/ashaychangwani/imprint/main/scripts/install.sh | bash',
        ],
        { stdio: 'pipe', timeout: 60_000 },
      )
    : spawnSync('bun', ['install', '-g', `${PACKAGE_NAME}@latest`], {
        stdio: 'pipe',
        timeout: 60_000,
      });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      ok: false,
      from: check.current,
      to: check.latest,
      error: stderr || result.error?.message || `install exited with code ${result.status}`,
    };
  }

  return { ok: true, from: check.current, to: check.latest };
}
