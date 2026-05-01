/**
 * `imprint record` — capture a teaching session.
 *
 * Spawns a real Chromium with `--remote-debugging-port`, connects via the
 * Chrome DevTools Protocol (CDP), and streams every network request, DOM
 * navigation event, and user narration to a JSONL session file.
 *
 *   chromium ──CDP──▶ recorder ──▶ session.jsonl ──▶ session.json (on close)
 *      │
 *      └─ user does the workflow in a visible window
 *
 *   stdin ──narration loop──▶ recorder
 *
 * Ctrl+C stops the recording cleanly: stops accepting CDP events, flushes the
 * JSONL stream, writes the assembled `session.json`, kills Chromium.
 */

import { mkdirSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import { launchChromium } from './chromium.ts';
import { createSessionWriter } from './session-writer.ts';
import type { CapturedEvent, CapturedRequest } from './types.ts';

const VERSION = '0.1.0';

export interface RecordOptions {
  /** Site label, e.g. "southwest". Determines output path. */
  site: string;
  /** Starting URL. If omitted, opens about:blank — user navigates manually. */
  url?: string;
  /** Output path for session.jsonl. Defaults to examples/<site>/sessions/<timestamp>.jsonl */
  outPath?: string;
  /**
   * Stop signal. CLI wires this to SIGINT; tests can fire it from an
   * AbortController to shut down cleanly without process.exit.
   */
  signal?: AbortSignal;
  /**
   * If true, skip the interactive narration prompt (terminal stdin loop).
   * Tests use this. CLI never sets it.
   */
  noNarration?: boolean;
}

export interface RecordResult {
  jsonlPath: string;
  sessionPath: string;
  /** Number of records written (requests + events + narration). */
  count: number;
}

interface PendingRequest {
  seq: number;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  resourceType: string;
}

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const startedAt = new Date();
  const sessionTs = startedAt.toISOString().replace(/[:.]/g, '-');

  const outPath = opts.outPath
    ? pathResolve(opts.outPath)
    : pathResolve(`examples/${opts.site}/sessions/${sessionTs}.jsonl`);

  mkdirSync(pathJoin(outPath, '..'), { recursive: true });

  console.log(`[imprint] recording → ${outPath}`);
  console.log('[imprint] launching chromium...');

  // Critical: launch Chromium with about:blank, NOT the target URL. We need to
  // attach CDP and enable Network BEFORE the first request fires. If we passed
  // the URL up front, Chromium would race ahead and the page would already be
  // loaded by the time we subscribe.
  const chromium = await launchChromium({
    url: 'about:blank',
    headless: false,
  });

  try {
    await chromium.ready;
  } catch (err) {
    await chromium.close();
    throw err;
  }
  console.log(`[imprint] chromium up on CDP port ${chromium.port}`);

  // Give Chromium a beat to publish the target list, then attach to the page tab.
  // chrome-remote-interface's `target` callback must return a number (index) or
  // a Target — never undefined. We pick the index of the first real page tab.
  await sleep(250);
  const client = await CDP({
    port: chromium.port,
    target: (targets) => {
      const idx = targets.findIndex(
        (t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'),
      );
      return idx >= 0 ? idx : 0;
    },
  });
  const { Network, Page, Runtime } = client;

  await Promise.all([Network.enable(), Page.enable(), Runtime.enable()]);

  const writer = createSessionWriter(outPath, {
    site: opts.site,
    url: opts.url ?? 'about:blank',
    imprintVersion: VERSION,
    startedAt: startedAt.toISOString(),
  });

  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;

  let seq = 0;
  const nextSeq = (): number => seq++;

  // ── Network capture ────────────────────────────────────────────────────────
  //
  // CDP fires events per request roughly in this order:
  //
  //   requestWillBeSent  → request method, url, body, headers
  //   responseReceived   → response status, headers, mimeType   ← we WRITE here
  //   loadingFinished    → response body fetchable via getResponseBody
  //
  // We deliberately write the captured record on `responseReceived` instead of
  // waiting for `loadingFinished`. Two reasons:
  //   (1) `loadingFinished` is unreliable in practice — for navigation requests
  //       it can be deferred indefinitely or never fire at all.
  //   (2) For LLM intent detection, the request method/url/body and response
  //       status/headers are sufficient. Response BODIES are only needed when
  //       a later request in a chained workflow references them via ${response[N]}.
  //
  // Body fetching is opportunistic and async: we attempt it after writing the
  // request line and append a `body` to the JSONL via a separate `request-body`
  // record. The Workflow generator merges these when assembling the request
  // chain.
  const pending = new Map<string, PendingRequest>();
  const inflight = new Set<Promise<void>>();

  Network.requestWillBeSent((params) => {
    const { request, requestId, type } = params;
    if (process.env.IMPRINT_DEBUG) {
      console.error(`[debug] requestWillBeSent ${requestId} ${request.method} ${request.url}`);
    }
    pending.set(requestId, {
      seq: nextSeq(),
      timestamp: elapsed(),
      method: request.method,
      url: request.url,
      headers: request.headers as Record<string, string>,
      body: typeof request.postData === 'string' ? request.postData : undefined,
      resourceType: type ?? 'Other',
    });
  });

  Network.responseReceived((params) => {
    const { requestId, response } = params;
    const reqInfo = pending.get(requestId);
    if (!reqInfo) return;
    // Don't delete from pending yet — we may still try to fetch the body on
    // loadingFinished. Mark "written" by writing the line now.
    pending.delete(requestId);

    if (process.env.IMPRINT_DEBUG) {
      console.error(
        `[debug] responseReceived ${requestId} status=${response.status} ${reqInfo.url}`,
      );
    }

    const captured: CapturedRequest = {
      seq: reqInfo.seq,
      timestamp: reqInfo.timestamp,
      method: reqInfo.method,
      url: reqInfo.url,
      headers: reqInfo.headers,
      body: reqInfo.body,
      resourceType: reqInfo.resourceType,
      response: {
        status: response.status,
        headers: response.headers as Record<string, string>,
        mimeType: response.mimeType,
        // body filled in by the loadingFinished handler if it fires
      },
    };
    writer.request(captured);

    // Best-effort: kick off a body fetch in the background. If it succeeds,
    // we write a companion `request-body` record keyed by seq. If
    // `loadingFinished` never fires, we just don't get a body — fine.
    const bodyWork = (async () => {
      // Wait briefly — getResponseBody often errors before loadingFinished.
      await sleep(100);
      try {
        const bodyResp = await Network.getResponseBody({ requestId });
        const body = bodyResp.base64Encoded
          ? Buffer.from(bodyResp.body, 'base64').toString('utf8')
          : bodyResp.body;
        // Truncate very large bodies (>256KB) to keep JSONL readable.
        const MAX = 256 * 1024;
        const truncated = body.length > MAX ? `${body.slice(0, MAX)}\n[…truncated…]` : body;
        writer.requestBody(captured.seq, truncated);
      } catch {
        // Body unavailable (preflight, navigation, evicted). Fine.
      }
    })();
    inflight.add(bodyWork);
    bodyWork.finally(() => inflight.delete(bodyWork));
  });

  // Failed requests still need to drop out of pending so the map doesn't leak.
  Network.loadingFailed((params) => {
    if (process.env.IMPRINT_DEBUG) {
      console.error(`[debug] loadingFailed ${params.requestId} ${params.errorText}`);
    }
    pending.delete(params.requestId);
  });

  // Now that Network is wired, navigate to the user's URL. If they didn't pass
  // one, leave the user on about:blank — they'll navigate manually.
  if (opts.url && opts.url !== 'about:blank') {
    if (process.env.IMPRINT_DEBUG) {
      console.error(`[debug] navigating to ${opts.url}`);
    }
    const navResult = await Page.navigate({ url: opts.url });
    if (process.env.IMPRINT_DEBUG) {
      console.error(`[debug] navigate returned: ${JSON.stringify(navResult)}`);
    }
  }

  // ── Page navigation events ────────────────────────────────────────────────
  Page.frameNavigated((params) => {
    if (params.frame.parentId) return; // only top-level frames
    const ev: CapturedEvent = {
      seq: nextSeq(),
      timestamp: elapsed(),
      type: 'navigation',
      detail: params.frame.url,
    };
    writer.event(ev);
  });

  // ── Narration loop ────────────────────────────────────────────────────────
  // Day 1 lays the wiring; the polished prompt lands in day 2.
  let narrationOpen = !opts.noNarration;
  let rl: ReturnType<typeof createInterface> | null = null;

  const narrationLoop: Promise<void> = (async () => {
    if (opts.noNarration) return;
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    console.log('');
    console.log('[imprint] recording. type narration lines, blank line skips.');
    console.log('[imprint] press Ctrl+C when done.');
    console.log('');
    while (narrationOpen) {
      const reader = rl;
      if (!reader) break;
      const line: string = await new Promise((resolve) => {
        reader.question('narrate> ', (answer) => resolve(answer));
      });
      if (!narrationOpen) break;
      if (line.trim().length === 0) continue;
      writer.narration({ seq: nextSeq(), timestamp: elapsed(), text: line.trim() });
    }
  })();

  // ── Shutdown handling ─────────────────────────────────────────────────────
  let shuttingDown = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const shutdown = async (): Promise<RecordResult> => {
    if (shuttingDown) {
      await stopped;
      const { jsonlPath: jp, sessionPath: sp } = await writer.close();
      return { jsonlPath: jp, sessionPath: sp, count: seq };
    }
    shuttingDown = true;
    narrationOpen = false;
    rl?.close();

    // Drain in-flight loadingFinished handlers so their writer.request() calls
    // land before we close the JSONL stream. CDP body-fetch is async; without
    // this, late-arriving requests get silently dropped.
    if (inflight.size > 0) {
      if (process.env.IMPRINT_DEBUG) {
        console.error(`[debug] draining ${inflight.size} inflight handlers`);
      }
      await Promise.allSettled(Array.from(inflight));
    }

    try {
      await client.close();
    } catch {
      // ignore
    }
    await chromium.close();
    const { jsonlPath, sessionPath } = await writer.close();
    resolveStopped();
    console.log('');
    console.log(`[imprint] saved ${jsonlPath}`);
    console.log(`[imprint] assembled ${sessionPath}`);
    console.log(`[imprint] ${seq} captured records`);
    return { jsonlPath, sessionPath, count: seq };
  };

  // External AbortSignal (tests, programmatic API).
  if (opts.signal) {
    if (opts.signal.aborted) {
      return shutdown();
    }
    opts.signal.addEventListener('abort', () => {
      void shutdown();
    });
  }

  // If Chromium dies on its own (user closes the window), wind down too.
  chromium.process.once('exit', () => {
    void shutdown();
  });

  // Wait for narration loop to terminate (only happens on shutdown).
  await narrationLoop;
  // Belt and suspenders: ensure shutdown ran even if narration loop exited via other path.
  return shutdown();
}
