export type WrbRecord = { rpcid: string | null; payload: unknown; rawPayload: string | null; envelope: unknown[] };

const XSSI_PREFIX = ")]}'";

export function stripXssiPrefix(body: string): string {
  const withoutPrefix = body.startsWith(XSSI_PREFIX) ? body.slice(XSSI_PREFIX.length) : body;
  return withoutPrefix.replace(/^\s+/, "");
}

function utf8EndOffset(text: string, start: number, byteLength: number): number | null {
  let offset = start;
  let bytes = 0;

  while (offset < text.length && bytes < byteLength) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) return null;

    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;

    offset += codePoint > 0xffff ? 2 : 1;
  }

  return bytes === byteLength ? offset : null;
}

function findBalancedJsonEnd(text: string, start: number): number | null {
  let offset = start;
  while (offset < text.length && /\s/.test(text.charAt(offset))) offset += 1;

  const first = text.charAt(offset);
  if (first !== "[" && first !== "{") return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = offset; i < text.length; i += 1) {
    const ch = text.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "[" || ch === "{") {
      stack.push(ch === "[" ? "]" : "}");
      continue;
    }

    if (ch === "]" || ch === "}") {
      const expected = stack.pop();
      if (expected !== ch) return null;
      if (stack.length === 0) return i + 1;
    }
  }

  return null;
}

function tryParseFrame(text: string, start: number, frameLength: number): { parsed: unknown; end: number } | null {
  const charEnd = start + frameLength;
  if (charEnd <= text.length) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, charEnd));
      return { parsed, end: charEnd };
    } catch {
      // Google frame lengths are byte counts in some recordings; retry with UTF-8 offsets.
    }
  }

  const byteEnd = utf8EndOffset(text, start, frameLength);
  if (byteEnd !== null && byteEnd <= text.length) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, byteEnd));
      return { parsed, end: byteEnd };
    } catch {
      // Fall through to balanced parsing for recordings whose stored text length differs.
    }
  }

  const balancedEnd = findBalancedJsonEnd(text, start);
  if (balancedEnd === null) return null;
  const parsed: unknown = JSON.parse(text.slice(start, balancedEnd));
  return { parsed, end: balancedEnd };
}

export function parseLengthFramedJson(body: string): unknown[] {
  const text = stripXssiPrefix(body);
  const frames: unknown[] = [];
  let offset = 0;

  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text.charAt(offset))) offset += 1;
    if (offset >= text.length) break;

    const match = /^(\d+)/.exec(text.slice(offset));
    if (!match?.[1]) break;

    const frameLength = Number(match[1]);
    offset += match[1].length;

    if (text.charAt(offset) === "\r") offset += 1;
    if (text.charAt(offset) !== "\n") break;
    offset += 1;

    const frame = tryParseFrame(text, offset, frameLength);
    if (frame === null) break;

    frames.push(frame.parsed);
    offset = frame.end;
  }

  return frames;
}

export function parseNestedPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

export function extractWrbRecords(body: string): WrbRecord[] {
  const records: WrbRecord[] = [];

  for (const frame of parseLengthFramedJson(body)) {
    if (!Array.isArray(frame)) continue;

    for (const maybeRecord of frame) {
      if (!Array.isArray(maybeRecord)) continue;
      if (maybeRecord[0] !== "wrb.fr") continue;

      const rpcidValue = maybeRecord[1];
      const payloadValue = maybeRecord[2];
      const envelope = maybeRecord as unknown[];

      records.push({
        rpcid: typeof rpcidValue === "string" ? rpcidValue : null,
        payload: parseNestedPayload(payloadValue),
        rawPayload: typeof payloadValue === "string" ? payloadValue : null,
        envelope,
      });
    }
  }

  return records;
}
