#!/bin/sh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.persona.shell.plist"
PLIST_SRC="${PROJECT_DIR}/${PLIST_NAME}"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}"

echo "Project dir: ${PROJECT_DIR}"

# Generate plist with actual paths
sed "s|__PROJECT_DIR__|${PROJECT_DIR}|g" "${PLIST_SRC}" > "${PLIST_DST}"

# Ensure logs dir exists
mkdir -p "${PROJECT_DIR}/logs"

# Service env file for launchd-only secrets (optional)
SERVICE_ENV="$HOME/.persona/service.env"
if [ ! -f "${SERVICE_ENV}" ]; then
  cat > "${SERVICE_ENV}" <<'EOF'
# Launchd-only environment for persona-shell.
# Example:
# export GH_TOKEN=ghp_xxx
# export GITHUB_TOKEN=ghp_xxx
EOF
  chmod 600 "${SERVICE_ENV}"
fi

# Load service
launchctl unload "${PLIST_DST}" 2>/dev/null || true
launchctl load "${PLIST_DST}"

echo "Service installed and started."
echo "  plist: ${PLIST_DST}"
echo "  logs:  ${PROJECT_DIR}/logs/"
