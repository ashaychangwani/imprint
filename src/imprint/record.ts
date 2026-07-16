/**
 * `imprint record` — capture a teaching session via CDP. Streams network
 * requests, DOM events, and stdin narration to JSONL; assembles session.json
 * on clean shutdown (Ctrl+C, /done, or external AbortSignal).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import envPaths from 'env-paths';
import { launchChromium } from './chromium.ts';
import { IMPRINT_SENTINEL, createInjectedListenerSource } from './inject-listener.ts';
import { isDebug } from './log.ts';
import { defaultSessionJsonlPath } from './paths.ts';
import { type ResponseBodyIntentKind, ResponseBodyIntentTracker } from './response-body-intent.ts';
import { RequestBodyLifecycleTracker } from './response-body-lifecycle.ts';
import {
  RESPONSE_BODY_STREAM_ALLOCATION_HEADROOM_BYTES,
  type ResponseBodyCompletion,
  type ResponseBodyStreamCapture,
  type ResponseBodyStreamLease,
  ResponseBodyStreamLeaseTracker,
  ResponseBodyStreamStore,
  matchesIntendedRoute,
  needsLaterIntent,
  resolveResponseBodyWithFallback,
  shouldRecoverStreamedBody,
  shouldStreamResponseBody,
} from './response-body-stream.ts';
import { createSessionWriter } from './session-writer.ts';
import { isTelemetryRequest } from './telemetry.ts';
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
  /** Test/embedding hook for attaching a second CDP driver. */
  onBrowserReady?: (port: number, closeBrowser: () => Promise<void>) => void;
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
  requestAtMs: number;
  recentUserIntent?: boolean;
  recentUserActivation?: boolean;
  intendedUrl?: string;
}

interface StreamingNetworkDomain {
  streamResourceContent?: (params: { requestId: string }) => Promise<{ bufferedData: string }>;
  dataReceived: (callback: (params: { requestId: string; data?: string }) => void) => unknown;
}

interface ActiveResponseStream {
  seq: number;
  url: string;
  capture: ResponseBodyStreamCapture;
  started: Promise<boolean>;
  lease: ResponseBodyStreamLease;
  priority: boolean;
  requiresIntent: boolean;
}

interface DormantResponseStream {
  active: ActiveResponseStream;
  completion: ResponseBodyCompletion;
  method: string;
  mimeType?: string;
  url: string;
  requestHeaders: Record<string, string>;
  retainedAtMs: number;
}

const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const STREAM_START_TIMEOUT_MS = 2_000;
const MAX_ISSUED_RESPONSE_STREAMS = 16;
const MAX_STREAM_START_FAILURES = 8;
const MAX_DORMANT_RESPONSE_STREAMS = 8;
const DORMANT_RESPONSE_STREAM_TTL_MS = 30_000;
const MAX_ACTIVE_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PASSIVE_STREAM_BYTES =
  MAX_ACTIVE_STREAM_BYTES -
  MAX_RESPONSE_BODY_BYTES -
  RESPONSE_BODY_STREAM_ALLOCATION_HEADROOM_BYTES;

function capResponseBody(body: string): string {
  const encoded = Buffer.from(body, 'utf8');
  if (encoded.length <= MAX_RESPONSE_BODY_BYTES) return body;
  let end = MAX_RESPONSE_BODY_BYTES;
  // Do not split a multi-byte UTF-8 code point at the storage boundary.
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end--;
  return `${encoded.subarray(0, end).toString('utf8')}\n[…truncated…]`;
}

function isUnsupportedStreamMethodError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  const responseCode =
    typeof error === 'object' && error !== null && 'response' in error
      ? (error as { response?: { code?: unknown } }).response?.code
      : undefined;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : responseCode;
  return (
    code === -32601 ||
    message.includes('-32601') ||
    message.includes('method not found') ||
    message.includes("method wasn't found")
  );
}

