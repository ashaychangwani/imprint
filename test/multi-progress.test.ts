import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MultiProgress } from '../src/imprint/multi-progress.ts';

describe('MultiProgress', () => {
  const origWrite = process.stderr.write;
  const origIsTTY = process.stderr.isTTY;
  let writes: string[];

  beforeEach(() => {
    writes = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    (process.stderr as { isTTY: boolean }).isTTY = true;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    (process.stderr as { isTTY: boolean | undefined }).isTTY = origIsTTY;
  });

  it('first update: erase + line (no cursor-up)', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b[J│  tool1: thinking\n');
  });

  it('second update: cursor-up 1 + erase + line in single write', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    writes.length = 0;

    mp.update('tool1', 'tool1: running');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b[1F\x1b[J│  tool1: running\n');
  });

  it('two keys: cursor-up 2 + erase + two lines', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    mp.update('tool2', 'tool2: thinking');
    writes.length = 0;

    mp.update('tool1', 'tool1: running');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b[2F\x1b[J│  tool1: running\n│  tool2: thinking\n');
  });

  it('clear: cursor-up + erase', () => {
    const mp = new MultiProgress();
    mp.update('a', 'line-a');
    mp.update('b', 'line-b');
    writes.length = 0;

    mp.clear();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b[2F\x1b[J');
  });

  it('clear then render starts fresh (no cursor-up)', () => {
    const mp = new MultiProgress();
    mp.update('a', 'line-a');
    mp.update('b', 'line-b');

    mp.clear();
    mp.remove('a');
    writes.length = 0;

    mp.render();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b[J│  line-b\n');
  });

  it('non-TTY falls back to plain newlines', () => {
    (process.stderr as { isTTY: boolean | undefined }).isTTY = undefined;
    const mp = new MultiProgress();

    mp.update('tool1', 'tool1: thinking');
    mp.update('tool1', 'tool1: running');
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe('tool1: thinking\n');
    expect(writes[1]).toBe('tool1: running\n');
  });

  it('remove + render keeps correct line set', () => {
    const mp = new MultiProgress();
    mp.update('a', 'line-a');
    mp.update('b', 'line-b');
    mp.update('c', 'line-c');

    mp.remove('b');
    writes.length = 0;

    mp.update('a', 'line-a-v2');
    expect(writes).toHaveLength(1);
    const out = writes[0] as string;
    expect(out).toStartWith('\x1b[3F\x1b[J');
    expect(out).toContain('│  line-a-v2');
    expect(out).toContain('│  line-c');
    expect(out).not.toContain('line-b');
  });
});
