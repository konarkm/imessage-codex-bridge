#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$ROOT_DIR/launchd/com.imessage.codex.bridge.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.imessage.codex.bridge.plist"

if [ ! -f "$PLIST_TEMPLATE" ]; then
  echo "Missing template: $PLIST_TEMPLATE" >&2
  exit 1
fi

sed "s#/ABSOLUTE/PATH/TO/imessage-codex-bridge#$ROOT_DIR#g" "$PLIST_TEMPLATE" > "$TARGET_PLIST"

launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl load "$TARGET_PLIST"

echo "Installed launchd agent: $TARGET_PLIST"
echo "Logs: /tmp/imessage-codex-bridge.out.log and /tmp/imessage-codex-bridge.err.log"
