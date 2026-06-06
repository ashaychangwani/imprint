// Decodes the Google `batchexecute` anti-XSSI envelope and returns the inner
// JSON payload for a given rpcid. Every TravelFrontendUi response shares this
// framing:
//
//   )]}'                       <- anti-XSSI guard line
//                              <- blank line
//   <len>                      <- chunk length (UTF-8 BYTE count)
//   [["wrb.fr","<rpcid>","<innerJsonString>",null,null,null,"<src>"]]
//   <len>
//   [["di",..],["af.httprm",..]]
//   ...
//
// Key invariants proven by the recordings (seq 222, 229, 286, 300, 497, 525, 2429):
//  - Each JSON chunk sits on ONE physical line; every newline inside string data
//    is escaped (\n -> \\n), so splitting on "\n" cleanly separates length
//    markers from JSON chunks.
//  - A single chunk can carry MULTIPLE rows of mixed type (seq 2429 packs the
//    wrb.fr row alongside ["di",..]/["af.httprm",..]), so we must filter rows by
//    row[0] === "wrb.fr", never assume one row per chunk.
//  - row[2] is the payload as a JSON STRING -> a second JSON.parse yields the
//    result array. \u00xx / \u0026 escapes (Priceline URLs, seq 497) are valid
//    JSON escapes resolved natively by JSON.parse -- no manual unescaping.
//
// We deliberately ignore the numeric chunk lengths: they are UTF-8 byte counts,
// while JS string slicing is by UTF-16 code unit, so honoring them would
// misalign on multibyte data (e.g. "Costa Rican Colón" in seq 229). Splitting on
// "\n" is safe because chunks never contain a literal newline.

// Collect every envelope row across all chunks. Kept as any[] on purpose:
// JSON.parse returns `any`, and indexed access on `any` does NOT widen to
// `T | undefined` under noUncheckedIndexedAccess, so r[0]/r[1]/r[2] stay clean.
function collectRows(rawResponse: string): any[] {
  const rows: any[] = [];
  const lines = rawResponse.split('\n');
  for (const line of lines) {
    if (line === ")]}'" || line === '') continue; // guard line / blank separator
    if (/^\d+$/.test(line)) continue; // numeric chunk-length marker (.test -> boolean, no capture)
    if (!line.startsWith('[')) continue; // anything else is not a JSON chunk
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip an unparseable / truncated chunk rather than throwing
    }
    if (Array.isArray(parsed)) {
      for (const row of parsed) rows.push(row);
    }
  }
  return rows;
}

export function parseBatchExecute(rawResponse: string, rpcid: string): any {
  const rows = collectRows(rawResponse);
  const hit = rows.find(
    (r: any) => Array.isArray(r) && r[0] === 'wrb.fr' && r[1] === rpcid,
  );
  // Missing rpcid (or non-string payload) returns null per spec -- do not throw.
  // The typeof guard also narrows hit[2] for the JSON.parse below.
  if (!hit || typeof hit[2] !== 'string') return null;
  return JSON.parse(hit[2]);
}

export function parseAllRpc(rawResponse: string): Record<string, any> {
  const rows = collectRows(rawResponse);
  const out: Record<string, any> = {};
  for (const r of rows) {
    if (Array.isArray(r) && r[0] === 'wrb.fr' && typeof r[2] === 'string') {
      // Last write wins on duplicate rpcid (not observed in recordings).
      out[r[1]] = JSON.parse(r[2]);
    }
  }
  return out;
}
