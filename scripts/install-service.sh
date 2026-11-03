#!/usr/bin/env bash
# Install (or uninstall) the laobaigan systemd user service + hourly timer.
#   scripts/install-service.sh            install / update and start the timer
#   scripts/install-service.sh uninstall  stop and remove
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ "${1:-}" == "uninstall" ]]; then
  systemctl --user disable --now laobaigan.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/laobaigan.service" "$UNIT_DIR/laobaigan.timer"
  systemctl --user daemon-reload
  echo "Removed. State is kept in ~/.local/state/laobaigan."
  exit 0
fi

# Resolve node to an absolute path. mise shims need a shell environment, so resolve
# them; `.../mise/installs/node/24/bin/node` is kept as-is (stable across 24.x upgrades).
NODE="${NODE:-$(command -v node)}"
if [[ "$NODE" == */mise/shims/* ]]; then
  NODE="$(mise which node)"
fi
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( major >= 24 )) || { echo "Need Node >= 24, found $("$NODE" -v) at $NODE" >&2; exit 1; }

[[ -d "$REPO/node_modules" ]] || (cd "$REPO" && npm ci)

mkdir -p "$UNIT_DIR"
sed -e "s#@NODE@#$NODE#g" -e "s#@REPO@#$REPO#g" "$REPO/systemd/laobaigan.service.in" >"$UNIT_DIR/laobaigan.service"
cp "$REPO/systemd/laobaigan.timer" "$UNIT_DIR/laobaigan.timer"
systemctl --user daemon-reload
systemctl --user enable --now laobaigan.timer

echo "Installed: node=$NODE repo=$REPO"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "Note: lingering is off, so the timer only runs while you're logged in."
  echo "      Enable with: loginctl enable-linger $USER"
fi
systemctl --user list-timers laobaigan.timer --no-pager
