# Persona Shell

飞书 ↔ Director（Claude Code）消息桥接服务。

配套身份/记忆仓库：`~/.persona/`

## 快速开始

```bash
# 安装依赖
bun install

# 配置
cp config.example.yaml ~/.persona/config.yaml
# 编辑 ~/.persona/config.yaml，填入飞书 App ID / Secret

# 运行
bun run dev
```

## 配置说明

配置文件位于 `~/.persona/config.yaml`（不在项目目录内，避免密钥泄露）。

```yaml
feishu:
  app_id: "cli_xxxx"
  app_secret: "xxxx"

director:
  persona_dir: "~/.persona"               # 身份/记忆仓库路径
  pipe_dir: "/tmp/persona"                # named pipe 存放
  pid_file: "/tmp/persona/director.pid"
  claude_path: "claude"
  time_sync_interval_hours: 2             # 时间同步注入间隔（小时）
  flush_context_limit: 700000             # 上下文 token 阈值，超过自动 flush
  flush_interval_days: 7                  # 距上次 flush 最大天数
```

## 飞书命令

| 命令 | 说明 |
|------|------|
| `/esc` | 取消当前正在处理的消息（SIGINT 中断 + 自动重启） |
| `/flush` | 手动刷新 Director 上下文（checkpoint → 重启 → 恢复） |

## 服务化（launchd）

```bash
# 安装并启动（自动生成 plist，路径从项目目录推断）
bun run install-service

# 管理
launchctl start com.persona.shell
launchctl stop  com.persona.shell

# 卸载
bun run uninstall-service
```

## Console API（运维）

Shell 在 `http://localhost:3000` 提供生命周期管理 API，仅限运维手动操作，不对 Director 暴露。

```bash
curl -X POST localhost:3000/api/flush     # 刷新 Director 上下文
curl -X POST localhost:3000/api/esc       # 取消当前处理中的消息
curl -X POST localhost:3000/api/restart   # 重启 Director 进程
```

## 架构

```
飞书消息 → TS Shell → named pipe (FIFO) → Director (Claude Code) → 回复
                                              │
                                              ├─ cwd = ~/.persona/
                                              ├─ --bare + --add-dir (CLAUDE.md)
                                              ├─ --plugin-dir (personas/, skills/)
                                              └─ spawn Persona 实例 (claude -p, detached)
```

### FLUSH 机制

Director 作为长驻 daemon 运行，上下文窗口会持续膨胀。FLUSH 定期重启认知：

1. **Drain** — 等待 in-flight 消息处理完成
2. **Checkpoint** — Director 将工作状态保存到 `daily/state.md`
3. **Reset** — kill 进程 + 清空 session
4. **Bootstrap** — 新 Director 读取 `state.md` 恢复上下文

触发条件：上下文超 700k token 或距上次 flush 超 7 天。支持 `/flush` 手动触发。

### 时间同步

Director session 跨天时 `currentDate` 会过期。Shell 在消息间隔超过 2 小时时自动注入时间前缀。

## 目录结构

```
persona-shell/               # 本仓库（基础设施代码）
├── src/
│   ├── index.ts               # 入口
│   ├── feishu.ts              # 飞书 WebSocket 客户端
│   ├── director.ts            # Director 进程管理 + named pipe + FLUSH
│   ├── queue.ts               # 消息队列（correlation ID + cancel）
│   ├── persona-runner.ts      # Persona 实例 spawn
│   └── config.ts              # 配置加载（默认 ~/.persona/config.yaml）
├── config.example.yaml
├── start.sh                   # launchd wrapper（source shell profile）
├── com.persona.shell.plist   # launchd 服务定义
├── docs/                      # 设计文档 + 审查报告
└── logs/

~/.persona/                    # 身份/记忆仓库（独立 git）
├── CLAUDE.md                  # Soul 层
├── config.yaml                # 运行配置（含密钥，不进 git）
├── personas/                  # 人格定义（Explorer/Executor/Critic/Introspector）
├── skills/                    # Skill 定义（orchestrate/soul-crafting）
├── daily/                     # 日报 + state.md
│   └── state.md               # Director 工作记忆（FLUSH checkpoint）
├── inbox/ outbox/             # 人格通信
└── audit_log/                 # 决策日志
```
