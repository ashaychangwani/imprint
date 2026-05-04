# Imprint architecture

## The core idea

Imprint records a real browser session, then compiles it into TWO deterministic artifacts:

1. **`workflow.json`** — the captured API call chain, replayable via `fetch()`. Fast (~200ms), brittle on bot-protected sites.
2. **`playbook.yaml`** — the captured DOM script, replayable via Playwright. Slow (~9s), works everywhere a real browser does.

Both are auto-discovered by the cron daemon and the MCP server, which dispatch through a **backend ladder** that escalates through cheaper-to-costlier replay strategies on FORBIDDEN errors.

## Data flow

```
                       ┌──────────────────┐
                       │  imprint record  │   ← user drives a real Chrome,
                       └─────────┬────────┘     narrates what they're doing
                                 ▼
                       session.json + .jsonl
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   ┌─────────────────────┐               ┌──────────────────────┐
   │ imprint generate    │               │ imprint compile-     │
   │  (LLM → workflow)   │               │   playbook (LLM)     │
   └──────────┬──────────┘               └──────────┬───────────┘
              ▼                                     ▼
       workflow.json                          playbook.yaml
              │                                     │
       imprint emit                                 │
              │                                     │
              ▼                                     │
   examples/<site>/index.ts                         │
              │                                     │
              ▼                                     ▼
   ┌─────────────────────────────────────────────────────────┐
   │  imprint cron <site>     ┌─►  backend ladder            │
   │  imprint mcp-server      │      fetch ─FORBIDDEN→        │
   │  imprint playbook        │      stealth-fetch ─→         │
   │                          │      playbook                 │
   └──────────────────────────┴───────────────────────────────┘
```

## Module map

```
src/imprint/
├── record.ts            CDP capture + DOM listener + JSONL stream
├── session-writer.ts    JSONL writer + Session assembler
├── inject-listener.ts   Sentinel-prefixed DOM event capture (injected)
├── redact.ts            Credential / PII scrub
├── check.ts             Sanity-check captured sessions
│
├── compile.ts           One LLM compiler, two configs:
│                          - generate (Workflow)
│                          - compilePlaybook (Playbook)
├── llm.ts               Vertex Anthropic wrapper + JSON extractor
├── playbook-parser.ts   YAML → Playbook (Zod-validated)
│
├── emit.ts              workflow.json → examples/<site>/index.ts
├── runtime.ts           executeWorkflow — substitutions + chain + classification
├── tool-loader.ts       Discover examples/<site>/index.ts modules
│
├── backend-ladder.ts    runWithLadder + resolveLadder
├── stealth-fetch.ts     Headless Chromium → mint sensor tokens → native fetch
├── playbook-runner.ts   Playwright + stealth + locator priority + DOM walk
│
├── cron.ts              Polling daemon
├── mcp-server.ts        MCP stdio + Streamable HTTP
├── probe-backends.ts    Try each backend at record time → backends.json
├── notify.ts            evaluateNotifyWhen + Pushover/ntfy delivery
├── login.ts             Session.json → credentials store
│
├── chromium.ts          Locate + launch Chromium for CDP
├── json-path.ts         Dot-path walker (a[].b.c)
├── log.ts               createLog factory
└── types.ts             Zod schemas (Session, Workflow, Playbook, Cron, etc.)
```

## Backend ladder

| Backend | Per-call cost | Defeats |
|---|---|---|
| `fetch` | ~200ms | Plain APIs |
| `stealth-fetch` | ~12s bootstrap (one-time) + ~1s | Akamai, Cloudflare, DataDome (token tier) |
| `playbook` | ~9.4s | Universal — also handles form-fills, autocompletes, multi-page |

`auto` mode walks the ladder. The probe-backends cache (`examples/<site>/backends.json`) reorders the ladder so cron + MCP start with the cheapest known-working backend.

## File taxonomy per example

```
examples/<site>/
├── sessions/
│   ├── <ts>.jsonl              raw streaming capture
│   └── <ts>.json               assembled session
│   └── <ts>.redacted.json      after `imprint redact`
├── workflow.json               output of `imprint generate`
├── playbook.yaml               output of `imprint compile-playbook`
├── index.ts                    output of `imprint emit` (consumed by cron + MCP)
├── cron.json                   schedule + params + replayBackend + notifyWhen
└── backends.json               output of `imprint probe-backends`
```
