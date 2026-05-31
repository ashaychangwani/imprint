import { describe, expect, it } from 'bun:test';
import { resolve as pathResolve } from 'node:path';
import {
  defaultSessionJsonlPath,
  imprintHomeDir,
  localSessionsDir,
  localSharedDir,
  localSharedModulePath,
  localSiteDir,
  localToolDir,
  relativeToLocalSite,
  resolveLocalSitePath,
} from '../src/imprint/paths.ts';

describe('local imprint paths', () => {
  const originalImprintHome = process.env.IMPRINT_HOME;

  function withImprintHome<T>(path: string, fn: () => T): T {
    process.env.IMPRINT_HOME = path;
    try {
      return fn();
    } finally {
      if (originalImprintHome === undefined) Reflect.deleteProperty(process.env, 'IMPRINT_HOME');
      else process.env.IMPRINT_HOME = originalImprintHome;
    }
  }

  it('stores default recordings under the local imprint home', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(imprintHomeDir()).toBe(pathResolve('/tmp', 'imprint-home'));
      expect(localSiteDir('southwest')).toBe(pathResolve('/tmp', 'imprint-home', 'southwest'));
      expect(localToolDir('southwest', 'search_flights')).toBe(
        pathResolve('/tmp', 'imprint-home', 'southwest', 'search_flights'),
      );
      expect(localSessionsDir('southwest')).toBe(
        pathResolve('/tmp', 'imprint-home', 'southwest', 'sessions'),
      );
      expect(defaultSessionJsonlPath('southwest', '2026-05-08T09-24-14-916Z')).toBe(
        pathResolve(
          '/tmp',
          'imprint-home',
          'southwest',
          'sessions',
          '2026-05-08T09-24-14-916Z.jsonl',
        ),
      );
    });
  });

  it('resolves relative paths inside the local site directory', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(resolveLocalSitePath('demo', 'sessions/one.json')).toBe(
        pathResolve('/tmp', 'imprint-home', 'demo', 'sessions', 'one.json'),
      );
    });
  });

  it('can store local paths relative to the site directory', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      const sessionPath = pathResolve('/tmp', 'imprint-home', 'demo', 'sessions', 'one.json');
      expect(relativeToLocalSite('demo', sessionPath)).toBe('sessions/one.json');
      expect(relativeToLocalSite('demo', pathResolve('/tmp', 'other', 'one.json'))).toBeNull();
    });
  });

  it('rejects path traversal in site names', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(() => localSiteDir('../../etc')).toThrow(/Invalid site name/);
      expect(() => localSiteDir('foo/bar')).toThrow(/Invalid site name/);
      expect(() => localSiteDir('foo\\bar')).toThrow(/Invalid site name/);
      expect(() => localSiteDir('..')).toThrow(/Invalid site name/);
    });
  });

  it('rejects path traversal in tool names', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(() => localToolDir('southwest', '../escape')).toThrow(/Invalid tool name/);
      expect(() => localToolDir('southwest', 'a/b')).toThrow(/Invalid tool name/);
    });
  });

  it('resolves the site-level shared module directory', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(localSharedDir('demo')).toBe(pathResolve('/tmp', 'imprint-home', 'demo', '_shared'));
      expect(localSharedModulePath('demo', '_shared/sign.ts')).toBe(
        pathResolve('/tmp', 'imprint-home', 'demo', '_shared', 'sign.ts'),
      );
      // Accepts a bare filename too.
      expect(localSharedModulePath('demo', 'sign.ts')).toBe(
        pathResolve('/tmp', 'imprint-home', 'demo', '_shared', 'sign.ts'),
      );
    });
  });

  it('rejects path traversal in shared module paths', () => {
    withImprintHome(pathResolve('/tmp', 'imprint-home'), () => {
      expect(() => localSharedModulePath('demo', '../escape.ts')).toThrow(/Invalid shared module/);
      expect(() => localSharedModulePath('demo', '/etc/passwd')).toThrow(/Invalid shared module/);
      expect(() => localSharedModulePath('demo', 'nested/dir.ts')).toThrow(/Invalid shared module/);
    });
  });
});
