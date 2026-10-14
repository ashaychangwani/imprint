import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface Rollout {
  id: string;
  parent?: string;
  agentPath?: string;
  timestamp: string;
  path: string;
}

/** Only inspect headers while discovering the family. Full transcripts are read
 * only for this root and its descendants; forked ancestor history is excluded. */
export async function readNativeAgentUsage(rootId: string, directories: string[]) {
  const rollouts: Rollout[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names.filter((name) => name.endsWith('.jsonl'))) {
      const path = join(directory, name);
      const input = createReadStream(path);
      const header = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      try {
        const line = await header[Symbol.asyncIterator]().next();
        const first = JSON.parse(line.value ?? '');
        if (first.type !== 'session_meta') continue;
        const meta = first.payload;
        const source = meta.source?.subagent?.thread_spawn;
        rollouts.push({
          id: meta.id,
          parent: source?.parent_thread_id,
          agentPath: source?.agent_path,
          timestamp: meta.timestamp ?? first.timestamp,
          path,
        });
      } catch {
        /* incomplete or unrelated header */
      } finally {
        header.close();
        input.destroy();
      }
    }
  }
  const family = new Set([rootId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const rollout of rollouts)
      if (rollout.parent && family.has(rollout.parent) && !family.has(rollout.id)) {
        family.add(rollout.id);
        changed = true;
      }
  }
  const usage = [];
  for (const rollout of rollouts.filter(({ id }) => family.has(id))) {
    let reported: Record<string, number> | undefined;
    let previous: Record<string, number> | undefined;
    let signature: string | undefined;
    const missing = new Set<string>();
    let completed = false;
    let model: string | undefined;
    const lines = createInterface({
      input: createReadStream(rollout.path),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      let event: {
        timestamp: string;
        type: string;
        payload?: {
          type?: string;
          model?: string;
          info?: {
            total_token_usage?: Record<string, number>;
            last_token_usage?: Record<string, number>;
          };
        };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (Date.parse(event.timestamp) < Date.parse(rollout.timestamp)) continue;
      if (event.type === 'turn_context') model = event.payload?.model ?? model;
      if (event.type !== 'event_msg') continue;
      if (event.payload?.type === 'token_count' && event.payload.info?.total_token_usage) {
        const current = event.payload.info.total_token_usage;
        const nextSignature = JSON.stringify(current);
        if (nextSignature !== signature) {
          reported ??= {};
          const request = event.payload.info.last_token_usage;
          const reset =
            current.input_tokens !== undefined &&
            previous?.input_tokens !== undefined &&
            current.input_tokens < previous.input_tokens;
          for (const key of [
            'input_tokens',
            'output_tokens',
            'cached_input_tokens',
            'cache_write_input_tokens',
            'reasoning_output_tokens',
          ]) {
            const count =
              request?.[key] ??
              (current[key] === undefined
                ? undefined
                : reset
                  ? current[key]
                  : current[key] - (previous?.[key] ?? 0));
            if (count === undefined) missing.add(key);
            else reported[key] = (reported[key] ?? 0) + count;
          }
          previous = current;
          signature = nextSignature;
        }
      }
      if (event.payload?.type === 'task_started') completed = false;
      if (event.payload?.type === 'task_complete') completed = true;
    }
    usage.push({
      ...rollout,
      model,
      terminalEventObserved: completed,
      measurement: reported ? 'reported_usage_snapshot' : 'missing',
      missingFields: [...missing],
      inputTokens: reported?.input_tokens ?? null,
      outputTokens: reported?.output_tokens ?? null,
      cacheReadInputTokens: reported?.cached_input_tokens ?? null,
      cacheCreationInputTokens: missing.has('cache_write_input_tokens')
        ? null
        : (reported?.cache_write_input_tokens ?? null),
      reasoningOutputTokens: reported?.reasoning_output_tokens ?? null,
    });
  }
  return { rootId, rootFound: usage.some(({ id }) => id === rootId), threads: usage };
}
