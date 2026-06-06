# Capture Protocol — One-Shot Recording

For high-stakes recordings (a real booking flow you can't easily redo), follow this protocol exactly. ~5 minutes from start to verified capture.

## Before you start

1. **Quit any other Chromium / Chrome instance you don't need.** The recorder launches its own. Avoiding extra Chromiums prevents CDP port conflicts.
2. **Have your library card / login credentials ready.** You'll log in inside the recorder's Chromium window.
3. **Decide your booking target in advance.** Pick the specific attraction + date BEFORE you hit record so you don't hesitate mid-flow (long pauses make narration less useful).
4. **Open this protocol in another window** so you can glance at the narration prompts.

## Run the capture

```bash
cd /path/to/imprint
imprint record discoverandgo --url https://www.discoverandgo.net --persist-profile
```

What `--persist-profile` does: stores the Chrome profile at `~/Library/Application Support/imprint/profiles/discoverandgo`, so the second time you run this command (later, when iterating), you'll already be logged in. **First run only:** you log in fresh inside the Chromium window.

## What the terminal will show

```
[imprint] recording → $HOME/.imprint/discoverandgo/sessions/2026-04-30T01-23-45-678Z.jsonl
[imprint] using persistent profile at /Users/.../profiles/discoverandgo
[imprint] launching chromium...
[imprint] chromium up on CDP port 54321

[imprint] recording. drive the browser, narrate as you go.
[imprint]   blank line   = skip without recording narration
[imprint]   /done        = stop recording cleanly
[imprint]   Ctrl+C       = same as /done

[0:00 • 0 captured] narrate (or /done):
```

The `[mm:ss • N captured]` updates each time you press enter. N is the running count of captured records (network requests + DOM events + narration).

## During the recording — what to do

A Chromium window opens with the D&G homepage. Drive it normally:

1. **Log in** with your library card.
   - Switch back to the terminal and narrate: `narrate> logging in to discoverandgo with my library card`
2. **Navigate to your chosen attraction.** Take the path you'd actually take — search, browse, whatever.
   - Narrate at each meaningful step:
     - `searching for the exploratorium`
     - `clicking the date picker`
     - `selecting saturday may 5`
     - `picking 2 adult passes`
     - `clicking reserve`
3. **Complete the booking** if you're going through with it. The booking POST is the load-bearing request the LLM must identify, so we want to see it actually fire.
4. **Wait for the confirmation page** to fully load. The confirmation often sets a final session cookie or returns a booking ID we'll need for replay codegen.
5. Narrate the confirmation: `narrate> got the confirmation, booking id is visible on the page`
6. Type `/done` in the terminal (or press Ctrl+C in the terminal window, NOT in the browser).

## What the recorder is capturing

| Capture | How | Powers |
|---|---|---|
| Every network request (method, URL, headers, body) | CDP `Network.requestWillBeSent` | API workflow (`workflow.json` → `index.ts`) |
| Every response (status, headers, mimeType, body) | CDP `Network.responseReceived` + best-effort `Network.getResponseBody` | API workflow + playbook result extraction |
| Page navigations | CDP `Page.frameNavigated` | Playbook (`navigate` steps) |
| Clicks, inputs, form submits — with element tag, id, text, aria-label, selector, value | Injected JS listener → `Runtime.consoleAPICalled` | Playbook (`click`/`type`/`submit` steps with locator priority) |
| WebSocket frames (if any) | CDP `Network.webSocketFrameSent/Received` | (v0.2 codegen) |
| Cookies at start AND end | CDP `Network.getAllCookies` | `imprint login` credential store |
| localStorage/sessionStorage snapshots | Page evaluation at relevant origins | State captures + durable storage credentials |
| Your narration | Terminal stdin loop | LLM intent identification (both compilers) |

Password fields are auto-redacted before being captured. Other input values are captured verbatim (truncated to 200 chars per value). Response bodies larger than 256 KB are truncated with a `[…truncated…]` marker — if you're recording a site with very large payloads (e.g., flight search results), the workflow compiler will still generate correct code but the truncated body won't be available for parser verification.

**One recording, two artifacts.** The same session.json compiles to both:
- `imprint generate` → `workflow.json` → `imprint emit` → `index.ts` (API replay path, including named state captures)
- `imprint compile-playbook` → `playbook.yaml` (DOM replay path)

You don't have to commit to one or the other when you record. Generate both; the cron / MCP layer picks which to use per `replayBackend` config (`fetch` / `fetch-bootstrap` / `cdp-replay` / `stealth-fetch` / `playbook` / `auto`).

## After the recording — verify it worked

```bash
imprint check ~/.imprint/discoverandgo/sessions/<timestamp>.json
```

You should see something like:

```
[imprint] check $HOME/.imprint/discoverandgo/sessions/2026-04-30T01-23-45-678Z.json

  site:        discoverandgo
  duration:    142.3s
  requests:    87 (3 doc, 64 xhr, 4 POST/PUT/DELETE)
  responses:   84 2xx, 0 4xx/5xx
  events:      4 nav, 12 click, 8 input, 1 submit
  narration:   6 lines
  cookies:     0 at start, 23 at end

  ✓ no warnings — capture looks complete
```

**What to look for:**
- `POST/PUT/DELETE` should be > 0 — that's the booking submission. If it's 0, the booking POST didn't fire and the capture is incomplete.
- `submit` events should be > 0 — confirms the injected listener worked.
- `cookies: ... at end` count should be > `at start` count, OR the values should differ — confirms the booking set a session cookie.
- `4xx/5xx` should be near zero. A few 404s for missing assets are fine; many error responses suggest the workflow didn't complete.
- `narration: N lines` should match what you typed. If 0, the narration wasn't captured (rare, but worth catching now).

If `imprint check` reports warnings, **don't move on yet** — re-record or tell me what the warnings are and we'll figure out whether the capture is salvageable.

## If something goes wrong

**Recorder crashes mid-session, no `session.json` written:**
```bash
imprint assemble ~/.imprint/discoverandgo/sessions/<timestamp>.jsonl
# reconstructs the .json from the streamed JSONL
```

The JSONL is written line-by-line as events fire, so even a crash leaves you with everything captured up to the crash. Run `assemble` to recover it, then `check` to see what you have.

**Chromium window closes accidentally:**
The recorder detects this and shuts down cleanly. You'll get a partial session.json with whatever was captured.

**You realize partway through you missed a step:**
Don't try to restart the recorder mid-booking. Finish what you started. The codegen LLM is robust to extra/missing requests — better to have one complete-ish capture than two half captures stitched together.

**The browser is stuck on a captcha or anti-bot challenge:**
Solve it manually inside the Chromium window. The recorder doesn't care. Solving captchas is part of the workflow we want to capture (so the LLM knows to expect it).

**The site uses bot-detection (Akamai, DataDome, Cloudflare, PerimeterX, etc.):**
The recording will succeed because you are using a real browser. Replay may need more than plain fetch because those systems generate per-session opaque tokens that go stale within minutes. The compiler should avoid hard-coding common bot headers and instead use `fetch-bootstrap` or `stealth-fetch` when browser-minted state is required. If replay still fails with 403 / 429 / a CAPTCHA page in the response body, probe the backends and inspect whether the workflow needs a bootstrap capture, stealth tokens, or full playbook replay.

**The redactor scrubbed `X-API-Key` (or another header) you know is public:**
Re-run with `--keep-header`:
```bash
imprint redact ~/.imprint/<site>/sessions/<ts>.json --keep-header x-api-key
```
You can pass `--keep-header` multiple times. Use this when the redacted value is an app-level identifier embedded in the site's JavaScript (every visitor sees the same value), not a per-user secret. The default is to redact `X-API-Key` because some sites do use it as a per-user credential — you opt out per-site.

## Where the file lands

`~/.imprint/discoverandgo/sessions/<timestamp>.{jsonl,json}`

The `.jsonl` is the raw streaming log (line-per-event). The `.json` is the assembled session. Both stay outside the repo by default — they may contain auth tokens. Don't share them unless you have audited and redacted them.

When you're done capturing, pass the session to `imprint teach --from-session <path>` or run the manual `redact` → `generate` → `compile-playbook` → `emit` pipeline.
