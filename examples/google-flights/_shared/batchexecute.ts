// Decode Google's batchexecute streaming envelope used by every FlightsFrontendUi RPC.
//
// Wire format (verified against recorded seq 69/97/111/667):
//   )]}'\n\n            <- anti-XSSI magic prefix
//   <decimal length>\n   <- length line (jsonChars + 2; counts bounding newlines)
//   [[...rows...]]\n      <- one chunk = single-line JSON array of rows
//   ...repeats...
//
// We DELIBERATELY do not slice by the length lines: the stated length is
// `jsonChars + 2`, so naive slice(pos, pos+len) overshoots into the next token.
// Because every chunk is single-line JSON (all interior newlines are escaped as
// \n), splitting on "\n" is exact and robust. Each real RPC result is a row
// ["wrb.fr", <rpcid|null>, "<doubly-encoded JSON payload>", ...]; row[2] must be
// JSON.parse'd a SECOND time. Sidecar rows ("di", "af.httprm", "e") are ignored.

export function decodeBatchExecute(raw: string): Array<{ rpcid: string | null; payload: any }> {
  let text = raw;
  if (text.startsWith(")]}'")) {
    text = text.slice(4);
  }

  const out: Array<{ rpcid: string | null; payload: any }> = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Skip the decimal length marker lines.
    if (/^\d+$/.test(trimmed)) continue;
    // Chunks are JSON arrays; anything else is noise / partial.
    if (trimmed[0] !== '[') continue;

    let chunk: any;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      // Tolerate truncated / partial trailing lines.
      continue;
    }
    if (!Array.isArray(chunk)) continue;

    for (const row of chunk) {
      if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;
      const rpcid = typeof row[1] === 'string' ? row[1] : null;
      if (typeof row[2] !== 'string') continue;
      let payload: any;
      try {
        payload = JSON.parse(row[2]);
      } catch {
        continue;
      }
      out.push({ rpcid, payload });
    }
  }

  return out;
}

export function extractRpcPayload(raw: string, rpcid?: string): any {
  const frames = decodeBatchExecute(raw);
  const frame = rpcid != null ? frames.find((f) => f.rpcid === rpcid) : frames[0];
  return frame?.payload;
}
