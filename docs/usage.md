# 使用指南

## Slash 命令

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消队列中最早的消息 🔒 |
| `/flush` | 当前会话 | 保存上下文后刷新（checkpoint → 新 session → bootstrap）🔒 |
| `/clear` | 当前会话 | 清空上下文（不保存，直接重置）🔒 |
| `/session-restart` `/restart` | 当前会话 | 重启当前 Director（保留 session，加载新配置）🔒 |
| `/shell-restart` `/restart-shell` | 全局 | 重启整个 Shell 进程（代码更新生效）🔒 |
| `/start-with-codex` | 当前小群 | 将当前小群切换为 Codex Director 模式 |
| `/start-with-claude` | 当前小群 | 将当前小群切回 Claude Director 模式 |
| `/status` | 当前会话 | 查看 Director 状态摘要 |
| `/help` | 全局 | 显示可用命令列表 |

🔒 标记的命令仅限本体执行（需配置 `feishu.master_id`）。

### 命令语义对比

| | `/esc` | `/flush` | `/clear` | `/restart` | `/shell-restart` |
|---|---|---|---|---|---|
| 信号 | SIGINT | SIGTERM | SIGTERM | SIGTERM | SIGTERM（全部） |
| 对话历史 | 保留 | 清空（新 session） | 清空 | 保留 | N/A |
| 状态保存 | 无 | checkpoint → state.md | 无 | 无 | 无 |
| 场景 | 取消卡住的请求 | token 过长 | 彻底重置 | 加载新配置 | 代码更新 |

## 群聊策略

群聊消息不走主 Director，由 DirectorPool 动态分配独立会话：

- **小群**（成员 ≤ 5）→ 分配专属 Director，保持上下文连续，需要 @mention
- **单人群**（仅 bot + 用户）→ 等同私聊，不需要 @mention
- **大群**（成员 > 5）→ one-shot 模式，无状态响应
- **白名单群**（`parallel_chat_ids`）→ 无论人数，始终分配专属 Director

群级切换后端：在小群里发 `/start-with-codex` 或 `/start-with-claude`，只影响当前群。

Pool 容量上限默认 5 个，满时 LRU 淘汰。空闲超 30 分钟自动回收。

## 后台任务

Director 可以派发任务给子角色独立执行，不阻塞主对话：

1. Director 通过 MCP `create_task` 指定角色、prompt、描述
2. Shell spawn 对应后端进程执行
3. 产出写入 `~/.persona/outbox/YYYY-MM-DD/`
4. 完成后回调给发起方 Director

任务有超时保护（默认 30 分钟）、重试、取消功能。

## Cron 调度

Director 可创建定时任务，支持三种调度格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| `every Nm` | `every 30m` | 每 N 分钟 |
| `every Nh` | `every 2h` | 每 N 小时 |
| `daily HH:MM` | `daily 09:00` | 每天固定时间（Asia/Shanghai） |

三种动作类型：

- **spawn_role** — 创建子角色任务
- **director_msg** — 给 Director 发消息
- **shell_action** — 执行 Shell 内部动作（如定时 flush）

## Web 控制台

`http://localhost:3000`，仅监听 localhost。

**功能**：
- 系统状态面板（Director / Token / Queue / Uptime）
- 会话消息查看（支持流式 streaming 实时显示回复）
- DirectorPool 群聊 Director 列表
- 后台任务管理 + Cron Jobs 管理
- 操作按钮：Flush / Clear / Esc / Restart

### HTTP API

```bash
# 生命周期管理
curl -X POST localhost:3000/api/flush
curl -X POST localhost:3000/api/clear
curl -X POST localhost:3000/api/esc
curl -X POST localhost:3000/api/session-restart

# 向 Director 发消息（绕过飞书）
curl -X POST localhost:3000/api/send -H "Content-Type: application/json" \
  -d '{"text":"你好"}'

# 任务管理
curl localhost:3000/api/tasks
curl localhost:3000/api/tasks/{id}
curl -X POST localhost:3000/api/tasks/{id}/cancel

# 会话查看（支持 ?director={label} 查询 pool Director）
curl localhost:3000/api/messages?limit=100
curl localhost:3000/api/sessions
```

## 人格自定义

人格定义在 `~/.persona/personas/` 下，使用 Claude Code agent frontmatter 格式：

```markdown
---
name: Explorer
description: 好奇心驱动的探索者。
tools: [Read, Grep, Glob, Bash]
---

你是一个好奇心驱动的探索者。
你的任务是发现尽可能多的可能性和联系。
```

四类内置角色：Explorer（调研）、Executor（执行）、Critic（审核）、Introspector（自省）。可自由增删。

技能定义在 `~/.persona/skills/` 下，每个技能是一个 Claude Code plugin 目录。

## 日报与记忆

- **日报**：Director 每天自动写入 `~/.persona/daily/YYYY-MM-DD.md`
- **工作记忆**：`daily/state.md`，FLUSH 时 checkpoint，新 session bootstrap 时读取
- **跨会话记忆**：`memory/` 目录，简单 md 文件，git 管理
- **跨天待办**：`TODO.md`

## 日志

| 日志 | 路径 |
|------|------|
| Shell stdout/stderr | `logs/shell.stdout.log` / `logs/shell.stderr.log` |
| 消息队列 | `logs/queue.log` |
| Director stderr | `/tmp/persona/director-stderr.log` |
| 会话输入/输出 | `logs/{label}/input-{date}.log` / `logs/{label}/output-{date}.log` |

## 运行时文件

| 文件 | 路径 |
|------|------|
| Director PID | `/tmp/persona/director.pid` |
| Session ID | `/tmp/persona/director-session` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` |
| Pool Director（Claude） | `/tmp/persona/{label}/` |
| Pool Director（Codex） | `logs/{label}/` + `/tmp/persona/{label}/session` |
