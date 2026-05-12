/** Site-discovery helpers shared by verbs that take a <site> arg.
 *  When a verb gets a site name it doesn't recognize, list what's
 *  actually under the generated asset root so the user can spot a typo. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

/** List the configured sites under the asset root to suggest in error messages.
 *  Returns a single line starting with "→" for inclusion in a multi-line
 *  Error message. Always returns *something* (so callers can concat
 *  unconditionally). */
export function availableSitesHint(assetRoot: string, badSite: string): string {
  if (!existsSync(assetRoot)) {
    return `→ generated asset root doesn't exist at ${assetRoot} — run \`imprint teach <site>\` or \`imprint emit <workflow.json>\` to create a generated tool.`;
  }
  const sites = readdirSync(assetRoot).filter((d) => {
    try {
      return statSync(pathResolve(assetRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (sites.length === 0) {
    return `→ generated asset root is empty at ${assetRoot} — run \`imprint teach <site>\` or \`imprint emit <workflow.json>\` to create a generated tool.`;
  }
  return `→ available sites: ${sites.join(', ')} (you asked for "${badSite}").`;
}
