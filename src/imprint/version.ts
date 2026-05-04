/** Single source of truth for the imprint version — read once from
 *  package.json so cli.ts, record.ts, probe-backends.ts can't drift. */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const pkgPath = pathResolve(import.meta.dir, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const VERSION = pkg.version;
