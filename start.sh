#!/bin/zsh
# Wrapper script for launchd — loads user's full shell environment
# launchd doesn't source .zshrc, so tools like bun/claude/go are missing from PATH

# Source profile files to get full PATH
# Use || true to prevent non-interactive warnings from killing the script
[[ -f ~/.zprofile ]] && source ~/.zprofile 2>/dev/null || true
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null || true

# Optional service-scoped env vars (for launchd-only secrets such as GH_TOKEN)
SERVICE_ENV="$HOME/.persona/service.env"
[[ -f "${SERVICE_ENV}" ]] && source "${SERVICE_ENV}" 2>/dev/null || true

# Auto-inherit GitHub token from gh CLI auth store if not already set
if [[ -z "${GH_TOKEN}" ]] && command -v gh &>/dev/null; then
  export GH_TOKEN="$(gh auth token 2>/dev/null)"
fi

cd "$(dirname "$0")" || exit 1
exec bun src/index.ts
