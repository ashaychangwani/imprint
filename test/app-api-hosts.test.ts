import { describe, expect, it } from 'bun:test';
import { inferAppApiHosts } from '../src/imprint/app-api-hosts.ts';
import type { Session } from '../src/imprint/types.ts';

const baseSession: Session = {
  site: 'demo',
  startedAt: '2026-05-22T00:00:00.000Z',
  url: 'https://www.example.com/app',
  imprintVersion: '0.1.0',
  requests: [],
  events: [],
  narration: [],
  cookieSnapshots: [],
  storageSnapshots: [],
};

function makeSession(requests: Session['requests']): Session {
  return { ...baseSession, requests };
}

describe('inferAppApiHosts', () => {
  it('promotes a cross-origin host when a request has a redacted authorization header', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.backend.net/data',
          headers: { authorization: '[REDACTED:v3:id=1:len=32]' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ]),
      'example.com',
    );
    expect(hosts.has('api.backend.net')).toBe(true);
  });

  it('promotes a cross-origin host when a request has a redacted cookie header', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.other.io/execute',
          headers: { cookie: 'session=[REDACTED:v3:id=2:len=16]' },
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ]),
      'example.com',
    );
    expect(hosts.has('api.other.io')).toBe(true);
  });

  it('promotes a cross-origin host when a request has credential placeholders', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://sso.idp.com/login',
          headers: { 'content-type': 'application/json' },
          body: '{"user":"${credential.username}","pass":"${credential.password}"}',
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"token":"abc"}' },
        },
      ]),
      'example.com',
    );
    expect(hosts.has('sso.idp.com')).toBe(true);
  });

  it('promotes a cross-origin host when request body has redacted values', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.backend.net/foundation/api/execute',
          headers: { 'content-type': 'text/plain' },
          body: '{"authcode":"[REDACTED:v3:id=1:len=36]","name":"LOGIN","userid":"[REDACTED:v3:id=4:len=31]"}',
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ]),
      'example.com',
    );
    expect(hosts.has('api.backend.net')).toBe(true);
  });

  it('does not promote a cross-origin host with no auth signals', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://analytics.tracker.io/collect',
          headers: { 'content-type': 'text/plain' },
          resourceType: 'XHR',
        },
      ]),
      'example.com',
    );
    expect(hosts.size).toBe(0);
  });

  it('does not include same-origin hosts in the set', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.com/login',
          headers: { authorization: 'Bearer abc123' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ]),
      'example.com',
    );
    expect(hosts.size).toBe(0);
  });

  it('promotes multiple cross-origin API hosts independently', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.backend-a.com/rpc',
          headers: { cookie: 'sid=[REDACTED:v3:id=1:len=16]' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{}' },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://api.backend-b.com/rpc',
          headers: { 'x-api-key': '[REDACTED:v3:id=2:len=24]' },
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{}' },
        },
        {
          seq: 3,
          timestamp: 300,
          method: 'GET',
          url: 'https://cdn.images.net/logo.json',
          headers: {},
          resourceType: 'XHR',
        },
      ]),
      'example.com',
    );
    expect(hosts.has('api.backend-a.com')).toBe(true);
    expect(hosts.has('api.backend-b.com')).toBe(true);
    expect(hosts.has('cdn.images.net')).toBe(false);
  });

  it('ignores non-XHR/Fetch resource types', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://cdn.other.net/bundle.js',
          headers: { cookie: 'tracking=abc' },
          resourceType: 'Script',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://cdn.other.net/style.css',
          headers: { cookie: 'tracking=abc' },
          resourceType: 'Stylesheet',
        },
      ]),
      'example.com',
    );
    expect(hosts.size).toBe(0);
  });

  it('returns empty set when startRoot is null', () => {
    const hosts = inferAppApiHosts(
      makeSession([
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.backend.net/data',
          headers: { authorization: 'Bearer token' },
          resourceType: 'XHR',
          response: { status: 200, headers: {}, body: '{}' },
        },
      ]),
      null,
    );
    expect(hosts.size).toBe(0);
  });
});
