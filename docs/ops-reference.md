# 运维速查

## 服务管理

```bash
cd ~/github/jzlikewei/persona-shell && bun run install-service   # 安装/重装
launchctl start com.persona.shell                                # 启动
launchctl stop  com.persona.shell                                # 停止
```

## 飞书命令

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消队列中最早的消息 |
| `/flush` | 当前会话 | 保存上下文后刷新（checkpoint → 新 session → bootstrap） |
| `/clear` | 当前会话 | 清空上下文（不保存，直接重置） |
| `/session-restart` `/restart` | 当前会话 | 重启当前 Director（保留 session，加载新配置） |
| `/shell-restart` `/restart-shell` | 全局 | 重启整个 Shell 进程（代码更新生效） |
| `/status` | 当前会话 | 查看 Director 状态摘要（PID、token、队列等） |
| `/switch-agent <agent>` | 当前会话 | 切换当前会话的 Director agent；切换前先 flush 保存上下文，切换后自动恢复，并持久化该会话的 agent 选择 |
| `/start-with-codex` | 当前会话 | 快捷切换到 Codex Director 模式（等价于 `/switch-agent codex`） |
| `/start-with-claude` | 当前会话 | 快捷切回 Claude Director 模式（等价于 `/switch-agent claude`） |
| `/help` | 全局 | 列出所有可用命令 |

## 日志

| 日志 | 路径 |
|------|------|
| Shell stdout/stderr | `logs/shell.stdout.log` / `logs/shell.stderr.log` |
| 消息队列 | `logs/queue.log` |
| Director stderr | `/tmp/persona/director-stderr.log` |
| 会话输入记录 | `logs/{label}/input-{YYYYMMDD}.log` |
| 会话输出记录 | `logs/{label}/output-{YYYYMMDD}.log` |

## 运行时文件

| 文件 | 路径 |
|------|------|
| Director PID | `/tmp/persona/director.pid` |
| Session ID | `/tmp/persona/director-session` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` |
| Pool Director（Claude） | `/tmp/persona/{label}/`（群聊 Director，含 session / PID / FIFO） |
| Pool Director（Codex） | `logs/{label}/` 为主要排障入口；session 文件落在 `/tmp/persona/{label}/session`，但无常驻 PID/FIFO |

当前 Codex pool Director 是 turn-based transport：群会话常驻，但底层 `codex` 进程不会常驻；每次处理消息时会短暂拉起一次。

## Web 控制台

`http://localhost:3000` — 状态面板 / 会话查看 / 流式响应 / 任务管理
