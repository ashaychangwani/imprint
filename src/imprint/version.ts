/** Single source of truth for the imprint version — read once from
 *  package.json so cli.ts, record.ts, probe-backends.ts can't drift.
 *  Compiled binaries receive the version via --define at build time. */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const compiledVersion = (globalThis as Record<string, unknown>).__IMPRINT_VERSION__ as
  | string
  | undefined;

let version: string;
if (compiledVersion) {
  version = compiledVersion;
} else {
  const pkgPath = pathResolve(import.meta.dir, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  version = pkg.version;
}

export const VERSION = version;
