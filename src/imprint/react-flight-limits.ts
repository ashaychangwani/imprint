/** Bound per-row metadata for untrusted React Flight bodies below the byte cap. */
export const MAX_REACT_FLIGHT_ROWS = 16_384;

/** Bound aggregate parsed JSON width across an untrusted React Flight body. */
export const MAX_REACT_FLIGHT_JSON_NODES = 32_768;

/**
 * Estimate JSON node count before JSON.parse allocates the object graph.
 * For valid JSON, one root plus each container opener and comma is a
 * conservative upper approximation of containers and values. Delimiters in
 * strings are ignored, including escaped quotes.
 */
export function boundedJsonNodeCount(json: string, limit: number): number | null {
  if (limit < 1) return null;
  let count = 1;
  let inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index++;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) {
      inString = true;
    } else if (char === 0x7b || char === 0x5b || char === 0x2c) {
      if (++count > limit) return null;
    }
  }
  return count;
}
