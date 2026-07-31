export interface BatchExecuteFrame {
  rpcId: string;
  payload: unknown;
  rawPayload: string;
}

export function decodeBatchExecuteResponse(body: string): BatchExecuteFrame[] {
  let text = body.replace(/\r\n?/g, "\n");
  if (text.startsWith(")]}'")) {
    text = text.slice(4);
  }

  const frames: BatchExecuteFrame[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || /^\d+$/.test(trimmed)) {
      continue;
    }

    let outer: unknown;
    try {
      outer = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    if (!Array.isArray(outer)) {
      continue;
    }

    for (const record of outer) {
      if (!Array.isArray(record) || record[0] !== "wrb.fr") {
        continue;
      }

      const rpcId = record[1];
      const rawPayload = record[2];
      if (typeof rpcId !== "string" || typeof rawPayload !== "string") {
        continue;
      }

      let payload: unknown = rawPayload;
      try {
        payload = JSON.parse(rawPayload) as unknown;
      } catch {
        // Preserve malformed nested data so findBatchPayload can report its RPC.
      }

      frames.push({ rpcId, payload, rawPayload });
    }
  }

  return frames;
}

export function findBatchPayload(
  frames: BatchExecuteFrame[],
  rpcId: string,
): unknown {
  const frame = frames.find((candidate) => candidate.rpcId === rpcId);
  if (!frame) {
    throw new Error(`BatchExecute RPC "${rpcId}" was not found`);
  }
  if (typeof frame.payload === "string") {
    throw new Error(`BatchExecute RPC "${rpcId}" has a malformed payload`);
  }
  return frame.payload;
}
