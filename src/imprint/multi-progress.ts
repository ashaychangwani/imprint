/**
 * In-place multi-line progress renderer for concurrent compile agents.
 *
 * Uses CSI CPL (\x1b[nF — cursor previous line) to move back to the
 * first rendered line, then CSI ED (\x1b[J — erase to end of screen)
 * before rewriting.  Everything is emitted in a single write() call
 * so the terminal processes it atomically.
 *
 * Falls back to plain newline-per-update for non-TTY output.
 */

const isTTY = (): boolean => process.stderr.isTTY ?? false;

export class MultiProgress {
  private lines = new Map<string, string>();
  private renderedCount = 0;
  private paused = false;

  update(key: string, message: string): void {
    this.lines.set(key, message);
    if (this.paused) return;
    if (!isTTY()) {
      process.stderr.write(`${message}\n`);
      return;
    }
    this.redraw();
  }

  remove(key: string): void {
    this.lines.delete(key);
  }

  /** Erase all rendered progress lines from the terminal. */
  clear(): void {
    if (!isTTY() || this.renderedCount === 0) return;
    process.stderr.write(`\x1b[${this.renderedCount}F\x1b[J`);
    this.renderedCount = 0;
  }

  /** Stop writing to the terminal. Updates are buffered in memory. */
  pause(): void {
    this.paused = true;
  }

  /** Resume writing. Redraws current state immediately. */
  resume(): void {
    this.paused = false;
    if (isTTY() && this.lines.size > 0) this.redraw();
  }

  render(): void {
    if (this.paused) return;
    if (!isTTY() || this.lines.size === 0) return;
    this.redraw();
  }

  private redraw(): void {
    const cols = process.stderr.columns || 80;
    let buf = '';
    if (this.renderedCount > 0) {
      buf += `\x1b[${this.renderedCount}F`;
    }
    buf += '\x1b[J';
    let physicalLines = 0;
    for (const [, msg] of this.lines) {
      const line = `│  ${msg}`;
      const truncated = line.length >= cols ? line.slice(0, cols - 1) : line;
      buf += `${truncated}\n`;
      physicalLines += 1;
    }
    process.stderr.write(buf);
    this.renderedCount = physicalLines;
  }
}
