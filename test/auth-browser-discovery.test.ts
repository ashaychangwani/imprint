import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
} from '../src/imprint/auth-compile-tools.ts';
import { AuthDiscoveryEvidence } from '../src/imprint/auth-discovery-evidence.ts';
import { createCdpBrowserFetch } from '../src/imprint/cdp-browser-fetch.ts';
import { writePrivateFile } from '../src/imprint/private-file.ts';
import { executeWorkflow } from '../src/imprint/runtime.ts';
import { SessionSchema, WorkflowSchema } from '../src/imprint/types.ts';

const browserIt = process.env.CI !== 'true' || process.env.RUN_BROWSER_TESTS === '1' ? it : it.skip;

describe('auth live browser discovery', () => {
  browserIt(
    'learns unrecorded SMS and email requests from UI actions, captures late traffic and redirects, and makes evidence readable and citeable',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'imprint-auth-discovery-'));
      const sent: Array<{ path: string; body: string }> = [];
      let ticketSequence = 0;
      const tickets = new Set<string>();
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/login')
            return new Response(
              `<!doctype html><html><body>
          <select id="factor"><option value="sms">SMS</option><option value="email">Email</option></select>
          <button id="send">Send current code</button>
          <button id="late">Observe delayed traffic</button>
          <form id="verify"><label>Code<input id="otp"></label><button>Verify</button></form><p id="status">Choose a factor</p>
          <script>
          let ticket;
          document.querySelector('#send').onclick = async () => {
            const factor = document.querySelector('#factor').value;
            ticket = await (await fetch('/fresh/' + factor + '/dispatch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ factor }) })).json();
            document.querySelector('#status').textContent = 'Code sent';
          };
          document.querySelector('#late').onclick = () => setTimeout(() => fetch('/late-evidence'), 500);
          document.querySelector('#verify').onsubmit = async e => {
            e.preventDefault();
            const response = await fetch('/fresh/' + ticket.factor + '/confirm', { method:'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify({ ticket: ticket.id, code: document.querySelector('#otp').value }) });
            document.querySelector('#status').textContent = (await response.json()).status;
          };
          </script></body></html>`,
              { headers: { 'content-type': 'text/html' } },
            );
          if (path.endsWith('/dispatch')) {
            const body = await request.text();
            sent.push({ path, body });
            const id = `fixture-ticket-${++ticketSequence}`;
            tickets.add(id);
            return Response.json({ id, factor: JSON.parse(body).factor });
          }
          if (path.endsWith('/confirm')) {
            const body = await request.text();
            sent.push({ path, body });
            const values = JSON.parse(body);
            const accepted = tickets.delete(values.ticket) && values.code === 'fixture-code-425671';
            return Response.json(
              {
                status: accepted ? 'accepted' : 'rejected',
                token: accepted ? 'fixture-durable-token' : '',
              },
              { status: accepted ? 200 : 401 },
            );
          }
          if (path === '/redirect') return Response.redirect(new URL('/login', request.url).href);
          return Response.json({ late: true });
        },
      });
      const url = `http://127.0.0.1:${server.port}/login`;
      const browser = createCdpBrowserFetch({
        baseUrl: url,
        bootstrapUrl: url,
        abckWaitSeconds: 0,
        // This fixture launches real Chromium. Use the normal startup/command
        // budget; the assertions exercise discovery, not sub-two-second launch.
      });
      const original = SessionSchema.parse({
        site: 'fixture-discovery',
        url,
        startedAt: new Date().toISOString(),
        imprintVersion: '0.7.0',
        requests: [
          { seq: 200, timestamp: 0, method: 'GET', url, headers: {}, resourceType: 'Document' },
        ],
        events: [],
        narration: [],
      });
      const evidence = new AuthDiscoveryEvidence(original, root);
      const interact = browser.interactBrowser?.bind(browser);
      if (!interact) throw new Error('Discovery transport missing');
      try {
        const initial = await interact({ action: 'inspect' });
        expect(
          initial.page.controls.find((control) => control.selector === '#factor'),
        ).toMatchObject({ tag: 'select' });
        evidence.append(initial);
        for (const factor of ['sms', 'email']) {
          await interact({ action: 'select', selector: '#factor', value: factor });
          const delivery = await interact({ action: 'click', selector: '#send' });
          evidence.append(delivery);
          expect(
            delivery.requests.some(
              (r) => r.url.endsWith(`/fresh/${factor}/dispatch`) && r.response?.status === 200,
            ),
          ).toBe(true);
          await interact({ action: 'fill', selector: '#otp', value: 'fixture-code-425671' });
          const completion = await interact({ action: 'press', key: 'Enter' });
          evidence.append(completion);
          expect(completion.page.bodyText).toContain('accepted');
          const confirmation = completion.requests.find((r) =>
            r.url.endsWith(`/fresh/${factor}/confirm`),
          );
          expect(confirmation?.response?.body).toContain('fixture-durable-token');
        }
        await interact({ action: 'click', selector: '#late' });
        await new Promise((resolve) => setTimeout(resolve, 650));
        const later = await interact({ action: 'wait', milliseconds: 0 });
        evidence.append(later);
        expect(later.requests.some((r) => r.url.endsWith('/late-evidence'))).toBe(true);
        const redirected = await interact({
          action: 'navigate',
          url: url.replace('/login', '/redirect'),
        });
        evidence.append(redirected);
        expect(redirected.requests.find((r) => r.url.endsWith('/redirect'))?.response?.status).toBe(
          302,
        );
        expect(redirected.page.url).toBe(url);
        expect(original.requests).toHaveLength(1);
        expect(statSync(evidence.sessionPath).mode & 0o777).toBe(0o600);
        const tools = buildAuthCompileTools(evidence.session, root, evidence.sessionPath, {
          site: original.site,
          values: {},
        });
        const seq = evidence.session.requests.find((r) =>
          r.url.endsWith('/fresh/email/confirm'),
        )?.seq;
        expect(seq).toBeGreaterThan(200);
        const read = await tools.find((t) => t.name === 'read_request')?.handler({ seq });
        expect(read?.result).toContain('/fresh/email/confirm');
        const captured = evidence.session.requests.find((r) => r.seq === seq);
        if (!captured) throw new Error('Missing live capture');
        const delivery = evidence.session.requests.find((r) =>
          r.url.endsWith('/fresh/email/dispatch'),
        );
        if (!delivery) throw new Error('Missing delivery evidence');
        const workflow = WorkflowSchema.parse({
          toolName: 'authenticate_fixture',
          toolKind: 'authenticate',
          site: original.site,
          intent: { description: 'Fixture auth' },
          parameters: [
            {
              name: 'action',
              type: 'string',
              description: 'Compiled action',
              default: 'begin',
              choices: ['begin', 'finish'],
            },
            { name: 'code', type: 'string', description: 'Current code', default: '' },
          ],
          requests: [
            {
              method: 'POST',
              url: delivery.url,
              headers: { 'content-type': 'application/json' },
              body: delivery.body,
              recordingRequestSeq: delivery.seq,
              captures: [{ name: 'ticket', source: 'json', path: 'id' }],
            },
            {
              method: 'POST',
              url: captured.url,
              headers: { 'content-type': 'application/json' },
              body: '{"ticket":"${state.ticket}","code":"${param.code}"}',
              bodyPlaceholderEncoding: 'json-string',
              recordingRequestSeq: seq,
              captures: [{ name: 'token', source: 'json', path: 'token' }],
            },
          ],
          authConfig: {
            entry: 'begin',
            actions: {
              begin: {
                parameters: [],
                steps: [{ request: 0, onError: 'fail' }],
                outcome: {
                  type: 'pause',
                  next: 'finish',
                  evidence: ['ticket'],
                  carry: ['ticket'],
                  message: 'Enter current code',
                },
              },
              finish: {
                parameters: ['code'],
                steps: [{ request: 1, onError: 'fail' }],
                outcome: { type: 'success', evidence: ['token'] },
              },
            },
            persist: ['token'],
          },
        });
        writePrivateFile(join(root, 'workflow.json'), JSON.stringify(workflow));
        expect(authWorkflowPreflightFailures(root, evidence.session)).toEqual([]);
        // Replay in a fresh HTTP client, with no browser state or recorded ticket.
        const credentials = { site: original.site, cookies: [], values: {} };
        const started = await executeWorkflow({
          workflow,
          params: { action: 'begin' },
          credentials,
          persistAuthState: false,
        });
        expect(started).toMatchObject({
          ok: false,
          error: 'ACTION_REQUIRED',
          nextAction: 'finish',
        });
        const continuation = started.ok ? undefined : started.continuation;
        expect(continuation?.ticket).toBe('fixture-ticket-3');
        const finished = await executeWorkflow({
          workflow,
          params: { action: 'finish', code: 'fixture-code-425671' },
          credentials,
          initialState: continuation,
          persistAuthState: false,
        });
        expect(finished.ok).toBe(true);
        expect(readFileSync(evidence.sessionPath, 'utf8')).toContain('/fresh/email/confirm');
        expect(sent.map((r) => r.path)).toEqual([
          '/fresh/sms/dispatch',
          '/fresh/sms/confirm',
          '/fresh/email/dispatch',
          '/fresh/email/confirm',
          '/fresh/email/dispatch',
          '/fresh/email/confirm',
        ]);
      } finally {
        await browser.close();
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
