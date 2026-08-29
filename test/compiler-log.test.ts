import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { recordCompilerHostError } from '../src/imprint/compiler-log.ts';

describe('recordCompilerHostError', () => {
  it('appends a launch failure without replacing existing compile events', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compiler-log-'));
    try {
      const logPath = pathJoin(dir, '.compile-log.json');
      const existing = [{ type: 'assistant', message: 'work already completed' }];
      writeFileSync(logPath, JSON.stringify(existing));

      recordCompilerHostError(logPath, 'failed to resume provider');

      expect(JSON.parse(readFileSync(logPath, 'utf8'))).toMatchObject([
        existing[0],
        { type: 'host_error', error: 'failed to resume provider' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an unreadable existing diagnostic', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compiler-log-'));
    try {
      const logPath = pathJoin(dir, '.compile-log.json');
      writeFileSync(logPath, 'partial diagnostic');
      recordCompilerHostError(logPath, 'spawn failed');
      expect(readFileSync(logPath, 'utf8')).toBe('partial diagnostic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
