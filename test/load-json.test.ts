/**
 * `loadJsonFile` is the shared file/JSON/schema-validation helper used
 * by cron.ts, emit.ts, compile.ts, and the cli.ts redact case. The
 * exact error shape matters — every callsite relies on the multi-line
 * format ("noun not found: PATH\n→ remediation") so users see the same
 * shape regardless of which verb threw.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { loadJsonFile } from '../src/imprint/load-json.ts';

const SCHEMA = z.object({
  name: z.string(),
  count: z.number().int(),
  optional: z.boolean().optional(),
});

const REMEDIATION = {
  notFound: '→ create one with: {"name":"foo","count":1}',
  notJson: '→ check for stray commas',
  badSchema: '→ see the schema docs',
};

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-load-json-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadJsonFile', () => {
  it('returns parsed data on a valid file', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'good.json');
      writeFileSync(path, JSON.stringify({ name: 'alice', count: 3 }));
      const data = loadJsonFile(path, SCHEMA, REMEDIATION, 'config');
      expect(data).toEqual({ name: 'alice', count: 3 });
    });
  });

  it('throws "noun not found" with the remediation when file missing', () => {
    expect(() => loadJsonFile('/nope/missing.json', SCHEMA, REMEDIATION, 'config')).toThrow(
      /config not found.*\/nope\/missing\.json[\s\S]*create one/,
    );
  });

  it('throws "not valid JSON" with the underlying parse error', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'bad.json');
      writeFileSync(path, '{not json');
      expect(() => loadJsonFile(path, SCHEMA, REMEDIATION, 'config')).toThrow(
        /is not valid JSON[\s\S]*stray commas/,
      );
    });
  });

  it('throws "not a file" when the path is a directory', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'config.json');
      mkdirSync(path);
      expect(() => loadJsonFile(path, SCHEMA, REMEDIATION, 'config')).toThrow(
        /config is not a file[\s\S]*create one/,
      );
    });
  });

  it('throws "doesn\'t match the noun schema" with each issue listed', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'wrong-shape.json');
      writeFileSync(path, JSON.stringify({ count: 'three' }));
      expect(() => loadJsonFile(path, SCHEMA, REMEDIATION, 'config')).toThrow(
        /doesn't match the config schema[\s\S]*name[\s\S]*count[\s\S]*see the schema docs/,
      );
    });
  });

  it('omits optional remediation tails when not provided', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'bad.json');
      writeFileSync(path, '{');
      // No notJson; only notFound provided.
      try {
        loadJsonFile(path, SCHEMA, { notFound: '→ try harder' }, 'config');
        throw new Error('should have thrown');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/is not valid JSON/);
        // Tail should be empty — no '→ ...' line because notJson wasn't set.
        expect(msg.endsWith('JSON')).toBe(false);
        expect(msg.split('\n').filter((l) => l.startsWith('→')).length).toBe(0);
      }
    });
  });

  it('uses default noun "file" when not specified', () => {
    expect(() => loadJsonFile('/nope.json', SCHEMA, REMEDIATION)).toThrow(/file not found/);
  });

  it('preserves schema-default expansion (output type, not input type)', () => {
    const SCHEMA_WITH_DEFAULT = z.object({
      name: z.string(),
      count: z.number().default(0),
    });
    withTemp((dir) => {
      const path = pathJoin(dir, 'partial.json');
      writeFileSync(path, JSON.stringify({ name: 'alice' }));
      const data = loadJsonFile(path, SCHEMA_WITH_DEFAULT, REMEDIATION);
      // count was filled in by the schema default — required in output type
      expect(data.count).toBe(0);
    });
  });
});
