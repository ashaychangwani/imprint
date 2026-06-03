import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { SharedModuleSpec } from '../src/imprint/build-plan.ts';
import {
  importModuleFresh,
  summarizeFailures,
  verifySharedModule,
} from '../src/imprint/prereq-builder.ts';
import type { Session } from '../src/imprint/types.ts';

function scratchDir(prefix: string): string {
  const scratchRoot = pathJoin(import.meta.dir, '..', '.context');
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(pathJoin(scratchRoot, prefix));
}

function sessionWithSignedRequest(seq: number, sig: string): Session {
  return {
    site: 'demo',
    startedAt: '2026-05-04T00:00:00.000Z',
    url: 'https://example.com/start',
    imprintVersion: '0.1.0',
    requests: [
      {
        seq,
        timestamp: 100,
        method: 'GET',
        url: `https://example.com/api?q=foo&sig=${sig}`,
        headers: {},
        resourceType: 'Fetch',
        response: { status: 200, headers: {}, mimeType: 'application/json', body: '{"ok":true}' },
      },
    ],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function writeSession(dir: string, session: Session): string {
  const p = pathJoin(dir, 'session.json');
  writeFileSync(p, JSON.stringify(session, null, 2), 'utf8');
  return p;
}

describe('importModuleFresh', () => {
  it('sees edits to the same module path within one process (defeats bun stale .ts cache)', async () => {
    const dir = scratchDir('prereq-fresh-');
    try {
      const p = pathJoin(dir, 'mod.ts');
      writeFileSync(p, 'export const foo = 1;\n', 'utf8');
      const m1 = await importModuleFresh(p);
      expect(Object.keys(m1)).toEqual(['foo']);
      // Simulate the compile agent adding the `transform` export in a later
      // verify cycle. A plain `import(path?t=...)` would return the stale m1
      // here (bun ignores the query for local .ts), wrongly pruning the fixed
      // module; importModuleFresh must observe the new export.
      writeFileSync(
        p,
        'export const foo = 1;\nexport function transform() { return "x"; }\n',
        'utf8',
      );
      const m2 = await importModuleFresh(p);
      expect(typeof m2.transform).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifySharedModule', () => {
  it('fails when the module file was not written', async () => {
    const dir = scratchDir('prereq-missing-');
    try {
      const session = sessionWithSignedRequest(5, 'ABCDEFGH12345678');
      const sessionPath = writeSession(dir, session);
      const module: SharedModuleSpec = {
        path: '_shared/sign.ts',
        kind: 'request-transform',
        purpose: 'sign',
        exportSignatures: ['export function transform(method: string, url: string): string'],
        spec: 'x',
        sourceSeqs: [5],
        dependsOn: [],
      };
      const { failures } = await verifySharedModule(dir, module, session, sessionPath);
      expect(failures.some((f) => f.includes('was not written'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a request-transform that reproduces the recorded signing param', async () => {
    const dir = scratchDir('prereq-rt-ok-');
    try {
      const sig = 'ABCDEFGH12345678';
      const session = sessionWithSignedRequest(5, sig);
      const sessionPath = writeSession(dir, session);
      writeFileSync(
        pathJoin(dir, 'sign.ts'),
        `export function transform(_method: string, url: string): string {
  const u = new URL(url);
  u.searchParams.set('sig', '${sig}');
  return u.toString();
}
`,
        'utf8',
      );
      writeFileSync(
        pathJoin(dir, 'sign.test.ts'),
        `import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { transform } from './sign.ts';
const SESSION_PATH = process.env.IMPRINT_SESSION_PATH;
if (!SESSION_PATH) throw new Error('IMPRINT_SESSION_PATH not set');
const session = JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as { requests: Array<{ seq: number; url: string }> };
test('re-signs the recorded URL', () => {
  const req = session.requests.find((r) => r.seq === 5);
  if (!req) throw new Error('seq 5 missing');
  const stripped = new URL(req.url);
  stripped.searchParams.delete('sig');
  const out = new URL(transform('GET', stripped.toString()));
  expect(out.searchParams.get('sig')).toBe('${sig}');
  expect(out.pathname).toBe('/api');
  expect(out.searchParams.get('q')).toBe('foo');
});
`,
        'utf8',
      );
      const module: SharedModuleSpec = {
        path: '_shared/sign.ts',
        kind: 'request-transform',
        purpose: 'sign',
        exportSignatures: ['export function transform(method: string, url: string): string'],
        spec: 'reproduce sig',
        sourceSeqs: [5],
        dependsOn: [],
      };
      const { failures } = await verifySharedModule(dir, module, session, sessionPath);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns (but does not fail) when a request-transform reproduces no recorded param', async () => {
    const dir = scratchDir('prereq-rt-noop-');
    try {
      const session = sessionWithSignedRequest(5, 'ABCDEFGH12345678');
      const sessionPath = writeSession(dir, session);
      // No-op transform — returns the URL unchanged.
      writeFileSync(
        pathJoin(dir, 'sign.ts'),
        `export function transform(_method: string, url: string): string {
  return url;
}
`,
        'utf8',
      );
      // A test that passes without asserting reproduction.
      writeFileSync(
        pathJoin(dir, 'sign.test.ts'),
        `import { expect, test } from 'bun:test';
import { transform } from './sign.ts';
test('returns a string', () => {
  expect(typeof transform('GET', 'https://x/y?a=b')).toBe('string');
  expect(transform('GET', 'https://x/y').length).toBeGreaterThan(0);
  expect(transform('GET', 'https://x/y')).toContain('https');
});
`,
        'utf8',
      );
      const module: SharedModuleSpec = {
        path: '_shared/sign.ts',
        kind: 'request-transform',
        purpose: 'sign',
        exportSignatures: ['export function transform(method: string, url: string): string'],
        spec: 'reproduce sig',
        sourceSeqs: [5],
        dependsOn: [],
      };
      const { failures, warnings } = await verifySharedModule(dir, module, session, sessionPath);
      expect(failures).toEqual([]);
      expect(warnings.some((w) => w.includes('did not reproduce'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a type-only module with no test file', async () => {
    const dir = scratchDir('prereq-types-');
    try {
      const session = sessionWithSignedRequest(5, 'ABCDEFGH12345678');
      const sessionPath = writeSession(dir, session);
      writeFileSync(
        pathJoin(dir, 'types.ts'),
        `export type Flight = { origin: string; destination: string };
export interface Hotel { name: string }
`,
        'utf8',
      );
      const module: SharedModuleSpec = {
        path: '_shared/types.ts',
        kind: 'types',
        purpose: 'shared types',
        exportSignatures: ['export type Flight', 'export interface Hotel'],
        spec: 'shared domain types',
        sourceSeqs: [],
        dependsOn: [],
      };
      const { failures } = await verifySharedModule(dir, module, session, sessionPath);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the module omits a declared export', async () => {
    const dir = scratchDir('prereq-missing-export-');
    try {
      const session = sessionWithSignedRequest(5, 'ABCDEFGH12345678');
      const sessionPath = writeSession(dir, session);
      writeFileSync(
        pathJoin(dir, 'parse.ts'),
        `export function other(): string { return 'x'; }
`,
        'utf8',
      );
      const module: SharedModuleSpec = {
        path: '_shared/parse.ts',
        kind: 'parser-helper',
        purpose: 'decode',
        exportSignatures: ['export function decode(body: unknown): unknown'],
        spec: 'decode the response',
        sourceSeqs: [5],
        dependsOn: [],
      };
      const { failures } = await verifySharedModule(dir, module, session, sessionPath);
      expect(failures.some((f) => f.includes('does not export "decode"'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarizeFailures', () => {
  it('categorizes each verification gate', () => {
    expect(summarizeFailures(['_shared/x.ts failed typecheck (exit 2)\nstdout:\n…'])).toBe(
      'typecheck',
    );
    expect(summarizeFailures(['bun test x.test.ts exited 1\nstdout:\n…'])).toBe('test');
    expect(
      summarizeFailures(['_shared/x.ts does not export "decode" (declared in exportSignatures)']),
    ).toBe('missing export');
    expect(summarizeFailures(['_shared/x.ts import failed: SyntaxError'])).toBe('import error');
    expect(
      summarizeFailures(['_shared/x.ts (request-transform) threw or returned no URL string']),
    ).toBe('signing anchor');
  });

  it('dedupes and joins multiple distinct gates in first-seen order', () => {
    expect(
      summarizeFailures([
        '_shared/x.ts failed typecheck (exit 2)',
        'bun test x.test.ts exited 1',
        '_shared/x.ts failed typecheck (exit 2)',
      ]),
    ).toBe('typecheck, test');
  });

  it('uses a generic label for unknown failures and never returns empty', () => {
    expect(summarizeFailures(['something totally unexpected'])).toBe('verification');
    expect(summarizeFailures([])).toBe('unknown');
  });
});
