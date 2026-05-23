/**
 * Infer which cross-origin hostnames belong to the application's API surface.
 *
 * Many web apps serve their frontend and API from different registrable domains
 * (e.g. frontend on `app.example.com`, API on `api.backend.net`). The rest of
 * the pipeline filters by registrable domain, which would silently drop every
 * API request. This module scans the session once and returns the set of
 * cross-origin hostnames that carry authentication signals — meaning the
 * browser sent credentials to them, so they're part of the application.
 */

import { isSameRegistrableDomain } from './etld.ts';
import { isSensitiveHeader } from './sensitive-keys.ts';
import type { CapturedRequest, Session } from './types.ts';

const CREDENTIAL_PLACEHOLDER_RE = /\$\{credential\.[^}]+\}/;
const REDACTED_MARKER_RE = /\[REDACTED:v3:id=\d+:len=\d+\]/;

function hasAuthSignals(request: CapturedRequest): boolean {
  for (const [name, value] of Object.entries(request.headers)) {
    if (isSensitiveHeader(name) && value.length > 0) return true;
  }

  const text = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ''}`;
  if (CREDENTIAL_PLACEHOLDER_RE.test(text)) return true;
  if (REDACTED_MARKER_RE.test(text)) return true;

  return false;
}

export function inferAppApiHosts(session: Session, startRoot: string | null): Set<string> {
  const hosts = new Set<string>();
  if (!startRoot) return hosts;

  for (const request of session.requests) {
    if (request.resourceType !== 'XHR' && request.resourceType !== 'Fetch') continue;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }

    if (startRoot && isSameRegistrableDomain(url.hostname, startRoot)) continue;

    if (hasAuthSignals(request)) {
      hosts.add(url.hostname);
    }
  }

  return hosts;
}
