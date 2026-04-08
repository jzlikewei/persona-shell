#!/bin/sh

PLIST_DST="$HOME/Library/LaunchAgents/com.persona.bridge.plist"

if [ -f "${PLIST_DST}" ]; then
  launchctl unload "${PLIST_DST}" 2>/dev/null || true
  rm "${PLIST_DST}"
  echo "Service uninstalled."
else
  echo "Service not installed."
fi
