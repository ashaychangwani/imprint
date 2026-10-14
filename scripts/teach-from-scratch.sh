#!/usr/bin/env bash
set -euo pipefail

# Start one fresh foreground master teach from the site's latest combined
# recording. Every discovered tool is planned and built; old failed runs are
# diagnostic evidence only and are never resumed.

usage() {
  echo "usage: $(basename "$0") <site>" >&2
  exit 2
}

SITE="${1:-}"
[[ -n "$SITE" && $# -eq 1 ]] || usage
if [[ "$SITE" == *"/"* || "$SITE" == *".."* ]]; then
  echo "error: invalid site name: $SITE" >&2
  exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEACH_PROVIDER="${IMPRINT_TEACH_PROVIDER:-codex-cli}"
TIMEOUT_ARGS=()
if [[ -n "${IMPRINT_TEACH_TIMEOUT:-}" ]]; then
  TIMEOUT_ARGS=(--timeout "$IMPRINT_TEACH_TIMEOUT")
fi

IMPRINT_TRACE=1 \
PHOENIX_COLLECTOR_ENDPOINT="${PHOENIX_COLLECTOR_ENDPOINT:-http://localhost:6006}" \
  bun run "$REPO/src/cli.ts" teach "$SITE" \
    --agent codex --no-interactive --provider "$TEACH_PROVIDER" "${TIMEOUT_ARGS[@]}"
