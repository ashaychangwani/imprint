#!/usr/bin/env bash
set -euo pipefail

# Re-run a site's bounded compile window with Phoenix tracing on. Existing
# generated artifacts and durable verifier feedback stay in place so compile
# agents revise proven work instead of recreating it from raw capture.
#
# Usage:
#   scripts/teach-from-scratch.sh <site> [--keep-shared]
#
#   <site>          Imprint site label under ${IMPRINT_HOME:-$HOME/.imprint}.
#   --keep-shared   Resume at generate and reuse the verified _shared/ modules
#                   + .build-plan.json. Without it, resume at plan-prereqs so
#                   shared planning is refreshed before revising the tools.
#
# Always preserves sessions/, .teach-state.json, and classification artifacts.

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
  echo "[teach-from-scratch] mode:      rebuild compile window"
fi

STATE_PATH="$RESOLVED_SITE_DIR/.teach-state.json"
if [[ ! -f "$STATE_PATH" ]]; then
  echo "error: analyzed teach state not found: $STATE_PATH" >&2
  echo "       run teach through detect-candidates first; reteaches resume with --from-step plan-prereqs." >&2
  exit 1
fi

CANDIDATE_COUNT="$(jq '[.workflows[] | select(.candidate != null)] | length' "$STATE_PATH")"
INCOMPLETE_CANDIDATES="$(
  jq '[.workflows[] | select(.candidate != null and ((.completedSteps // []) | index("detect-candidates") | not))] | length' "$STATE_PATH"
)"
if [[ "$CANDIDATE_COUNT" -eq 0 || "$INCOMPLETE_CANDIDATES" -ne 0 ]]; then
  echo "error: teach state has not completed candidate detection for every candidate workflow" >&2
  echo "       finish analysis first; this script only runs --from-step plan-prereqs --to-step emit." >&2
  exit 1
fi

FROM_STEP="plan-prereqs"
if [[ "$KEEP_SHARED" -eq 1 ]]; then
  FROM_STEP="generate"
fi
echo "[teach-from-scratch] preserved: sessions/ generated tools/ verifier feedback/ teach state/ backend cache/"
echo "[teach-from-scratch] window:    $FROM_STEP → emit"

# Per-tool compile timeout passthrough (heavy multi-filter search tools need
# more than the 20-min default once parameter-fidelity verification runs).
TIMEOUT_ARGS=()
if [[ -n "${IMPRINT_TEACH_TIMEOUT:-}" ]]; then
  TIMEOUT_ARGS=(--timeout "$IMPRINT_TEACH_TIMEOUT")
  echo "[teach-from-scratch] per-tool timeout: $IMPRINT_TEACH_TIMEOUT"
fi

echo "[teach-from-scratch] running teach with tracing on…"
TEACH_PROVIDER="${IMPRINT_TEACH_PROVIDER:-codex-cli}"
IMPRINT_TRACE=1 \
PHOENIX_COLLECTOR_ENDPOINT="${PHOENIX_COLLECTOR_ENDPOINT:-http://localhost:6006}" \
  bun run "$REPO/src/cli.ts" teach "$SITE" \
    --from-step "$FROM_STEP" --to-step emit \
    --no-interactive --all-tools --provider "$TEACH_PROVIDER" "${TIMEOUT_ARGS[@]}"
