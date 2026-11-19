export interface BatchExecuteFrame {
  kind: string;
  rpcId: string | null;
  payload: unknown;
  raw: unknown[];
}

const encoder = new TextEncoder();

function malformed(message: string): Error {
  return new Error(`Malformed batchexecute envelope: ${message}`);
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
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      expectedClosers.push("]");
    } else if (character === "{") {
      expectedClosers.push("}");
    } else if (character === "]" || character === "}") {
      if (expectedClosers.pop() !== character) return null;
      if (expectedClosers.length === 0) return offset + 1;
    }
  }

  return null;
}

function stripAntiXssiPrefix(body: string): string {
  if (!body.startsWith(")]}'")) return body;

  const afterPrefix = 4;
  if (body.startsWith("\r\n", afterPrefix)) return body.slice(afterPrefix + 2);
  if (body.startsWith("\n", afterPrefix)) return body.slice(afterPrefix + 1);
  if (body.length === afterPrefix) return "";

  throw malformed("anti-XSSI prefix is not followed by a line break");
}

export function parseBatchExecuteEnvelope(body: string): BatchExecuteFrame[] {
  if (body.trim().length === 0) {
    throw malformed("body is empty");
  }

  const text = stripAntiXssiPrefix(body);
  const frames: BatchExecuteFrame[] = [];
  let offset = 0;

  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text[offset] ?? "")) offset += 1;
    if (offset >= text.length) break;

    const lengthStart = offset;
    while (offset < text.length) {
      const character = text[offset];
      if (character === undefined || character < "0" || character > "9") break;
      offset += 1;
    }

    if (offset === lengthStart) {
      throw malformed("expected a decimal chunk length");
    }

    const lengthText = text.slice(lengthStart, offset);
    const terminator = text[offset];
    if (terminator === "\r") {
      if (text[offset + 1] !== "\n") {
        throw malformed("chunk length line has an invalid terminator");
      }
      offset += 2;
    } else if (terminator === "\n") {
      offset += 1;
    } else {
      throw malformed("chunk length is not followed by a line break");
    }

    const chunkLength = Number(lengthText);
    if (!Number.isSafeInteger(chunkLength) || chunkLength < 0) {
      throw malformed(`invalid chunk length ${lengthText}`);
    }

    const remainingText = text.slice(offset);
    const remainingByteLength = encoder.encode(remainingText).byteLength;
    if (
      chunkLength > remainingText.length + 1 &&
      chunkLength > remainingByteLength + 1
    ) {
      throw malformed(`chunk declares ${chunkLength} bytes but the body is truncated`);
    }

    const chunkEnd = findJsonEnd(text, offset);
    if (chunkEnd === null) {
      throw malformed("chunk is not valid JSON");
    }

    const chunkText = text.slice(offset, chunkEnd);
    const jsonCharacterLength = chunkEnd - offset;
    const jsonByteLength = encoder.encode(chunkText).byteLength;
    if (chunkLength < jsonCharacterLength && chunkLength < jsonByteLength) {
      throw malformed(`chunk declares ${chunkLength} bytes but its JSON is longer`);
    }
    offset = chunkEnd;

    let chunkValue: unknown;
    try {
      chunkValue = JSON.parse(chunkText) as unknown;
    } catch {
      throw malformed("chunk is not valid JSON");
    }

    if (!Array.isArray(chunkValue)) {
      throw malformed("chunk JSON is not an array");
    }

    for (const rowValue of chunkValue) {
      if (!Array.isArray(rowValue)) {
        throw malformed("chunk contains a non-array frame");
      }

      const kindValue = rowValue[0];
      if (typeof kindValue !== "string" || kindValue.length === 0) {
        throw malformed("frame kind must be a nonempty string");
      }

      if (kindValue !== "wrb.fr") {
        frames.push({
          kind: kindValue,
          rpcId: null,
          payload: rowValue.slice(1),
          raw: rowValue,
        });
        continue;
      }

      const rpcValue = rowValue[1];
      if (rpcValue !== null && typeof rpcValue !== "string") {
        throw malformed("wrb.fr RPC ID must be a string or null");
      }

      const payloadText = rowValue[2];
      if (typeof payloadText !== "string") {
        throw malformed("wrb.fr payload must be a JSON string");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(payloadText) as unknown;
      } catch {
        const label = rpcValue === null ? "null RPC ID" : `RPC ID ${rpcValue}`;
        throw malformed(`wrb.fr payload for ${label} is not valid JSON`);
      }

      frames.push({
        kind: kindValue,
        rpcId: rpcValue,
        payload,
        raw: rowValue,
      });
    }
  }

  if (frames.length === 0) {
    throw malformed("body contains no frames");
  }

  return frames;
}

export function getWrbPayload(
  frames: BatchExecuteFrame[],
  rpcId?: string | null,
): unknown {
  const requestedRpcId = rpcId ?? null;
  let matchingFrame: BatchExecuteFrame | undefined;

  for (const value of frames as unknown[]) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Malformed batchexecute frame: expected an object");
    }

    const candidate = value as Partial<BatchExecuteFrame>;
    if (typeof candidate.kind !== "string") {
      throw new Error("Malformed batchexecute frame: kind must be a string");
    }

    if (candidate.kind !== "wrb.fr") continue;
    if (candidate.rpcId !== null && typeof candidate.rpcId !== "string") {
      throw new Error("Malformed wrb.fr frame: RPC ID must be a string or null");
    }

    if (candidate.rpcId === requestedRpcId && matchingFrame === undefined) {
      matchingFrame = candidate as BatchExecuteFrame;
    }
  }

  if (matchingFrame === undefined) {
    if (requestedRpcId === null) {
      throw new Error("No null-RPC-ID wrb.fr service frame exists");
    }
    throw new Error(`No wrb.fr service frame found for RPC ID ${requestedRpcId}`);
  }

  if (!("payload" in matchingFrame)) {
    throw new Error("Malformed wrb.fr frame: decoded payload is missing");
  }
  if (typeof matchingFrame.payload === "string") {
    throw new Error("Malformed wrb.fr frame: payload has not been JSON-decoded");
  }

  return matchingFrame.payload;
}
