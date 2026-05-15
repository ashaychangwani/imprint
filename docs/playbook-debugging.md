# Debugging a playbook that doesn't work

When `imprint playbook <site>` fails or returns wrong data, walk this checklist before assuming the site is unreplayable. Every item here came out of the Southwest bring-up where each "I can't see what's happening" turned out to be solvable.

## 1. Screenshot at failure (always)

Every failed run drops a screenshot to `/tmp/imprint-playbook-<tool>-step<N>-<ts>.png`. The path is in the error message. Open it first — it usually tells you exactly what state the page is in (overlay covering the next button, validation error, blank page mid-navigation, calendar that didn't dismiss, etc).

Read the file directly:
```
Read tool with the absolute path
```
Don't try to render the PNG in stdout — the Read tool handles images natively.

## 2. Per-step trace

Add `--trace` to see what every step did:
```bash
imprint playbook <site> --trace --param k=v
```
After each step the runner logs the URL + a screenshot path. You can spot the exact step where state diverges from expected.

## 3. URL is the cheapest oracle

After every step the trace prints `url=...`. If the URL doesn't change after a click that's supposed to navigate, the click missed (probably matched a label not a button). If the URL has `validate=true` or `?error=...` query params, the form failed validation.

## 4. Inspect captured XHRs

If the result extraction fails or returns empty, the issue is usually in the result XHR. Drop into a one-off Bun script:
```ts
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
let body, status;
page.on('response', async r => {
  if (r.url().includes('YOUR_RESULT_URL_PATTERN')) {
    status = r.status();
    try { body = await r.text(); } catch {}
  }
});
await page.goto('YOUR_URL', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
console.log('status', status, 'body', body?.slice(0, 500));
await browser.close();
```
Status 403 with `{"code": 403050700}` = Akamai bot block (use stealth — already default in our runner). Status 200 with no `data` field = different shape than expected.

## 5. Compare playbook to recorded events

The compiler is good but not infallible. Verify what the user actually did vs what the playbook compiled to. (This reads YOUR original `session.json` from when you recorded the workflow — stored at `~/.imprint/<site>/sessions/<ts>.json`. If you're debugging a playbook someone else taught, you won't have this file.)
```bash
python3 -c "
import json
import os
s = json.load(open(os.path.expanduser('~/.imprint/<site>/sessions/<ts>.json')))
for e in s['events']:
  if e['type'] in ('click', 'input', 'change', 'submit'):
    d = json.loads(e['detail'])
    print(f'{e[\"timestamp\"]/1000:6.1f}s {e[\"type\"]} tag={d[\"tag\"]} id={d.get(\"id\")} text={d.get(\"text\",\"\")[:40]!r} val={d.get(\"value\")!r}')
"
```
**Critical signal:** if there are zero `input` events on a field but the playbook has a `type` step, the field is non-typeable (custom date picker, masked input, click-only widget). Replace the type step with click-input-then-click-the-popup.

## 6. URL params often subsume the entire form

Many SPAs accept the full search/filter state as query params and auto-fire the result XHR. Look at the captured Referer header on the result-XHR — it often reveals the URL pattern that pre-fills the form. For Southwest: `/air/booking/select-depart.html?originationAirportCode=SJC&destinationAirportCode=SAN&departureDate=2026-06-20&tripType=oneway` skips 11 of 12 form-fill steps.

## 7. React state vs visible value

If `locator.fill()` puts the value in the input visually but submit acts like the field is empty, React's controlled-input dance isn't being triggered. Try `clear: false` (uses `pressSequentially` which fires per-char input events). If that still fails, the field is click-only — go via the picker UI.

## 8. Bot detection symptoms (and the cure)

| Symptom | Diagnosis |
|---|---|
| Result XHR returns 403 with `{"code": <number>}` | Akamai Bot Manager |
| Result XHR returns 403 with `<html>...captcha...</html>` | DataDome / PerimeterX |
| Page loads forever, network never idles | Cloudflare interstitial |
| 200 OK but body is `<html>captcha</html>` | Cloudflare Turnstile |

The runner already uses `playwright-extra` + `puppeteer-extra-plugin-stealth` by default — that defeats Akamai on Southwest, verified end-to-end. If stealth doesn't beat the site, options in order of effort:
1. Add explicit `Accept-Language`, `Sec-CH-UA-*` headers via `context = await browser.newContext({ userAgent: '...', extraHTTPHeaders: {...} })`
2. Pin a specific Chromium version that matches a real user's fingerprint
3. Use `rebrowser-patches` (patches the Chromium binary itself; ~70% success against Akamai per public reports)
4. Pivot to `--headed` on a real desktop with real mouse movement
5. Pay for a stealth API (Bright Data Web Unlocker, ScrapingBee)

Don't conclude any of these without trying the previous one first.

## 9. Eager body capture is a runner gotcha

Playwright's `resp.text()` returns a Promise. If you read it lazily at extract time, Playwright/CDP has often GC'd the body and you get "no resource with given identifier found". The runner reads bodies inside the `response` handler and tracks pending promises that get drained before extraction. If you're writing a one-off debug script, do the same.

## 10. `domcontentloaded` not `load`

For SPAs with persistent connections (analytics, A/B test loaders, websockets), `await page.goto(url)` with the default `load` waitUntil hangs. Use `{ waitUntil: 'domcontentloaded' }` and let the explicit `wait_for: xhr:<pattern>` step handle the semantic readiness condition.

## When to actually conclude "needs more"

After all of the above:
- Screenshot shows the page is rendering correctly but the next click target genuinely isn't there → the playbook needs a hand-edit (likely an extra `wait` step or a different locator)
- Stealth + URL params + everything else still gets bot-blocked → the site truly requires paid stealth or a real-residential-IP pipeline
- The recorded session is missing critical events (e.g., user clicked things the recorder didn't capture) → re-record more carefully

Anything short of this and "I can't do this remotely" is the wrong answer.
