import { afterEach, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import {
  __setCdpBrowserFetchHooksForTest,
  buildFormPostNavigationExpr,
  buildInPageFetchExpr,
  buildNavigationClickTargetExpression,
  buildNavigationSelectorExpression,
  buildStorageSeedExpression,
  createCdpBrowserFetch,
  isSiblingOrigin,
  normalizeCdpResponseHeaders,
  parseCdpPageInspectionResult,
  parseSetCookieForCdp,
  validateFormPostNavigationHeaders,
} from '../src/imprint/cdp-browser-fetch.ts';

const browserIt = process.env.CI !== 'true' || process.env.RUN_BROWSER_TESTS === '1' ? it : it.skip;

describe('buildNavigationSelectorExpression', () => {
  it('quotes arbitrary CSS selectors as data instead of executable source', () => {
    const selector = '[data-name="quoted"]\\path';
    const expression = buildNavigationSelectorExpression(selector);

    expect(expression).toBe(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    expect(expression).not.toContain('querySelector([data-name');
  });
});

describe('buildNavigationClickTargetExpression', () => {
  it('quotes dynamic selectors and rejects hidden, disabled, or occluded targets', () => {
    const selector = '[data-location-id="S1"]\\path';
    const expression = buildNavigationClickTargetExpression(selector);

    expect(expression).toContain(`document.querySelector(${JSON.stringify(selector)})`);
    expect(expression).toContain("target.matches(':disabled')");
    expect(expression).toContain('document.elementFromPoint(x, y)');
    expect(expression).not.toContain('querySelector([data-location-id');
  });
});

describe('buildInPageFetchExpr', () => {
  it('keeps the request timeout active while reading the response body', async () => {
    let abortedDuringBodyRead = false;
    const expression = buildInPageFetchExpr('https://example.test/slow', 'GET', {}, null, 5);
    const result = await runInNewContext(expression, {
      AbortController,
      clearTimeout,
      setTimeout,
      fetch: async (_url: string, init: RequestInit) => ({
        status: 200,
        headers: new Headers(),
        async text() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          abortedDuringBodyRead = Boolean(init.signal?.aborted);
          return 'ok';
        },
      }),
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true, body: 'ok' });
    expect(abortedDuringBodyRead).toBe(true);
  });

  it('clears page-side timers when fetch rejects', async () => {
    const active = new Set<ReturnType<typeof setTimeout>>();
    const trackedSetTimeout = (callback: () => void, ms: number) => {
      const handle = setTimeout(() => {
        active.delete(handle);
        callback();
      }, ms);
      active.add(handle);
      return handle;
    };
    const trackedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
      active.delete(handle);
      clearTimeout(handle);
    };
    const failingFetch = async () => {
      throw new Error('fixture fetch failed');
    };
    const expression = buildInPageFetchExpr('https://example.test/fail', 'GET', {}, null, 60_000);
    const result = await runInNewContext(expression, {
      AbortController,
      setTimeout: trackedSetTimeout,
      clearTimeout: trackedClearTimeout,
      fetch: failingFetch,
      document: {
        createElement: () => ({
          style: {},
          contentWindow: { fetch: failingFetch },
          remove() {},
        }),
        body: { appendChild() {} },
      },
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false });
    expect(active.size).toBe(0);
  });
});

describe('buildStorageSeedExpression', () => {
  it('restores only missing storage values for the current origin', () => {
    const local = new Map<string, string>([['local', 'rotated-live-value']]);
    const session = new Map<string, string>();
    const expression = buildStorageSeedExpression([
      { origin: 'https://fixture.test', kind: 'localStorage', key: 'local', value: 'one' },
      { origin: 'https://fixture.test', kind: 'sessionStorage', key: 'session', value: 'two' },
      { origin: 'https://other.test', kind: 'sessionStorage', key: 'wrong', value: 'three' },
    ]);

    runInNewContext(expression, {
      location: { origin: 'https://fixture.test' },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
      },
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
      },
    });

    expect(Object.fromEntries(local)).toEqual({ local: 'rotated-live-value' });
    expect(Object.fromEntries(session)).toEqual({ session: 'two' });
  });

  it('surfaces storage access failures with a tagged browser exception', () => {
    const expression = buildStorageSeedExpression([
      { origin: 'https://fixture.test', kind: 'localStorage', key: 'token', value: 'value' },
    ]);

    expect(() =>
      runInNewContext(expression, {
        location: { origin: 'https://fixture.test' },
        localStorage: {
          getItem() {
            throw new Error('storage blocked');
          },
        },
        sessionStorage: {},
      }),
    ).toThrow('__IMPRINT_STORAGE_SEED_FAILED__localStorage:token');
  });
});

