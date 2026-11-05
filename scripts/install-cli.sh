#!/usr/bin/env bash
# Install `lbg` from this checkout with `npm link`, into ~/.local (or $LBG_PREFIX):
#   scripts/install-cli.sh             ~/.local/bin/lbg -> ~/.local/lib/node_modules/laobaigan (-> this repo)
#   scripts/install-cli.sh uninstall
# The link runs bin/lbg.js, which runs src/ directly: edits take effect immediately,
# no build step. The ~/.local prefix (not mise's per-version Node prefix) survives
# Node upgrades. This doesn't change your npm config.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${LBG_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/lbg"
npm_prefix() { npm_config_prefix="$PREFIX" "$@"; }

if [[ "${1:-}" == "uninstall" ]]; then
  (cd "$REPO" && npm_prefix npm unlink -g laobaigan >/dev/null)
  echo "Removed $BIN"
  exit 0
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
(( node_major >= 24 )) || { echo "lbg needs Node >= 24 (found: $(node -v 2>/dev/null || echo none))" >&2; exit 1; }

# The previous install was a plain symlink to src/cli.ts; npm won't overwrite it.
if [[ -L "$BIN" && "$(readlink "$BIN")" == */src/cli.ts ]]; then
  rm "$BIN"
  echo "Replaced the old symlink $BIN"
elif [[ -e "$BIN" && ! -L "$BIN" ]]; then
  echo "$BIN exists and isn't a link; refusing to overwrite" >&2
  exit 1
fi

[[ -d "$REPO/node_modules" ]] || (cd "$REPO" && npm ci)
(cd "$REPO" && npm_prefix npm link --no-fund --no-audit >/dev/null)
echo "Installed $BIN -> $(readlink -f "$BIN")"

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "Note: $PREFIX/bin is not on PATH; add it to your shell profile." ;;
esac
found="$(command -v lbg || true)"
if [[ -n "$found" && "$found" != "$BIN" ]]; then
  echo "Note: \`lbg\` on PATH resolves to $found, not $BIN. Remove the other one, or put $PREFIX/bin first in PATH."
fi
