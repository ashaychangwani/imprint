#!/usr/bin/env bash
# Test multi-tool progress display by copying an avis recording to a
# throwaway site and running teach.
#
# Usage:
#   ./scripts/test-multi-progress.sh [session-file]
#
# If no session file is given, uses the latest redacted avis session.
# Ctrl-C to stop once you've seen enough of the compile progress.
# Run with --cleanup to remove the test site directory afterward.

set -euo pipefail

SITE="test-mp"
IMPRINT_DIR="$HOME/.imprint"
TEST_DIR="$IMPRINT_DIR/$SITE"
DO_CLEANUP=false

for arg in "$@"; do
  if [[ "$arg" == "--cleanup" ]]; then
    DO_CLEANUP=true
  fi
done

# ── Resolve source session ──────────────────────────────────────────
SRC_SESSION=""
for arg in "$@"; do
  [[ "$arg" == "--cleanup" ]] && continue
  SRC_SESSION="$arg"
  break
done

if [[ -z "$SRC_SESSION" ]]; then
  SRC_DIR="$IMPRINT_DIR/avis/sessions"
  if [[ ! -d "$SRC_DIR" ]]; then
    echo "error: no avis sessions at $SRC_DIR" >&2
    echo "usage: $0 [session-file] [--cleanup]" >&2
    exit 1
  fi
  SRC_SESSION=$(ls -t "$SRC_DIR"/*.redacted.json 2>/dev/null | head -1)
  if [[ -z "$SRC_SESSION" ]]; then
    SRC_SESSION=$(ls -t "$SRC_DIR"/*.json 2>/dev/null | grep -v '\.redacted\.\|\.triaged\.\|\.jsonl' | head -1)
  fi
  if [[ -z "$SRC_SESSION" ]]; then
    echo "error: no avis session files found" >&2
    exit 1
  fi
fi

if [[ ! -f "$SRC_SESSION" ]]; then
  echo "error: session file not found: $SRC_SESSION" >&2
  exit 1
fi

echo "[test-mp] source: $SRC_SESSION"

# ── Remove stale state from prior runs ──────────────────────────────
if [[ -d "$TEST_DIR" ]]; then
  echo "[test-mp] removing stale $TEST_DIR from a prior run"
  rm -rf "$TEST_DIR"
fi

# ── Copy + sanitize ─────────────────────────────────────────────────
mkdir -p "$TEST_DIR/sessions"
DEST_SESSION="$TEST_DIR/sessions/test-session.json"

bun -e "
const fs = require('fs');
const src = JSON.parse(fs.readFileSync('$SRC_SESSION', 'utf8'));
src.site = '$SITE';
if (src.requests) {
  for (const r of src.requests) {
    if (r.headers) {
      for (const k of Object.keys(r.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'cookie') r.headers[k] = 'session=test-value';
        if (lk === 'authorization') r.headers[k] = 'Bearer test-token';
        if (lk === 'x-api-key') r.headers[k] = 'test-api-key';
      }
    }
    if (r.response?.headers) {
      for (const k of Object.keys(r.response.headers)) {
        if (k.toLowerCase() === 'set-cookie') r.response.headers[k] = 'session=test-value; Path=/';
      }
    }
  }
}
for (const field of ['cookies', 'cookiesBefore', 'cookiesAfter']) {
  if (src[field]) for (const c of src[field]) if (c.value) c.value = 'sanitized';
}
fs.writeFileSync('$DEST_SESSION', JSON.stringify(src, null, 2));
console.error('[test-mp] sanitized → $DEST_SESSION');
"

echo ""
echo "[test-mp] running teach — watch for clean one-line-per-tool progress during compile step"
echo "[test-mp] press Ctrl-C once you've seen enough"
echo ""

# ── Run teach (no timeout wrapper — let the user Ctrl-C) ────────────
set +e
bun src/cli.ts teach "$SITE" \
  --from-session "$DEST_SESSION" \
  --no-interactive \
  --all-tools \
  --provider vertex
EXIT_CODE=$?
set -e

echo ""
if [[ $EXIT_CODE -ne 0 ]]; then
  echo "[test-mp] exited with code $EXIT_CODE"
fi

if $DO_CLEANUP; then
  echo "[test-mp] cleaning up $TEST_DIR"
  rm -rf "$TEST_DIR"
else
  echo "[test-mp] test site left at $TEST_DIR (pass --cleanup to remove)"
fi