function responseContentLength(headers: Record<string, unknown>): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length');
  if (!entry) return undefined;
  const value = Number(entry[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasSameOrigin(first: string, second: string): boolean {
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
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
  const streamingNetwork = Network as typeof Network & StreamingNetworkDomain;

  await Promise.all([Network.enable(), Page.enable(), Runtime.enable()]);

  // Passive DOM listener emits sentinel-prefixed console.log lines we parse
  // via Runtime.consoleAPICalled below.
  const eventToken = randomUUID();
  await Page.addScriptToEvaluateOnNewDocument({
    source: createInjectedListenerSource(eventToken),
  });

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
  const bodyReady = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<Exclude<ResponseBodyCompletion, { kind: 'timeout' }>>>
  >();
  const requestGenerations = new Map<string, number>();
  const bodyLifecycles = new RequestBodyLifecycleTracker();
  const bodyIntents = new ResponseBodyIntentTracker();
  const intentRequestUrls = new Map<string, string>();
  const intentRequestActivations = new Map<string, boolean>();
  const streamStore = new ResponseBodyStreamStore();
  const streamLeases = new ResponseBodyStreamLeaseTracker(MAX_ISSUED_RESPONSE_STREAMS, 4);
  const activeStreams = new Map<string, ActiveResponseStream>();
  const dormantStreams = new Map<number, DormantResponseStream>();
  let streamMethodSupported = typeof streamingNetwork.streamResourceContent === 'function';
  let streamStartFailures = 0;
  let normalBodySuccesses = 0;
  let normalBodyFailures = 0;
  let networkCaptureClosing = false;
  let responseAdmissionClosed = false;
  let browserExited = false;

  const discardDormantStream = (captureSeq: number): void => {
    const dormant = dormantStreams.get(captureSeq);
    if (!dormant) return;
    dormantStreams.delete(captureSeq);
    streamStore.discard(dormant.active.capture);
  };

  const pruneDormantStreams = (nowMs = Date.now()): void => {
    for (const [captureSeq, dormant] of dormantStreams) {
      if (nowMs - dormant.retainedAtMs <= DORMANT_RESPONSE_STREAM_TTL_MS) continue;
      discardDormantStream(captureSeq);
    }
  };

  const makeRoomForPriorityStream = (): void => {
    pruneDormantStreams();
    while (dormantStreams.size > 0 && streamStore.stats.activeBytes > MAX_PASSIVE_STREAM_BYTES) {
      const oldest = dormantStreams.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      discardDormantStream(oldest);
    }
    if (streamStore.stats.activeBytes <= MAX_PASSIVE_STREAM_BYTES) return;
    for (const [requestId, active] of activeStreams) {
      if (active.priority) continue;
      streamStore.abandon(active.capture);
      if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
      if (streamStore.stats.activeBytes <= MAX_PASSIVE_STREAM_BYTES) break;
    }
  };

  const enforcePassiveStreamBudget = (requestId: string, active: ActiveResponseStream): void => {
    if (active.priority) return;
    pruneDormantStreams();
    while (dormantStreams.size > 0 && streamStore.stats.activeBytes > MAX_PASSIVE_STREAM_BYTES) {
      const oldest = dormantStreams.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      discardDormantStream(oldest);
    }
    if (streamStore.stats.activeBytes <= MAX_PASSIVE_STREAM_BYTES) return;
    streamStore.abandon(active.capture);
    if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
  };

  const promoteDormantStreams = (
    intendedUrl: string,
    intentAt: number,
    intentKind: ResponseBodyIntentKind,
  ): void => {
    if (intentKind !== 'pointerdown' && intentKind !== 'click') return;
    pruneDormantStreams(intentAt);
    let promotedActive = false;
    for (const active of activeStreams.values()) {
      if (!active.requiresIntent || !matchesIntendedRoute(active.url, intendedUrl)) continue;
      active.requiresIntent = false;
      active.priority = true;
      streamLeases.promote(active.lease);
      promotedActive = true;
    }
    if (promotedActive) makeRoomForPriorityStream();
    for (const [captureSeq, dormant] of dormantStreams) {
      if (!matchesIntendedRoute(dormant.url, intendedUrl)) continue;
      dormantStreams.delete(captureSeq);
      const body = streamStore.recover(dormant.active.capture, (candidate) =>
        shouldRecoverStreamedBody({
          completion: dormant.completion,
          method: dormant.method,
          mimeType: dormant.mimeType,
          url: dormant.url,
          requestHeaders: dormant.requestHeaders,
          body: candidate,
        }),
      );
      if (body !== null) writer.requestBody(captureSeq, capResponseBody(body));
    }
  };

  (streamingNetwork.dataReceived as StreamingNetworkDomain['dataReceived'])((params) => {
    if (!params.data) return;
    const active = activeStreams.get(params.requestId);
    if (!active) return;
    streamStore.appendData(active.capture, params.data);
    enforcePassiveStreamBudget(params.requestId, active);
    if (active.capture.truncated || active.capture.abandoned) {
      streamStore.abandon(active.capture);
      if (activeStreams.get(params.requestId) === active) {
        activeStreams.delete(params.requestId);
      }
    }
  });

  Network.requestWillBeSent((params) => {
    const { request, requestId, type } = params;
    if (responseAdmissionClosed || (networkCaptureClosing && !pending.has(requestId))) return;
    if (isDebug()) {
      console.error(`[debug] requestWillBeSent ${requestId} ${request.method} ${request.url}`);
    }
    const previousGeneration = requestGenerations.get(requestId);
    streamLeases.markRequestCompleted(requestId, previousGeneration);
    const previousReady = bodyReady.get(requestId);
    previousReady?.resolve({ kind: 'failed', errorText: 'requestId reused' });
    const previousStream = activeStreams.get(requestId);
    if (previousStream) {
      streamStore.abandon(previousStream.capture);
      activeStreams.delete(requestId);
    }

    const requestAtMs =
      typeof params.wallTime === 'number' && Number.isFinite(params.wallTime)
        ? params.wallTime * 1_000
        : Date.now();
    const matchedIntentUrl = bodyIntents.match(request.url, requestAtMs);
    const matchedActivationUrl = bodyIntents.matchActivation(request.url, requestAtMs);
    const directIntentMatch = Boolean(matchedIntentUrl);
    const previousIntentUrl = intentRequestUrls.get(requestId);
    const redirectedIntentMatch = Boolean(
      params.redirectResponse &&
        previousIntentUrl &&
        hasSameOrigin(request.url, previousIntentUrl) &&
        matchesIntendedRoute(request.url, previousIntentUrl),
    );
    const intentMatched = directIntentMatch || redirectedIntentMatch;
    const intendedUrl = directIntentMatch
      ? matchedIntentUrl
      : redirectedIntentMatch
        ? previousIntentUrl
        : undefined;
    const recentUserActivation = Boolean(
      matchedActivationUrl ||
        (redirectedIntentMatch && intentRequestActivations.get(requestId) === true),
    );
    if (intendedUrl) intentRequestUrls.set(requestId, intendedUrl);
    else intentRequestUrls.delete(requestId);
    if (intendedUrl) intentRequestActivations.set(requestId, recentUserActivation);
    else intentRequestActivations.delete(requestId);

    const requestSeq = nextSeq();
    requestGenerations.set(requestId, requestSeq);
    pending.set(requestId, {
      seq: requestSeq,
      timestamp: elapsed(),
      method: request.method,
      url: request.url,
      headers: request.headers as Record<string, string>,
      body: typeof request.postData === 'string' ? request.postData : undefined,
      resourceType: type ?? 'Other',
      requestAtMs,
      recentUserIntent: intentMatched,
      recentUserActivation,
      intendedUrl,
    });
    bodyReady.set(
      requestId,
      Promise.withResolvers<Exclude<ResponseBodyCompletion, { kind: 'timeout' }>>(),
    );
  });

  Network.responseReceived((params) => {
    if (responseAdmissionClosed) return;
    const { requestId, response } = params;
    const reqInfo = pending.get(requestId);
    if (!reqInfo) return;
    pending.delete(requestId);

    // Runtime and Network events originate in separate CDP domains. Re-check
    // at response time so a browser-timestamped intent that arrived after
    // requestWillBeSent still qualifies its request deterministically.
    const lateIntentUrl = bodyIntents.match(reqInfo.url, reqInfo.requestAtMs);
    const lateActivationUrl = bodyIntents.matchActivation(reqInfo.url, reqInfo.requestAtMs);
    if (lateIntentUrl) {
      reqInfo.recentUserIntent = true;
      reqInfo.intendedUrl = lateIntentUrl;
      intentRequestUrls.set(requestId, lateIntentUrl);
    }
    if (lateActivationUrl) {
      reqInfo.recentUserActivation = true;
      intentRequestActivations.set(requestId, true);
    }

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

    const streamResourceContent = streamingNetwork.streamResourceContent;
    if (
      streamMethodSupported &&
      streamStartFailures < MAX_STREAM_START_FAILURES &&
      streamResourceContent &&
      !isTelemetryRequest(captured) &&
      shouldStreamResponseBody({
        method: reqInfo.method,
        resourceType: reqInfo.resourceType,
        status: response.status,
        mimeType: response.mimeType,
        contentLength: responseContentLength(response.headers),
        url: reqInfo.url,
        requestHeaders: reqInfo.headers,
        recentUserIntent: reqInfo.recentUserIntent,
        recentUserActivation: reqInfo.recentUserActivation,
        intendedUrl: reqInfo.intendedUrl,
      })
    ) {
      const streamCandidate = {
        method: reqInfo.method,
        resourceType: reqInfo.resourceType,
        status: response.status,
        mimeType: response.mimeType,
        contentLength: responseContentLength(response.headers),
        url: reqInfo.url,
        requestHeaders: reqInfo.headers,
        recentUserIntent: reqInfo.recentUserIntent,
        recentUserActivation: reqInfo.recentUserActivation,
        intendedUrl: reqInfo.intendedUrl,
      };
      const priority = reqInfo.method === 'POST' || reqInfo.recentUserActivation === true;
      const lease = streamLeases.begin(requestId, captured.seq, priority);
      if (lease) {
        if (priority) makeRoomForPriorityStream();
        const capture = streamStore.begin(requestId, captured.seq);
        const active: ActiveResponseStream = {
          seq: captured.seq,
          url: reqInfo.url,
          capture,
          started: Promise.resolve(false),
          lease,
          priority,
          requiresIntent: needsLaterIntent(streamCandidate),
        };
        activeStreams.set(requestId, active);
        active.started = streamResourceContent({ requestId })
          .then(({ bufferedData }) => {
            if (activeStreams.get(requestId) !== active) {
              streamStore.discard(capture);
              return false;
            }
            streamStore.markStarted(capture);
            if (bufferedData) {
              streamStore.appendBufferedData(capture, bufferedData);
              enforcePassiveStreamBudget(requestId, active);
              if (capture.truncated || capture.abandoned) {
                streamStore.abandon(capture);
                if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
                return false;
              }
            }
            return true;
          })
          .catch((error) => {
            streamStartFailures++;
            if (
              isUnsupportedStreamMethodError(error) ||
              streamStartFailures >= MAX_STREAM_START_FAILURES
            ) {
              streamMethodSupported = false;
            }
            if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
            streamStore.discard(capture);
            if (isDebug()) {
              console.error(
                `[debug] response stream unavailable seq=${captured.seq} ${reqInfo.url}: ${String(error)}`,
              );
            }
            return false;
          })
          .finally(() => streamLeases.markCommandSettled(lease));
      }
    }

    bodyLifecycles.begin(requestId, captured.seq);
    const bodyWork = (async () => {
      const ready = bodyReady.get(requestId);
      const completion: ResponseBodyCompletion = ready
        ? await Promise.race([
            ready.promise,
            sleep(30_000).then((): ResponseBodyCompletion => ({ kind: 'timeout' })),
          ])
        : { kind: 'timeout' };
      if (bodyReady.get(requestId) === ready) bodyReady.delete(requestId);

      const activeCandidate = activeStreams.get(requestId);
      const active = activeCandidate?.seq === captured.seq ? activeCandidate : undefined;
      const stoppedAtShutdownCutoff =
        completion.kind === 'failed' && completion.errorText === 'shutdown cutoff';
      try {
        const resolved = await resolveResponseBodyWithFallback({
          readNormal: async () => {
            if (browserExited || stoppedAtShutdownCutoff) {
              throw new Error('response body read unavailable during shutdown');
            }
            if (requestGenerations.get(requestId) !== captured.seq) {
              throw new Error('request generation changed');
            }
            const bodyResp = await Network.getResponseBody({ requestId });
            if (requestGenerations.get(requestId) !== captured.seq) {
              throw new Error('request generation changed');
            }
            normalBodySuccesses++;
            return bodyResp.base64Encoded
              ? Buffer.from(bodyResp.body, 'base64').toString('utf8')
              : bodyResp.body;
          },
          readStream: active
            ? async () => {
                normalBodyFailures++;
                const started = await Promise.race([
                  active.started,
                  sleep(STREAM_START_TIMEOUT_MS).then(() => false),
                ]);
                if (
                  !started ||
                  activeStreams.get(requestId) !== active ||
                  requestGenerations.get(requestId) !== captured.seq
                ) {
                  return null;
                }
                if (
                  active.requiresIntent &&
                  completion.kind !== 'timeout' &&
                  !bodyIntents.hasMatchingActivationSince(reqInfo.url, reqInfo.requestAtMs)
                ) {
                  pruneDormantStreams();
                  if (active.capture.bytes === 0) return null;
                  while (dormantStreams.size >= MAX_DORMANT_RESPONSE_STREAMS) {
                    const oldest = dormantStreams.keys().next().value as number | undefined;
                    if (oldest === undefined) break;
                    discardDormantStream(oldest);
                  }
                  dormantStreams.set(captured.seq, {
                    active,
                    completion,
                    method: reqInfo.method,
                    mimeType: response.mimeType,
                    url: reqInfo.url,
                    requestHeaders: reqInfo.headers,
                    retainedAtMs: Date.now(),
                  });
                  while (
                    dormantStreams.size > 0 &&
                    streamStore.stats.activeBytes > MAX_PASSIVE_STREAM_BYTES
                  ) {
                    const oldest = dormantStreams.keys().next().value as number | undefined;
                    if (oldest === undefined) break;
                    discardDormantStream(oldest);
                  }
                  if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
                  return null;
                }
                return streamStore.recover(active.capture, (body) =>
                  shouldRecoverStreamedBody({
                    completion,
                    method: reqInfo.method,
                    mimeType: response.mimeType,
                    url: reqInfo.url,
                    requestHeaders: reqInfo.headers,
                    body,
                  }),
                );
              }
            : undefined,
        });
        if (resolved.source !== 'normal' && resolved.normalError !== undefined && !active) {
          normalBodyFailures++;
        }
        if (resolved.body === null || requestGenerations.get(requestId) !== captured.seq) {
          if (isDebug() && resolved.normalError !== undefined) {
            console.error(
              `[debug] body unavailable seq=${captured.seq} ${reqInfo.url}: ${String(resolved.normalError)}`,
            );
          }
          return;
        }
        // Body cap for the on-disk session. Server-rendered HTML pages on
        // travel/booking sites routinely run 250-500KB (Costco's rental-car
        // results page is ~262KB). The previous 256KB cap silently chopped
        // such pages and the compile agent saw the `[…truncated…]` marker
        // as a hard data-quality block (even when only a few bytes were
        // lost, leaving plenty of structure to parse). 2MB covers the
        // ~99th percentile of full-page renders without bloating most
        // sessions — `Network.getResponseBody` still streams to memory,
        // so very large bodies remain capped to protect process memory.
        writer.requestBody(captured.seq, capResponseBody(resolved.body));
        if (resolved.source === 'stream' && isDebug()) {
          console.error(
            `[debug] recovered streamed response body seq=${captured.seq} bytes=${Buffer.byteLength(resolved.body)} ${reqInfo.url}`,
          );
        }
      } finally {
        if (active && !dormantStreams.has(captured.seq)) {
          streamStore.discard(active.capture);
          if (activeStreams.get(requestId) === active) activeStreams.delete(requestId);
        }
        const terminalWhileActive = bodyLifecycles.finish(requestId, captured.seq);
        if (
          (completion.kind !== 'timeout' || terminalWhileActive) &&
          requestGenerations.get(requestId) === captured.seq
        ) {
          requestGenerations.delete(requestId);
        }
      }
    })();
    inflight.add(bodyWork);
    bodyWork.finally(() => inflight.delete(bodyWork));
  });

  Network.loadingFinished((params) => {
    const generation = requestGenerations.get(params.requestId);
    const ready = bodyReady.get(params.requestId);
    streamLeases.markRequestCompleted(params.requestId, generation);
    ready?.resolve({ kind: 'finished' });
    const canDeleteGeneration =
      generation === undefined || bodyLifecycles.markTerminal(params.requestId, generation);
    if (!ready && canDeleteGeneration && requestGenerations.get(params.requestId) === generation) {
      requestGenerations.delete(params.requestId);
    }
    intentRequestUrls.delete(params.requestId);
    intentRequestActivations.delete(params.requestId);
  });

  Network.loadingFailed((params) => {
    const generation = requestGenerations.get(params.requestId);
    const ready = bodyReady.get(params.requestId);
    streamLeases.markRequestCompleted(params.requestId, generation);
    if (isDebug()) {
      console.error(`[debug] loadingFailed ${params.requestId} ${params.errorText}`);
    }
    ready?.resolve({
      kind: 'failed',
      errorText: params.errorText,
      canceled: params.canceled,
      blockedReason: params.blockedReason,
    });
    bodyReady.delete(params.requestId);
    intentRequestUrls.delete(params.requestId);
    intentRequestActivations.delete(params.requestId);
    if (pending.delete(params.requestId)) requestGenerations.delete(params.requestId);
    const canDeleteGeneration =
      generation === undefined || bodyLifecycles.markTerminal(params.requestId, generation);
    if (!ready && canDeleteGeneration && requestGenerations.get(params.requestId) === generation) {
      requestGenerations.delete(params.requestId);
    }
  });

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
      if (params.type !== 'log' || !params.args || params.args.length < 4) return;
      const first = params.args[0];
      if (!first || first.type !== 'string' || first.value !== IMPRINT_SENTINEL) return;
      const second = params.args[1];
      const third = params.args[2];
      const fourth = params.args[3];
      if (!second || second.type !== 'string' || second.value !== eventToken) return;
      const eventType = third?.type === 'string' ? third.value : null;
      const payload = fourth?.type === 'string' ? fourth.value : null;
      if (!eventType || !payload) return;
      if (eventType === 'intent') {
        try {
          const detail = JSON.parse(payload) as {
            absoluteHref?: unknown;
            intentAt?: unknown;
            intentKind?: unknown;
          };
          const intentAt =
            typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
              ? params.timestamp
              : Date.now();
          const intentKind =
            detail.intentKind === 'pointerover' ||
            detail.intentKind === 'pointerdown' ||
            detail.intentKind === 'focusin' ||
            detail.intentKind === 'click'
              ? detail.intentKind
              : undefined;
          bodyIntents.record(
            intentAt,
            typeof detail.absoluteHref === 'string' ? detail.absoluteHref : undefined,
            intentKind,
          );
          if (typeof detail.absoluteHref === 'string' && intentKind) {
            promoteDormantStreams(detail.absoluteHref, intentAt, intentKind);
          }
        } catch {
          // Ignore malformed intent records.
        }
        return;
      }
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

  // Event listeners are wired — safe to drive Chromium to the target URL.
  // Registering them first ensures early hydration actions and user intent are
  // observable instead of racing the initial navigation.
  if (opts.url && opts.url !== 'about:blank') {
    if (isDebug()) {
      console.error(`[debug] navigating to ${opts.url}`);
    }
    const navResult = await Page.navigate({ url: opts.url });
    if (isDebug()) {
      console.error(`[debug] navigate returned: ${JSON.stringify(navResult)}`);
    }
  }

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
    if (opts.noNarration) {
      if (opts.signal && !opts.signal.aborted) {
        await Promise.race([
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), { once: true }),
          ),
          chromium.process.exitCode === null
            ? new Promise<void>((resolve) => chromium.process.once('exit', () => resolve()))
            : Promise.resolve(),
        ]);
      }
      return;
    }
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
    networkCaptureClosing = true;
    narrationOpen = false;
    rl?.close();

    // Stop admitting new generations, but give requests that already emitted
    // requestWillBeSent a short window to receive their response headers and
    // join the normal inflight body drain.
    const pendingDeadline = Date.now() + 2_000;
    while (!browserExited && Date.now() < pendingDeadline) {
      if (pending.size > 0) {
        await sleep(25);
        continue;
      }
      // Redirects reuse a request id and briefly leave `pending` empty between
      // responseReceived for the redirect and requestWillBeSent for its target.
      await sleep(25);
      if (pending.size === 0) break;
    }
    responseAdmissionClosed = true;
    for (const requestId of pending.keys()) {
      pending.delete(requestId);
      bodyReady.get(requestId)?.resolve({ kind: 'failed', errorText: 'shutdown cutoff' });
      bodyReady.delete(requestId);
      requestGenerations.delete(requestId);
      intentRequestUrls.delete(requestId);
      intentRequestActivations.delete(requestId);
    }
    while (!browserExited && bodyReady.size > 0 && Date.now() < pendingDeadline) await sleep(25);
    // Requests that already received response headers no longer appear in
    // `pending`, but their body workers can still be waiting for a terminal
    // Network event. Once admission closes there is nothing useful left to
    // wait for: resolve every remaining waiter so shutdown cannot inherit the
    // normal 30-second body timeout (especially after Chromium exits).
    for (const [requestId, ready] of bodyReady) {
      ready.resolve({ kind: 'failed', errorText: 'shutdown cutoff' });
      bodyReady.delete(requestId);
    }

    // A dead browser can leave an already-issued CDP command unresolved. Tear
    // down the transport before awaiting body workers so those promises reject
    // instead of holding shutdown open indefinitely.
    if (browserExited) {
      try {
        await Promise.race([client.close(), sleep(1_000)]);
      } catch {
        // The browser may have already closed the transport.
      }
    }

    // Drain in-flight body fetches before closing the JSONL stream — CDP body
    // fetch is async, and late arrivals would otherwise be silently dropped.
    if (inflight.size > 0) {
      if (isDebug()) {
        console.error(`[debug] draining ${inflight.size} inflight handlers`);
      }
      await Promise.allSettled(Array.from(inflight));
    }

    // Final cookie snapshot before CDP teardown — confirmation pages
    // sometimes set fresh session cookies the replay needs.
    if (!browserExited) {
      await snapshotCookies('end');
      await snapshotStorage('end');
    }

    if (!browserExited) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    const outstandingIssuedStreams = streamLeases.size;
    for (const active of activeStreams.values()) streamStore.discard(active.capture);
    activeStreams.clear();
    for (const dormant of dormantStreams.values()) streamStore.discard(dormant.active.capture);
    dormantStreams.clear();
    streamLeases.clear();
    if (isDebug() && streamStore.stats.attempted > 0) {
      console.error(
        `[debug] response stream stats ${JSON.stringify({
          ...streamStore.stats,
          streamStartFailures,
          outstandingIssuedStreams,
          normalBodySuccesses,
          normalBodyFailures,
        })}`,
      );
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
  chromium.process.once('exit', () => {
    browserExited = true;
    void shutdown();
  });
  opts.onBrowserReady?.(chromium.port, chromium.close);

  await narrationLoop;
  return shutdown();
}
