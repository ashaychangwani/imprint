# Glossary

Names you'll see in code, docs, and CLI output.

| Term | What it is |
|---|---|
| **Session** | A captured browser run: every network request + every DOM event + the user's narration. On disk: `examples/<site>/sessions/<ts>.{jsonl,json}`. |
| **Workflow** | The API-replay artifact compiled from a session. A chain of `WorkflowRequest` records with `${param}` / `${response[N]}` substitutions. On disk: `workflow.json`. |
| **Playbook** | The DOM-replay artifact compiled from a session. A list of typed steps (`navigate`, `click`, `type`, `submit`, `press`, `wait`) with locator-priority arrays. On disk: `playbook.yaml`. |
| **Tool** | The user-facing object: a `runWorkflow(input)`-style function exposed as MCP, scheduled by cron, or invoked directly. The generated `examples/<site>/index.ts` exports one. |
| **Generated module** | The TypeScript file emitted by `imprint emit` — a thin wrapper over `runtime.executeWorkflow` with the workflow inlined. Self-contained, committable. |
| **Backend** | A replay strategy. Three exist: `fetch`, `stealth-fetch`, `playbook`. |
| **Backend ladder** | An ordered list of backends `runWithLadder` walks; first non-FORBIDDEN result wins. `auto` is a meta-value that expands to the cached preferred order or the default. |
| **Probe** | `imprint probe-backends <site>` — runs every backend once at record time and caches the working order to `backends.json`. |
| **Stealth-fetch** | A short-lived Playwright bootstrap that mints Akamai / Cloudflare / DataDome sensor tokens, then native `fetch()` augmented with those tokens. |
| **Sensor headers** | Bot-detection headers a site's JS injects (e.g. `EE-a`, `_abck` cookie). The stealth bootstrap captures them so plain `fetch()` can replay later. |
| **Token TTL refresh** | Stealth-fetch proactively re-bootstraps when tokens age past `maxTokenAgeSeconds`, and reactively on a 403 response. |
| **Sentinel** | The `[IMPRINT]` prefix on injected DOM-listener console.log lines. The recorder's `Runtime.consoleAPICalled` handler exact-match-checks this. |
| **CDP** | Chrome DevTools Protocol. The recorder uses it (via `chrome-remote-interface`) for Network + Page + Runtime events. |
| **Credential store** | `~/.config/imprint/credentials/<site>.json` — cookies + extracted values populated by `imprint login`. |
| **NotifyWhen** | A predicate config in `cron.json` that decides whether a successful tool result is interesting enough to push (e.g. `price_below`). |
