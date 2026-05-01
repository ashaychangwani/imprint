/**
 * Streams a recording to a single JSON file on disk.
 *
 * The on-disk format is one JSON object per line (JSONL) so a Ctrl+C mid-recording
 * still leaves a parseable file. On clean close we ALSO write a sidecar
 * `<file>.json` that is the fully assembled `Session` object — the shape every
 * downstream verb (generate, emit) actually consumes.
 */

import { type WriteStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CapturedEvent,
  type CapturedRequest,
  type CookieSnapshot,
  type Narration,
  type Session,
  SessionSchema,
} from './types.ts';

type Record =
  | { kind: 'request'; data: CapturedRequest }
  | { kind: 'event'; data: CapturedEvent }
  | { kind: 'narration'; data: Narration }
  | { kind: 'request-body'; data: { seq: number; body: string } }
  | { kind: 'cookies'; data: CookieSnapshot };

export interface SessionWriter {
  request(req: CapturedRequest): void;
  /** Late-arriving response body for a request already written. Merged on assemble. */
  requestBody(seq: number, body: string): void;
  event(ev: CapturedEvent): void;
  narration(n: Narration): void;
  cookies(snapshot: CookieSnapshot): void;
  /** Flush + close the JSONL stream and write the assembled Session object. */
  close(): Promise<{ jsonlPath: string; sessionPath: string }>;
}

export interface SessionMeta {
  site: string;
  url: string;
  imprintVersion: string;
  startedAt: string;
}

export function createSessionWriter(jsonlPath: string, meta: SessionMeta): SessionWriter {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  const stream: WriteStream = createWriteStream(jsonlPath, { flags: 'w', encoding: 'utf8' });

  // First line is the meta header so a partial JSONL can still be reconstructed.
  stream.write(`${JSON.stringify({ kind: 'meta', data: meta })}\n`);

  let closed = false;

  const writeLine = (rec: Record): void => {
    if (closed) return;
    stream.write(`${JSON.stringify(rec)}\n`);
  };

  return {
    request: (data) => writeLine({ kind: 'request', data }),
    requestBody: (seq, body) => writeLine({ kind: 'request-body', data: { seq, body } }),
    event: (data) => writeLine({ kind: 'event', data }),
    narration: (data) => writeLine({ kind: 'narration', data }),
    cookies: (data) => writeLine({ kind: 'cookies', data }),
    async close() {
      if (closed) {
        // Still return paths if called twice.
        return { jsonlPath, sessionPath: jsonlPath.replace(/\.jsonl$/, '.json') };
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      const session = assembleFromJsonl(jsonlPath);
      const sessionPath = jsonlPath.replace(/\.jsonl$/, '.json');
      const fs = await import('node:fs/promises');
      await fs.writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
      return { jsonlPath, sessionPath };
    },
  };
}

/**
 * Read a JSONL recording back into a full Session object.
 * Exposed so downstream tools (and tests) can rehydrate without touching disk twice.
 */
export function assembleFromJsonl(jsonlPath: string): Session {
  const text = readFileSync(jsonlPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  let meta: SessionMeta | null = null;
  const requests: CapturedRequest[] = [];
  const events: CapturedEvent[] = [];
  const narration: Narration[] = [];
  const cookieSnapshots: CookieSnapshot[] = [];

  // First pass: collect everything.
  for (const line of lines) {
    const rec = JSON.parse(line) as
      | { kind: 'meta'; data: SessionMeta }
      | { kind: 'request'; data: CapturedRequest }
      | { kind: 'request-body'; data: { seq: number; body: string } }
      | { kind: 'event'; data: CapturedEvent }
      | { kind: 'narration'; data: Narration }
      | { kind: 'cookies'; data: CookieSnapshot };

    switch (rec.kind) {
      case 'meta':
        meta = rec.data;
        break;
      case 'request':
        requests.push(rec.data);
        break;
      case 'request-body': {
        const target = requests.find((r) => r.seq === rec.data.seq);
        if (target?.response) {
          target.response = { ...target.response, body: rec.data.body };
        }
        break;
      }
      case 'event':
        events.push(rec.data);
        break;
      case 'narration':
        narration.push(rec.data);
        break;
      case 'cookies':
        cookieSnapshots.push(rec.data);
        break;
    }
  }

  if (!meta) {
    throw new Error(`Session JSONL ${jsonlPath} has no meta header — cannot rehydrate`);
  }

  const session: Session = {
    site: meta.site,
    startedAt: meta.startedAt,
    url: meta.url,
    imprintVersion: meta.imprintVersion,
    requests,
    events,
    narration,
    cookieSnapshots,
  };

  // Validate before handing back. A malformed session should fail loud, not silently
  // produce a broken workflow downstream.
  return SessionSchema.parse(session);
}
