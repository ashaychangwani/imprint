#!/usr/bin/env bash
set -euo pipefail

# Wipe a site's compiled artifacts (never its recordings) and re-teach it from
# scratch with Phoenix tracing on. This is the acceptance entry point: a full
# from-scratch run is what the ≥95% audit gate is measured against.
#
# Usage:
#   scripts/teach-from-scratch.sh <site> [--keep-shared]
#
#   <site>          Imprint site label under ${IMPRINT_HOME:-$HOME/.imprint}.
#   --keep-shared   Reuse the verified _shared/ modules + .build-plan.json
#                   (fast iteration); still wipes per-tool dirs + teach state.
#
# Always preserves sessions/ — recordings are expensive and never regenerated.

usage() {
  echo "usage: $(basename "$0") <site> [--keep-shared]" >&2
  exit 2
}

SITE=""
KEEP_SHARED=0
for arg in "$@"; do
  case "$arg" in
    --keep-shared) KEEP_SHARED=1 ;;
    -h|--help) usage ;;
    -*) echo "error: unknown flag: $arg" >&2; usage ;;
    *)
      if [[ -n "$SITE" ]]; then
        echo "error: unexpected extra argument: $arg" >&2
        usage
      fi
      SITE="$arg"
      ;;
  esac
done

[[ -n "$SITE" ]] || usage

# Reject anything that could escape the imprint home (path separators / "..").
if [[ "$SITE" == *"/"* || "$SITE" == *".."* ]]; then
  echo "error: invalid site name: \"$SITE\" (no path separators or \"..\")" >&2
  exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMPRINT_HOME="${IMPRINT_HOME:-$HOME/.imprint}"
SITE_DIR="$IMPRINT_HOME/$SITE"

if [[ ! -d "$SITE_DIR" ]]; then
  echo "error: site directory not found: $SITE_DIR" >&2
  echo "       record a session first (imprint record \"$SITE\") before teaching from scratch." >&2
  exit 1
fi

# Resolve the real path and confirm it is genuinely under the imprint home —
# a second guard against symlink / traversal tricks before we delete anything.
RESOLVED_SITE_DIR="$(cd "$SITE_DIR" && pwd -P)"
RESOLVED_HOME="$(cd "$IMPRINT_HOME" && pwd -P)"
case "$RESOLVED_SITE_DIR/" in
  "$RESOLVED_HOME"/*/) : ;;
  *)
    echo "error: refusing to operate on \"$RESOLVED_SITE_DIR\" — not under $RESOLVED_HOME" >&2
    exit 1
    ;;
esac

echo "[teach-from-scratch] site:      $SITE"
echo "[teach-from-scratch] site dir:  $RESOLVED_SITE_DIR"
if [[ "$KEEP_SHARED" -eq 1 ]]; then
  echo "[teach-from-scratch] mode:      --keep-shared (reuse _shared/ + .build-plan.json)"
else
  echo "[teach-from-scratch] mode:      full from scratch"
fi

# Always wipe teach state so the run starts clean.
WIPED=()
if [[ -e "$RESOLVED_SITE_DIR/.teach-state.json" ]]; then
  rm -f "$RESOLVED_SITE_DIR/.teach-state.json"
  WIPED+=(".teach-state.json")
fi

if [[ "$KEEP_SHARED" -eq 0 ]]; then
  if [[ -e "$RESOLVED_SITE_DIR/.build-plan.json" ]]; then
    rm -f "$RESOLVED_SITE_DIR/.build-plan.json"
    WIPED+=(".build-plan.json")
  fi
  if [[ -d "$RESOLVED_SITE_DIR/_shared" ]]; then
    rm -rf "$RESOLVED_SITE_DIR/_shared"
    WIPED+=("_shared/")
  fi
fi

# Remove every immediate subdirectory (the per-tool dirs) except sessions/ and,
# when --keep-shared, _shared/.
for entry in "$RESOLVED_SITE_DIR"/*/; do
  [[ -d "$entry" ]] || continue
  name="$(basename "$entry")"
  [[ "$name" == "sessions" ]] && continue
  if [[ "$KEEP_SHARED" -eq 1 && "$name" == "_shared" ]]; then
    continue
  fi
  rm -rf "$entry"
  WIPED+=("$name/")
done

if [[ "${#WIPED[@]}" -gt 0 ]]; then
  echo "[teach-from-scratch] wiped:     ${WIPED[*]}"
else
  echo "[teach-from-scratch] wiped:     (nothing — already clean)"
fi
echo "[teach-from-scratch] preserved: sessions/"

# Compile from the EXISTING recordings, not a fresh capture. Plain
# `teach <site> --no-interactive` would launch chromium and block on a new
# recording; pointing teach at any one raw session makes it skip record, start
# at redact, and combine ALL raw siblings (combineAvailableSessions →
# mergeSessions). Pick the newest raw session by mtime, matching the raw-session
# filter in listSessionsInDir (session-merge.ts): a *.json that does not contain
# ".redacted"/".triaged" and does not start with "combined-".
SESSION=""
for f in $(ls -t "$RESOLVED_SITE_DIR"/sessions/*.json 2>/dev/null); do
  base="$(basename "$f")"
  case "$base" in
    *.redacted.*|*.triaged.*|combined-*) continue ;;
  esac
  SESSION="$f"
  break
done

if [[ -z "$SESSION" ]]; then
  echo "error: no raw recording found in $RESOLVED_SITE_DIR/sessions/ — record one first (imprint record \"$SITE\")" >&2
  exit 1
fi
echo "[teach-from-scratch] session:   $(basename "$SESSION") (merges all raw siblings)"

# Per-tool compile timeout passthrough (heavy multi-filter search tools need
# more than the 20-min default once parameter-fidelity verification runs).
TIMEOUT_ARGS=()
if [[ -n "${IMPRINT_TEACH_TIMEOUT:-}" ]]; then
  TIMEOUT_ARGS=(--timeout "$IMPRINT_TEACH_TIMEOUT")
  echo "[teach-from-scratch] per-tool timeout: $IMPRINT_TEACH_TIMEOUT"
fi

echo "[teach-from-scratch] running teach with tracing on…"
IMPRINT_TRACE=1 \
PHOENIX_COLLECTOR_ENDPOINT="${PHOENIX_COLLECTOR_ENDPOINT:-http://localhost:6006}" \
  bun run "$REPO/src/cli.ts" teach "$SITE" \
    --from-session "$SESSION" \
    --no-interactive --all-tools --provider claude-cli "${TIMEOUT_ARGS[@]}"
