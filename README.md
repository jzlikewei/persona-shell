# Persona Bridge

飞书 ↔ Director（Claude Code）消息桥接服务。

配套身份/记忆仓库：`~/.persona/`

## 快速开始

```bash
# 安装依赖
bun install

# 配置
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入飞书 App ID / Secret

# 运行
bun run dev
```

## 配置说明

```yaml
feishu:
  app_id: "cli_xxxx"
  app_secret: "xxxx"

director:
  persona_dir: "~/.persona"         # 身份/记忆仓库路径
  pipe_dir: "/tmp/persona"          # named pipe 存放
  pid_file: "/tmp/persona/director.pid"
  claude_path: "claude"
```

## 服务化（launchd）

```bash
ln -sf $(pwd)/com.persona.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.persona.bridge.plist

# 管理
launchctl start com.persona.bridge
launchctl stop  com.persona.bridge
launchctl unload ~/Library/LaunchAgents/com.persona.bridge.plist
```

## 架构

```
飞书消息 → TS Bridge → named pipe (FIFO) → Director (Claude Code) → 回复
                                              │
                                              ├─ cwd = ~/.persona/
                                              ├─ --bare + --add-dir (CLAUDE.md)
                                              ├─ --plugin-dir (personas/, skills/)
                                              └─ spawn Persona 实例 (claude -p, detached)
```

## 目录结构

```
persona-bridge/               # 本仓库（基础设施代码）
├── src/
│   ├── index.ts               # 入口
│   ├── feishu.ts              # 飞书 WebSocket 客户端
│   ├── director.ts            # Director 进程管理 + named pipe
│   ├── queue.ts               # 消息队列（correlation ID）
│   ├── persona-runner.ts      # Persona 实例 spawn
│   └── config.ts              # YAML 配置加载
├── config.example.yaml
├── start.sh                   # launchd wrapper（source shell profile）
├── com.persona.bridge.plist   # launchd 服务定义
└── logs/

~/.persona/                    # 身份/记忆仓库（独立 git）
├── CLAUDE.md                  # Soul 层
├── personas/                  # 人格定义
├── skills/                    # Skill 定义
├── daily/                     # 日报
├── inbox/ outbox/             # 人格通信
├── audit_log/                 # 决策日志
└── docs/                      # 架构文档
```
