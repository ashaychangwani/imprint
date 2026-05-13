/** JSONL streaming writer (crash-safe) + sidecar Session JSON on close. */

import { type WriteStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CapturedEvent,
  type CapturedRequest,
  type CookieSnapshot,
  type Narration,
  type Session,
  SessionSchema,
  type StorageSnapshot,
} from './types.ts';

type Record =
  | { kind: 'request'; data: CapturedRequest }
  | { kind: 'event'; data: CapturedEvent }
  | { kind: 'narration'; data: Narration }
  | { kind: 'request-body'; data: { seq: number; body: string } }
  | { kind: 'cookies'; data: CookieSnapshot }
  | { kind: 'storage'; data: StorageSnapshot };

interface SessionWriter {
  request(req: CapturedRequest): void;
  /** Late-arriving response body for a request already written. Merged on assemble. */
  requestBody(seq: number, body: string): void;
  event(ev: CapturedEvent): void;
  narration(n: Narration): void;
  cookies(snapshot: CookieSnapshot): void;
  storage(snapshot: StorageSnapshot): void;
  /** Flush + close the JSONL stream and write the assembled Session object. */
  close(): Promise<{ jsonlPath: string; sessionPath: string }>;
}

interface SessionMeta {
  site: string;
  url: string;
  imprintVersion: string;
  startedAt: string;
}

export function createSessionWriter(jsonlPath: string, meta: SessionMeta): SessionWriter {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  const stream: WriteStream = createWriteStream(jsonlPath, { flags: 'w', encoding: 'utf8' });

  // First line: meta header so a partial JSONL still rehydrates.
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
    storage: (data) => writeLine({ kind: 'storage', data }),
    async close() {
      if (closed) return { jsonlPath, sessionPath: jsonlPath.replace(/\.jsonl$/, '.json') };
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

/** Rehydrate a JSONL recording into a Session object. */
export function assembleFromJsonl(jsonlPath: string): Session {
  const text = readFileSync(jsonlPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  let meta: SessionMeta | null = null;
  const requests: CapturedRequest[] = [];
  const events: CapturedEvent[] = [];
  const narration: Narration[] = [];
  const cookieSnapshots: CookieSnapshot[] = [];
  const storageSnapshots: StorageSnapshot[] = [];

  for (const line of lines) {
    const rec = JSON.parse(line) as
      | { kind: 'meta'; data: SessionMeta }
      | { kind: 'request'; data: CapturedRequest }
      | { kind: 'request-body'; data: { seq: number; body: string } }
      | { kind: 'event'; data: CapturedEvent }
      | { kind: 'narration'; data: Narration }
      | { kind: 'cookies'; data: CookieSnapshot }
      | { kind: 'storage'; data: StorageSnapshot };

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
      case 'storage':
        storageSnapshots.push(rec.data);
        break;
    }
  }

  if (!meta) {
    throw new Error(
      `Session JSONL ${jsonlPath} has no meta header — cannot rehydrate.\n→ this usually means recording was killed before the first event fired; re-record.`,
    );
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
    storageSnapshots,
  };

  return SessionSchema.parse(session); // fail loud if malformed
}
