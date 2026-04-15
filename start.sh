#!/bin/zsh
# Wrapper script for launchd — loads user's full shell environment
# launchd doesn't source .zshrc, so tools like bun/claude/go are missing from PATH

# Source profile files to get full PATH
# Use || true to prevent non-interactive warnings from killing the script
[[ -f ~/.zprofile ]] && source ~/.zprofile 2>/dev/null || true
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null || true

# 飞书是国内服务，不走代理（Lark SDK multipart 上传经代理会 ECONNRESET）
export no_proxy="${no_proxy:+$no_proxy,}open.feishu.cn,*.feishu.cn,*.larkoffice.com"
export NO_PROXY="$no_proxy"

cd "$(dirname "$0")" || exit 1
exec bun src/index.ts
