/**
 * In-place multi-line progress renderer for concurrent compile agents.
 *
 * Maintains one line per active tool, updating them in-place via ANSI escape
 * codes. Falls back to plain newline-per-update for non-TTY output.
 */

const isTTY = (): boolean => process.stderr.isTTY ?? false;

export class MultiProgress {
  private lines = new Map<string, string>();
  private renderedCount = 0;

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
    for (let i = 0; i < this.renderedCount; i++) {
      process.stderr.write('\x1b[A\x1b[2K');
    }
    this.renderedCount = 0;
  }

  render(): void {
    if (!isTTY() || this.lines.size === 0) return;
    this.redraw();
  }

  private redraw(): void {
    if (this.renderedCount > 0) {
      process.stderr.write(`\x1b[${this.renderedCount}A`);
    }
    for (const [, msg] of this.lines) {
      process.stderr.write(`\x1b[2K${msg}\n`);
    }
    this.renderedCount = this.lines.size;
  }
}
