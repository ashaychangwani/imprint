/**
 * Predicate engine for cron's `notifyWhen` config. Decides — given a
 * successful tool result — whether to fire a push notification and what
 * to say in it.
 *
 * Lives outside the workflow runtime on purpose: deciding "is this fare
 * a good price?" is operator-specific business logic that has nothing
 * to do with how the underlying API call is made. The runtime stays
 * generic; this file holds the conditional-notify logic.
 */

import { extractAt } from './json-path.ts';
import type { NotifyWhen } from './types.ts';

export interface NotifyDecision {
  notify: boolean;
  /** Used as the push title when notify=true. */
  title?: string;
  /** Used as the push body when notify=true. */
  message?: string;
}

export function evaluateNotifyWhen(
  pred: NotifyWhen,
  data: unknown,
  toolName = 'workflow',
): NotifyDecision {
  switch (pred.type) {
    case 'price_below': {
      const prices = extractAt(data, pred.pricePath);
      if (prices.length === 0) {
        // No prices at all — most likely an empty result set or a
        // misconfigured path. Treat as "no signal", don't push.
        return { notify: false };
      }
      const min = Math.min(...prices);
      if (min < pred.threshold) {
        return {
          notify: true,
          title: `imprint: price drop on ${toolName}`,
          message: `Lowest price $${min} (under your $${pred.threshold} threshold) — ${prices.length} option${prices.length === 1 ? '' : 's'} found.`,
        };
      }
      return { notify: false };
    }
  }
}
