#!/bin/sh
# Install dtmux's macOS login pieces for the current user:
#   com.dima.dtmux        runs `dtmux start` at login
#   com.dima.dtmux.guard  DtmuxGuard.app, which stops dtmux gently before a
#                         logout, restart or shutdown (see DtmuxGuard.swift)
# Run again after changing DtmuxGuard.swift. Needs swiftc (Xcode or its
# command line tools). Undo: launchctl bootout gui/$(id -u)/<label> and
# remove the plist from ~/Library/LaunchAgents.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
TMUX_PATH=$(command -v tmux || true)
AGENTS="$HOME/Library/LaunchAgents"
APP="$HOME/Library/Application Support/dtmux/DtmuxGuard.app"
LOGS="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"
PATH_ENV="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$APP/Contents/MacOS" "$AGENTS" "$LOGS"
swiftc -O -o "$APP/Contents/MacOS/DtmuxGuard" "$ROOT/macos/DtmuxGuard.swift"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.dima.dtmux.guard</string>
  <key>CFBundleName</key><string>DtmuxGuard</string>
  <key>CFBundleExecutable</key><string>DtmuxGuard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

env_xml() {
  cat <<EOF
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>TMUX_BIN</key><string>${TMUX_PATH:-tmux}</string>
  </dict>
EOF
}

# `dtmux start` once at login; the daemon detaches and must outlive the job.
cat > "$AGENTS/com.dima.dtmux.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dima.dtmux</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/bin/dtmux.js</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
$(env_xml)
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>StandardOutPath</key><string>$LOGS/dtmux-launchd.log</string>
  <key>StandardErrorPath</key><string>$LOGS/dtmux-launchd.log</string>
</dict></plist>
EOF

# The guard: always running in the login session.
cat > "$AGENTS/com.dima.dtmux.guard.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dima.dtmux.guard</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/DtmuxGuard</string><string>$NODE</string><string>$ROOT/bin/dtmux.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
$(env_xml)
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>StandardOutPath</key><string>$LOGS/dtmux-guard.log</string>
  <key>StandardErrorPath</key><string>$LOGS/dtmux-guard.log</string>
</dict></plist>
EOF

for label in com.dima.dtmux com.dima.dtmux.guard; do
  plutil -lint "$AGENTS/$label.plist" >/dev/null
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl enable "$DOMAIN/$label"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
done
echo "installed: com.dima.dtmux (start at login), com.dima.dtmux.guard ($APP)"
