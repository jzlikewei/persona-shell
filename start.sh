#!/bin/zsh
# Wrapper script for launchd — loads user's full shell environment.
# launchd doesn't source .zshrc, so tools like bun/gh are otherwise missing.

# Source profile files to get full PATH.
# Use || true to prevent non-interactive warnings from aborting startup.
[[ -f ~/.zprofile ]] && source ~/.zprofile 2>/dev/null || true
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null || true

# Use GitHub CLI keyring auth if available.
if command -v gh &>/dev/null; then
  GH_CLI_TOKEN="$(gh auth token 2>/dev/null)"
  if [[ -n "${GH_CLI_TOKEN}" ]]; then
    export GH_TOKEN="${GH_CLI_TOKEN}"
  fi
fi

cd "$(dirname "$0")" || exit 1
exec bun src/index.ts
