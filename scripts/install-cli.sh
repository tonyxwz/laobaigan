#!/usr/bin/env bash
# Put `lbg` on PATH as a symlink to this repo's src/cli.ts.
#   scripts/install-cli.sh             install into ~/.local/bin (or $BIN_DIR)
#   scripts/install-cli.sh uninstall
# A symlink (not `npm link`) so it survives Node upgrades by mise and always runs
# the current code in this repo; no build step needed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/lbg"

if [[ "${1:-}" == "uninstall" ]]; then
  [[ -L "$LINK" ]] && rm "$LINK" && echo "Removed $LINK"
  exit 0
fi

if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  echo "$LINK exists and is not a symlink; refusing to overwrite" >&2
  exit 1
fi
[[ -d "$REPO/node_modules" ]] || (cd "$REPO" && npm ci)
chmod +x "$REPO/src/cli.ts"
mkdir -p "$BIN_DIR"
ln -sfn "$REPO/src/cli.ts" "$LINK"
echo "Installed $LINK -> $REPO/src/cli.ts"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on PATH; add it to your shell profile." ;;
esac
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
(( node_major >= 24 )) || echo "Note: \`node\` on PATH must be >= 24 (found: $(node -v 2>/dev/null || echo none))."
