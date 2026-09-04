import { copyFileSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let importCounter = 0;

/**
 * Import an agent-written module without reusing Bun's path-keyed TypeScript
 * module cache. Teach rewrites these files in place between attempts, so a
 * normal dynamic import can otherwise execute an earlier attempt.
 *
 * A unique sibling copy also keeps relative imports resolving from the
 * artifact directory. The copy is removed after evaluation.
 */
export async function importModuleFresh(modulePath: string): Promise<Record<string, unknown>> {
  const extension = extname(modulePath) || '.js';
  const copyPath = join(
    dirname(modulePath),
    `.imprint-import-${process.pid}-${Date.now()}-${importCounter++}${extension}`,
  );
  copyFileSync(modulePath, copyPath);
  try {
    return (await import(pathToFileURL(copyPath).href)) as Record<string, unknown>;
  } finally {
    rmSync(copyPath, { force: true });
  }
}
