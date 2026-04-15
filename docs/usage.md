# 使用指南

## 基本对话

启动后，在飞书私聊 Bot 即可对话。你发的每条消息都会进入 Director 的消息队列，按序处理。Director 是你的主分身——它读取你的 soul.md、记忆、技能，以你的人格回复。

处理过程中会看到 `Typing` 表情，表示 Director 正在思考。回复完成后表情消失。

**引用回复**：回复 Bot 之前的消息时，引用原文会作为上下文一并传给 Director（截断到 `quote_max_length`，默认 200 字符）。

**附件**：可以直接发图片、文件、语音给 Bot。通讯层会下载附件到本地，将文件路径传给 Director，Director 可以读取和处理这些文件。

## 多会话与群聊

除了私聊，你可以拉群让 Bot 参与。不同大小的群有不同的行为：

### 单人群（只有你和 Bot）

等同于另一个私聊窗口——Bot 收到消息直接响应，不需要 @mention。适合拉一个专属"干活群"让 Bot 持续跟进某个话题，不污染主对话的上下文。

### 小群（成员 ≤ 5）

需要 @mention Bot 才会响应。每个小群会分配一个独立的 Director 实例（独立上下文），通过 DirectorPool 管理。

### 大群（成员 > 5）

@mention Bot 后会以 one-shot 模式响应——spawn 一次性进程，回复后退出，不保持对话历史。适合偶尔提问，不适合持续对话。

### 白名单群

在 `config.yaml` 的 `pool.parallel_chat_ids` 中配置的群，无论人数都分配专属 Director，不需要 @mention。

### 容量与回收

- Pool 最多同时运行 5 个群 Director（`pool.max_directors`）
- 满时 LRU 淘汰最久未活跃的
- 空闲超 30 分钟自动回收（≤ 3 个时不回收）

## 上下文管理（FLUSH）

Director 作为长驻 daemon 运行，上下文窗口会随对话持续膨胀。FLUSH 机制解决这个问题——定期"重启认知"，进程不死：

1. **Drain** — 等待当前处理中的消息完成
2. **Checkpoint** — Director 把工作状态写到 `daily/state.md`（"我正在做什么"）
3. **Kill** — 终止进程、清空 session
4. **Bootstrap** — 启动新 Director，读取 state.md 恢复上下文

**自动触发**：上下文 token 超过 700k，或距上次 flush 超过 7 天。

**手动触发**：发 `/flush`。当你感觉 Director "变笨了"（上下文太长导致注意力分散），手动 flush 一次。

**区别于 `/clear`**：`/flush` 会先 checkpoint（保留工作记忆），`/clear` 直接重置（一切从零开始）。

### 时间同步

Director 的 session 可能跨天运行。Shell 会在消息间隔超过 2 小时时自动注入当前时间，确保 Director 知道"现在几点"。

## 后台任务

你可以让 Director 派活给子角色，独立执行，不阻塞主对话。

### 怎么用

直接告诉 Director 你要做什么，它会判断是自己做还是派发。或者明确说"派个任务"、"让 Explorer 去调研"。Director 通过 MCP 工具 `create_task` 派发任务。

```
你：帮我调研一下 Rust 的 async runtime 生态，对比 tokio / async-std / smol
Director：好的，我派 Explorer 去调研。
→ [后台] Explorer 开始执行...
→ [几分钟后] Director 收到回调，整合结果回复你
```

### 任务流程

1. Director 调用 `create_task(role, prompt, description)`
2. Shell 按角色默认 agent（或指定的 agent）spawn 进程
3. 子角色独立运行，产出写入 `~/.persona/outbox/YYYY-MM-DD/`
4. 完成后 Shell 回调给发起方 Director，Director 审阅产出并回复你

### 管理

- **超时**：默认 30 分钟，超时自动终止
- **重试**：失败最多重试 3 次
- **取消**：通过 Web 控制台或 API `POST /api/tasks/{id}/cancel`
- **查看**：Web 控制台的任务面板，或 API `GET /api/tasks`

