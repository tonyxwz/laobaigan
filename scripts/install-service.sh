#!/usr/bin/env bash
# Development: install the timer for this checkout (an npm install uses `lbg service install`).
#   scripts/install-service.sh [--path DIR[:DIR]]   install / update and start the timer
#   scripts/install-service.sh uninstall            stop and remove
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -d "$REPO/node_modules" ]] || (cd "$REPO" && npm ci)
if [[ "${1:-}" == "uninstall" ]]; then exec node "$REPO/src/cli.ts" service uninstall; fi
exec node "$REPO/src/cli.ts" service install "$@"
