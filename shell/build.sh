#!/bin/bash
# P2-3 桌面壳构建：swiftc 直编 → ~/Applications/agentbd-panel.app
# 用法: bash shell/build.sh [目标.app 路径]
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/Applications/agentbd-panel.app}"
BIN="$APP/Contents/MacOS/agentbd-panel"

# 编译（系统 Swift 工具链，arm64，macOS 13+）
swiftc -O -target arm64-apple-macos13.0 \
  -o /tmp/agentbd-panel-bin \
  "$SRC_DIR/AgentbdPanel.swift" "$SRC_DIR/LampProbe.swift" \
  -framework Cocoa -framework WebKit

# 组 bundle
mkdir -p "$(dirname "$BIN")"
cp /tmp/agentbd-panel-bin "$BIN"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agentbd-panel</string>
  <key>CFBundleIdentifier</key><string>ai.agentbd.panel</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleExecutable</key><string>agentbd-panel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleIconFile</key><string>menubar</string>
</dict>
</plist>
PLIST

# 菜单栏图标：SVG → template PNG（@1x 18pt / @2x 36pt）
# 必须是 template image（单色 + 透明底），macOS 才会按菜单栏深浅色自动反相。
mkdir -p "$APP/Contents/Resources"
ICON_DIR="$SRC_DIR/icons"
mkdir -p "$ICON_DIR"
if [ ! -f "$ICON_DIR/menubar.png" ] || [ "$SRC_DIR/agentbd-menubar.svg" -nt "$ICON_DIR/menubar.png" ]; then
  qlmanage -t -s 18 -o "$ICON_DIR" "$SRC_DIR/agentbd-menubar.svg" >/dev/null 2>&1
  mv -f "$ICON_DIR/agentbd-menubar.svg.png" "$ICON_DIR/menubar.png"
  qlmanage -t -s 36 -o "$ICON_DIR" "$SRC_DIR/agentbd-menubar.svg" >/dev/null 2>&1
  mv -f "$ICON_DIR/agentbd-menubar.svg.png" "$ICON_DIR/menubar@2x.png"
fi
cp "$ICON_DIR/menubar.png" "$ICON_DIR/menubar@2x.png" "$APP/Contents/Resources/"

echo "OK: $APP"