describe('buildFormPostNavigationExpr', () => {
  it('preserves duplicate URL-encoded fields and safely quotes the destination', () => {
    const expression = buildFormPostNavigationExpr(
      'https://login.example.test/u/login?state=a"b',
      'action=default&action=continue&username=a%2Bb%40example.test',
    );

    expect(expression).toContain(
      'new URLSearchParams("action=default&action=continue&username=a%2Bb%40example.test")',
    );
    expect(expression).toContain(
      'new URL("https://login.example.test/u/login?state=a\\"b", location.href)',
    );
    expect(expression).toContain('Array.from(document.forms)');
    expect(expression).toContain("candidate.getAttribute('action')");
    expect(expression).toContain("form.setAttribute('action', targetUrl)");
    expect(expression).toContain('new FormData(clone, cloneSubmitter)');
    expect(expression).toContain('JSON.stringify(encoded) !== JSON.stringify(params)');
    expect(expression).toContain("action: 'click'");
    expect(expression).toContain('form.requestSubmit()');
    expect(expression).toContain('form.submit()');
  });

  browserIt(
    'executes a matching rendered form with duplicate fields and the recorded submitter',
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <form method="post" action="https://login.example.test/continue">
          <input type="hidden" name="action" value="default">
          <input type="email" name="username">
          <button type="submit" name="action" value="continue">Continue</button>
        </form>
      `);
        await page.addScriptTag({
          content: `document.forms[0].addEventListener('submit', (event) => {
          event.preventDefault();
          globalThis.captured = Array.from(new FormData(event.currentTarget, event.submitter))
            .map(([name, value]) => [name, String(value)]);
        });`,
        });
        const expression = buildFormPostNavigationExpr(
          'https://login.example.test/continue',
          'action=default&username=person%40example.test&action=continue',
        );
        await page.addScriptTag({ content: `globalThis.directive = ${expression};` });
        const directive = await page.evaluate('globalThis.directive');
        expect(directive).toMatchObject({ action: 'click', renderedForm: true });
        await page.addScriptTag({
          content: `for (const field of ${JSON.stringify(
            (directive as { typedFields: unknown }).typedFields,
          )}) {
          globalThis.__imprintForm.elements[field.index].value = field.value;
        }
        globalThis.__imprintSubmitter.click();`,
        });

        const captured = (await page.evaluate('globalThis.captured')) as unknown;
        expect(captured).toEqual([
          ['action', 'default'],
          ['username', 'person@example.test'],
          ['action', 'continue'],
        ]);
        expect(await page.locator('input[type=hidden][name=action]').inputValue()).toBe('default');
      } finally {
        await browser.close();
      }
    },
  );

  browserIt(
    'uses an exact synthetic form instead of hijacking an unrelated rendered form',
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <form id="unrelated" method="post" action="https://example.test/newsletter">
          <input name="email">
          <button type="submit">Subscribe</button>
        </form>
      `);
        await page.addScriptTag({
          content: `HTMLFormElement.prototype.submit = function submit() {
          globalThis.submitted = {
            id: this.id,
            action: this.action,
            fields: Array.from(new FormData(this)).map(([name, value]) => [name, String(value)]),
          };
        };`,
        });
        const expression = buildFormPostNavigationExpr(
          'https://login.example.test/continue',
          'email=person%40example.test&scope=openid&scope=profile',
        );
        await page.addScriptTag({ content: `globalThis.directive = ${expression};` });
        const directive = await page.evaluate('globalThis.directive');

        expect(directive).toEqual({ action: 'submitted', renderedForm: false });
        const submitted = (await page.evaluate('globalThis.submitted')) as unknown;
        expect(submitted).toEqual({
          id: '',
          action: 'https://login.example.test/continue',
          fields: [
            ['email', 'person@example.test'],
            ['scope', 'openid'],
            ['scope', 'profile'],
          ],
        });
        expect(await page.locator('#unrelated').getAttribute('action')).toBe(
          'https://example.test/newsletter',
        );
      } finally {
        await browser.close();
      }
    },
  );
});

describe('isSiblingOrigin', () => {
  it('shares real registrable domains but isolates private-suffix tenants', () => {
    expect(isSiblingOrigin('https://www.example.co.uk', 'https://api.example.co.uk')).toBe(true);
    expect(isSiblingOrigin('https://alice.github.io', 'https://bob.github.io')).toBe(false);
  });
});

describe('top-level form POST validation', () => {
  it('accepts only explicitly URL-encoded form semantics', () => {
    expect(() =>
      validateFormPostNavigationHeaders({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: 'browser-managed=true',
      }),
    ).not.toThrow();
    expect(() => validateFormPostNavigationHeaders({})).toThrow(/explicit Content-Type/);
    expect(() => validateFormPostNavigationHeaders({ 'Content-Type': 'application/json' })).toThrow(
      /requires application\/x-www-form-urlencoded/,
    );
    expect(() =>
      validateFormPostNavigationHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Bearer token',
      }),
    ).toThrow(/cannot preserve request header\(s\): Authorization/);
  });
});

describe('parseCdpPageInspectionResult', () => {
  it('accepts a live rendered-page snapshot', () => {
    expect(
      parseCdpPageInspectionResult({
        result: {
          value: { url: 'https://example.test/login', title: 'Login', bodyText: 'Welcome' },
        },
      }),
    ).toEqual({ url: 'https://example.test/login', title: 'Login', bodyText: 'Welcome' });
  });

  it('throws when CDP cannot produce a usable rendered page', () => {
    expect(() => parseCdpPageInspectionResult({ result: {} })).toThrow(/no page snapshot/);
    expect(() =>
      parseCdpPageInspectionResult({
        exceptionDetails: { exception: { description: 'Target closed' } },
      }),
    ).toThrow(/Target closed/);
  });
});

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

describe('normalizeCdpResponseHeaders', () => {
  it('drops array indexes and invalid names while folding multiline values', () => {
    expect(
      normalizeCdpResponseHeaders({
        50: '<https://example.test/a>; rel="preload"\n<https://example.test/b>; rel="preload"',
        Link: '<https://example.test/a>; rel="preload"\n<https://example.test/b>; rel="preload"',
        'X-Test': 'ok',
        'bad header': 'ignored',
      }),
    ).toEqual({
      link: '<https://example.test/a>; rel="preload", <https://example.test/b>; rel="preload"',
      'x-test': 'ok',
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
