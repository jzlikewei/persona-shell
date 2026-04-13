#!/bin/bash
set -e

PERSONA_DIR="$HOME/.persona"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔧 Persona Shell 初始化"
echo ""

# 1. 安装依赖
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦 安装依赖..."
  cd "$SCRIPT_DIR" && bun install
fi

# 2. 初始化身份仓库
if [ -d "$PERSONA_DIR" ]; then
  echo "⚠️  $PERSONA_DIR 已存在，跳过模板复制"
else
  echo "📁 初始化身份仓库 → $PERSONA_DIR"
  cp -r "$SCRIPT_DIR/persona-template" "$PERSONA_DIR"
  cd "$PERSONA_DIR" && git init -q && git add -A && git commit -q -m "init persona"
  echo "   ✓ 已创建并初始化 git"
fi

# 3. 配置飞书凭据
CONFIG="$PERSONA_DIR/config.yaml"
if [ ! -f "$CONFIG" ]; then
  cp "$SCRIPT_DIR/config.example.yaml" "$CONFIG"
  echo ""
  echo "📝 请输入飞书应用凭据（从开放平台控制台获取）："
  printf "   App ID: "
  read -r APP_ID
  printf "   App Secret: "
  read -r APP_SECRET

  if [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ]; then
    sed -i '' "s/cli_xxxx/$APP_ID/" "$CONFIG" 2>/dev/null || sed -i "s/cli_xxxx/$APP_ID/" "$CONFIG"
    sed -i '' "s/app_secret: \"xxxx\"/app_secret: \"$APP_SECRET\"/" "$CONFIG" 2>/dev/null || sed -i "s/app_secret: \"xxxx\"/app_secret: \"$APP_SECRET\"/" "$CONFIG"
    echo "   ✓ 凭据已写入 $CONFIG"
  else
    echo "   ⏭️  跳过，请稍后手动编辑 $CONFIG"
  fi
else
  echo "✓ 配置文件已存在：$CONFIG"
fi

echo ""
echo "✅ 初始化完成！"
echo ""
echo "后续步骤："
echo "  1. 自定义你的分身：cd ~/.persona && claude /soul-crafting"
echo "  2. 启动：bun run dev"
