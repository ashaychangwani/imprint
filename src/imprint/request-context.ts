/**
 * Shared helpers for compacting repeated request metadata before it is handed
 * to an LLM. Full request/response bodies remain available through explicit
 * read tools; these helpers only shrink overview payloads.
 */

interface CompactRequestContext {
  seq: number;
  timestamp: number;
  repeatCount?: number;
  repeatedSeqs?: number[];
  lastTimestamp?: number;
}

interface CompactRequestContextsOptions {
  /**
   * Seqs that must remain as their own rows, even if they look identical to a
   * neighboring request. Candidate-scoped requests use this so selected tool
   * traffic is never hidden inside an unrelated representative row.
   */
  preserveSeqs?: Iterable<number>;
}

export function compactRequestContexts<T extends CompactRequestContext>(
  requests: T[],
  groupKey: (request: T) => unknown,
  opts: CompactRequestContextsOptions = {},
): T[] {
  const out: T[] = [];
  const seen = new Map<string, T>();
  const preserveSeqs = new Set(opts.preserveSeqs ?? []);

  for (const request of requests) {
    if (preserveSeqs.has(request.seq)) {
      out.push(request);
      continue;
    }

    const key = stableRequestContextKey(groupKey(request));
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, request);
      out.push(request);
      continue;
    }

    existing.repeatCount = (existing.repeatCount ?? 1) + 1;
    existing.repeatedSeqs = [...(existing.repeatedSeqs ?? [existing.seq]), request.seq];
    existing.lastTimestamp = request.timestamp;
  }

  return out;
}

function stableRequestContextKey(parts: unknown): string {
  return typeof parts === 'string' ? parts : JSON.stringify(parts);
}
