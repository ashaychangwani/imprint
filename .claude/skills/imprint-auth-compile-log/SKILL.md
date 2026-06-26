---
name: imprint-auth-compile-log
version: 1.0.0
description: Investigate a site's auth-tool compile — ongoing or completed. Locate the real agent transcript (not just the hook log), read the live 2FA verification, inspect the emitted workflow.json, confirm the login actually completed, and diagnose "no auth tool compiled".
triggers:
  - investigate auth compile
  - auth compile log
  - debug auth tool
  - why did auth fail
  - auth tool didn't compile
  - check the auth compile
  - auth 2fa compile log
  - did the auth login work
  - inspect authenticate tool
allowed-tools:
  - Bash
  - Read
---

# Investigate a site's auth-tool compile

The `authenticate_<site>` tool is compiled by a **separate agent loop** from data tools
(`auth-compile-agent.ts` → an MCP-server-driven claude-cli/codex session; the live login runs
in `auth-verifier.ts` on **headed `cdp-replay`**). Its logs live in a few places — and the most
important one is **not** the file you'd guess.

> **Key gotcha:** `~/.imprint/<site>/authenticate_<site>/.compile-log.json` is **hook events only**
> (SessionStart / init / success). The agent's actual tool calls + reasoning are in a **separate
> claude-cli transcript** keyed by the `session_id` inside that hook log. Step 2 shows how to find it.

Substitute the real site slug for `<site>` throughout (e.g. `amex-fhr`, `remitly`). The auth tool
dir is always `~/.imprint/<site>/authenticate_<site>/`.

## Step 1 — Ongoing or completed?

```bash
SITE=<site>; AUTHDIR=~/.imprint/$SITE/authenticate_$SITE

# Is a teach process still alive? (auth runs HEADED — a visible Chrome window is open mid-run)
pgrep -fl "cli.ts teach $SITE" ; pgrep -afl "Chrome for Testing|Chromium" | head -1

# Completed? these appear only after the auth block finishes
ls -la "$AUTHDIR"/.compile-done.json "$AUTHDIR"/workflow.json "$AUTHDIR"/index.ts 2>/dev/null
```

| Signal | Meaning |
|---|---|
| `.compile-log.json` mtime advancing, no `.compile-done.json` | **Ongoing** — agent still shaping/verifying |
| spinner shows `Auth compile: turn N — verify initiate …` | **Ongoing**, in live verification |
| a headed Chrome window is open + a push/OTP hit your phone | **Ongoing**, `initiate` fired — approve it |
| `.compile-done.json` present + `workflow.json`/`index.ts` emitted | **Completed (success)** — `emit()` only runs on success |
| run log says `Auth tool compiled + session stored` / `compilation failed` | **Completed** — success / failure |

## Step 2 — Find the artifacts (incl. the real transcript)

```bash
SITE=<site>; AUTHDIR=~/.imprint/$SITE/authenticate_$SITE

# 1. Hook log — grab the claude-cli session_id from it
SID=$(python3 -c "import json,sys; d=json.load(open('$AUTHDIR/.compile-log.json')); print(next((e.get('session_id') for e in d if e.get('session_id')), ''))")
echo "auth session: $SID"

# 2. The REAL agent transcript (full tool-call conversation), located by session_id
T=$(find ~/.claude/projects -name "$SID.jsonl" 2>/dev/null | head -1); echo "transcript: $T"

# 3. Final outcome
cat "$AUTHDIR/.compile-done.json" 2>/dev/null
```

| Path | Contents |
|---|---|
| `~/.imprint/<site>/authenticate_<site>/.compile-log.json` | **Hook events only** (has `session_id`) |
| `~/.claude/projects/**/<session_id>.jsonl` | **The agent transcript** — every tool call + result |
| `~/.imprint/<site>/authenticate_<site>/.compile-done.json` | Final result / outcome |
| `~/.imprint/<site>/authenticate_<site>/workflow.json` | The emitted auth tool (captures, authConfig) |
| `~/.imprint/<site>/authenticate_<site>/.tool-plan.md` | Plan injected into the agent's first message |
| the teach run's stdout/stderr | Spinner-only during auth (logs are muted); see Step 4 |

