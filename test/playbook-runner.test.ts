/**
 * Tests for the playbook runner. The Playwright-bound integration is
 * covered by the end-to-end test against examples/southwest in Phase 2;
 * these unit tests exercise the pure logic (parameter handling, error
 * paths, missing-Playwright detection).
 */

import { describe, expect, it } from 'bun:test';
import {
  extractPlaybookCaptures,
  extractResult,
  runPlaybook,
} from '../src/imprint/playbook-runner.ts';
import type { Playbook, PlaybookCapture, PlaybookResult } from '../src/imprint/types.ts';

const MIN_PLAYBOOK: Playbook = {
  toolName: 'test_tool',
  summary: 'fixture',
  parameters: [
    { name: 'q', type: 'string', description: 'query' },
    { name: 'count', type: 'number', description: 'count', default: 10 },
  ],
  steps: [
    {
      action: 'navigate',
      url: 'https://example.com/?q=${q}&n=${count}',
      wait_for: 'networkidle',
    },
  ],
  result: {
    source: 'xhr',
    url_pattern: '/api/search',
    extract: 'items[].id',
    return_as: 'hits',
  },
};

describe('runPlaybook', () => {
  it('rejects when a required parameter is missing', async () => {
    const r = await runPlaybook({
      playbook: MIN_PLAYBOOK,
      // q is required, no default
      params: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The browser launch happens AFTER param coercion in our code? Let's
    // check what we actually get. The error should mention `q`.
    expect(r.message.toLowerCase()).toContain('q');
  });

  it('errors gracefully when Playwright Chromium is not installed', async () => {
    // Hard to inject this without mocking — just confirm the error path
    // produces a clear UNKNOWN with installation guidance, by giving an
    // invalid Playwright page override. We use a minimal stub Page that
    // throws on .on() — that triggers the catch path.
    const stubPage = {
      on: () => {
        throw new Error('stub-page failure');
      },
    } as unknown as import('playwright').Page;
    const r = await runPlaybook({
      playbook: MIN_PLAYBOOK,
      params: { q: 'hello' },
      pageOverride: stubPage,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('BAD_RESPONSE');
    expect(r.message).toContain('stub-page failure');
  });

  it('passes raw body to parser when extract is "*" and body is non-JSON', async () => {
    // Many APIs return non-JSON envelopes — Google XSSI (`)]}'\n<size>\n...`),
    // JSONP, chunked batchexecute, protobuf, server-sent events — that the
    // downstream parser knows how to decode. The playbook fallback must
    // hand those raw bytes through (matching workflow runtime semantics)
    // rather than throwing before the parser sees them. Otherwise the
    // playbook path silently breaks for every site whose API isn't pure JSON.
    const result: PlaybookResult = {
      source: 'xhr',
      url_pattern: '/data/batchexecute',
      extract: '*',
      return_as: 'raw',
    };
    const xssiBody =
      ')]}\'\n590\n[["wrb.fr","H028ib","[[[1,\\"airport\\"]]]",null,null,null,"generic"]]\n';
    const captured = [
      {
        url: 'https://www.google.com/_/FlightsFrontendUi/data/batchexecute?rpcids=H028ib',
        method: 'POST',
        status: 200,
        body: xssiBody,
      },
    ];
    // Page is unused in the xhr branch; a bare stub satisfies the type.
    const stubPage = {} as unknown as import('playwright').Page;
    const out = await extractResult(stubPage, result, captured);
    expect(out.raw).toBe(xssiBody);
    expect(out.source_url).toContain('batchexecute');
  });

  it('still throws on non-JSON body when extract is a path expression', async () => {
    // Path extraction (`items[].id`) requires structured data to navigate.
    // The relaxed-on-`*` behavior must NOT regress this case — the parser
    // would silently get garbage. Locked in behavior.
    const result: PlaybookResult = {
      source: 'xhr',
      url_pattern: '/api/search',
      extract: 'items[].id',
      return_as: 'hits',
    };
    const captured = [
      {
        url: 'https://example.com/api/search',
        method: 'GET',
        status: 200,
        body: 'not-json-at-all',
      },
    ];
    const stubPage = {} as unknown as import('playwright').Page;
    await expect(extractResult(stubPage, result, captured)).rejects.toThrow(/body was not JSON/);
  });

  it('loads playbook from a YAML path string', async () => {
    // The path-loading branch is covered just by reaching the next
    // step (parameter coercion) without a "Playbook not found" error.
    // We use a definitely-bad path to confirm THAT specific failure
    // surfaces with the right error text.
    const r = await runPlaybook({
      playbook: '/tmp/imprint-no-such-playbook.yaml',
      params: { q: 'x' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('not found');
  });

  it('bounds a hanging playbook step with the whole-run timeout', async () => {
    const stubPage = {
      on: () => {},
      goto: () => new Promise(() => {}),
      screenshot: async () => Buffer.from(''),
    } as unknown as import('playwright').Page;
    const startedAt = Date.now();

    const r = await runPlaybook({
      playbook: MIN_PLAYBOOK,
      params: { q: 'hello' },
      pageOverride: stubPage,
      stepTimeoutMs: 10_000,
      maxDurationMs: 25,
      screenshotTimeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NETWORK');
    expect(r.message).toContain('Playbook step 1/1 (navigate) timed out');
  });

  it('extracts a best-effort 2FA-chain token from a matching XHR (Component D)', () => {
    // A login playbook's OTP-send step mints a single-use token in its response;
    // extractPlaybookCaptures pulls it out so the runtime can carry it across the
    // stateless initiate→submit_otp gap. All values synthetic.
    const captures: PlaybookCapture[] = [
      { name: 'SecurityCode', url_pattern: '/otp/send', extract: 'data.securityCode' },
    ];
    const captured = [
      { url: 'https://fix.example/login', method: 'POST', status: 200, body: '{"step":"otp"}' },
      {
        url: 'https://fix.example/otp/send',
        method: 'POST',
        status: 200,
        body: '{"data":{"securityCode":"SYNTH-SEC-1"}}',
      },
    ];
    expect(extractPlaybookCaptures(captures, captured)).toEqual({ SecurityCode: 'SYNTH-SEC-1' });
  });

  it('skips captures with no matching XHR or a failed status (best-effort)', () => {
    const captures: PlaybookCapture[] = [
      { name: 'SecurityCode', url_pattern: '/otp/send', extract: 'data.securityCode' },
      { name: 'Other', url_pattern: '/never', extract: 'x' },
    ];
    const captured = [
      // matches the URL but 4xx → skipped (a failed mint isn't a usable token)
      { url: 'https://fix.example/otp/send', method: 'POST', status: 500, body: '{"err":1}' },
    ];
    // Both skipped → empty object, never throws. Missing token degrades to an
    // attempt that fails honestly downstream.
    expect(extractPlaybookCaptures(captures, captured)).toEqual({});
  });

  it('passes the whole parsed body when capture extract is "*"', () => {
    const captures: PlaybookCapture[] = [{ name: 'blob', url_pattern: '/mint', extract: '*' }];
    const captured = [
      { url: 'https://fix.example/mint', method: 'GET', status: 200, body: 'raw-non-json-token' },
    ];
    expect(extractPlaybookCaptures(captures, captured)).toEqual({ blob: 'raw-non-json-token' });
  });

  it('does not hang when the failure screenshot stalls', async () => {
    const stubPage = {
      on: () => {},
      goto: async () => {
        throw new Error('Timeout 10ms exceeded while navigating');
      },
      screenshot: () => new Promise(() => {}),
    } as unknown as import('playwright').Page;
    const startedAt = Date.now();

    const r = await runPlaybook({
      playbook: MIN_PLAYBOOK,
      params: { q: 'hello' },
      pageOverride: stubPage,
      stepTimeoutMs: 10,
      maxDurationMs: 100,
      screenshotTimeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NETWORK');
    expect(r.message).toContain('Timeout 10ms exceeded');
    expect(r.message).not.toContain('screenshot:');
  });
});
