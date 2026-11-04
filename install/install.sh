#!/usr/bin/env sh
# Tempolight installer for Linux, Raspberry Pi OS and macOS.
#   curl -fsSL https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.sh | sh
#   ... | sh -s -- --service     also start Tempolight at boot (systemd, Linux only)
# What it does: checks for Node.js 20+ (offers to install it on Debian/Ubuntu/Raspberry Pi OS), puts Tempolight in
# ~/.local/share/tempolight, adds a `tempolight` command to ~/.local/bin, and optionally a systemd service.
set -eu

REPO="${TEMPOLIGHT_REPO:-D4RKGEEK/tempolight}"
BRANCH="${TEMPOLIGHT_BRANCH:-main}"
DEST="${TEMPOLIGHT_HOME:-$HOME/.local/share/tempolight}"
BIN="$HOME/.local/bin"
GIT_URL="${TEMPOLIGHT_GIT_URL:-https://github.com/$REPO.git}"
SERVICE=0
for a in "$@"; do case "$a" in --service) SERVICE=1 ;; esac; done

say() { printf '\033[1;33m>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

# ---- Node.js
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  if [ "$(uname)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    say "Tempolight needs Node.js 20 or newer. Installing Node.js 22 from NodeSource (needs sudo)…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E sh - && sudo apt-get install -y nodejs || die "Couldn't install Node.js. Install it from https://nodejs.org and run this again."
  elif [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "Installing Node.js with Homebrew…"; brew install node
  else
    die "Tempolight needs Node.js 20 or newer. Install it from https://nodejs.org and run this again."
  fi
fi
say "Node.js $(node -v)"

# ---- Tempolight
mkdir -p "$DEST" "$BIN"
if command -v git >/dev/null 2>&1; then
  if [ -d "$DEST/.git" ]; then say "Updating $DEST"; git -C "$DEST" pull --ff-only -q
  else rm -rf "$DEST"; say "Downloading Tempolight to $DEST"; git clone -q --depth 1 -b "$BRANCH" "$GIT_URL" "$DEST"; fi
else
  say "Downloading Tempolight to $DEST"
  tmp="$(mktemp -d)"; curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp"
  rm -rf "$DEST"; mv "$tmp"/* "$DEST"; rm -rf "$tmp"
fi

cat > "$BIN/tempolight" <<EOF
#!/usr/bin/env sh
exec node "$DEST/packages/server/src/index.js" "\$@"
EOF
chmod +x "$BIN/tempolight"
case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to use the tempolight command (or run $BIN/tempolight)";; esac

# ---- optional: start at boot
if [ "$SERVICE" = 1 ]; then
  [ "$(uname)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 || die "--service needs Linux with systemd"
  say "Installing a systemd service (needs sudo)…"
  sudo tee /etc/systemd/system/tempolight.service >/dev/null <<EOF
[Unit]
Description=Tempolight music-reactive lighting
After=network-online.target sound.target
Wants=network-online.target

[Service]
User=$(id -un)
Environment=TEMPOLIGHT_DATA=$HOME/.tempolight
# one-click updates exit with code 3 and systemd starts the new version
Environment=TEMPOLIGHT_SUPERVISED=1
ExecStart=$(command -v node) $DEST/packages/server/src/index.js --port 8080
Restart=always
RestartSec=3
Nice=-5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload && sudo systemctl enable --now tempolight
  say "Tempolight is running and will start at boot. Logs: journalctl -u tempolight -f"
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  say "Open http://${IP:-localhost}:8080 on your phone or computer."
else
  say "Installed. Start it with:  tempolight --open"
fi
