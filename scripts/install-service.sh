#!/usr/bin/env bash
# Install the timer for this checkout (an npm install uses `lbg service install`).
#   scripts/install-service.sh [--path DIR[:DIR]]   install / update and start the timer
#   scripts/install-service.sh uninstall            stop and remove
# When `lbg` on PATH is this checkout (scripts/install-cli.sh), the timer runs through it,
# like an npm install; otherwise it runs src/cli.ts directly.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -d "$REPO/node_modules" ]] || (cd "$REPO" && npm ci)
LBG="$(command -v lbg || true)"
if [[ -n "$LBG" && "$(readlink -f "$LBG")" == "$(readlink -f "$REPO")/bin/lbg.js" ]]; then
  run=("$LBG")
else
  run=(node "$REPO/src/cli.ts")
fi
if [[ "${1:-}" == "uninstall" ]]; then exec "${run[@]}" service uninstall; fi
exec "${run[@]}" service install "$@"
