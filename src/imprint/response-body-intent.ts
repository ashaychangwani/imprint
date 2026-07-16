import { RSC_USER_INTENT_WINDOW_MS, matchesIntendedRoute } from './response-body-stream.ts';

interface UserIntent {
  atMs: number;
  url: string;
  activation: boolean;
}

const MAX_TRACKED_INTENTS = 256;
const MAX_INTENT_URL_CHARS = 4_096;

export type ResponseBodyIntentKind = 'pointerover' | 'pointerdown' | 'focusin' | 'click';

function isActivation(kind: ResponseBodyIntentKind | undefined): boolean {
  return kind === 'pointerdown' || kind === 'click';
}

/**
 * Correlates browser-timestamped DOM intent with requests independently of the
 * order in which Runtime and Network domain events reach the CDP client.
 */
export class ResponseBodyIntentTracker {
  readonly #intents: UserIntent[] = [];

  record(atMs: number, url: string | undefined, kind?: ResponseBodyIntentKind): void {
    if (!Number.isFinite(atMs) || !url || url.length > MAX_INTENT_URL_CHARS) return;
    const intent = { atMs, url, activation: isActivation(kind) };
    let low = 0;
    let high = this.#intents.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.#intents[middle]?.atMs ?? atMs) <= atMs) low = middle + 1;
      else high = middle;
    }
    this.#intents.splice(low, 0, intent);

    const newest = this.#intents.at(-1)?.atMs ?? atMs;
    const cutoff = newest - RSC_USER_INTENT_WINDOW_MS * 2;
    while ((this.#intents[0]?.atMs ?? newest) < cutoff) this.#intents.shift();
    if (this.#intents.length > MAX_TRACKED_INTENTS) {
      this.#intents.splice(0, this.#intents.length - MAX_TRACKED_INTENTS);
    }
  }

  match(requestUrl: string, requestAtMs: number): string | undefined {
    return this.#match(requestUrl, requestAtMs, false);
  }

  matchActivation(requestUrl: string, requestAtMs: number): string | undefined {
    return this.#match(requestUrl, requestAtMs, true);
  }

  #match(requestUrl: string, requestAtMs: number, requireActivation: boolean): string | undefined {
    for (let index = this.#intents.length - 1; index >= 0; index--) {
      const intent = this.#intents[index];
      if (!intent) continue;
      if (intent.atMs > requestAtMs) continue;
      if (requestAtMs - intent.atMs > RSC_USER_INTENT_WINDOW_MS) break;
      if (requireActivation && !intent.activation) continue;
      if (matchesIntendedRoute(requestUrl, intent.url)) return intent.url;
    }
    return undefined;
  }

  hasMatchingActivationSince(requestUrl: string, requestAtMs: number): boolean {
    return this.#intents.some(
      (intent) =>
        intent.activation &&
        intent.atMs >= requestAtMs &&
        matchesIntendedRoute(requestUrl, intent.url),
    );
  }
}
