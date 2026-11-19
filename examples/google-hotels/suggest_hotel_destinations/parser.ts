type Segment = { text: string; isCompletion: boolean };

function parseBatch(raw: string): unknown[] {
  const lines = raw.split('\n');
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('[[')) continue;
    let frame: unknown;
    try { frame = JSON.parse(candidate); } catch { continue; }
    if (!Array.isArray(frame)) continue;
    const rpc = frame.find((entry) =>
      Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === 'mejVKc'
    );
    if (!Array.isArray(rpc)) continue;
    if (typeof rpc[2] !== 'string') throw new Error('Malformed mejVKc response payload');
    return JSON.parse(rpc[2]) as unknown[];
  }
  throw new Error('Missing wrb.fr/mejVKc response frame');
}

export function extract(rawResponse: unknown): unknown {
  const decoded = typeof rawResponse === 'string' ? parseBatch(rawResponse) : rawResponse;
  if (!Array.isArray(decoded)) throw new Error('Malformed mejVKc decoded payload');
  const rows = decoded[0];
  if (!Array.isArray(rows)) throw new Error('Malformed mejVKc suggestion list');

  const suggestions = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row, rank) => {
      const matchedSegments: Segment[] = Array.isArray(row[5])
        ? row[5].filter(Array.isArray).map((segment: unknown[]) => ({
            text: typeof segment[0] === 'string' ? segment[0] : '',
            isCompletion: segment[1] === true,
          }))
        : [];
      const selectionMetadata = row[7] ?? null;
      const identifierTuple =
        Array.isArray(selectionMetadata) && Array.isArray(selectionMetadata[0])
          ? selectionMetadata[0]
          : null;
      const rankingMetadata =
        Array.isArray(selectionMetadata) ? selectionMetadata[5] ?? null : null;
      return {
        rank,
        suggestionType: typeof row[0] === 'number' ? row[0] : null,
        displayText: typeof row[1] === 'string' ? row[1] : '',
        imageUrl: typeof row[3] === 'string' ? row[3] : null,
        address: typeof row[4] === 'string' ? row[4] : null,
        matchedSegments,
        propertyId: typeof row[6] === 'string' ? row[6] : null,
        selectionMetadata,
        identifierTuple,
        rankingMetadata,
        canonicalQuery: typeof row[11] === 'string' ? row[11] : null,
      };
    })
    .filter((item) => item.displayText.length > 0);

  return { suggestions, count: suggestions.length };
}
