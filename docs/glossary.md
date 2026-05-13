# Glossary

Names you'll see in code, docs, and CLI output.

| Term | What it is |
|---|---|
| **Session** | A captured browser run: every network request + every DOM event + the user's narration. On disk: `~/.imprint/<site>/sessions/<ts>.{jsonl,json}`. |
| **Workflow** | The API-replay artifact compiled from a session. A chain of `WorkflowRequest` records with `${param}`, `${credential}`, `${state}`, and legacy `${response[N]}` substitutions. On disk: `workflow.json`. |
| **Playbook** | The DOM-replay artifact compiled from a session. A list of typed steps (`navigate`, `click`, `type`, `submit`, `press`, `wait`) with locator-priority arrays. On disk: `playbook.yaml`. |
| **Tool** | The user-facing object: a `runWorkflow(input)`-style function exposed as MCP, scheduled by cron, or invoked directly. The generated `examples/<site>/<toolName>/index.ts` exports one. |
| **Generated module** | The TypeScript file emitted by `imprint emit` — a thin wrapper over `runtime.executeWorkflow` with the workflow inlined. Self-contained, committable. |
| **Backend** | A replay strategy. Four exist: `fetch`, `fetch-bootstrap`, `stealth-fetch`, `playbook`. |
| **Backend ladder** | An ordered list of backends `runWithLadder` walks. `FORBIDDEN` and satisfiable `STATE_MISSING` escalate; terminal errors return immediately. `auto` is a meta-value that expands to the cached preferred order or the default. |
| **Probe** | `imprint probe-backends <site>` — runs every applicable backend at record time and caches the working order to `backends.json`. Conditional backends like `fetch-bootstrap` are skipped unless the workflow declares state they can produce. |
| **Fetch-bootstrap** | A short-lived Playwright context that seeds credential cookies/storage, navigates to `workflow.bootstrap.url`, harvests cookies/storage/DOM-derived state, closes the browser, and then runs native API replay. It is not a full DOM fallback. |
| **Stealth-fetch** | A short-lived Playwright bootstrap that mints Akamai / Cloudflare / DataDome sensor tokens, then native `fetch()` augmented with those tokens. |
| **Sensor headers** | Bot-detection headers a site's JS injects (e.g. `EE-a`, `_abck` cookie). The stealth bootstrap captures them so plain `fetch()` can replay later. |
| **Token TTL refresh** | Stealth-fetch proactively re-bootstraps when tokens age past `maxTokenAgeSeconds`, and reactively on a 403 response. |
| **Capture** | A named value extracted from a request response or bootstrap page: JSON path, response header, regex text, cookie, localStorage/sessionStorage key, HTML regex, DOM attribute, or DOM text. Captures are referenced later as `${state.NAME}`. |
| **STATE_MISSING** | A typed runtime failure for required state that could not be produced. It carries a capability (`ordinary_http`, `browser_bootstrap`, `stealth_bootstrap`, `credential_required`, or `unsupported`) so the ladder can decide whether escalation is valid. |
| **RuntimeCookieJar** | Per-execution cookie jar used by API replay. It ingests `Set-Cookie`, emits Cookie headers, preserves browser session cookies, detects ambiguous scalar lookups, and guards HttpOnly projection. |
| **Sentinel** | The `[IMPRINT]` prefix on injected DOM-listener console.log lines. The recorder's `Runtime.consoleAPICalled` handler exact-match-checks this. |
| **CDP** | Chrome DevTools Protocol. The recorder uses it (via `chrome-remote-interface`) for Network + Page + Runtime events. |
| **Credential store** | Per-site secrets, cookies, and declared storage values populated by `imprint login` or `imprint credential import`. Uses the OS keychain when available and falls back to encrypted local storage on headless machines. |
| **NotifyWhen** | A predicate config in `cron.json` that decides whether a successful tool result is interesting enough to push (e.g. `price_below`). |
