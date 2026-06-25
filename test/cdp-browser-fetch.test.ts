import { afterEach, describe, expect, it } from 'bun:test';
import {
  __setCdpBrowserFetchHooksForTest,
  createCdpBrowserFetch,
  parseSetCookieForCdp,
} from '../src/imprint/cdp-browser-fetch.ts';

afterEach(() => {
  __setCdpBrowserFetchHooksForTest(null);
});

describe('parseSetCookieForCdp (cross-origin Set-Cookie re-injection)', () => {
  const reqUrl = 'https://functions.example.com/login';

  it('parses name=value with url scoping and no attributes', () => {
    expect(parseSetCookieForCdp('sid=ABC123', reqUrl)).toEqual({
      name: 'sid',
      value: 'ABC123',
      url: reqUrl,
    });
  });

  it('parses Domain/Path/Secure/HttpOnly/SameSite attributes', () => {
    expect(
      parseSetCookieForCdp(
        'sess=tok; Domain=.example.com; Path=/app; Secure; HttpOnly; SameSite=Lax',
        reqUrl,
      ),
    ).toEqual({
      name: 'sess',
      value: 'tok',
      url: reqUrl,
      domain: '.example.com',
      path: '/app',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('converts Expires to epoch seconds', () => {
    const ck = parseSetCookieForCdp('a=b; Expires=Thu, 01 Jan 2099 00:00:00 GMT', reqUrl);
    expect(ck?.expires).toBe(Math.floor(Date.parse('Thu, 01 Jan 2099 00:00:00 GMT') / 1000));
  });

  it('drops unrecognized SameSite casing instead of emitting an invalid value', () => {
    expect(parseSetCookieForCdp('a=b; SameSite=weird', reqUrl)?.sameSite).toBeUndefined();
  });

  it('returns null when there is no name=value pair', () => {
    expect(parseSetCookieForCdp('', reqUrl)).toBeNull();
    expect(parseSetCookieForCdp('   ; Path=/', reqUrl)).toBeNull();
  });

  it('preserves "=" inside the cookie value', () => {
    expect(parseSetCookieForCdp('jwt=a.b=c; Path=/', reqUrl)).toMatchObject({
      name: 'jwt',
      value: 'a.b=c',
      path: '/',
    });
  });
});

describe('createCdpBrowserFetch CDP timeouts', () => {
  it('times out a stuck startup CDP command and closes the browser', async () => {
    let chromeClosed = 0;
    let clientClosed = 0;
    const never = new Promise<never>(() => {});

    __setCdpBrowserFetchHooksForTest({
      launchChromium: async () =>
        ({
          process: {} as never,
          port: 12345,
          userDataDir: '/tmp/imprint-fake-chrome',
          ready: Promise.resolve(),
          close: async () => {
            chromeClosed++;
          },
        }) as Awaited<ReturnType<typeof import('../src/imprint/chromium.ts').launchChromium>>,
      connectCdp: async () =>
        ({
          Runtime: {
            enable: () => never,
            evaluate: async () => ({ result: { value: 'Chrome/148' } }),
          },
          Network: {
            enable: async () => ({}),
            setCookie: async () => ({}),
            setUserAgentOverride: async () => ({}),
            getCookies: async () => ({ cookies: [] }),
          },
          Page: {
            enable: async () => ({}),
            navigate: async () => ({}),
            loadEventFired: async () => ({}),
          },
          Input: {
            dispatchMouseEvent: async () => ({}),
            dispatchKeyEvent: async () => ({}),
          },
          close: async () => {
            clientClosed++;
          },
        }) as never,
    });

    const cf = createCdpBrowserFetch({
      baseUrl: 'https://example.com',
      cdpCommandTimeoutMs: 10,
      abckWaitSeconds: 1,
    });

    const started = Date.now();
    await expect(cf.mintJar()).rejects.toThrow(/CDP Runtime\.enable timed out after 10ms/);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(clientClosed).toBe(1);
    expect(chromeClosed).toBe(1);
  });
});
