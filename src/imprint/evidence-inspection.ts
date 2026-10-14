import { Script } from 'node:vm';

/** Bounded pure-data inspection; no network, file handles, or parser module. */
export function projectEvidence(value: unknown, source: string): string {
  const script = new Script(`JSON.stringify((${source})(JSON.parse(raw)))`);
  return String(
    script.runInNewContext(
      { raw: JSON.stringify(value) },
      { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } },
    ) ?? 'null',
  );
}

/** Inspect saved text only. Projection output is explicitly distinguished from source bytes. */
export function inspectEvidenceText(
  text: string,
  query: {
    offset: number;
    length: number;
    search?: string;
    project?: string;
  },
) {
  if (query.project !== undefined) {
    let output = '';
    let error: string | undefined;
    try {
      output = projectEvidence(text, query.project);
    } catch (cause) {
      error = String(cause).slice(0, 2000);
    }
    return {
      offset: 0,
      totalCharacters: text.length,
      text: output.slice(0, query.length),
      nextOffset: null,
      projection: {
        source: query.project,
        outputCharacters: output.length,
        ...(error ? { error } : {}),
      },
    };
  }
  const match =
    query.search === undefined ? query.offset : text.indexOf(query.search, query.offset);
  const offset = match < 0 ? query.offset : match;
  const slice = match < 0 ? '' : text.slice(offset, offset + query.length);
  return {
    offset,
    totalCharacters: text.length,
    text: slice,
    nextOffset: match < 0 || offset + slice.length >= text.length ? null : offset + slice.length,
    ...(query.search === undefined ? {} : { matchFound: match >= 0 }),
  };
}
