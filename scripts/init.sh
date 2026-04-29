#!/bin/bash
set -e

PERSONA_DIR="$HOME/.persona"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "🔧 Persona Shell 初始化"
echo ""

# 1. 安装依赖
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "📦 安装依赖..."
  cd "$PROJECT_DIR" && bun install
fi

# 2. 初始化身份仓库
if [ -d "$PERSONA_DIR" ]; then
  echo "⚠️  $PERSONA_DIR 已存在，跳过模板复制"
  if [ ! -L "$PERSONA_DIR/.claude/skills" ]; then
    mkdir -p "$PERSONA_DIR/.claude"
    ln -sf ../skills "$PERSONA_DIR/.claude/skills"
    echo "   ✓ 已补建 .claude/skills 软链接"
  fi
  if [ ! -L "$PERSONA_DIR/.agents/skills" ]; then
    mkdir -p "$PERSONA_DIR/.agents"
    ln -sf ../skills "$PERSONA_DIR/.agents/skills"
    echo "   ✓ 已补建 .agents/skills 软链接"
  fi
else
  echo "📁 初始化身份仓库 → $PERSONA_DIR"
  cp -r "$PROJECT_DIR/persona-template" "$PERSONA_DIR"
  mkdir -p "$PERSONA_DIR/.claude"
  ln -sf ../skills "$PERSONA_DIR/.claude/skills"
  echo "   ✓ 已创建 .claude/skills 软链接"
  mkdir -p "$PERSONA_DIR/.agents"
  ln -sf ../skills "$PERSONA_DIR/.agents/skills"
  echo "   ✓ 已创建 .agents/skills 软链接"
  cd "$PERSONA_DIR" && git init -q && git add -A && git commit -q -m "init persona"
  echo "   ✓ 已创建并初始化 git"
fi

# 3. 配置飞书凭据
CONFIG="$PERSONA_DIR/config.yaml"
IM_SECRET_CONFIG="$PERSONA_DIR/im_secret.yaml"
if [ ! -f "$CONFIG" ]; then
  cp "$PROJECT_DIR/config.example.yaml" "$CONFIG"
  echo ""
  echo "📝 请输入飞书应用凭据（从开放平台控制台获取）："
  printf "   App ID: "
  read -r APP_ID
  printf "   App Secret: "
  read -r APP_SECRET

  if [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ]; then
    printf 'feishu:\n  app_id: "%s"\n  app_secret: "%s"\n' "$APP_ID" "$APP_SECRET" > "$IM_SECRET_CONFIG"
    echo "   ✓ 飞书凭据已写入 $IM_SECRET_CONFIG"
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
