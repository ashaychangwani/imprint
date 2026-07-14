import { describe, expect, it } from 'bun:test';
import { collectDescendantPids } from '../src/imprint/codex-cli-compile.ts';

describe('collectDescendantPids', () => {
  it('returns nested compiler descendants deepest-first across process groups', () => {
    expect(
      collectDescendantPids(
        [
          { pid: 20, ppid: 10 },
          { pid: 30, ppid: 20 },
          { pid: 40, ppid: 10 },
          { pid: 99, ppid: 1 },
        ],
        10,
      ),
    ).toEqual([30, 20, 40]);
  });
});
