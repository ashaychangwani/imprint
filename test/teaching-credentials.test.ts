import { describe, expect, it } from 'bun:test';
import { prepareRedactedTeachingSession } from '../src/imprint/master-teach-controller.ts';
import { substituteString } from '../src/imprint/runtime.ts';
import type { Session } from '../src/imprint/types.ts';

const username = '${credential.username}';
const password = '${credential.password}';

function session(bodies: string[]): Session {
  return {
    site: 'fixture-teaching-credentials',
    startedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://fixture.test/login',
    imprintVersion: '0.0.0-test',
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
    requests: bodies.map((body, index) => ({
      seq: index + 1,
      timestamp: index,
      method: 'POST',
      url: 'https://fixture.test/login',
      headers: {},
      body,
      resourceType: 'XHR',
    })),
  };
}

describe('teaching credential references', () => {
  for (const [format, body] of [
    ['JSON', JSON.stringify({ username, password })],
    ['form', `username=${username}&password=${password}`],
    ['encoded form', new URLSearchParams({ username, password }).toString()],
    [
      'renamed',
      JSON.stringify({
        username: '${credential.login_id}',
        password: '${credential.login_secret}',
      }),
    ],
  ] as const) {
    it(`preserves existing ${format} references without extracting them as secret values`, () => {
      const recorded = session([body]);
      const result = prepareRedactedTeachingSession(recorded);
      expect(result.credentialValues).toEqual({});
      expect(result.credentialReplacements).toEqual([]);
      expect(result.session.requests[0]?.body).toBe(body);
    });
  }

  for (const values of [
    { username, password: 'fixture-new-password' },
    { username: 'fixture-new-user', password },
  ]) {
    it(`extracts only the literal field when ${values.username === username ? 'username' : 'password'} is already a reference`, () => {
      const result = prepareRedactedTeachingSession(session([JSON.stringify(values)]));
      expect(result.credentialValues).toEqual(
        values.username === username
          ? { password: values.password }
          : { username: values.username },
      );
      expect(JSON.parse(result.session.requests[0]?.body ?? '')).toEqual({ username, password });
    });
  }

  it('does not overwrite earlier literal inputs with later credential references', () => {
    const values = { username: 'fixture-user', password: 'fixture-pass-9472' };
    const result = prepareRedactedTeachingSession(
      session([JSON.stringify(values), JSON.stringify({ username, password })]),
    );
    expect(result.credentialValues).toEqual(values);
    for (const request of result.session.requests) {
      expect(JSON.parse(request.body ?? '')).toEqual({ username, password });
    }
  });

  it('reports a missing referenced credential instead of rendering the reference as a value', () => {
    const result = prepareRedactedTeachingSession(
      session([JSON.stringify({ username, password })]),
    );
    expect(() =>
      substituteString(
        password,
        {},
        { site: 'fixture', cookies: [], values: result.credentialValues },
        [],
      ),
    ).toThrow(/password/);
  });
});
