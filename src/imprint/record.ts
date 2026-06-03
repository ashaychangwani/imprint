/**
 * `imprint record` — capture a teaching session via CDP. Streams network
 * requests, DOM events, and stdin narration to JSONL; assembles session.json
 * on clean shutdown (Ctrl+C, /done, or external AbortSignal).
 */

import { mkdirSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import envPaths from 'env-paths';
import { launchChromium } from './chromium.ts';
import { IMPRINT_SENTINEL, INJECTED_LISTENER_SOURCE } from './inject-listener.ts';
import { isDebug } from './log.ts';
import { defaultSessionJsonlPath } from './paths.ts';
import { createSessionWriter } from './session-writer.ts';
import type { CapturedEvent, CapturedRequest, CookieSnapshot, StorageSnapshot } from './types.ts';
import { VERSION } from './version.ts';

const PATHS = envPaths('imprint', { suffix: '' });

interface RecordOptions {
  /** Site label, e.g. "southwest". Determines output path. */
  site: string;
  /** Starting URL. If omitted, opens about:blank — user navigates manually. */
  url?: string;
  /** Output path for session.jsonl. Defaults to ~/.imprint/<site>/sessions/<timestamp>.jsonl */
  outPath?: string;
  /** Persist a stable profile at $IMPRINT_DATA/profiles/<site> so cookies + login
   *  survive between captures. Useful for re-recording an authed site. Default false. */
  persistProfile?: boolean;
  /** Stop signal. CLI wires this to SIGINT. */
  signal?: AbortSignal;
  /** Skip the interactive stdin narration loop (tests). */
  noNarration?: boolean;
}

interface RecordResult {
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
    : defaultSessionJsonlPath(opts.site, sessionTs);

  mkdirSync(pathJoin(outPath, '..'), { recursive: true });

  console.log(`[imprint] recording → ${outPath}`);
  console.log('[imprint] launching chromium...');

  // Launch with about:blank so we attach CDP + enable Network BEFORE the
  // first real request fires. Passing the target URL up front loses events.
  const userDataDir = opts.persistProfile ? pathJoin(PATHS.data, 'profiles', opts.site) : undefined;
  if (userDataDir) {
    mkdirSync(userDataDir, { recursive: true });
    console.log(`[imprint] using persistent profile at ${userDataDir}`);
  }
  const chromium = await launchChromium({
    url: 'about:blank',
    headless: false,
    userDataDir,
  });

  try {
    await chromium.ready;
  } catch (err) {
    await chromium.close();
    throw err;
  }
  console.log(`[imprint] chromium up on CDP port ${chromium.port}`);

  // Wait for Chromium to publish the target list, then attach to the first
  // real page tab (skip chrome-extension://). The callback must return a
  // number index — never undefined.
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

  // Passive DOM listener emits sentinel-prefixed console.log lines we parse
  // via Runtime.consoleAPICalled below.
  await Page.addScriptToEvaluateOnNewDocument({ source: INJECTED_LISTENER_SOURCE });

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

  // CDP order: requestWillBeSent → responseReceived → loadingFinished.
  // We write the request record on responseReceived. The body fetch waits
  // for loadingFinished (with a 30s safety timeout) before calling
  // getResponseBody — large bodies aren't ready immediately and the older
  // sleep(100) heuristic dropped flight-search payloads silently.
  const pending = new Map<string, PendingRequest>();
  const inflight = new Set<Promise<void>>();
  const bodyReady = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  Network.requestWillBeSent((params) => {
    const { request, requestId, type } = params;
    if (isDebug()) {
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
    bodyReady.set(requestId, Promise.withResolvers<void>());
  });

  Network.responseReceived((params) => {
    const { requestId, response } = params;
    const reqInfo = pending.get(requestId);
    if (!reqInfo) return;
    pending.delete(requestId);

    if (isDebug()) {
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

    const bodyWork = (async () => {
      const ready = bodyReady.get(requestId);
      if (ready) {
        await Promise.race([ready.promise, sleep(30_000)]);
      }
      bodyReady.delete(requestId);
      try {
        const bodyResp = await Network.getResponseBody({ requestId });
        const body = bodyResp.base64Encoded
          ? Buffer.from(bodyResp.body, 'base64').toString('utf8')
          : bodyResp.body;
        // Body cap for the on-disk session. Server-rendered HTML pages on
        // travel/booking sites routinely run 250-500KB (Costco's rental-car
        // results page is ~262KB). The previous 256KB cap silently chopped
        // such pages and the compile agent saw the `[…truncated…]` marker
        // as a hard data-quality block (even when only a few bytes were
        // lost, leaving plenty of structure to parse). 2MB covers the
        // ~99th percentile of full-page renders without bloating most
        // sessions — `Network.getResponseBody` still streams to memory,
        // so very large bodies remain capped to protect process memory.
        const MAX = 2 * 1024 * 1024;
        const truncated = body.length > MAX ? `${body.slice(0, MAX)}\n[…truncated…]` : body;
        writer.requestBody(captured.seq, truncated);
      } catch (err) {
        if (isDebug()) {
          console.error(`[debug] body unavailable seq=${captured.seq} ${reqInfo.url}: ${err}`);
        }
      }
    })();
    inflight.add(bodyWork);
    bodyWork.finally(() => inflight.delete(bodyWork));
  });

  Network.loadingFinished((params) => {
    bodyReady.get(params.requestId)?.resolve();
  });

  Network.loadingFailed((params) => {
    if (isDebug()) {
      console.error(`[debug] loadingFailed ${params.requestId} ${params.errorText}`);
    }
    bodyReady.get(params.requestId)?.resolve();
    bodyReady.delete(params.requestId);
    pending.delete(params.requestId);
  });

  // Network is wired — safe to drive Chromium to the target URL.
  if (opts.url && opts.url !== 'about:blank') {
    if (isDebug()) {
      console.error(`[debug] navigating to ${opts.url}`);
    }
    const navResult = await Page.navigate({ url: opts.url });
    if (isDebug()) {
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

  // ── DOM event capture (via injected console.log sentinel) ────────────────
  // The injector posts lines like:  [IMPRINT] click {"tag":"button","id":...,"selector":...}
  Runtime.consoleAPICalled((params) => {
    try {
      if (params.type !== 'log' || !params.args || params.args.length < 2) return;
      const first = params.args[0];
      if (!first || first.type !== 'string' || first.value !== IMPRINT_SENTINEL) return;
      const second = params.args[1];
      const third = params.args[2];
      const eventType = second?.type === 'string' ? second.value : null;
      const payload = third?.type === 'string' ? third.value : null;
      if (!eventType || !payload) return;
      // Map injector's event names to our CapturedEvent type union.
      const allowed: CapturedEvent['type'][] = ['click', 'input', 'change', 'submit'];
      if (!allowed.includes(eventType as CapturedEvent['type'])) return;
      writer.event({
        seq: nextSeq(),
        timestamp: elapsed(),
        type: eventType as CapturedEvent['type'],
        detail: payload,
      });
    } catch {
      // Never let a single bad console line break the recorder.
    }
  });

  // ── WebSocket frames (sent + received, payload truncated to 1KB) ─────────
  const wsUrls = new Map<string, string>();
  Network.webSocketCreated((params) => {
    wsUrls.set(params.requestId, params.url);
  });
  Network.webSocketFrameSent((params) => {
    const url = wsUrls.get(params.requestId) ?? '';
    const payload = params.response.payloadData ?? '';
    writer.event({
      seq: nextSeq(),
      timestamp: elapsed(),
      type: 'ws-sent',
      detail: JSON.stringify({
        url,
        opcode: params.response.opcode,
        payloadDataPreview: payload.slice(0, 1024),
      }),
    });
  });
  Network.webSocketFrameReceived((params) => {
    const url = wsUrls.get(params.requestId) ?? '';
    const payload = params.response.payloadData ?? '';
    writer.event({
      seq: nextSeq(),
      timestamp: elapsed(),
      type: 'ws-received',
      detail: JSON.stringify({
        url,
        opcode: params.response.opcode,
        payloadDataPreview: payload.slice(0, 1024),
      }),
    });
  });
  Network.webSocketClosed((params) => {
    wsUrls.delete(params.requestId);
  });

  // ── Cookie snapshots: start (initial auth) + end (e.g. confirmation cookies) ─
  const snapshotCookies = async (label: CookieSnapshot['label']): Promise<void> => {
    try {
      const all = await Network.getAllCookies();
      writer.cookies({
        takenAt: new Date().toISOString(),
        timestamp: elapsed(),
        label,
        cookies: all.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
      });
    } catch (err) {
      if (isDebug()) {
        console.error(`[debug] cookie snapshot ${label} failed: ${String(err)}`);
      }
    }
  };
  await snapshotCookies('start');

  const snapshotStorage = async (label: StorageSnapshot['label']): Promise<void> => {
    try {
      const result = await Runtime.evaluate({
        expression: `(() => {
          const local = {};
          const session = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k) local[k] = localStorage.getItem(k) ?? '';
            }
          } catch {}
          try {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              if (k) session[k] = sessionStorage.getItem(k) ?? '';
            }
          } catch {}
          return { origin: location.origin, localStorage: local, sessionStorage: session };
        })()`,
        returnByValue: true,
      });
      const value = result.result.value as
        | {
            origin?: string;
            localStorage?: Record<string, string>;
            sessionStorage?: Record<string, string>;
          }
        | undefined;
      if (!value?.origin || value.origin === 'null') return;
      writer.storage({
        takenAt: new Date().toISOString(),
        timestamp: elapsed(),
        label,
        origin: value.origin,
        localStorage: value.localStorage ?? {},
        sessionStorage: value.sessionStorage ?? {},
      });
    } catch (err) {
      if (isDebug()) {
        console.error(`[debug] storage snapshot ${label} failed: ${String(err)}`);
      }
    }
  };
  await snapshotStorage('start');

  // ── Narration loop ────────────────────────────────────────────────────────
  let narrationOpen = !opts.noNarration;
  let rl: ReturnType<typeof createInterface> | null = null;

  const formatPrompt = (): string => {
    const secs = Math.floor(elapsed() / 1000);
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    return `[${mm}:${ss} • ${seq} captured] narrate (or /done): `;
  };

  const narrationLoop: Promise<void> = (async () => {
    if (opts.noNarration) return;
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    console.log('');
    console.log('[imprint] recording. drive the browser, narrate as you go.');
    console.log('[imprint]   blank line   = skip without recording narration');
    console.log('[imprint]   /done        = stop recording cleanly');
    console.log('[imprint]   Ctrl+C       = same as /done');
    console.log('');
    while (narrationOpen) {
      const reader = rl;
      if (!reader) break;
      const line: string = await new Promise((resolve) => {
        reader.question(formatPrompt(), (answer) => resolve(answer));
      });
      if (!narrationOpen) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === '/done' || trimmed === '/quit' || trimmed === '/q') {
        narrationOpen = false;
        break;
      }
      writer.narration({ seq: nextSeq(), timestamp: elapsed(), text: trimmed });
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

    // Drain in-flight body fetches before closing the JSONL stream — CDP
    // body fetch is async, late arrivals would be silently dropped.
    if (inflight.size > 0) {
      if (isDebug()) {
        console.error(`[debug] draining ${inflight.size} inflight handlers`);
      }
      await Promise.allSettled(Array.from(inflight));
    }

    // Final cookie snapshot before CDP teardown — confirmation pages
    // sometimes set fresh session cookies the replay needs.
    await snapshotCookies('end');
    await snapshotStorage('end');

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
    console.log('');
    console.log('next step:');
    console.log(`  imprint redact ${sessionPath}    # scrub credentials before LLM analysis`);
    return { jsonlPath, sessionPath, count: seq };
  };

  if (opts.signal) {
    if (opts.signal.aborted) return shutdown();
    opts.signal.addEventListener('abort', () => void shutdown());
  }
  // If the user closes the window, wind down.
  chromium.process.once('exit', () => void shutdown());

  await narrationLoop;
  return shutdown();
}
