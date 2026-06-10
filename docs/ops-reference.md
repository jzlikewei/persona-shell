# 运维速查

## 服务管理

```bash
cd ~/github/jzlikewei/persona-shell && bun run install-service   # 安装/重装
launchctl start com.persona.shell                                # 启动
launchctl stop  com.persona.shell                                # 停止
```

服务模式专用环境变量文件：`~/.persona/service.env`

常见用途：给 `persona-shell` 和它拉起的 Codex 注入 `GH_TOKEN` / `GITHUB_TOKEN`。修改后需要重启服务生效。

## 飞书命令

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消队列中最早的消息 |
| `/flush` | 当前会话 | 保存上下文后刷新（checkpoint → 新 session → bootstrap） |
| `/clear` | 当前会话 | 清空上下文（不保存，直接重置） |
| `/session-restart` `/restart` | 当前会话 | 重启当前 Director 进程（CLAUDE.md、prompts 等会重新加载；config.yaml 不受影响） |
| `/shell-restart` `/restart-shell` | 全局 | 重启整个 Shell 进程（config.yaml、源代码等 Shell 启动时加载的内容重新生效） |
| `/status` | 当前会话 | 查看 Director 状态摘要（PID、token、队列等） |
| `/switch-agent <agent>` | 当前会话 | 切换当前会话的 Director agent；切换前先 flush 保存上下文，切换后自动恢复，并持久化该会话的 agent 选择 |
| `/start-with-codex` | 当前会话 | 快捷切换到 Codex Director 模式（等价于 `/switch-agent codex`） |
| `/start-with-claude` | 当前会话 | 快捷切回 Claude Director 模式（等价于 `/switch-agent claude`） |
| `/help` | 全局 | 列出所有可用命令 |
| `/persona <name>` | 当前会话 | 切换人格角色（如 philosopher, critic 等） |
| `/new-session` | 当前会话 | 丢弃当前 session，下次消息创建全新 session（进程保留，不 checkpoint）🔒 |

### 重启级别速查

| 改动类型 | 所需重启 | 原因 |
|----------|----------|------|
| CLAUDE.md / prompts/*.md | `/flush` 或 `/restart` | Director 启动时读取 |
| config.yaml: agent provider / model / defaults / roles | 无需重启 | Web 下拉、创建会话、切换 agent 时读取最新配置 |
| config.yaml: console 端口、persona_dir、pool 等进程级参数 | `/shell-restart` | Shell 启动时绑定端口和初始化运行目录 |
| service.env | 重启服务（launchctl stop/start） | 环境变量在进程启动时注入 |
| 源代码（src/） | `/shell-restart` | Shell 进程需要重启加载新代码 |

### Agent provider 与模型配置

Web 控制台的 agent 下拉、点「+ / OK」创建会话、运行时切换 agent、后台任务的 agent 参数都读取 `~/.persona/config.yaml` 的 `agents.providers`。provider 名就是可选择的 agent 名，例如 `claude`、`codex`。

```yaml
agents:
  defaults:
    director: "claude"
    explorer: "codex"
  roles:
    explorer:
      agent: "codex"
      model: "gpt-5.1"      # 角色级模型覆盖
  providers:
    claude:
      type: "claude"
      command: "claude"
      model: "claude-opus-4-6"  # provider 默认模型，可省略走 CLI 默认
    codex:
      type: "codex-app-server"
      command: "codex"
      model: "gpt-5.1"          # provider 默认模型，可省略走 Codex 默认
      sandbox: "danger-full-access"
      approval: "never"
```

模型解析优先级：`agents.roles.<role>.model` → `agents.providers.<agent>.model` → CLI 默认模型。Web 会话顶部显示的 model 来自运行时状态；如果 provider 没配置 `model`，启动初期可能为空，等后端回报模型后写入 session。

增删 provider、修改 provider model、修改 defaults/roles 后，重新打开下拉或点 OK 即读取最新配置。已经运行中的会话保持原 agent；切换 agent 或新建会话会使用最新 provider/model。

## 日志

| 日志 | 路径 |
|------|------|
| Shell stdout/stderr | `logs/shell.stdout.log` / `logs/shell.stderr.log` |
| 消息队列 | `logs/queue.log` |
| Director stderr (Claude) | `/tmp/persona/director-stderr.log` |
| 会话输入记录 | `logs/{label}/input-{YYYYMMDD}.log` |
| 会话输出记录 | `logs/{label}/output-{YYYYMMDD}.log` |

## 运行时文件

| 文件 | 路径 |
|------|------|
| Director PID | `/tmp/persona/director.pid` |
| Session ID | `/tmp/persona/director-session` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` |
| Pool runtime entry（Claude） | `/tmp/persona/{label}/`（runtime 实例目录，含 session / PID / FIFO） |
| Pool runtime entry（Codex） | `logs/{label}/` 为主要排障入口；session 文件落在 `/tmp/persona/{label}/session`；app-server stderr 在 `codex-app-server-stderr.log` |

Pool runtime entry / 历史文档中的 “Pool Director” 只是 DirectorPool 里的运行时实例别名，不是业务路由实体；业务路由以 workspace / sessionId 为准。当前默认 Codex pool runtime 是 app-server/live transport：Shell 为会话拉起长驻 `codex app-server --listen stdio://`；`codex-app-server` provider 的后台任务使用临时 App Server task runtime。legacy turn-based `codex exec` provider 已下线.

## Web 控制台

`http://localhost:3000`

| 入口 | 用途 |
|------|------|
| `/` | web-v2 主界面:Chat / Tasks / Files |

旧 Web v1 已下线。Runtime、队列、Cron、日志、配置等未迁移到 web-v2 的能力当前没有 Web fallback;优先通过 CLI、日志和后端 API 排障。

排障优先级:

1. 日常会话、任务结果、文件产物:先看 `/`。
2. 运行时状态、队列、Cron、日志、配置、安全审批:走 CLI、日志或后端 API;确认有高频场景后再迁移到 web-v2。

## 生命周期操作对比

| 操作 | 进程 | Session | 保存上下文 | 重新加载配置 | 适用场景 |
|------|------|---------|-----------|-------------|---------|
| `flush` (`/flush`) | kill → 重启 | **清除** → 全新 | ✅ checkpoint | ✅ | 定期刷新、加载新配置 |
| `clear` (`/clear`) | kill → 重启 | **清除** → 全新 | ❌ 直接丢弃 | ✅ | 上下文损坏、硬重置 |
| `restart` (`/session-restart`) | kill → 重启 | **保留** → resume | ❌ | ✅（进程重启副作用） | 中断卡住的 turn |
| `new-session` (`/new-session`) | **保留** | **清除** | ❌ | ❌ | 轻量切换 session |
| `shutdown` | kill | **保留** | ❌ | ❌ | Pool 回收、应用退出 |
| `detach` | **保留** | **保留** | ❌ | ❌ | Shell 重启前保活 |

**"加载新配置" = flush**：如果目的是让 Director 读取最新的 skills / CLAUDE.md / personas，必须用 flush（清 session + 新进程 + bootstrap），而非 shutdown（resume 旧上下文）或 restart（resume 保留旧 session）。
