const encoder = new TextEncoder();
type ErrorWithCause = Error & { cause?: unknown };

function makeError(message: string, cause?: unknown): Error {
  const error: ErrorWithCause = new Error(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function stripXssiMarker(body: string): string {
  if (body.startsWith(")]}'\r\n")) return body.slice(6);
  if (body.startsWith(")]}'\n")) return body.slice(5);
  return body;
}

function findJsonEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== "[" && opening !== "{") return null;

  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (let offset = start; offset < text.length; offset += 1) {
    const character = text[offset];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "[") expectedClosers.push("]");
    else if (character === "{") expectedClosers.push("}");
    else if (character === "]" || character === "}") {
      if (expectedClosers.pop() !== character) return null;
      if (expectedClosers.length === 0) return offset + 1;
    }
  }

  return null;
}

function decodePayloads(body: string, rpcId?: string): unknown[] {
  const text = stripXssiMarker(body);
  const payloads: unknown[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
    if (cursor >= text.length) break;

    const lengthStart = cursor;
    while (cursor < text.length && /[0-9]/.test(text[cursor] ?? "")) cursor += 1;
    if (cursor === lengthStart) {
      throw new Error(`Malformed batchexecute framing at character ${cursor}: expected a decimal frame length`);
    }

    const lengthText = text.slice(lengthStart, cursor);
    const declaredLength = Number(lengthText);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new Error(`Malformed batchexecute frame length: ${lengthText}`);
    }

    if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor += 2;
    else if (text[cursor] === "\n") cursor += 1;
    else throw new Error("Malformed batchexecute framing: frame length is not followed by a line break");

    const remainingText = text.slice(cursor);
    const remainingByteLength = encoder.encode(remainingText).byteLength;
    if (declaredLength > remainingText.length + 1 && declaredLength > remainingByteLength + 1) {
      throw new Error(`Truncated batchexecute frame: declared ${declaredLength} bytes`);
    }

    const frameEnd = findJsonEnd(text, cursor);
    if (frameEnd === null) throw new Error("Malformed batchexecute outer JSON frame");
    const frameText = text.slice(cursor, frameEnd);
    const frameByteLength = encoder.encode(frameText).byteLength;
    if (declaredLength < frameText.length && declaredLength < frameByteLength) {
      throw new Error(`Malformed batchexecute frame: declared ${declaredLength} bytes but JSON is longer`);
    }

    let frame: unknown;
    try {
      frame = JSON.parse(frameText) as unknown;
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw makeError(`Malformed batchexecute outer JSON frame: ${detail}`, cause);
    }

    if (Array.isArray(frame)) {
      for (const row of frame) {
        if (!Array.isArray(row) || row[0] !== "wrb.fr") continue;

        const rowRpcId = row[1];
        if (typeof rowRpcId !== "string") continue;
        if (rpcId !== undefined && rowRpcId !== rpcId) continue;

        const encodedPayload = row[2];
        if (typeof encodedPayload !== "string") {
          throw new Error(`Malformed wrb.fr payload for RPC ${rowRpcId}: payload is not a JSON string`);
        }

        try {
          payloads.push(JSON.parse(encodedPayload) as unknown);
        } catch (cause: unknown) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw makeError(`Malformed wrb.fr JSON payload for RPC ${rowRpcId}: ${detail}`, cause);
        }
      }
    }

    cursor = frameEnd;
  }

  return payloads;
}

export function parseBatchExecuteResponse(body: string, rpcId?: string): unknown[] {
  return decodePayloads(body, rpcId);
}

export function findRpcPayloads(body: string, rpcId?: string): unknown[] {
  return parseBatchExecuteResponse(body, rpcId);
}
