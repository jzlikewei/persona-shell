# Web 管理控制台 — 设计与状态

## 目标

给 persona-shell 加一个 Web 管理控制台，能**完整管理**这个应用：看状态、看操作、看当前和历史会话、管理后台任务。

## 架构

```
Browser (Catppuccin SPA)
    ↕ WebSocket + HTTP API
persona-shell (Bun)
    ├── index.ts          ← 飞书 ↔ Director ↔ Pool 编排
    ├── console.ts        ← Web 控制台服务
    │     ├── Bun.serve()         HTTP + WebSocket
    │     ├── GET /               单文件 HTML SPA
    │     ├── WebSocket           推状态(1s) + 推 chunk(实时) + 收命令
    │     ├── buildSnapshot()     状态快照（含 DirectorPool）
    │     └── broadcastWs()       chunk / stream-abort 广播
    └── public/index.html ← 前端 SPA（vanilla JS + marked.js）
```

嵌入 Shell 进程，不独立部署。原因：Queue 状态在内存里，Director 实例引用在进程内。

## 数据源

| 数据 | 来源 | 访问方式 |
|------|------|----------|
| Director 状态（alive/tokens/pending/activity） | Director.getStatus() | 进程内直接读 |
| Pool Director 状态 | DirectorPool.getPoolStatus() | 进程内直接读 |
| 消息队列 | MessageQueue.getSnapshot() | 进程内直接读 |
| 流式 chunk | Director `chunk` 事件 / Pool re-emit | EventEmitter |
| 会话消息 | `logs/{label}/output-{date}.log` + `logs/{label}/input-{date}.log` | 读文件（parseConversationLog） |
| 任务 | task-store.ts SQLite | 进程内读 |
| 日内统计 | MetricsCollector（内存） | 进程内直接读 |

## WebSocket 协议

### 服务端推送

| type | 频率 | 载荷 |
|------|------|------|
| `status` | 每 1s | `{ system, activity, context, metrics, queue, tasks, pool }` |
| `chunk` | 实时 | `{ director: string, text: string }` — 流式文本增量 |
| `stream-abort` | 事件 | `{ director: string }` — Director 异常关闭，清理前端流式状态 |
| `command_result` | 事件 | `{ command, ok, message }` |
| `chat_reply` | 事件 | `{ messageId?, text }` — Director 回复 web chat |

### 客户端发送

| type | 载荷 |
|------|------|
| `command` | `{ command: 'flush' | 'esc' | 'restart' }` |
| `chat` | `{ text, messageId }` — web chat 消息 |

## HTTP API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/messages?limit=N&sessionId=&director=` | GET | 会话消息。`director={label}` 查询 pool Director |
| `/api/sessions?director=` | GET | 会话列表。`director={label}` 查询 pool Director |
| `/api/send` | POST | 向 Director 发消息（绕过飞书） |
| `/api/flush` | POST | 手动 flush |
| `/api/esc` | POST | 取消最旧消息 |
| `/api/restart` | POST | 重启 Director |
| `/api/tasks` | GET/POST | 任务列表 / 创建任务 |
| `/api/tasks/{id}` | GET | 任务详情 |
| `/api/tasks/{id}/logs?after=N` | GET | 任务结构化日志 |
| `/api/tasks/{id}/output` | GET | 任务结果文件 |
| `/api/tasks/{id}/cancel` | POST | 取消任务 |
| `/api/cron-jobs` | GET/POST | Cron 列表 / 创建 |
| `/api/cron-jobs/{id}` | GET/PUT/DELETE | Cron 详情 / 更新 / 删除 |
| `/api/cron-jobs/{id}/toggle` | POST | 启用/禁用 cron |
| `/api/send-attachment` | POST | 发送附件（图片/文件） |

## 前端 UI

### 布局

```
┌── Header ────────────────────────────────────────────────┐
│  Persona Shell  ● Healthy  Connected  Alive +2  3h 12m  │
├── Sidebar (280px) ──┬── Main Content ────────────────────┤
│  Activity: ● Idle   │                                    │
│  Context: ████░ 42% │  Dashboard / Session / Task view   │
│  Today: 15 msgs     │                                    │
│                     │  Session view: 流式 streaming      │
│  Sessions           │  bubble 实时显示 Director 回复     │
│  ├─ ● live session  │                                    │
│  └─ ○ old session   │                                    │
│                     │                                    │
│  Groups (2)         │                                    │
│  ├─ ● 干活群 busy   │                                    │
│  └─ ○ 讨论群 idle   │                                    │
│                     │                                    │
│  Tasks (3 running)  │                                    │
│  Actions            │                                    │
│  [Flush][Esc][Rst]  │                                    │
└─────────────────────┴────────────────────────────────────┘
```

### 视图模式

- **Dashboard**：统计卡片 + 队列 + 最近消息 + 错误
- **Session**：主 Director 的会话消息（markdown 渲染），支持流式 streaming bubble
- **Pool Session**：点击 Groups 列表中的群 → 加载对应 pool Director 的会话
- **Task**：Split view（左：结构化日志，右：任务结果 + metadata）

### 流式响应渲染

1. 收到 `chunk` 消息 → 累积到 `streamingChunks[directorLabel]`
2. 100ms debounce 后渲染 streaming bubble（绿色脉冲左边框 + ▍ 光标）
3. `processing → idle` 转换或 `stream-abort` → 清除 bubble + 重新加载完整消息
4. 有 streaming 时隐藏静态 "Processing..." 指示器

## 实现状态

| 功能 | 状态 |
|------|------|
| 状态面板（Director/Token/Queue/Uptime） | ✅ 完成 |
| 操作（Flush/Esc/Restart） | ✅ 完成 |
| 会话列表 + 消息查看 | ✅ 完成 |
| 任务管理（创建/查看/取消/日志） | ✅ 完成 |
| Cron Jobs 管理 | ✅ 完成 |
| Web Chat（向 Director 发消息） | ✅ 完成 |
| DirectorPool 可见性（Groups 列表） | ✅ 完成 (81151b5) |
| 流式 streaming bubble（Web） | ✅ 完成 (81151b5) |
| Pool Director 会话查看 | ✅ 完成 (81151b5) |
| 飞书流式响应（message.update） | 🔲 TODO |

## TODO

- [ ] 飞书流式响应：StreamingReply 状态机 + `im.v1.message.update` API
- [ ] 日志查看器（多源切换 + tail）
- [ ] Token 用量趋势图
