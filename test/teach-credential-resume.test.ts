/**
 * Credential recovery for the auth-compile step of `imprint teach`.
 *
 * `detectRecordedUsername` pulls the typed identifier out of the recording's DOM
 * submit events so the interactive credential prompt can pre-fill it. The capture
 * listener masks password fields (`[redacted]`) but leaves the username visible —
 * this is the one credential value a hosted-login (Auth0/Okta) recording reliably
 * carries, which is exactly why the password must be prompted for separately.
 *
 * All fixtures are synthetic — never check real credentials into this repo.
 * See CLAUDE.md "Test data hygiene".
 */

import { describe, expect, it } from 'bun:test';
import { detectRecordedUsername } from '../src/imprint/teach.ts';
import type { Session } from '../src/imprint/types.ts';

function emptySession(): Session {
  return {
    site: 'test',
    startedAt: new Date().toISOString(),
    url: 'https://example.com',
    imprintVersion: '0.1.0',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

/** A DOM submit event as inject-listener records it (password value masked). */
function submitEvent(fields: Array<{ name: string; type: string; value: string }>) {
  return { type: 'submit' as const, seq: 1, timestamp: 0, detail: JSON.stringify({ fields }) };
}

describe('detectRecordedUsername', () => {
  it('recovers the username from a masked-password login submit (Auth0 shape)', () => {
    const session: Session = {
      ...emptySession(),
      // Mirrors the real Auth0 universal-login capture: identifier step, then a
      // password step whose password value is masked to "[redacted]".
      events: [
        submitEvent([
          { name: 'username', type: 'email', value: 'fixture-user@example.com' },
          { name: 'action', type: 'submit', value: 'default' },
        ]),
        submitEvent([
          { name: 'username', type: 'text', value: 'fixture-user@example.com' },
          { name: 'password', type: 'password', value: '[redacted]' },
        ]),
      ],
    };
    expect(detectRecordedUsername(session)).toBe('fixture-user@example.com');
  });

  it('ignores password fields and redaction markers', () => {
    const session: Session = {
      ...emptySession(),
      events: [
        submitEvent([
          { name: 'email', type: 'text', value: '[redacted]' },
          { name: 'password', type: 'password', value: 'fixture-user@example.com' },
        ]),
      ],
    };
    // The only username-like non-password value is "[redacted]" → rejected.
    expect(detectRecordedUsername(session)).toBeUndefined();
  });

  it('returns undefined when there are no submit events', () => {
    expect(detectRecordedUsername(emptySession())).toBeUndefined();
  });
});
