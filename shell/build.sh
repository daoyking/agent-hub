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
</dict>
</plist>
PLIST

echo "OK: $APP"
