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

  it('first update: save cursor + erase + line', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    expect(writes).toHaveLength(1);
    // \x1b7 = DECSC (save), \x1b[J = erase to end of screen
    expect(writes[0]).toBe('\x1b7\x1b[J│  tool1: thinking\n');
  });

  it('second update: restore + save + erase + line in single write', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    writes.length = 0;

    mp.update('tool1', 'tool1: running');
    expect(writes).toHaveLength(1);
    // \x1b8 = DECRC (restore), \x1b7 = DECSC (re-save), \x1b[J = erase
    expect(writes[0]).toBe('\x1b8\x1b7\x1b[J│  tool1: running\n');
  });

  it('two keys: restore + save + erase + two lines', () => {
    const mp = new MultiProgress();
    mp.update('tool1', 'tool1: thinking');
    mp.update('tool2', 'tool2: thinking');
    writes.length = 0;

    mp.update('tool1', 'tool1: running');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b8\x1b7\x1b[J│  tool1: running\n│  tool2: thinking\n');
  });

  it('clear: restore + erase, resets cursorSaved', () => {
    const mp = new MultiProgress();
    mp.update('a', 'line-a');
    mp.update('b', 'line-b');
    writes.length = 0;

    mp.clear();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b8\x1b[J');
  });

  it('clear then render saves new cursor position', () => {
    const mp = new MultiProgress();
    mp.update('a', 'line-a');
    mp.update('b', 'line-b');

    mp.clear();
    mp.remove('a');
    writes.length = 0;

    // After clear, cursorSaved is false so no restore — just save + erase + line
    mp.render();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b7\x1b[J│  line-b\n');
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
    expect(out).toStartWith('\x1b8\x1b7\x1b[J');
    expect(out).toContain('│  line-a-v2');
    expect(out).toContain('│  line-c');
    expect(out).not.toContain('line-b');
  });
});
