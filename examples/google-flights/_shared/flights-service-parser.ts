import {
  getWrbPayload,
  parseBatchExecuteEnvelope,
} from './batchexecute-envelope.ts';

export function parseFlightsServicePayload(body: string): unknown[] {
  const envelope = parseBatchExecuteEnvelope(body);
  const payload: unknown = getWrbPayload(envelope);
  return asJspbArray(payload, 'FlightsFrontendService payload');
}

export function jspbAt(value: unknown, path: readonly number[]): unknown {
  let current: unknown = value;

  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    const array: unknown[] = current;
    const next: unknown = array[index];
    if (next === undefined) return undefined;
    current = next;
  }

  return current;
}

export function asJspbArray(value: unknown, context: string): unknown[] {
  if (Array.isArray(value)) {
    const array: unknown[] = value;
    return array;
  }

  throw new Error(`Expected ${context} to be an array`);
}
