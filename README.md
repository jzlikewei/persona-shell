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

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消当前正在处理的消息（SIGINT + resume） |
| `/flush` | 当前会话 | 有状态的上下文刷新（checkpoint → 杀进程 → 新 session → bootstrap） |
| `/restart` | 全局 | 重启整个 Shell 进程（launchd 自动拉起，代码更新生效） |

命令语义详见 `docs/architecture.md` 附录 A。

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

## 日志

| 日志 | 路径 |
|------|------|
| Shell stdout | `logs/bridge.stdout.log` |
| Shell stderr | `logs/bridge.stderr.log` |
| 消息队列 | `logs/queue.log` |
| Director stderr | `/tmp/persona/director-stderr.log` |
| 会话输出 | `logs/{label}/output-{date}.log` |
| 会话输入 | `logs/{label}/input-{date}.log` |

## 运行时文件

| 文件 | 路径 | 说明 |
|------|------|------|
| Director PID | `/tmp/persona/director.pid` | 主 Director 进程 ID |
| Director Session | `/tmp/persona/director-session` | 当前 session ID，用于 `--resume` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` | Shell ↔ Director 通信 |
| Pool Director | `/tmp/persona/{label}/` | 群聊 Director 的 PID / FIFO / session |

## Console API（运维）

Shell 在 `http://localhost:3000` 提供 Web 管理控制台 + HTTP API，仅监听 localhost。

**Web 控制台**：浏览器打开 `http://localhost:3000`，提供：
- 系统状态面板（Director/Token/Queue/Uptime）
- 会话消息查看（支持流式 streaming bubble 实时显示回复）
- DirectorPool 群聊 Director 列表（Groups 面板，点击查看对应群的会话）
- 后台任务管理 + Cron Jobs 管理
- 操作按钮：Flush / Esc / Restart

**HTTP API**：

```bash
# 生命周期管理
curl -X POST localhost:3000/api/flush     # 刷新 Director 上下文
curl -X POST localhost:3000/api/esc       # 取消当前处理中的消息
curl -X POST localhost:3000/api/restart   # 重启 Director 进程

# 向 Director 发消息（绕过飞书）
curl -X POST localhost:3000/api/send -H "Content-Type: application/json" -d '{"text":"你好"}'

# 任务管理
curl localhost:3000/api/tasks                          # 任务列表
curl -X POST localhost:3000/api/tasks -H "Content-Type: application/json" \
  -d '{"role":"explorer","description":"测试","prompt":"hello"}'
curl localhost:3000/api/tasks/{id}                     # 任务详情
curl -X POST localhost:3000/api/tasks/{id}/cancel      # 取消任务

# 会话查看（支持 ?director={label} 查询 pool Director）
curl localhost:3000/api/messages?limit=100
curl localhost:3000/api/sessions
```

详细协议见 `docs/web-console-plan.md`。

## 架构

```
飞书消息 → TS Shell → MessageQueue → Director (主, named pipe)
              │                         │
              │  群聊 → DirectorPool ─→ Director (群1)
              │                    └──→ Director (群2)
              │
              └── Web Console (localhost:3000)
                    ├─ 状态快照 (1s WebSocket)
                    ├─ 流式 chunk (实时 WebSocket)
                    └─ HTTP API
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
│   ├── index.ts               # 入口，编排层
│   ├── feishu.ts              # 飞书 WebSocket 客户端
│   ├── messaging.ts           # MessagingClient 接口
│   ├── messaging-router.ts    # 多渠道路由器
│   ├── director.ts            # Director 进程管理 + named pipe + FLUSH + chunk 事件
│   ├── director-pool.ts       # DirectorPool 多 Director 实例管理
│   ├── queue.ts               # 消息队列（correlation ID + cancel）
│   ├── console.ts             # Web 控制台 + API + WebSocket 广播
│   ├── task-runner.ts         # 后台任务进程管理
│   ├── task-store.ts          # 任务/Cron SQLite 存储
│   ├── scheduler.ts           # Cron 调度器
│   ├── persona-process.ts     # Persona 实例 spawn
│   ├── config.ts              # 配置加载
│   └── public/index.html      # Web 控制台前端 SPA
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
