#!/bin/sh
# Install dtmux.app for the current user, run at login by the LaunchAgent
# com.dima.dtmux. The app starts dtmux, so macOS privacy permissions given to
# dtmux.app cover dtmux and everything in its tabs, and it stops dtmux gently
# before a logout, restart or shutdown (see dtmux-app.swift).
#
# Run again after changing dtmux-app.swift. The app is rebuilt only when its
# source changed: a rebuilt app is new to macOS, which then asks for its
# permissions again. Needs swiftc (Xcode or its command line tools).
# Undo: launchctl bootout gui/$(id -u)/com.dima.dtmux, then remove
# ~/Library/LaunchAgents/com.dima.dtmux.plist and the app.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
TMUX_PATH=$(command -v tmux || true)
AGENTS="$HOME/Library/LaunchAgents"
APPS="$HOME/Library/Application Support/dtmux"
APP="$APPS/dtmux.app"
LOGS="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"
LABEL=com.dima.dtmux
PATH_ENV="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# The earlier two-piece setup: a LaunchAgent running node directly, and
# DtmuxGuard.app. Stopping the guard does not touch a running dtmux.
launchctl bootout "$DOMAIN/com.dima.dtmux.guard" 2>/dev/null || true
rm -f "$AGENTS/com.dima.dtmux.guard.plist"
rm -rf "$APPS/DtmuxGuard.app"

mkdir -p "$AGENTS" "$LOGS"
SUM=$(shasum -a 256 < "$ROOT/macos/dtmux-app.swift" | cut -c1-16)
if [ "$(cat "$APP/Contents/Resources/source.sum" 2>/dev/null)" != "$SUM" ]; then
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  swiftc -O -o "$APP/Contents/MacOS/dtmux" "$ROOT/macos/dtmux-app.swift"
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>dtmux</string>
  <key>CFBundleDisplayName</key><string>dtmux</string>
  <key>CFBundleExecutable</key><string>dtmux</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$SUM</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
  echo "$SUM" > "$APP/Contents/Resources/source.sum"
  # One signature over the whole bundle, under its bundle id, which is the
  # identity macOS keeps its permissions under.
  codesign --force --sign - --identifier "$LABEL" "$APP"
  echo "built $APP"
else
  echo "$APP is up to date (its permissions stay)"
fi

# dtmux's own tmux (see OWN_TMUX in server/tmux-control.js): a copy of the
# installed tmux under its own name and identity, so a permission given to
# it is dtmux's alone. Copied again only when the installed tmux changed
# (a copy is new to macOS, which then asks again).
OWN_TMUX="$APPS/dtmux-tmux"
if [ -n "$TMUX_PATH" ]; then
  REAL_TMUX=$(readlink -f "$TMUX_PATH")
  if [ "$(shasum -a 256 < "$REAL_TMUX")" != "$(cat "$OWN_TMUX.source" 2>/dev/null)" ]; then
    cp "$REAL_TMUX" "$OWN_TMUX.new"
    codesign --force --sign - --identifier "$LABEL.tmux" "$OWN_TMUX.new"
    mv "$OWN_TMUX.new" "$OWN_TMUX"
    shasum -a 256 < "$REAL_TMUX" > "$OWN_TMUX.source"
    echo "copied $REAL_TMUX to $OWN_TMUX ($("$OWN_TMUX" -V))"
  else
    echo "$OWN_TMUX is up to date (its permissions stay)"
  fi
fi

cat > "$AGENTS/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/dtmux</string><string>$NODE</string><string>$ROOT/bin/dtmux.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>PATH</key><string>$PATH_ENV</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>StandardOutPath</key><string>$LOGS/dtmux-app.log</string>
  <key>StandardErrorPath</key><string>$LOGS/dtmux-app.log</string>
</dict></plist>
EOF
plutil -lint "$AGENTS/$LABEL.plist" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl enable "$DOMAIN/$LABEL"
# bootout returns before the old app is gone; bootstrap fails until it is.
for try in 1 2 3 4 5 6 7 8 9 10; do
  launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL.plist" 2>/dev/null && break
  [ "$try" = 10 ] && { echo "launchctl bootstrap $LABEL failed" >&2; exit 1; }
  sleep 1
done
echo "installed: $LABEL runs $APP at login"
echo "Give both Full Disk Access once: System Settings > Privacy & Security > Full Disk Access > +, then:"
echo "  $APP"
echo "  $OWN_TMUX"
