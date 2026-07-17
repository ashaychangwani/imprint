/**
 * Coordinates terminal events with response-body work after the 30-second
 * loading wait has expired. A terminal event must not invalidate a request
 * generation while its final `getResponseBody` call is still in flight.
 */
export class RequestBodyLifecycleTracker {
  readonly #active = new Set<string>();
  readonly #terminal = new Set<string>();

  #key(requestId: string, generation: number): string {
    return `${requestId}\0${generation}`;
  }

  begin(requestId: string, generation: number): void {
    this.#active.add(this.#key(requestId, generation));
  }

  /** Returns true when the generation can be deleted immediately. */
  markTerminal(requestId: string, generation: number): boolean {
    const key = this.#key(requestId, generation);
    if (!this.#active.has(key)) return true;
    this.#terminal.add(key);
    return false;
  }

  /** Returns true when a terminal event arrived while the body work was active. */
  finish(requestId: string, generation: number): boolean {
    const key = this.#key(requestId, generation);
    this.#active.delete(key);
    return this.#terminal.delete(key);
  }
}
