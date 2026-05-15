/**
 * In-place multi-line progress renderer for concurrent compile agents.
 *
 * Uses DECSC/DECRC (save/restore cursor) to return to an absolute terminal
 * position on each redraw, then erases from that point to the end of the
 * screen.  This avoids relative cursor-up (CSI CUU) which breaks when
 * other code writes to stderr between redraws or when the terminal
 * processes escape sequences non-atomically.
 *
 * Falls back to plain newline-per-update for non-TTY output.
 */

const isTTY = (): boolean => process.stderr.isTTY ?? false;

export class MultiProgress {
  private lines = new Map<string, string>();
  private renderedCount = 0;
  private cursorSaved = false;

  update(key: string, message: string): void {
    this.lines.set(key, message);
    if (!isTTY()) {
      process.stderr.write(`${message}\n`);
      return;
    }
    this.redraw();
  }

  remove(key: string): void {
    this.lines.delete(key);
  }

  clear(): void {
    if (!isTTY() || this.renderedCount === 0) return;
    let buf = '';
    if (this.cursorSaved) buf += '\x1b8';
    buf += '\x1b[J';
    process.stderr.write(buf);
    this.renderedCount = 0;
    this.cursorSaved = false;
  }

  render(): void {
    if (!isTTY() || this.lines.size === 0) return;
    this.redraw();
  }

  private redraw(): void {
    let buf = '';
    if (this.cursorSaved) {
      buf += '\x1b8';
    }
    buf += '\x1b7\x1b[J';
    for (const [, msg] of this.lines) {
      buf += `${msg}\n`;
    }
    process.stderr.write(buf);
    this.cursorSaved = true;
    this.renderedCount = this.lines.size;
  }
}
