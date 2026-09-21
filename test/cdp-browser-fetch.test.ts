import { afterEach, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import {
  CdpNetworkResponseCapture,
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
import { WorkflowSchema } from '../src/imprint/types.ts';

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

describe('navigation click target facts', () => {
  it('reports bounded geometry and hit facts without choosing another element', () => {
    class FixtureElement {
      tagName = 'BUTTON';
      parentElement: FixtureElement | null = null;
      attrs: Record<string, string> = {};
      style = { display: 'block', visibility: 'visible', pointerEvents: 'auto' };
      rect = { x: 10, y: 20, left: 10, top: 20, width: 100, height: 40 };
      disabled = false;
      focused = false;
      getAttribute(name: string) {
        return this.attrs[name] ?? null;
      }
      getBoundingClientRect() {
        return this.rect;
      }
      scrollIntoView() {}
      matches() {
        return this.disabled;
      }
      contains(element: unknown) {
        return element === this;
      }
      focus() {
        this.focused = true;
      }
    }
    const target = new FixtureElement();
    const blocker = new FixtureElement();
    blocker.attrs.class = 'cover';
    const parent = new FixtureElement();
    parent.attrs.role = 'group';
    target.parentElement = parent;
    target.attrs.class = 'x'.repeat(1000);
    const evaluate = (element: FixtureElement | null, hit = element) =>
      runInNewContext(buildNavigationClickTargetExpression('#fixture'), {
        Element: FixtureElement,
        getComputedStyle: (node: FixtureElement) => node.style,
        document: {
          querySelector: () => element,
          querySelectorAll: () => (element ? [element, blocker] : []),
          elementFromPoint: () => hit,
        },
      });
    target.style.pointerEvents = 'none';
    const covered = evaluate(target, blocker).diagnostic;
    expect(covered.reason).toBe('center_hit_other_element');
    expect(covered.matchedCount).toBe(2);
    expect(covered.target.pointerEvents).toBe('none');
    expect(covered.target.class.length).toBe(160);
    expect(covered.parent.role).toBe('group');
    expect(covered.hit.class).toBe('cover');
    expect(covered.rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(target.focused).toBe(false);
    target.rect.width = 0;
    expect(evaluate(target).diagnostic.reason).toBe('zero_area');
    target.rect.width = 100;
    target.disabled = true;
    expect(evaluate(target).diagnostic.reason).toBe('disabled');
    expect(evaluate(null).diagnostic).toMatchObject({
      reason: 'not_found',
      matchedCount: 0,
      target: null,
    });
    target.disabled = false;
    target.style.pointerEvents = 'auto';
    expect(evaluate(target)).toEqual({ x: 60, y: 40 });
    expect(target.focused).toBe(true);
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

describe('navigation network-response capture', () => {
  it('identifies the failing matcher predicates without choosing a replacement', () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
      method: 'POST',
      resourceType: 'XHR',
    });
    for (const [requestId, path, method, resourceType] of [
      ['path', '/api.results', 'post', 'xhr'],
      ['method', '/api/results', 'GET', 'XHR'],
      ['type', '/api/results', 'POST', 'Fetch'],
    ] as const) {
      const request = { requestId, url: `https://fixture.test${path}`, method, resourceType };
      expect(capture.observeRequest(request)).toBe(false);
      expect(capture.observeResponse({ ...request, status: 200, headers: {} })).toBe(false);
    }
    const evidence = JSON.parse(
      capture.timeoutMessage(100).split('observed network responses: ')[1] ?? '',
    );
    expect(evidence.matchingRequestCount).toBe(0);
    expect(
      evidence.recent.map((response: { matcherChecks: unknown }) => response.matcherChecks),
    ).toEqual([
      { urlIncludes: false, method: true, resourceType: true },
      { urlIncludes: true, method: false, resourceType: true },
      { urlIncludes: true, method: true, resourceType: false },
    ]);
  });

  it('reports observed response facts without selecting a mismatched response', async () => {
    const capture = new CdpNetworkResponseCapture(
      { urlIncludes: '/api/results', recordingResponseRequestSeq: 42, method: 'POST' },
      { afterRequestSequence: 10, deferUntilNavigationScope: true },
    );
    capture.setNavigationScope({ loaderId: 'current' });
    for (const [requestId, requestSequence, loaderId] of [
      ['old', 9, 'previous'],
      ['background', 11, 'previous'],
      ['current', 12, 'current'],
    ] as const) {
      const request = {
        requestId,
        requestSequence,
        loaderId,
        url: 'https://fixture.test/api/changed',
        method: 'POST',
        resourceType: 'Fetch',
      };
      capture.observeRequest(request);
      expect(capture.observeResponse({ ...request, status: 200, headers: {} })).toBe(false);
    }
    const evidence = JSON.parse(
      capture.timeoutMessage(100).split('observed network responses: ')[1] ?? '',
    );
    expect(evidence).toMatchObject({
      count: 2,
      omitted: 0,
      matchingRequestCount: 0,
      navigationScopeReady: true,
      recent: [
        {
          endpoint: 'https://fixture.test/api/changed',
          method: 'POST',
          resourceType: 'Fetch',
          status: 200,
          inNavigationScope: false,
        },
        { endpoint: 'https://fixture.test/api/changed', inNavigationScope: true },
      ],
    });
    expect(capture.selectedRequestIs('current')).toBe(false);
    const wanted = {
      requestId: 'wanted',
      requestSequence: 13,
      loaderId: 'current',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'XHR',
    };
    capture.observeRequest(wanted);
    expect(capture.observeResponse({ ...wanted, status: 200, headers: {} })).toBe(true);
    await capture.finish('wanted', async () => ({ body: 'selected body' }));
    expect(await capture.outcome).toMatchObject({ ok: true, response: { body: 'selected body' } });
  });

  it('bounds timeout metadata and excludes URL secrets, headers and non-HTTP bodies', () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/missing',
      recordingResponseRequestSeq: 42,
    });
    for (let index = 0; index < 20; index++) {
      capture.observeResponse({
        requestId: String(index),
        url: `https://fixture-user:fixture-pass@fixture.test/${index}/${'x'.repeat(300)}?token=fixture-query-secret#fixture-fragment`,
        method: 'GET',
        resourceType: 'Script',
        status: 200,
        headers: { authorization: 'fixture-header-secret' },
      });
    }
    capture.observeResponse({
      requestId: 'data',
      url: 'data:text/plain,fixture-inline-secret',
      status: 200,
      headers: {},
    });
    capture.observeResponse({
      requestId: 'invalid',
      url: 'fixture-invalid-secret',
      status: 200,
      headers: {},
    });
    const message = capture.timeoutMessage(100);
    const evidence = JSON.parse(message.split('observed network responses: ')[1] ?? '');
    expect(evidence.count).toBe(22);
    expect(evidence.omitted).toBe(10);
    expect(evidence.recent).toHaveLength(12);
    expect(evidence.recent[0]).toMatchObject({ endpointTruncated: true });
    expect(evidence.recent[0].endpoint).toHaveLength(240);
    expect(evidence.recent.at(-2).endpoint).toBe('[non-HTTP URL]');
    expect(evidence.recent.at(-1).endpoint).toBe('[unparseable URL]');
    for (const secret of [
      'fixture-user',
      'fixture-pass',
      'fixture-query-secret',
      'fixture-fragment',
      'fixture-header-secret',
      'fixture-inline-secret',
      'fixture-invalid-secret',
    ]) {
      expect(message).not.toContain(secret);
    }
    expect(message.length).toBeLessThan(6000);
  });

  it('accepts an explicit, site-neutral network response matcher in workflow.json', () => {
    const workflow = WorkflowSchema.parse({
      toolName: 'network_response_fixture',
      intent: { description: 'Capture one response created by a rendered page.' },
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/results',
          headers: {},
          mode: 'navigate',
          navigation: {
            networkResponse: {
              urlIncludes: '/api/results',
              recordingResponseRequestSeq: 42,
              method: 'POST',
              resourceType: 'XHR',
              occurrence: 2,
            },
          },
        },
      ],
      site: 'fixture',
    });

    expect(workflow.requests[0]?.navigation?.networkResponse).toEqual({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
      method: 'POST',
      resourceType: 'XHR',
      occurrence: 2,
    });
    expect(() =>
      WorkflowSchema.parse({
        ...workflow,
        requests: [
          {
            ...workflow.requests[0],
            navigation: {
              networkResponse: {
                urlIncludes: '',
                recordingResponseRequestSeq: 42,
                occurrence: 0,
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      WorkflowSchema.parse({
        ...workflow,
        requests: [
          {
            ...workflow.requests[0],
            navigation: { networkResponse: { urlIncludes: '/api/results' } },
          },
        ],
      }),
    ).toThrow(/recordingResponseRequestSeq/);
    expect(() =>
      WorkflowSchema.parse({
        ...workflow,
        requests: [
          {
            ...workflow.requests[0],
            mode: 'fetch',
          },
        ],
      }),
    ).toThrow(/navigation\.networkResponse requires mode/);
  });

  it('selects the unique matcher and reads its body only after completion', async () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
      method: 'post',
      resourceType: 'xhr',
    });
    capture.observeRequest({
      requestId: 'wrong-method',
      url: 'https://fixture.test/api/results',
      method: 'GET',
      resourceType: 'XHR',
    });
    expect(
      capture.observeResponse({
        requestId: 'wrong-method',
        url: 'https://fixture.test/api/results',
        method: 'GET',
        resourceType: 'XHR',
        status: 200,
        headers: {},
      }),
    ).toBe(false);
    capture.observeRequest({
      requestId: 'first',
      url: 'https://fixture.test/api/results?page=1',
      method: 'POST',
      resourceType: 'Fetch',
    });
    expect(
      capture.observeResponse({
        requestId: 'first',
        url: 'https://fixture.test/api/results?page=1',
        method: 'POST',
        resourceType: 'Fetch',
        status: 200,
        headers: {},
      }),
    ).toBe(false);
    capture.observeRequest({
      requestId: 'second',
      url: 'https://fixture.test/api/results?page=2',
      method: 'POST',
      resourceType: 'XHR',
    });
    expect(
      capture.observeResponse({
        requestId: 'second',
        url: 'https://fixture.test/api/results?page=2',
        method: 'POST',
        resourceType: 'XHR',
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    ).toBe(true);

    let reads = 0;
    await capture.finish('first', async () => {
      reads++;
      return { body: 'wrong' };
    });
    expect(reads).toBe(0);
    await capture.finish('second', async () => {
      reads++;
      return { body: Buffer.from('{"ok":true}').toString('base64'), base64Encoded: true };
    });

    const outcome = await capture.outcome;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.response).toMatchObject({
      requestId: 'second',
      url: 'https://fixture.test/api/results?page=2',
      status: 201,
    });
    expect(
      typeof outcome.response.body === 'string'
        ? outcome.response.body
        : new TextDecoder().decode(outcome.response.body),
    ).toBe('{"ok":true}');
    expect(reads).toBe(1);
  });

  it('counts only responses while preserving request-start order among them', async () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/api/poll',
      recordingResponseRequestSeq: 43,
      method: 'POST',
      occurrence: 2,
    });
    for (const [requestId, requestSequence] of [
      ['failed', 1],
      ['first-response', 2],
      ['second-response', 3],
    ] as const) {
      capture.observeRequest({
        requestId,
        requestSequence,
        url: 'https://fixture.test/api/poll',
        method: 'POST',
        resourceType: 'XHR',
      });
    }

    expect(
      capture.observeResponse({
        requestId: 'second-response',
        requestSequence: 3,
        url: 'https://fixture.test/api/poll',
        method: 'POST',
        resourceType: 'XHR',
        status: 200,
        headers: {},
      }),
    ).toBe(false);
    expect(capture.fail('failed', 'cancelled')).toBe(false);
    expect(
      capture.observeResponse({
        requestId: 'first-response',
        requestSequence: 2,
        url: 'https://fixture.test/api/poll',
        method: 'POST',
        resourceType: 'XHR',
        status: 200,
        headers: {},
      }),
    ).toBe(true);
    await capture.finish('second-response', async () => ({ body: 'second body' }));
    expect(await capture.outcome).toMatchObject({
      ok: true,
      response: { requestId: 'second-response', body: 'second body' },
    });
  });

  it('reports whether no response matched or a matching body never completed', () => {
    const missing = new CdpNetworkResponseCapture({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
      method: 'POST',
    });
    expect(missing.timeoutMessage(500)).toStartWith(
      'browser navigation timed out after 500ms waiting for network response with URL containing "/api/results", method POST',
    );
    missing.observeRequest({
      requestId: 'pending',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
    });
    missing.observeResponse({
      requestId: 'pending',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
      status: 200,
      headers: {},
    });
    expect(missing.timeoutMessage(500)).toContain('before its response body completed');
  });

  it('binds a form capture only to a new document with the declared method and loader', () => {
    const capture = new CdpNetworkResponseCapture(
      {
        urlIncludes: '/api/results',
        recordingResponseRequestSeq: 42,
      },
      {
        afterRequestSequence: 10,
        deferUntilNavigationScope: true,
        navigationMethod: 'POST',
      },
    );
    capture.observeRequest({
      requestId: 'old-loader-result',
      requestSequence: 11,
      loaderId: 'old-loader',
      frameId: 'main-frame',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'XHR',
    });
    capture.observeResponse({
      requestId: 'old-loader-result',
      requestSequence: 11,
      loaderId: 'old-loader',
      frameId: 'main-frame',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'XHR',
      status: 200,
      headers: {},
    });
    expect(
      capture.setNavigationScopeFromDocument({
        requestId: 'old-document',
        requestSequence: 10,
        loaderId: 'old-loader',
        frameId: 'main-frame',
        url: 'https://fixture.test/start',
        method: 'POST',
        resourceType: 'Document',
        status: 200,
        headers: {},
      }),
    ).toBeUndefined();
    capture.observeRequest({
      requestId: 'missing-loader-result',
      requestSequence: 14,
      frameId: 'main-frame',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'XHR',
    });
    expect(
      capture.setNavigationScopeFromDocument({
        requestId: 'wrong-method-document',
        requestSequence: 12,
        loaderId: 'wrong-loader',
        frameId: 'main-frame',
        url: 'https://fixture.test/start',
        method: 'GET',
        resourceType: 'Document',
        status: 200,
        headers: {},
      }),
    ).toBeUndefined();
    expect(
      capture.setNavigationScopeFromDocument({
        requestId: 'new-document',
        requestSequence: 13,
        loaderId: 'new-loader',
        frameId: 'main-frame',
        url: 'https://fixture.test/start',
        method: 'POST',
        resourceType: 'Document',
        status: 200,
        headers: {},
      }),
    ).toBeUndefined();
    expect(
      capture.observeResponse({
        requestId: 'missing-loader-result',
        requestSequence: 14,
        frameId: 'main-frame',
        url: 'https://fixture.test/api/results',
        method: 'POST',
        resourceType: 'XHR',
        status: 200,
        headers: {},
      }),
    ).toBe(false);
    capture.observeRequest({
      requestId: 'new-loader-result',
      requestSequence: 15,
      loaderId: 'new-loader',
      frameId: 'main-frame',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'XHR',
    });
    expect(
      capture.observeResponse({
        requestId: 'new-loader-result',
        requestSequence: 15,
        loaderId: 'new-loader',
        frameId: 'main-frame',
        url: 'https://fixture.test/api/results',
        method: 'POST',
        resourceType: 'XHR',
        status: 200,
        headers: {},
      }),
    ).toBe(true);
  });

  it('retries a completed-body read to tolerate CDP event timing races', async () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
    });
    capture.observeRequest({
      requestId: 'request-1',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
    });
    capture.observeResponse({
      requestId: 'request-1',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
      status: 200,
      headers: {},
    });
    let reads = 0;
    await capture.finish('request-1', async () => {
      reads++;
      if (reads < 3) throw new Error('body is not ready yet');
      return { body: 'ready' };
    });

    expect(await capture.outcome).toMatchObject({
      ok: true,
      response: { body: 'ready' },
    });
    expect(reads).toBe(3);
  });

  it('cancels a body-read wait without waiting for an unresponsive CDP command', async () => {
    const capture = new CdpNetworkResponseCapture({
      urlIncludes: '/api/results',
      recordingResponseRequestSeq: 42,
    });
    capture.setDeadline(Date.now() + 60_000);
    capture.observeRequest({
      requestId: 'request-1',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
    });
    capture.observeResponse({
      requestId: 'request-1',
      url: 'https://fixture.test/api/results',
      method: 'POST',
      resourceType: 'Fetch',
      status: 200,
      headers: {},
    });
    const never = new Promise<{ body: string }>(() => {});
    const bodyRead = capture.finish('request-1', () => never);
    capture.cancel();

    await expect(bodyRead).resolves.toBeUndefined();
    expect(await capture.outcome).toMatchObject({
      ok: false,
      message: 'browser navigation response capture was cancelled',
    });
  });

  it('returns the matched page-generated body through a mocked CDP navigation', async () => {
    let currentUrl = 'about:blank';
    let navigationCount = 0;
    const bodyReads: string[] = [];
    let requestWillBeSent: ((event: unknown) => void) | undefined;
    let responseReceived: ((event: unknown) => void) | undefined;
    let loadingFinished: ((event: unknown) => void) | undefined;
    let loadingFailed: ((event: unknown) => void) | undefined;

    __setCdpBrowserFetchHooksForTest({
      launchChromium: async () =>
        ({
          process: {} as never,
          port: 12345,
          userDataDir: '/tmp/imprint-fake-chrome',
          ready: Promise.resolve(),
          close: async () => {},
        }) as Awaited<ReturnType<typeof import('../src/imprint/chromium.ts').launchChromium>>,
      connectCdp: async () =>
        ({
          Runtime: {
            enable: async () => ({}),
            evaluate: async ({ expression }: { expression: string }) => {
              if (expression === 'navigator.userAgent') {
                return { result: { value: 'Mozilla/5.0 Chrome/148.0.0.0' } };
              }
              if (expression === 'location.href') return { result: { value: currentUrl } };
              if (expression === 'document.documentElement.outerHTML') {
                return { result: { value: '<html>rendered page, not API data</html>' } };
              }
              return { result: { value: true } };
            },
          },
          Network: {
            enable: async () => ({}),
            setUserAgentOverride: async () => ({}),
            requestWillBeSent: (listener: (event: unknown) => void) => {
              requestWillBeSent = listener;
            },
            responseReceived: (listener: (event: unknown) => void) => {
              responseReceived = listener;
            },
            loadingFinished: (listener: (event: unknown) => void) => {
              loadingFinished = listener;
            },
            loadingFailed: (listener: (event: unknown) => void) => {
              loadingFailed = listener;
            },
            getResponseBody: async ({ requestId }: { requestId: string }) => {
              bodyReads.push(requestId);
              return {
                body:
                  requestId === 'background-live'
                    ? '{"items":[{"id":"live"}]}'
                    : '{"items":[{"id":"stale"}]}',
                base64Encoded: false,
              };
            },
            getCookies: async () => ({ cookies: [] }),
          },
          Page: {
            enable: async () => ({}),
            getFrameTree: async () => ({ frameTree: { frame: { id: 'main-frame' } } }),
            navigate: async ({ url }: { url: string }) => {
              navigationCount++;
              currentUrl = url;
              if (navigationCount === 1) {
                requestWillBeSent?.({
                  requestId: 'background-before-boundary',
                  loaderId: 'old-loader',
                  frameId: 'main-frame',
                  type: 'XHR',
                  request: {
                    method: 'POST',
                    url: 'https://fixture.test/api/results?query=stale-before',
                  },
                });
              }
              if (navigationCount === 2) {
                // A response whose request began during the prior pooled page
                // must not satisfy this new navigation's matcher.
                // Deliberately deliver completion before responseReceived. The
                // runtime must remember it and read the body after the match.
                loadingFinished?.({ requestId: 'background-before-boundary' });
                responseReceived?.({
                  requestId: 'background-before-boundary',
                  type: 'XHR',
                  frameId: 'main-frame',
                  loaderId: 'old-loader',
                  response: {
                    url: 'https://fixture.test/api/results?query=stale-before',
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  },
                });

                // This request starts after capture begins, but belongs to the
                // old loader. It is buffered until the new loader is known and
                // then rejected by the navigation scope.
                requestWillBeSent?.({
                  requestId: 'background-old-loader',
                  loaderId: 'old-loader',
                  frameId: 'main-frame',
                  type: 'XHR',
                  request: {
                    method: 'POST',
                    url: 'https://fixture.test/api/results?query=stale-loader',
                  },
                });
                loadingFinished?.({ requestId: 'background-old-loader' });
                responseReceived?.({
                  requestId: 'background-old-loader',
                  type: 'XHR',
                  frameId: 'main-frame',
                  loaderId: 'old-loader',
                  response: {
                    url: 'https://fixture.test/api/results?query=stale-loader',
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  },
                });

                requestWillBeSent?.({
                  requestId: 'document-new',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  type: 'Document',
                  request: { method: 'GET', url },
                });
                responseReceived?.({
                  requestId: 'document-new',
                  type: 'Document',
                  frameId: 'main-frame',
                  loaderId: 'new-loader',
                  response: { url, status: 200, headers: { 'Content-Type': 'text/html' } },
                });

                requestWillBeSent?.({
                  requestId: 'background-live',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  type: 'XHR',
                  request: {
                    method: 'POST',
                    url: 'https://fixture.test/api/results?query=live',
                  },
                });
                loadingFinished?.({ requestId: 'background-live' });
                responseReceived?.({
                  requestId: 'background-live',
                  type: 'XHR',
                  frameId: 'main-frame',
                  loaderId: 'new-loader',
                  response: {
                    url: 'https://fixture.test/api/results?query=live',
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Content-Length': '999' },
                  },
                });
              }
              return {
                loaderId: navigationCount === 2 ? 'new-loader' : 'old-loader',
                frameId: 'main-frame',
              };
            },
            // A selected background response is the completion condition for
            // this request; an unrelated document load event may never arrive.
            loadEventFired: () => new Promise(() => {}),
          },
          Input: {
            dispatchMouseEvent: async () => ({}),
            dispatchKeyEvent: async () => ({}),
          },
          close: async () => {},
        }) as never,
    });

    const browser = createCdpBrowserFetch({
      baseUrl: 'https://fixture.test/',
      abckWaitSeconds: 0,
      cdpCommandTimeoutMs: 100,
    });
    try {
      const response = await browser.navigate?.('https://fixture.test/results', {
        timeoutMs: 250,
        networkResponse: {
          urlIncludes: '/api/results',
          recordingResponseRequestSeq: 42,
          method: 'POST',
          resourceType: 'XHR',
        },
      });
      expect(await response?.text()).toBe('{"items":[{"id":"live"}]}');
      expect(response?.headers.get('x-imprint-response-source')).toBe('page-network');
      expect(response?.headers.get('x-imprint-network-response-url')).toContain('/api/results');
      expect(response?.headers.get('content-length')).toBeNull();
      expect(bodyReads).toEqual(['background-live']);
      expect(loadingFailed).toBeDefined();
    } finally {
      await browser.close();
    }
  });

  it('captures only requests started by the selected action, including repeated pooled calls', async () => {
    let currentUrl = 'about:blank';
    let clicked = 0;
    let serial = 0;
    let targetAttempts = 0;
    let targetState = 'delayed';
    const reads: string[] = [];
    const listeners: Record<string, (event: unknown) => void> = {};
    const emit = (id: string, phase: 'start' | 'response' | 'finish' | 'fail') => {
      const common = { requestId: id, loaderId: 'current', frameId: 'main', type: 'XHR' };
      if (phase === 'start')
        listeners.request?.({
          ...common,
          request: { method: 'POST', url: 'https://fixture.test/results' },
        });
      if (phase === 'response')
        listeners.response?.({
          ...common,
          response: { url: 'https://fixture.test/results', status: 200, headers: {} },
        });
      if (phase === 'finish') listeners.finish?.(common);
      if (phase === 'fail') listeners.fail?.({ ...common, errorText: 'net::ERR_ABORTED' });
    };
    __setCdpBrowserFetchHooksForTest({
      launchChromium: async () =>
        ({
          process: {} as never,
          port: 12345,
          userDataDir: '/tmp/imprint-fake-chrome',
          ready: Promise.resolve(),
          close: async () => {},
        }) as Awaited<ReturnType<typeof import('../src/imprint/chromium.ts').launchChromium>>,
      connectCdp: async () =>
        ({
          Runtime: {
            enable: async () => ({}),
            evaluate: async ({ expression }: { expression: string }) => {
              if (expression.includes('const target = document.querySelector')) {
                targetAttempts++;
                if (targetState === 'invalid') {
                  return { result: {}, exceptionDetails: { text: 'Invalid CSS selector' } };
                }
                if (targetState === 'diagnostic') {
                  return {
                    result: { value: { diagnostic: { reason: 'zero_area', matchedCount: 2 } } },
                  };
                }
                if (targetState === 'transport-error') throw new Error('CDP disconnected');
                if (targetState === 'closed') await browser.close();
                if (targetState !== 'delayed' || targetAttempts <= 2) {
                  // Even completed matching requests while waiting precede the click boundary.
                  emit(`waiting-${serial}-${targetAttempts}`, 'start');
                  emit(`waiting-${serial}-${targetAttempts}`, 'response');
                  emit(`waiting-${serial}-${targetAttempts}`, 'finish');
                  return { result: { value: null } };
                }
                return { result: { value: { x: 10, y: 20 } } };
              }
              return {
                result: {
                  value:
                    expression === 'navigator.userAgent'
                      ? 'Mozilla/5.0 Chrome/148.0.0.0'
                      : expression === 'location.href'
                        ? currentUrl
                        : true,
                },
              };
            },
          },
          Network: {
            enable: async () => ({}),
            setUserAgentOverride: async () => ({}),
            getCookies: async () => ({ cookies: [] }),
            requestWillBeSent: (fn: (event: unknown) => void) => {
              listeners.request = fn;
            },
            responseReceived: (fn: (event: unknown) => void) => {
              listeners.response = fn;
            },
            loadingFinished: (fn: (event: unknown) => void) => {
              listeners.finish = fn;
            },
            loadingFailed: (fn: (event: unknown) => void) => {
              listeners.fail = fn;
            },
            getResponseBody: async ({ requestId }: { requestId: string }) => {
              reads.push(requestId);
              return { body: requestId };
            },
          },
          Page: {
            bringToFront: async () => ({}),
            enable: async () => ({}),
            getFrameTree: async () => ({ frameTree: { frame: { id: 'main' } } }),
            domContentEventFired: async () => ({}),
            loadEventFired: async () => ({}),
            navigate: async ({ url }: { url: string }) => {
              currentUrl = url;
              clicked = 0;
              targetAttempts = 0;
              serial++;
              emit(`initial-${serial}`, 'start');
              emit(`initial-${serial}`, 'response');
              return { loaderId: 'current', frameId: 'main' };
            },
          },
          Input: {
            dispatchKeyEvent: async () => ({}),
            dispatchMouseEvent: async ({ type }: { type: string }) => {
              if (type !== 'mouseReleased') return {};
              clicked++;
              if (clicked === 1) {
                emit(`menu-${serial}`, 'start');
                emit(`menu-${serial}`, 'response');
                emit(`menu-${serial}`, 'finish');
                emit(`late-${serial}`, 'start');
              } else {
                emit(`initial-${serial}`, 'fail');
                // Earlier requests finishing after the boundary are still excluded.
                emit(`late-${serial}`, 'response');
                emit(`late-${serial}`, 'finish');
                emit(`chosen-${serial}`, 'start');
                emit(`chosen-${serial}`, 'response');
                emit(`chosen-${serial}`, 'finish');
              }
              return {};
            },
          },
          close: async () => {},
        }) as never,
    });
    const browser = createCdpBrowserFetch({
      baseUrl: 'https://fixture.test',
      abckWaitSeconds: 0,
      cdpCommandTimeoutMs: 100,
    });
    const actions = [
      { action: 'click' as const, selector: '#menu' },
      { action: 'click' as const, selector: '#choice' },
    ];
    const networkResponse = {
      urlIncludes: '/results',
      recordingResponseRequestSeq: 2,
      actionIndex: 1,
    };
    try {
      await expect(
        browser.navigate?.('https://fixture.test/page', {
          actions,
          networkResponse: { ...networkResponse, actionIndex: 2 },
        }),
      ).rejects.toThrow('existing navigation action');
      for (let index = 0; index < 2; index++) {
        const response = await browser.navigate?.('https://fixture.test/page', {
          waitUntil: 'domcontentloaded',
          timeoutMs: 1500,
          pollIntervalMs: 10,
          actions,
          networkResponse,
        });
        expect(await response?.text()).toBe(`chosen-${serial}`);
        expect(targetAttempts).toBe(4);
        expect(clicked).toBe(2);
      }
      expect(reads).toEqual(['chosen-2', 'chosen-3']);
      const firstAction = await browser.navigate?.('https://fixture.test/page', {
        waitUntil: 'domcontentloaded',
        timeoutMs: 1500,
        pollIntervalMs: 10,
        actions,
        networkResponse: { ...networkResponse, actionIndex: 0 },
      });
      expect(await firstAction?.text()).toBe('menu-4');
      expect(reads).toEqual(['chosen-2', 'chosen-3', 'menu-4']);
      for (const [state, message] of [
        ['missing', 'within 120ms'],
        ['diagnostic', 'target diagnostics: {"reason":"zero_area","matchedCount":2}'],
        ['invalid', 'Invalid CSS selector'],
        ['transport-error', 'CDP disconnected'],
        ['closed', 'browser closed'],
      ] as const) {
        targetState = state;
        const started = Date.now();
        await expect(
          browser.navigate?.('https://fixture.test/page', {
            waitUntil: 'domcontentloaded',
            timeoutMs: 120,
            pollIntervalMs: 10,
            actions,
            networkResponse,
          }),
        ).rejects.toThrow(message);
        expect(clicked).toBe(0);
        if (state === 'missing' || state === 'diagnostic') {
          expect(targetAttempts).toBeGreaterThan(1);
          expect(Date.now() - started).toBeLessThan(1000);
        } else {
          expect(targetAttempts).toBe(1);
        }
      }
      expect(reads).toEqual(['chosen-2', 'chosen-3', 'menu-4']);
    } finally {
      await browser.close();
    }
  }, 10_000);

  it('closes a pooled page before a detached body read can overlap another navigation', async () => {
    let currentUrl = 'about:blank';
    let navigationCount = 0;
    let chromeClosed = 0;
    let clientClosed = 0;
    let bodyReads = 0;
    let requestWillBeSent: ((event: unknown) => void) | undefined;
    let responseReceived: ((event: unknown) => void) | undefined;
    let loadingFinished: ((event: unknown) => void) | undefined;
    const never = new Promise<{ body: string; base64Encoded: false }>(() => {});

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
            enable: async () => ({}),
            evaluate: async ({ expression }: { expression: string }) => {
              if (expression === 'navigator.userAgent') {
                return { result: { value: 'Mozilla/5.0 Chrome/148.0.0.0' } };
              }
              if (expression === 'location.href') return { result: { value: currentUrl } };
              return { result: { value: true } };
            },
          },
          Network: {
            enable: async () => ({}),
            setUserAgentOverride: async () => ({}),
            requestWillBeSent: (listener: (event: unknown) => void) => {
              requestWillBeSent = listener;
            },
            responseReceived: (listener: (event: unknown) => void) => {
              responseReceived = listener;
            },
            loadingFinished: (listener: (event: unknown) => void) => {
              loadingFinished = listener;
            },
            loadingFailed: () => {},
            getResponseBody: async () => {
              bodyReads++;
              return never;
            },
            getCookies: async () => ({ cookies: [] }),
          },
          Page: {
            enable: async () => ({}),
            getFrameTree: async () => ({ frameTree: { frame: { id: 'main-frame' } } }),
            navigate: async ({ url }: { url: string }) => {
              navigationCount++;
              currentUrl = url;
              if (navigationCount === 2) {
                requestWillBeSent?.({
                  requestId: 'document-new',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  type: 'Document',
                  request: { method: 'GET', url },
                });
                responseReceived?.({
                  requestId: 'document-new',
                  type: 'Document',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  response: { url, status: 200, headers: {} },
                });
                requestWillBeSent?.({
                  requestId: 'background-stuck',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  type: 'XHR',
                  request: { method: 'POST', url: 'https://fixture.test/api/results' },
                });
                responseReceived?.({
                  requestId: 'background-stuck',
                  type: 'XHR',
                  loaderId: 'new-loader',
                  frameId: 'main-frame',
                  response: {
                    url: 'https://fixture.test/api/results',
                    status: 200,
                    headers: {},
                  },
                });
                loadingFinished?.({ requestId: 'background-stuck' });
              }
              return {
                loaderId: navigationCount === 2 ? 'new-loader' : 'old-loader',
                frameId: 'main-frame',
              };
            },
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

    const browser = createCdpBrowserFetch({
      baseUrl: 'https://fixture.test/',
      abckWaitSeconds: 0,
      cdpCommandTimeoutMs: 100,
    });
    try {
      const first = browser.navigate?.('https://fixture.test/results', {
        timeoutMs: 20,
        networkResponse: {
          urlIncludes: '/api/results',
          recordingResponseRequestSeq: 42,
          method: 'POST',
        },
      });
      await expect(browser.navigate?.('https://fixture.test/other')).rejects.toThrow(
        'another browser navigation is already active',
      );
      await expect(first).rejects.toThrow(/navigation deadline|browser navigation timed out/);
      expect(bodyReads).toBe(1);
      expect(clientClosed).toBe(1);
      expect(chromeClosed).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it('reports a factual timeout when mocked CDP observes no matching response', async () => {
    let currentUrl = 'about:blank';
    __setCdpBrowserFetchHooksForTest({
      launchChromium: async () =>
        ({
          process: {} as never,
          port: 12345,
          userDataDir: '/tmp/imprint-fake-chrome',
          ready: Promise.resolve(),
          close: async () => {},
        }) as Awaited<ReturnType<typeof import('../src/imprint/chromium.ts').launchChromium>>,
      connectCdp: async () =>
        ({
          Runtime: {
            enable: async () => ({}),
            evaluate: async ({ expression }: { expression: string }) => ({
              result: {
                value:
                  expression === 'navigator.userAgent'
                    ? 'Mozilla/5.0 Chrome/148.0.0.0'
                    : currentUrl,
              },
            }),
          },
          Network: {
            enable: async () => ({}),
            setUserAgentOverride: async () => ({}),
            requestWillBeSent: () => {},
            responseReceived: () => {},
            loadingFinished: () => {},
            loadingFailed: () => {},
            getResponseBody: async () => ({ body: '' }),
            getCookies: async () => ({ cookies: [] }),
          },
          Page: {
            enable: async () => ({}),
            getFrameTree: async () => ({ frameTree: { frame: { id: 'main-frame' } } }),
            navigate: async ({ url }: { url: string }) => {
              currentUrl = url;
              return {};
            },
            loadEventFired: async () => ({}),
          },
          Input: {
            dispatchMouseEvent: async () => ({}),
            dispatchKeyEvent: async () => ({}),
          },
          close: async () => {},
        }) as never,
    });

    const browser = createCdpBrowserFetch({
      baseUrl: 'https://fixture.test/',
      abckWaitSeconds: 0,
      cdpCommandTimeoutMs: 100,
    });
    try {
      await expect(
        browser.navigate?.('https://fixture.test/results', {
          timeoutMs: 10,
          networkResponse: {
            urlIncludes: '/api/results',
            recordingResponseRequestSeq: 42,
            method: 'POST',
          },
        }),
      ).rejects.toThrow(
        'browser navigation timed out after 10ms waiting for network response with URL containing "/api/results", method POST',
      );
    } finally {
      await browser.close();
    }
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