## Step 3 — Read what the agent actually did

The single most useful view — the ordered tool calls (did it read the recording, write the
workflow, reach 2FA, complete?):

```bash
python3 - "$T" <<'PY'
import json,sys
n=0
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except: continue
    c=(o.get('message',o) or {}).get('content')
    if not isinstance(c,list): continue
    for b in c:
        if isinstance(b,dict) and b.get('type')=='tool_use':
            n+=1
            name=b.get('name','').replace('mcp__imprint-compile__','')
            print(f"{n:3} {name:22} {json.dumps(b.get('input',{}))[:150]}")
PY
```

A healthy run looks like: `read_session_summary` → several `read_request`/`read_response_body`
→ one `write_file workflow.json` → `run_verification {phase:initiate}` → (`prompt_user`) →
`run_verification {phase:complete}` → `done`. Read the agent's text/`give_up` message for *why*
if it bailed.

## Step 4 — Read the live 2FA verification

Auth logs are muted under the spinner, so read them from the run's captured output (if you teed it
to a file) or from the task output file. Strip the ANSI/spinner noise:

```bash
LOG=/tmp/<your-teach-run>.log   # wherever you redirected the teach run
sed -E 's/\x1b\[[0-9;]*m//g; s/\x1b\[[0-9]*[A-Z]//g; s/\x1b\[J//g' "$LOG" | tr '\r' '\n' \
  | grep -oE "verify (initiate|complete|submit_otp) [A-Z_]+[^◐◓◑◒]*|AWAITING_2FA|Auth tool compiled[^◐◓◑◒]*|compilation failed|session stored|attempt [0-9]+/[0-9]+|BUDGET_EXHAUSTED|ATTEMPT_BUDGET_EXHAUSTED" \
  | sort -u | tail -20
```

`AWAITING_2FA` on `initiate` is the **healthy** outcome (the challenge was delivered) — it is
labelled "FAILED" by the generic progress formatter but means "reached 2FA". Two budgets bound it:
challenge cap (`IMPRINT_AUTH_MAX_INITIATE`, default 2) and attempt cap
(`IMPRINT_AUTH_MAX_INITIATE_ATTEMPTS`, default 5).

## Step 5 — Inspect the emitted workflow.json

```bash
python3 - "$AUTHDIR/workflow.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for i,r in enumerate(d.get('requests',[])):
    caps=[c.get('path') for c in r.get('captures',[])]
    print(f"[{i}] {r.get('method')} ...{r.get('url','')[-46:]} optional={r.get('optional',False)} caps={caps}")
ac=d.get('authConfig',{})
print("twoFactorType:",ac.get('twoFactorType'),"| initiateRequestCount:",ac.get('initiateRequestCount'))
print("pollEndpoint:",(ac.get('pollEndpoint') or '')[:70]," pollTerminal:",ac.get('pollTerminal'))
print("sessionCapture:",ac.get('sessionCapture'))
print("bootstrap.url:",(d.get('bootstrap') or {}).get('url'))
PY
```

What a robust tool has: `bootstrap.url` = the credential-entry page; **predicate** capture paths
(`challenges[type=push].token`, not a fixed `[0]`) for variable-order challenge arrays; `optional:true`
on best-effort steps (e.g. trust-device); for `push`, `pollEndpoint`+`pollBody`+`pollTerminal`; a
`sessionCapture` only if data tools need a non-cookie bearer/CSRF token (omit for cookie-auth).

## Step 6 — Did the login actually complete?

`emit()` (so `workflow.json`/`index.ts`) only runs on the agent calling `done`, but confirm a real
session landed — not just pre-existing cookies:

```bash
SITE=<site>
ls -la ~/.imprint/$SITE/.cdp-jar.json   # mtime ≈ run time → the headed browser ran live
bun run src/cli.ts credential list $SITE | grep -i cookies   # count grows after a fresh login
```

