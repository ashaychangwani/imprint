/** Site-discovery helpers shared by verbs that take a <site> arg.
 *  When a verb gets a site name it doesn't recognize, list what's
 *  actually under examples/ so the user can spot a typo. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

/** List the configured sites under examples/ to suggest in error messages.
 *  Returns a single line starting with "→" for inclusion in a multi-line
 *  Error message. Always returns *something* (so callers can concat
 *  unconditionally). */
export function availableSitesHint(examplesDir: string, badSite: string): string {
  if (!existsSync(examplesDir)) {
    return "→ examples/ doesn't exist — run `imprint record <site>` to create one.";
  }
  const sites = readdirSync(examplesDir).filter((d) => {
    try {
      return statSync(pathResolve(examplesDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (sites.length === 0) {
    return '→ examples/ is empty — run `imprint record <site>` to create one.';
  }
  return `→ available sites: ${sites.join(', ')} (you asked for "${badSite}").`;
}
