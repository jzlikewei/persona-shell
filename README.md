# Persona

AI 分身系统。替本体做事与探索，通过记忆同步保持对齐。

## 快速开始

### 1. 安装依赖

```bash
cd bridge && bun install
```

### 2. 配置

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入飞书 App ID 和 App Secret
```

### 3. 运行

```bash
# 开发模式
bun run dev

# 注册为系统服务（开机自启 + 崩溃重启）
ln -sf $(pwd)/com.persona.bridge.plist ~/Library/LaunchAgents/com.persona.bridge.plist
launchctl load ~/Library/LaunchAgents/com.persona.bridge.plist
```

### 服务管理

```bash
launchctl start com.persona.bridge     # 启动
launchctl stop  com.persona.bridge     # 停止
launchctl unload ~/Library/LaunchAgents/com.persona.bridge.plist  # 卸载

# 日志
tail -f bridge/logs/bridge.stdout.log
tail -f bridge/logs/bridge.stderr.log
```

## 架构

```
飞书消息 → TS Bridge → named pipe (FIFO) → Director (Claude Code) → 回复
                                              │
                                              ├─ spawn Persona 实例 (claude -p, detached)
                                              └─ 读写记忆层 (CLAUDE.md + .claude/memory/)
```

- **TS Bridge** — 飞书 WebSocket ↔ Director 消息桥接，launchd 守护
- **Director** — Claude Code 长驻进程，stream-json 双向通信，代表本体意志
- **Persona 实例** — 独立 claude -p 进程，四类人格按需 spawn

### 记忆层（五层渐进式披露）

| 层 | 文件 | 更新频率 | Claude Code 原生支持 |
|----|------|---------|---------------------|
| Soul | `CLAUDE.md` | 几乎不变 | ✅ 自动加载 |
| Core | `.claude/memory/*` | 月级 | ✅ auto memory |
| Work | `.claude/memory/*` | 周级 | ✅ auto memory |
| Project | 各项目 `CLAUDE.md` | 天级 | ✅ 项目隔离 |
| Daily | `daily/*` | 小时级 | ❌ 自建 |

### 四类人格

| 类型 | 驱动力 | 工具权限 | 方向 |
|------|--------|---------|------|
| Explorer | 好奇心 | 只读 | 外 |
| Executor | 结果 | 读写 | 外 |
| Critic | 风险 | 只读 | 外 |
| Introspector | 元认知 + 哲学 | 只读 | 内 |

## 目录结构

```
persona/
├── CLAUDE.md                  # Soul 层
├── bridge/
│   ├── src/
│   │   ├── index.ts           # 入口
│   │   ├── feishu.ts          # 飞书 WebSocket 客户端
│   │   ├── director.ts        # Director 进程管理 + named pipe
│   │   ├── queue.ts           # 消息队列（correlation ID）
│   │   ├── persona-runner.ts  # Persona 实例 spawn
│   │   └── config.ts          # YAML 配置加载
│   ├── config.example.yaml    # 配置模板
│   └── com.persona.bridge.plist  # launchd 服务
├── personas/                  # 人格定义
│   ├── explorer.md
│   ├── executor.md
│   ├── critic.md
│   └── introspector.md
├── skills/
│   └── soul-crafting.md       # 造魂引导 skill
├── daily/                     # 日报
├── inbox/                     # 人格通信
├── outbox/                    # 人格产出
├── audit_log/                 # 决策日志
└── docs/
    ├── architecture.md        # 完整架构设计
    └── research-claude-cli-streaming.md
```

## 详细文档

- [架构设计](docs/architecture.md) — 完整的系统设计：记忆层、人格体系、通信协议、FLUSH 机制
- [CLI 调研](docs/research-claude-cli-streaming.md) — Claude Code stream-json 双向通信方案