Cross-check: the run says `session stored` (vs `no live session stored`), and the Step-3 transcript
ends in `done` (not `give_up`). For `push`, the login can only complete if you approved it.

## Step 7 — Independence / "did the agent cheat?" audit

To confirm the agent derived the tool from the **recording** (not by copying a hand-tuned answer):

```bash
# It must NOT read the answer key. Expect ZERO read_file/run_bash on workflow.json / *.bak / handoff:
grep -oiE "read_file|run_bash|groundtruth|workflow\.json\.bak|AMEX_AUTH_HANDOFF" "$T" | sort | uniq -c
```
Then read the **first user message** in the transcript — the build-plan `authTool.notes` legitimately
describe the flow (that's the pipeline), but the predicate-path *syntax* and `optional` flag should be
the agent's own application of the prompt, not present verbatim in the notes.

## Failure signatures

| Symptom | Likely cause / fix |
|---|---|
| `FORBIDDEN`/`BAD_RESPONSE` + "Access Denied" on the credential POST | login-page sensor never ran → fix/add `bootstrap.url`; ensure auth ran **headed cdp-replay** (it should — `runCdpReplay` headed for `toolKind==='authenticate'`) |
| `AWAITING_2FA` then `Push not approved after N attempts` | poll body/terminal wrong, or you didn't approve in time; check `pollBody`/`pollTerminal`, raise `IMPRINT_AUTH_POLL_ATTEMPTS` |
| `STATE_MISSING` on `submit_otp`/`complete` | a `${state.X}` not echoed via `twoFactorContext` or captured on an initiate request; check captures (predicate path?) |
| `BUDGET_EXHAUSTED` / `ATTEMPT_BUDGET_EXHAUSTED` | too many initiates; a corrected workflow needs a fresh run |
| `no credentials … skipping auth compile` | run `imprint credential set <site>` (username/password) |
| agent called `give_up` | login can't be reproduced (creds rejected, unsolvable CAPTCHA, enrollment page) — read its message |
| `codex-cli cannot compile an authenticate tool` | auth verification is checkpoint-based; use `claude-cli` or `anthropic-api` |

## "No auth tool compiled at all"

If the recording had a login but **no `authenticate_<site>` dir / no auth block ran**, the planner
(the only producer of `buildPlan.authTool`) was skipped. Check:

```bash
SITE=<site>
ls ~/.imprint/$SITE/.build-plan.json 2>/dev/null && \
  python3 -c "import json;d=json.load(open('$HOME/.imprint/$SITE/.build-plan.json'));print('authTool:',(d.get('authTool') or {}).get('toolName'))"
grep -oE '"(twoFactorDetected|twoFactorType)":[^,}]*|"loginRequestSeqs":\[[^]]*\]' ~/.imprint/$SITE/.teach-state.json | head
```
The planner runs when **≥2 tools are selected OR any login was detected** (`sharedContextHasAuth`:
`loginRequestSeqs`/`credentialNames` non-empty, or `twoFactorDetected`). If a login is detected but
there's no `.build-plan.json`, re-run from the planner without redoing earlier stages:

```bash
bun run src/cli.ts teach <site> --from-step plan-prereqs   # interactive, so OTP/push prompts work
```

## Useful env knobs

| Variable | Effect |
|---|---|
| `IMPRINT_DEBUG=1` | Verbose stderr (HTTP, cookies, Chromium, stack traces) |
| `IMPRINT_COMPILE_ACT_SPACING_MS=0` | Skip the 25s compile-time replay pacing |
| `IMPRINT_CDP_HEADED=1` | Force headed cdp-replay for any rung (auth is headed already) |
| `IMPRINT_AUTH_MAX_INITIATE` / `_ATTEMPTS` | Challenge cap (2) / attempt cap (5) for live `initiate` |
| `IMPRINT_AUTH_POLL_ATTEMPTS` | Bound an unattended push poll |
