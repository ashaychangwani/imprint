/**
 * End-to-end smoke test for the recorder. Launches a real Chromium, navigates
 * to a local synthetic page (zero anti-bot, zero auth), records, then aborts
 * via AbortController and asserts the captured session is well-formed.
 *
 * Skipped when CI=true unless RUN_BROWSER_TESTS=1 is also set, because GitHub
 * Actions Ubuntu runners don't have Chrome at /usr/bin/google-chrome by default.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import { record } from '../src/imprint/record.ts';

const SHOULD_RUN = process.env.CI !== 'true' || process.env.RUN_BROWSER_TESTS === '1';

function startFixtureRecording(options: Parameters<typeof record>[0]) {
  const recording = record(options);
  // A fixture may be waiting for page activity when startup fails. Own that
  // rejection immediately, then surface it through the fixture's activity wait.
  void recording.catch(() => {});
  return recording;
}

async function waitForFixtureActivity<T>(
  activity: Promise<T>,
  recording: ReturnType<typeof record>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      activity,
      recording.then(() => {
        throw new Error(`Recording stopped before fixture activity: ${message}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('recorder e2e', () => {
  if (!SHOULD_RUN) {
    it.skip('skipped in CI: set RUN_BROWSER_TESTS=1 to enable', () => {});
    return;
  }

  it('captures a real navigation and response from a local fixture', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const fixtureBody =
      '<!doctype html><title>Fixture recorder navigation</title><h1>Recorded fixture</h1>';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(fixtureBody, { headers: { 'content-type': 'text/html' } }),
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const recordPromise = startFixtureRecording({
      site: 'test',
      url,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });
    try {
      // Preserve the existing launch/capture window; no external uptime dependency.
      await sleep(5000);
      ctrl.abort();
      const result = await recordPromise;
      expect(result.jsonlPath).toBe(outPath);
      expect(existsSync(result.sessionPath)).toBe(true);
      expect(result.count).toBeGreaterThan(0);
      const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
      const session = assembleFromJsonl(outPath);
      expect(session.site).toBe('test');
      expect(session.url).toBe(url);
      expect(session.requests.length).toBeGreaterThan(0);
      const navigation = session.requests.find((request) => request.url === url);
      expect(navigation).toBeDefined();
      expect(navigation?.method).toBe('GET');
      expect(navigation?.response?.status).toBe(200);
      expect(navigation?.response?.body).toContain('Fixture recorder navigation');
      expect(session.cookieSnapshots.length).toBeGreaterThanOrEqual(2);
      expect(session.cookieSnapshots.find((snapshot) => snapshot.label === 'start')).toBeDefined();
      expect(session.cookieSnapshots.find((snapshot) => snapshot.label === 'end')).toBeDefined();
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns when Chromium exits before a no-narration stop signal', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const closeBrowser = Promise.withResolvers<() => Promise<void>>();

    const recordPromise = startFixtureRecording({
      site: 'browser-exit-test',
      url: 'about:blank',
      outPath,
      signal: ctrl.signal,
      noNarration: true,
      onBrowserReady: (_port, close) => closeBrowser.resolve(close),
    });
    try {
      await (
        await waitForFixtureActivity(
          closeBrowser.promise,
          recordPromise,
          'browser did not become ready',
        )
      )();
      const result = await Promise.race([
        recordPromise,
        sleep(10_000).then(() => {
          throw new Error('recording did not stop after Chromium exited');
        }),
      ]);
      expect(result.jsonlPath).toBe(outPath);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns promptly when Chromium exits with an open response body', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const responseStarted = Promise.withResolvers<void>();
    const closeBrowser = Promise.withResolvers<() => Promise<void>>();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/open') {
          responseStarted.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'));
              },
            }),
            { headers: { 'content-type': 'text/plain' } },
          );
        }
        return new Response('<script>fetch("/open").catch(()=>{})</script>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    const recordPromise = startFixtureRecording({
      site: 'browser-exit-open-response-test',
      url: `http://127.0.0.1:${server.port}/`,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
      onBrowserReady: (_port, close) => closeBrowser.resolve(close),
    });
    try {
      await waitForFixtureActivity(
        responseStarted.promise,
        recordPromise,
        'open response did not start',
      );
      await sleep(200);
      await (
        await waitForFixtureActivity(
          closeBrowser.promise,
          recordPromise,
          'browser did not become ready',
        )
      )();
      const result = await Promise.race([
        recordPromise,
        sleep(5_000).then(() => {
          throw new Error('recording inherited the response-body timeout after Chromium exited');
        }),
      ]);
      expect(result.jsonlPath).toBe(outPath);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('check verb reports a session without erroring', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();

    const recordPromise = startFixtureRecording({
      site: 'check-test',
      url: 'https://example.com/',
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });

    try {
      await sleep(3500);
      ctrl.abort();
      await recordPromise;

      const { checkSession } = await import('../src/imprint/check.ts');
      const result = checkSession(outPath.replace(/\.jsonl$/, '.json'));
      // We expect at least the no-narration warning. Capture is otherwise sound.
      expect(result.summary).toContain('site:        check-test');
      expect(result.summary).toContain('cookies:');
      expect(result.warnings.some((w) => /narration/i.test(w))).toBe(true);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('drains and preserves a redirect that starts before shutdown', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const started = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/slow') {
          started.resolve();
          await sleep(500);
          return Response.redirect(new URL('/final', request.url).href, 302);
        }
        if (new URL(request.url).pathname === '/final') {
          return Response.json({ status: 'finished' });
        }
        return new Response('<script>fetch("/slow")</script>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    const recordPromise = startFixtureRecording({
      site: 'shutdown-drain-test',
      url: `http://127.0.0.1:${server.port}/`,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });
    try {
      await waitForFixtureActivity(started.promise, recordPromise, 'slow request did not start');
      ctrl.abort();
      await recordPromise;

      const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
      const session = assembleFromJsonl(outPath);
      const final = session.requests.find((request) => new URL(request.url).pathname === '/final');
      expect(final?.response?.status).toBe(200);
      expect(final?.response?.body).toContain('finished');
      expect(
        session.requests.some(
          (request) =>
            new URL(request.url).pathname === '/slow' && request.response?.status === 200,
        ),
      ).toBe(false);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('admits no response body work after the shutdown grace cutoff', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const started = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/too-late') {
          started.resolve();
          await sleep(2_500);
          return Response.json({ status: 'late' });
        }
        return new Response('<script>fetch("/too-late")</script>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    const recordPromise = startFixtureRecording({
      site: 'shutdown-cutoff-test',
      url: `http://127.0.0.1:${server.port}/`,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });
    try {
      await waitForFixtureActivity(started.promise, recordPromise, 'late request did not start');
      ctrl.abort();
      await recordPromise;

      const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
      const session = assembleFromJsonl(outPath);
      expect(
        session.requests.some((request) => new URL(request.url).pathname === '/too-late'),
      ).toBe(false);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures a complete canceled RSC stream when the normal body is unavailable', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const requested = Promise.withResolvers<void>();
    const flightBody = ['1:"$Sreact.fragment"', '0:{"b":"build-id","f":["$L1"],"q":""}', ''].join(
      '\n',
    );
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/rsc') {
          requested.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(flightBody));
              },
            }),
            { headers: { 'content-type': 'text/x-component' } },
          );
        }
        return new Response(
          '<script>const c=new AbortController();fetch("/rsc",{headers:{RSC:"1",Accept:"text/x-component"},signal:c.signal}).catch(()=>{});setTimeout(()=>c.abort(),500)</script>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });

    const recordPromise = startFixtureRecording({
      site: 'rsc-stream-test',
      url: `http://127.0.0.1:${server.port}/`,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
    });
    try {
      await waitForFixtureActivity(requested.promise, recordPromise, 'RSC request did not start');
      await sleep(1_000);
      ctrl.abort();
      await recordPromise;

      const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
      const session = assembleFromJsonl(outPath);
      const rsc = session.requests.find((request) => new URL(request.url).pathname === '/rsc');
      expect(rsc?.response?.mimeType).toBe('text/x-component');
      expect(rsc?.response?.body).toBe(flightBody);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('promotes a failed viewport prefetch only after later matching route intent', async () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'imprint-test-'));
    const outPath = pathJoin(tmp, 'session.jsonl');
    const ctrl = new AbortController();
    const requested = Promise.withResolvers<void>();
    const activeRequested = Promise.withResolvers<void>();
    const browserReady = Promise.withResolvers<number>();
    const flightBody = ['1:"$Sreact.fragment"', '0:{"b":"build-id","f":["$L1"],"q":""}', ''].join(
      '\n',
    );
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/target' || pathname === '/active') {
          if (pathname === '/target') requested.resolve();
          else activeRequested.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(flightBody));
              },
            }),
            { headers: { 'content-type': 'text/x-component' } },
          );
        }
        if (pathname === '/abort') {
          await sleep(250);
          return new Response('not an image', {
            status: 404,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response(
          '<a id="target" href="/target" onclick="event.preventDefault()">Target</a><a id="active" href="/active" onclick="event.preventDefault()">Active</a><script>window.prefetchController=new AbortController();fetch("/target?_rsc=viewport",{headers:{RSC:"1","Next-Router-Prefetch":"1"},signal:prefetchController.signal}).catch(()=>{})</script><img src="/abort" onerror="prefetchController.abort()">',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });

    const recordPromise = startFixtureRecording({
      site: 'rsc-prefetch-intent-test',
      url: `http://127.0.0.1:${server.port}/`,
      outPath,
      signal: ctrl.signal,
      noNarration: true,
      onBrowserReady: browserReady.resolve,
    });
    try {
      await waitForFixtureActivity(
        requested.promise,
        recordPromise,
        'prefetch request did not start',
      );
      await sleep(700);
      const port = await browserReady.promise;
      const driver = await CDP({
        port,
        target: (targets) => targets.findIndex((target) => target.type === 'page'),
      });
      try {
        const location = await driver.Runtime.evaluate({
          expression:
            '(() => { const r = document.getElementById("target").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
          returnByValue: true,
        });
        const point = location.result.value as { x: number; y: number };
        await driver.Input.dispatchMouseEvent({
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await driver.Input.dispatchMouseEvent({
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await driver.Runtime.evaluate({
          expression:
            'window.activeController=new AbortController();fetch("/active?_rsc=viewport",{headers:{RSC:"1","Next-Router-Prefetch":"1"},signal:activeController.signal}).catch(()=>{})',
        });
        await Promise.race([
          activeRequested.promise,
          sleep(5_000).then(() => {
            throw new Error('active prefetch request did not start');
          }),
        ]);
        await sleep(100);
        const activeLocation = await driver.Runtime.evaluate({
          expression:
            '(() => { const r = document.getElementById("active").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
          returnByValue: true,
        });
        const activePoint = activeLocation.result.value as { x: number; y: number };
        await driver.Input.dispatchMouseEvent({
          type: 'mousePressed',
          x: activePoint.x,
          y: activePoint.y,
          button: 'left',
          clickCount: 1,
        });
        await driver.Input.dispatchMouseEvent({
          type: 'mouseReleased',
          x: activePoint.x,
          y: activePoint.y,
          button: 'left',
          clickCount: 1,
        });
        await driver.Runtime.evaluate({ expression: 'activeController.abort()' });
      } finally {
        await driver.close();
      }
      await sleep(300);
      ctrl.abort();
      await recordPromise;

      const { assembleFromJsonl } = await import('../src/imprint/session-writer.ts');
      const session = assembleFromJsonl(outPath);
      const prefetch = session.requests.find(
        (request) => new URL(request.url).pathname === '/target',
      );
      const activePrefetch = session.requests.find(
        (request) => new URL(request.url).pathname === '/active',
      );
      expect(prefetch?.response?.body).toBe(flightBody);
      expect(activePrefetch?.response?.body).toBe(flightBody);
    } finally {
      ctrl.abort();
      await recordPromise.catch(() => {});
      server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
