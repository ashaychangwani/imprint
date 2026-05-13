import { describe, expect, it } from 'bun:test';
import { RuntimeCookieJar } from '../src/imprint/cookie-jar.ts';

describe('RuntimeCookieJar', () => {
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