## Cron 定时任务

Director 可以创建定时任务——"闹钟"。

### 调度格式

| 格式 | 示例 | 说明 |
|------|------|------|
| `every Nm` | `every 30m` | 每 N 分钟 |
| `every Nh` | `every 2h` | 每 N 小时 |
| `daily HH:MM` | `daily 09:00` | 每天固定时间（Asia/Shanghai） |

### 动作类型

| 类型 | 用途 | 示例 |
|------|------|------|
| **spawn_role** | 创建子角色任务 | 每天 9 点让 Explorer 扫一遍 HN |
| **director_msg** | 给 Director 发消息 | 每天 23 点提醒写日报 |
| **shell_action** | 执行 Shell 内部动作 | 定时 flush |

### 管理

通过 Web 控制台的 Cron 面板管理，或让 Director 直接创建/删除/启停。Cron 定义持久化在 SQLite 中，Shell 重启后自动恢复。

## 多后端切换

Persona Shell 支持 Claude Code 和 Codex 两个 agent 后端。

### 全局配置

在 `config.yaml` 的 `agents.defaults` 中按角色配置默认后端：

```yaml
agents:
  defaults:
    director: "claude"      # 主 Director 用 Claude
    explorer: "codex"       # 调研任务用 Codex
    executor: "claude"      # 执行任务用 Claude
```

### 群级切换

在小群里发 `/start-with-codex`，该群的 Director 切换为 Codex 后端。发 `/start-with-claude` 切回。只影响当前群。

### Claude vs Codex 的区别

| | Claude Code | Codex |
|---|---|---|
| 进程模型 | 常驻 daemon（FIFO pipe） | 按 turn spawn（每轮一次） |
| 流式响应 | ✅ 实时推送 chunk | ❌ 整段返回 |
| 工具体系 | Claude Code 原生工具 + skills/plugins | Codex 原生工具 |
| 适合场景 | 主 Director、需要流式体验的对话 | 后台任务、不需要实时反馈的场景 |

## 人格自定义

### 角色定义

人格文件在 `~/.persona/personas/`，使用 Claude Code agent frontmatter 格式：

```markdown
---
name: Explorer
description: 好奇心驱动的探索者，发散搜集可能性。
tools: [Read, Grep, Glob, Bash]
---

你是一个好奇心驱动的探索者。
你的任务是发现尽可能多的可能性和联系。
你不需要评估可行性——那是别人的工作。
你的产出格式：发现列表 + 意外关联 + 直觉预感
```

**内置角色**：

| 角色 | 职能 |
|------|------|
| Director | 主分身，接收用户消息，编排子角色，管理记忆 |
| Explorer | 调研、信息搜集、发现关联 |
| Executor | 编码、写作、操作执行 |
| Critic | 审核、评估、找漏洞 |
| Introspector | 系统自省、偏差检测 |

可自由增删角色，文件名不限。

### 技能（Skills）

技能定义在 `~/.persona/skills/` 下，每个技能是一个 Claude Code plugin 目录。Director 可以通过 `/skill-name` 调用技能。

```
~/.persona/skills/
├── code-review/          # 代码审查
├── soul-crafting/        # 自我人格调优
├── feature-dev/          # 功能开发
└── ...
```

### 灵魂文件

`~/.persona/soul.md` 定义分身的性格、价值观和行为边界。这是最核心的身份文件——改它就是改"你是谁"。

推荐用内置的 soul-crafting 技能交互式调优：

```bash
cd ~/.persona && claude /soul-crafting
```

## Web 控制台

`http://localhost:3000`，仅监听 localhost。

### 面板功能

- **状态面板**：Director PID、token 用量、消息队列长度、运行时间
- **会话查看**：完整对话历史，支持实时流式显示 Director 的回复
- **DirectorPool**：查看所有群聊 Director 的状态（活跃/空闲/已退出）
- **任务管理**：查看后台任务列表、状态、产出；取消运行中的任务
- **Cron 管理**：查看/创建/删除/启停 Cron 定时任务
- **操作按钮**：Flush / Clear / Esc / Restart（等同飞书 Slash 命令）

