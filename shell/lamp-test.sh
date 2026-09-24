#!/bin/bash
# 托盘灯色判定单测：bash shell/lamp-test.sh
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
swiftc -O -target arm64-apple-macos13.0 \
  -o /tmp/agentbd-lamp-test \
  "$SRC_DIR/lamp-test.swift" "$SRC_DIR/LampProbe.swift"
/tmp/agentbd-lamp-test
