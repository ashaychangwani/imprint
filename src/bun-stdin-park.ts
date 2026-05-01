/**
 * Side-effect-only module: at the moment Bun loads this file, grab the
 * Bun.stdin web stream and park it on globalThis. mcp-server.ts later
 * wraps it in a Node Readable. This MUST be imported as the very first
 * static import of cli.ts so it executes before any other module-evaluation
 * step that might let stdin bytes drain into Bun's default handler.
 */

const _g = globalThis as {
  Bun?: { stdin: { stream: () => unknown } };
  __imprintStdinStream?: unknown;
};

if (typeof _g.Bun !== 'undefined' && !_g.__imprintStdinStream) {
  _g.__imprintStdinStream = _g.Bun.stdin.stream();
  if (process.env.IMPRINT_DEBUG) {
    process.stderr.write(
      `[park] Bun.stdin.stream parked; type=${typeof _g.__imprintStdinStream}\n`,
    );
  }
}
