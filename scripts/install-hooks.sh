#!/bin/sh
# 把仓库内 scripts/hooks 设为本仓库的 git hooks 目录。
# 仅影响当前仓库的 .git/config(不污染你的全局 hooksPath)。
#
# 为什么需要这一步?
# 你全局可能配了 core.hooksPath = ~/.git-hooks(ai-commit 之类的工具)。
# 直接往本仓库 .git/hooks/ 写脚本会被忽略。设仓库级 core.hooksPath 是最干净的覆盖方式。

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config core.hooksPath scripts/hooks
echo "✓ git core.hooksPath → scripts/hooks (仓库级,覆盖全局设置)"

# 确保所有 hook 脚本都可执行
chmod +x scripts/hooks/* 2>/dev/null || true

# 列出当前生效的 hooks
echo "  生效 hooks:"
for hook in scripts/hooks/*; do
  [ -f "$hook" ] && echo "    $(basename "$hook")"
done
