import { describe, expect, it } from 'bun:test';
import { RuntimeCookieJar } from '../src/imprint/cookie-jar.ts';

describe('RuntimeCookieJar', () => {
  it('preserves same-name host-only and domain scopes through replacement and deletion', () => {
    const jar = new RuntimeCookieJar([
      { name: 'sid', value: 'fixture-host', domain: 'fixture.test', path: '/', hostOnly: true },
      { name: 'sid', value: 'fixture-domain', domain: '.fixture.test', path: '/', hostOnly: false },
    ]);
    expect(jar.toJSON()).toHaveLength(2);
    expect(jar.clone().getCookieHeader('https://fixture.test/')).toBe(
      'sid=fixture-host; sid=fixture-domain',
    );
    expect(jar.getCookieHeader('https://child.fixture.test/')).toBe('sid=fixture-domain');
    expect(jar.lookup('sid', 'https://fixture.test/')).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
    jar.replace(jar.toJSON());
    expect(jar.toJSON()).toHaveLength(2);
    jar.setCookieFromHeader(
      'sid=; Domain=fixture.test; Max-Age=0; Path=/',
      'https://fixture.test/',
    );
    expect(jar.getCookieHeader('https://fixture.test/')).toBe('sid=fixture-host');
    expect(jar.getCookieHeader('https://child.fixture.test/')).toBeNull();
  });

  it('reconciles each host/domain scope against its own browser and HTTP baseline', () => {
    const browser = new RuntimeCookieJar([
      { name: 'sid', value: 'fixture-host-old', domain: 'fixture.test', path: '/', hostOnly: true },
      {
        name: 'sid',
        value: 'fixture-domain-old',
        domain: '.fixture.test',
        path: '/',
        hostOnly: false,
      },
    ]);
    const jar = browser.clone();
    jar.setCookieFromHeader('sid=fixture-host-http; Path=/', 'https://fixture.test/', browser);
    const next = [
      {
        name: 'sid',
        value: 'fixture-domain-new',
        domain: '.fixture.test',
        path: '/',
        hostOnly: false,
      },
    ];
    jar.reconcileBrowserSnapshot(next, browser);
    expect(jar.getCookieHeader('https://fixture.test/')).toBe(
      'sid=fixture-host-http; sid=fixture-domain-new',
    );
    expect(jar.getCookieHeader('https://child.fixture.test/')).toBe('sid=fixture-domain-new');
    jar.restoreBrowserSnapshot(next);
    expect(jar.toJSON()).toHaveLength(1);
    jar.setCookieFromHeader('sid=; Max-Age=0; Path=/', 'https://fixture.test/');
    expect(jar.getCookieHeader('https://fixture.test/')).toBe('sid=fixture-domain-new');
  });
  it('round-trips independent HTTP updates and deletions against their browser baseline', () => {
    const originalCookie = {
      name: 'sid',
      value: 'browser-old',
      domain: 'fixture.test',
      path: '/',
      secure: true,
      httpOnly: true,
    };
    const original = [originalCookie];
    const browser = new RuntimeCookieJar(original);
    const http = browser.clone();
    http.setCookieFromHeader(
      'sid=; Max-Age=0; Path=/; Secure; HttpOnly',
      'https://fixture.test/',
      browser,
    );
    const restored = new RuntimeCookieJar(JSON.parse(JSON.stringify(http.toJSON())));
    restored.restoreBrowserSnapshot(original);
    expect(restored.getCookieHeader('https://fixture.test/')).toBeNull();
    expect(restored.toJSON()[0]?.httpResponse?.deleted).toBe(true);
    restored.restoreBrowserSnapshot([{ ...originalCookie, value: 'browser-new' }]);
    expect(restored.getCookieHeader('https://fixture.test/')).toBe('sid=browser-new');
    expect(restored.toJSON()[0]?.httpResponse).toBeUndefined();
  });
  it('reconciles browser removals without discarding independent HTTP changes', () => {
    const browser = new RuntimeCookieJar([
      { name: 'sid', value: 'browser-old', domain: 'fixture.test', path: '/' },
    ]);
    const jar = browser.clone();
    jar.setCookieFromHeader('sid=http-new; Path=/', 'https://fixture.test/');
    jar.setCookieFromHeader('other=http-only; Path=/', 'https://api.fixture.test/');
    jar.reconcileBrowserSnapshot(browser.toJSON(), browser);
    expect(jar.getCookieHeader('https://fixture.test/')).toBe('sid=http-new');
    jar.reconcileBrowserSnapshot([], browser);
    expect(jar.getCookieHeader('https://fixture.test/')).toBe('sid=http-new');
    expect(jar.getCookieHeader('https://api.fixture.test/')).toBe('other=http-only');
    jar.reconcileBrowserSnapshot(
      [{ name: 'sid', value: 'browser-new', domain: 'fixture.test', path: '/' }],
      browser,
    );
    expect(jar.getCookieHeader('https://fixture.test/')).toBe('sid=browser-new');
    jar.reconcileBrowserSnapshot([], browser);
    expect(jar.getCookieHeader('https://fixture.test/')).toBeNull();
  });
  it('replaces a full snapshot without reviving deleted scopes', () => {
    const jar = new RuntimeCookieJar([
      { name: 'removed', value: 'fixture-old', domain: 'login.fixture.test', path: '/' },
      { name: 'session', value: 'fixture-old', domain: 'travel.fixture.test', path: '/' },
    ]);
    jar.replace([
      { name: 'session', value: 'fixture-rotated', domain: 'travel.fixture.test', path: '/' },
    ]);
    expect(jar.getCookieHeader('https://login.fixture.test/')).toBeNull();
    expect(jar.getCookieHeader('https://travel.fixture.test/')).toBe('session=fixture-rotated');
    jar.replace([]);
    expect(jar.toJSON()).toEqual([]);
  });
  it('orders Cookie headers by longest path first', () => {
    const jar = new RuntimeCookieJar([
      { name: 'sid', value: 'root', domain: 'example.com', path: '/', hostOnly: true },
      { name: 'theme', value: 'dark', domain: 'example.com', path: '/app', hostOnly: true },
    ]);

    expect(jar.getCookieHeader('https://example.com/app/search')).toBe('theme=dark; sid=root');
  });

  it('deletes cookies with Max-Age=0 and preserves host-only matching', () => {
    const jar = new RuntimeCookieJar();
    jar.setCookieFromHeader('sid=abc; Path=/', 'https://example.com/app/start');
    expect(jar.getCookieHeader('https://example.com/app/next')).toBe('sid=abc');

    jar.setCookieFromHeader('sid=gone; Max-Age=0; Path=/', 'https://example.com/app/start');
    expect(jar.getCookieHeader('https://example.com/app/next')).toBeNull();
    expect(jar.getCookieHeader('https://sub.example.com/app/next')).toBeNull();
  });

  it('preserves browser session cookies with expires=-1 but drops real expired cookies', () => {
    const jar = new RuntimeCookieJar([
      {
        name: 'session',
        value: 'kept',
        domain: 'example.com',
        path: '/',
        hostOnly: true,
        expires: -1,
      },
      {
        name: 'expired',
        value: 'dropped',
        domain: 'example.com',
        path: '/',
        hostOnly: true,
        expires: 1,
      },
    ]);

    expect(jar.getCookieHeader('https://example.com/account')).toBe('session=kept');
  });

  it('fails scalar lookup when more than one matching cookie name applies', () => {
    const jar = new RuntimeCookieJar([
      { name: 'sid', value: 'root', domain: 'example.com', path: '/', hostOnly: true },
      { name: 'sid', value: 'app', domain: 'example.com', path: '/app', hostOnly: true },
    ]);

    const result = jar.lookup('sid', 'https://example.com/app/search');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
  });

  it('guards HttpOnly scalar projection unless explicitly allowed', () => {
    const jar = new RuntimeCookieJar([
      {
        name: 'sid',
        value: 'secret',
        domain: 'example.com',
        path: '/',
        hostOnly: true,
        httpOnly: true,
      },
    ]);

    expect(jar.lookup('sid', 'https://example.com/')).toMatchObject({
      ok: false,
      reason: 'httponly',
    });
    expect(
      jar.lookup('sid', 'https://example.com/', { allowHttpOnlyProjection: true }),
    ).toMatchObject({ ok: true, cookie: { value: 'secret' } });
  });
});