### HTTP API

```bash
# 生命周期
curl -X POST localhost:3000/api/flush
curl -X POST localhost:3000/api/clear
curl -X POST localhost:3000/api/esc
curl -X POST localhost:3000/api/session-restart

# 向 Director 发消息（绕过飞书）
curl -X POST localhost:3000/api/send \
  -H "Content-Type: application/json" -d '{"text":"你好"}'

# 任务
curl localhost:3000/api/tasks
curl localhost:3000/api/tasks/{id}
curl -X POST localhost:3000/api/tasks/{id}/cancel

# 会话（支持 ?director={label} 查询群 Director）
curl localhost:3000/api/messages?limit=100
curl localhost:3000/api/sessions
```

## 记忆系统

| 文件 | 用途 | 更新方式 |
|------|------|---------|
| `soul.md` | 性格、价值观、行为边界 | 本体手动或 /soul-crafting |
| `personas/*.md` | 角色人格定义 | 本体手动 |
| `memory/` | 跨会话记忆（用户画像、行为纠偏等） | Director 自动维护 |
| `daily/state.md` | 工作记忆（当前焦点、活跃任务） | FLUSH checkpoint 自动写入 |
| `daily/YYYY-MM-DD.md` | 日报（决策、产出、待办） | Director 自动生成 |
| `TODO.md` | 跨天待办事项 | Director 维护 |
| `outbox/YYYY-MM-DD/` | 子角色任务产出 | 任务完成时自动写入 |

所有记忆文件都是 Markdown，通过 git 管理，完整可追溯。

## 命令速查

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消队列中最早的消息 🔒 |
| `/flush` | 当前会话 | 保存上下文后刷新 🔒 |
| `/clear` | 当前会话 | 清空上下文（不保存）🔒 |
| `/restart` | 当前会话 | 重启 Director（保留 session）🔒 |
| `/shell-restart` `/restart-shell` | 全局 | 重启整个 Shell 🔒 |
| `/start-with-codex` | 当前小群 | 切到 Codex 后端 |
| `/start-with-claude` | 当前小群 | 切回 Claude 后端 |
| `/status` | 当前会话 | 查看状态摘要 |
| `/help` | 全局 | 显示命令列表 |

🔒 仅限本体（需配置 `feishu.master_id`）。

## 日志与排障

| 日志 | 路径 | 看什么 |
|------|------|--------|
| Shell stdout | `logs/shell.stdout.log` | Shell 运行日志、消息路由 |
| Shell stderr | `logs/shell.stderr.log` | 未捕获异常 |
| 消息队列 | `logs/queue.log` | 消息排队、处理、丢弃记录 |
| Director stderr | `/tmp/persona/director-stderr.log` | Claude Code CLI 的错误输出 |
| 会话输入 | `logs/{label}/input-{date}.log` | 发给 Director 的原始消息 |
| 会话输出 | `logs/{label}/output-{date}.log` | Director 的完整 stream-json 输出 |

**常见问题**：

| 现象 | 排查 |
|------|------|
| Bot 不回复 | 检查 Shell stdout 有没有收到消息；检查飞书 WebSocket 连接状态 |
| 回复变慢/变笨 | 上下文太长，试试 `/flush` |
| FLUSH 后丢失上下文 | 检查 `daily/state.md` 是否正确写入了 checkpoint |
| 群里不响应 | 确认是否需要 @mention；检查 pool 是否已满（`/status`） |
| 任务一直 running | 检查是否超时（默认 30 分钟）；Web 控制台手动取消 |

## 运行时文件

| 文件 | 路径 |
|------|------|
| Director PID | `/tmp/persona/director.pid` |
| Session ID | `/tmp/persona/director-session` |
| FIFO 管道 | `/tmp/persona/director-in`, `director-out` |
| Pool Director（Claude） | `/tmp/persona/{label}/` |
| Pool Director（Codex） | `logs/{label}/` + `/tmp/persona/{label}/session` |
