#!/usr/bin/env bash
# Reproduction wrapper for the orphaned-Chrome leak.
#
# Runs scripts/repro-chrome-leak-inner.ts THROUGH the real runCommand (the exact
# compile-verifier path: detached process group + close-time reap). The inner
# script launches Chrome, schedules cleanup on a 15s idle timer WITHOUT awaiting
# it, then process.exit()s — leaving Chrome orphaned in the group, exactly as the
# `bun test` verifier does. If runCommand doesn't reap the group on close, the
# Chrome PID survives (orphaned, PPID=1) = LEAK reproduced.
#
# Exit code: 0 = no leak (chrome reaped), 1 = LEAK (chrome orphaned).
set -uo pipefail
cd "$(dirname "$0")/.."

PIDFILE="$(mktemp)"
export REPRO_PIDFILE="$PIDFILE"

before=$(pgrep -f 'chrome-mac-arm64|chrome-headless-shell' 2>/dev/null | wc -l | tr -d ' ')
echo "chrome procs before: $before"
echo "running leak repro THROUGH the real runCommand (compile-verifier path)..."
t0=$(date +%s)
bun run scripts/repro-chrome-leak.ts
t1=$(date +%s)
echo "runCommand returned after $((t1 - t0))s (idle timer is 15s — if < 15s, timer cannot have fired)"

# Give the kernel a moment to reap any SIGKILLed Chrome (zombie -> gone) so
# kill -0 reflects real liveness, not a transient zombie.
sleep 2
leaked=0
while read -r pid; do
  [ -z "$pid" ] && continue
  if kill -0 "$pid" 2>/dev/null; then
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    echo "LEAK: chrome pid $pid survived child-process exit (orphaned, PPID=$ppid)"
    kill -9 "$pid" 2>/dev/null
    # also reap its children
    pkill -9 -P "$pid" 2>/dev/null || true
    leaked=1
  else
    echo "OK: chrome pid $pid was reaped on child-process exit"
  fi
done < "$PIDFILE"
rm -f "$PIDFILE"

after=$(pgrep -f 'chrome-mac-arm64|chrome-headless-shell' 2>/dev/null | wc -l | tr -d ' ')
echo "chrome procs after (post-cleanup): $after"
if [ "$leaked" = "1" ]; then echo "RESULT: LEAK REPRODUCED"; else echo "RESULT: no leak"; fi
exit "$leaked"
