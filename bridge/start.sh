#!/bin/zsh
# Wrapper script for launchd — loads user's full shell environment
# launchd doesn't source .zshrc, so tools like bun/claude/go are missing from PATH

# Source profile files to get full PATH
# Use || true to prevent non-interactive warnings from killing the script
[[ -f ~/.zprofile ]] && source ~/.zprofile 2>/dev/null || true
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null || true

cd "$(dirname "$0")" || exit 1
exec bun src/index.ts
