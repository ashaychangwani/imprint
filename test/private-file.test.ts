import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from '../src/imprint/private-file.ts';

describe('writePrivateFile', () => {
  it('replaces an older readable artifact with a private file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'imprint-private-file-'));
    try {
      const path = join(directory, 'session.redacted.json');
      writeFileSync(path, 'old');
      chmodSync(path, 0o644);

      writePrivateFile(path, 'sensitive replacement');

      expect(readFileSync(path, 'utf8')).toBe('sensitive replacement');
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replaces a symlink without writing to its target', () => {
    const directory = mkdtempSync(join(tmpdir(), 'imprint-private-file-'));
    try {
      const target = join(directory, 'target');
      const path = join(directory, 'session.redacted.json');
      writeFileSync(target, 'leave intact');
      symlinkSync(target, path);

      writePrivateFile(path, 'private result');

      expect(readFileSync(target, 'utf8')).toBe('leave intact');
      expect(readFileSync(path, 'utf8')).toBe('private result');
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
