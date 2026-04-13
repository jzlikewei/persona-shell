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
| `/esc` | 当前会话 | 取消正在处理的消息（SIGINT + resume） |
| `/flush` | 当前会话 | 上下文刷新（checkpoint → 新 session → bootstrap） |
| `/restart` | 全局 | 重启 Shell 进程（launchd 拉起，代码更新生效） |
| `/restart-shell` | 全局 | 同上（显式命名，区别于会话级操作） |

## 日志

| 日志 | 路径 |
|------|------|
| Shell stdout/stderr | `logs/bridge.stdout.log` / `logs/bridge.stderr.log` |
| 消息队列 | `logs/queue.log` |
| Director stderr | `/tmp/persona/director-stderr.log` |
| 会话记录 | `logs/{label}/output-{date}.log` |

## 运行时文件

| 文件 | 路径 |
|------|------|
| Director PID | `/tmp/persona/director.pid` |
| Session ID | `/tmp/persona/director-session` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` |
| Pool Director | `/tmp/persona/{label}/`（群聊 Director） |

## Web 控制台

`http://localhost:3000` — 状态面板 / 会话查看 / 流式响应 / 任务管理
