# 技术架构

## 领域模型

```
Workspace（持久容器，name 唯一 key）
  ├─ defaultSessionId          ← 飞书入口的路由 fallback
  └─ 1:N Session（路由单元，sessionId 是路由标识）
                ├─ archived: boolean
                └─ 1:1 Agent（运行时实例）
                      ├─ role: string
                      ├─ context
                      └─ cwd: string

────────────────────── 领域层 / 基础设施层 ──────────────────────

MessageChannel（基础设施层）
  ├─ WebUI      — 总是接收所有回复
  └─ IM（飞书）  — 按需转发
       ↕ MessagingRouter（转发决策）
```

### Workspace（工作空间）

一个具体的项目或长期追踪的事项。`name` 是唯一 key。

| 属性 | 类型 | 说明 |
|------|------|------|
| name | `string` | 唯一标识。如 `"main"`、`"p.sh维修"`、`"日报助手"` |
| contextFile | `string` | 持久化上下文：`workspaces/{name}/context.md` |
| config | `{ cwd?, agent? }` | 工作目录、默认 agent |
| sessions | `Session[]` | 该 workspace 下的所有 session（含归档） |
| defaultSessionId | `string` | 飞书入口使用的默认 session |

Workspace 是 Session 的聚合根，Session 的创建、归档、查询都通过 Workspace 操作。

**来源**：
- `main`：系统内置
- 飞书群聊：群名作为 workspace name，首条消息时自动创建
- Web Console：用户手动创建，或发消息时自动创建

**持久化**：

| 字段 | 存储 |
|------|------|
| name | SQLite `workspaces` 表 PK |
| default_session_id | SQLite `workspaces` 表 |
| cwd, agent | SQLite `workspaces` 表 |
| contextFile | 文件系统 `workspaces/{name}/context.md` |

### Session（对话实例）

Workspace 下的一次具体会话。Session 和 Agent 同生同灭。**sessionId 是消息路由标识**。

| 属性 | 类型 | 说明 |
|------|------|------|
| sessionId | `string` | 路由标识，由 Claude/Codex 分配 |
| workspace | `string` | 所属 workspace name |
| archived | `boolean` | 归档后 UI 不可见，数据不删除 |
| agent | `Agent` | 绑定的运行时实例 |

同一 Workspace 可以有多个活跃 Session（不同 agent 同时处理不同任务）。

**生命周期事件**：

| 操作 | 结果 |
|------|------|
| 首条消息到达 workspace | 创建 Session + Agent，设为 default |
| FLUSH | 旧 Session 保留，新建 Session + Agent，更新 default |
| 切换 Agent | 旧 Session 保留，新建 Session + 新 Agent，更新 default |
| 切换 Role | 旧 Session 保留，新建 Session + 新 Agent（新 role），更新 default |
| 归档 | 停止 Agent，Session 标记 archived |

**持久化**：

| 字段 | 存储 |
|------|------|
| session_id | SQLite `sessions` 表 PK |
| workspace | SQLite `sessions` 表 FK |
| archived | SQLite `sessions` 表 |
| role, cwd | SQLite `sessions` 表（Agent 快照） |

### Agent（运行时实例）

> 代码中现命名为 Director / SessionBridge，领域概念上是 Agent。

Session 绑定的 AI 运行时。不是持久实体——Session 创建时 Agent 启动，Session 结束时 Agent 销毁。Agent 不感知消息来源。

| 属性 | 类型 | 说明 |
|------|------|------|
| role | `string` | 当前角色（director / philosopher 等） |
| context | | 对话上下文（历史、system prompt 等） |
| cwd | `string` | 工作目录 |

### 消息路由

```
消息到达
  │
  ├─ Web（必须携带 sessionId）
  │     → 直接路由到 Session → Agent 处理
  │
  └─ 飞书（携带群名 / 私聊）
        → 群名映射到 workspace
        → workspace.defaultSessionId
        → Session → Agent 处理
```

Web 端发消息必须带 sessionId。如果是新 workspace 还没有 session，前端先调 `POST /api/sessions` 创建。

### 回复路由

Agent 和 Session 不感知消息来源。回复路由由基础设施层（MessageChannel + MessagingRouter）处理：

- 总是推送到 WebUI
- 如果上次消息来源是 IM → 同时转发到 IM

### 后台任务回调

Task 完成后回调投递优先级：

1. `source_session_id` 未归档 → 投递给该 session 对应的 director（如果 director 死了，拉起来）
2. `source_session_id` 已归档 → 投递给该 workspace 的 default session
3. workspace 没有 default session / 无法拉起 → 投递给 main director
4. main director 始终至少有一个 session，保证回调不会静默丢失

注意：MCP server 的 `PERSONA_WORKSPACE` / `PERSONA_SESSION_ID` 通过 CLI 进程的 env 继承传递。
如果 env 未正确传递（如 session 创建时机问题），`normalizeTaskSource` 会用 workspace 从 DB 查找 default session 兜底。

### Cron 调度

Cron job 使用所属 workspace 的 default session 执行。

### MessageChannel（消息通道）

消息的 UI 展示层，属于基础设施层，不属于领域模型。

| Channel | 说明 |
|---------|------|
| WebUI | Web Console，总是接收所有回复 |
| IM（飞书） | 飞书私聊/群聊，按需转发 |

**MessagingRouter**：负责把 Agent 的回复转发到正确的 Channel。

### 标识符归属

| 标识符 | 归属实体 | 说明 |
|--------|---------|------|
| workspace name | Workspace | 唯一 key，对外 |
| sessionId | Session | 消息路由标识，对外 |

### DirectorPool 边界

上述模型是当前领域模型。`WorkspaceRegistry` 和 `SessionManager` 是 workspace/session 的事实源和业务入口。

`DirectorPool` 只负责运行时实现细节:

- 活跃 Agent 进程池
- 消息队列和队列取消
- streaming reply transport
- 进程恢复、detach、shutdown、idle 回收

业务代码不能把 `DirectorPool` 作为 workspace/session 的事实源。需要发消息、创建 session、解析 workspace default session 时,必须先通过 `SessionManager`。

需要区分三类标识:

| 标识符 | 当前用途 | 收敛方向 |
|--------|----------|----------|
| workspace name | 对外 workspace key | 保留 |
| sessionId | 对外 session 路由 key | 保留并优先使用 |
| routingKey | DirectorPool 内部 key,可能来自 chatId / web id | 只允许留在 runtime/control 边界 |
| directorLabel | 运行时诊断、队列控制、日志定位字段 | 不作为业务路由参数 |
| source_director | Task/Cron 旧回调路由字段 | 仅作为一次性迁移输入 |

因此,看到 `directorLabel` / `routingKey` 只能说明代码正在做运行时控制或诊断,不能说明业务模型发生变化。

## 系统概览

Persona Shell 是一个 TypeScript (Bun) 进程，负责：
- 接收 IM 消息（飞书 WebSocket / Web Console）
- 路由到对应的 Session / Agent
- 管理 Agent 进程的生命周期（启动、通信、FLUSH、容灾）
- 派发子角色任务、调度 Cron

Shell 本身不做 AI 推理，所有智能由底层 agent（Claude Code / Codex）提供。

### 运行时组件

```
WorkspaceRegistry          — workspace CRUD + default session 管理
SessionManager             — Session/Agent 生命周期 + 消息发送
  entries: Map<sessionId, SessionEntry>
MessagingRouter            — 回复转发到 Channel（WebUI / IM）
```

消息流：
```
消息到达
  → WorkspaceRegistry.resolve(workspaceName) → sessionId（飞书路径）
  → SessionManager.send(sessionId, text)
  → Agent 处理 → 回复
  → MessagingRouter 转发到 Channel
```

## 通讯层

### MessagingClient 接口

通讯平台是外挂的适配器，路由层不依赖任何平台特有概念。所有适配器实现 `MessagingClient` 接口（`src/messaging.ts`）：

```typescript
interface MessagingClient {
  start(): void;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  reply(messageId: string, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string | null>;
  startStreamingReply?(messageId: string, initialText?: string): Promise<StreamingReplyHandle | null>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  uploadAndReplyImage / uploadAndReplyFile / uploadAndSendImage / uploadAndSendFile
  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
```

`IncomingMessage` 使用平台无关字段：`text`、`messageId`、`chatId`、`chatType`、`threadId`（通用子对话）、`quotedText`、`senderOpenId`、`attachments`。不暴露飞书特有概念。

### 引用消息

通讯层只提取引用原文（`quotedText`），不做截断。路由层根据目标模式决定截断策略。

## 消息入口路由

```
消息到达
  │
  ├─ 飞书私聊 → main workspace → default session
  │
  ├─ 飞书群聊
  │     ├─ 大群（> threshold）→ One-shot（无状态，不创建 session）
  │     └─ 小群（≤ threshold）→ workspace(群名) → default session
  │
  └─ Web Console → sessionId 直达（必须指定）
```

## Agent 三层架构

```
SessionBridge (session-bridge.ts)
  ├─ 会话编排：消息队列 / FLUSH / bootstrap / 事件发射
  ├─ 不关心底层是 Claude 还是 Codex
  │
  └─ DirectorSessionAdapter (director-session-adapter/)
      ├─ claude.ts — stream-json 双向协议
      ├─ codex-app-server.ts — App Server JSON-RPC 协议
      ├─ kimi.ts — stream-json stdin/stdout 协议
      │
      └─ DirectorRuntime (director-runtime/)
          ├─ claude.ts — daemon 进程（FIFO named pipe，长驻）
          ├─ codex-app-server.ts — App Server JSON-RPC runtime（主线）
          └─ kimi.ts — daemon 进程（stdin/stdout pipe，长驻）
```

### SessionBridge

对外的统一接口（EventEmitter），职责：
- 消息排队（correlation ID）、去重、丢弃过期消息
- FLUSH 生命周期（drain → checkpoint → kill → bootstrap）
- 自动 flush 策略（token 阈值 / 时间间隔）
- 时间同步注入（消息间隔超过阈值时注入当前时间前缀）

### Prompt Loader

`prompt-loader.ts` 从 `{personaDir}/prompts/` 目录加载用户可覆盖的 prompt 模板。文件存在则使用文件内容（`---` 分隔符后的部分），否则 fallback 到各调用点的硬编码默认值。支持 `{var_name}` 模板变量替换。

调用点：
- **SessionBridge**：bootstrap / flush checkpoint / agent-switch checkpoint
- **task-runner**：子角色任务产出指令
- **index**（cron 调度）：`@prompts/xxx.md` 文件引用，解析为消息内容

发出的事件：

| 事件 | 载荷 | 触发时机 |
|------|------|----------|
| `chunk` | `(text)` | assistant 流式文本到达（仅用户可见的响应） |
| `response` | `(text, durationMs?)` | 一轮完整回复结束 |
| `system-response` | `(text, replyTo)` | 系统消息响应（任务通知等） |
| `cron-response` | `(text)` | Cron 触发的消息响应 |
| `stream-abort` | `()` | 进程异常关闭，通知上层清理流式状态 |
| `alert` | `(message)` | 异常告警 |
| `close` | `()` | 管道关闭（pool 清理用） |
| `restarted` | `()` | 进程重启完成 |

### DirectorSessionAdapter

封装协议差异：
- **Claude**：管理 FIFO 读写句柄，逐行解析 stream-json（init → assistant → result），提取响应文本和 metrics（token 用量、cost）
- **Codex**：使用 App Server JSON-RPC runtime，解析 `agentMessage/delta`、tool items 和 `turn/completed`
- **Kimi**：维护 stdin/stdout pipe，逐行解析 print stream-json（assistant → tool → assistant），不含 tool_calls 的 assistant message 触发 turn complete

### DirectorRuntime

封装进程生命周期：
- **Claude**：spawn detached daemon、PID 文件追踪、FIFO 创建/清理、SIGINT/SIGTERM
- **Codex**：Director 持有长驻 `codex app-server --listen stdio://`；后台任务使用临时 App Server runtime
- **Kimi**：spawn detached daemon、stdin/stdout pipe、SIGINT/SIGTERM、resume hint 捕获

### 通信协议

**Claude**（FIFO named pipe 双向通信）：

输入（写 director-in）：
```json
{"type":"user","message":{"role":"user","content":"消息内容"}}
```

输出（读 director-out）：
```json
{"type":"system","subtype":"init","session_id":"xxx"}
{"type":"assistant","message":{"role":"assistant","content":"..."}}
{"type":"result","subtype":"success","cost":"...","duration":"..."}
```

**Codex**（App Server JSON-RPC）：
```text
initialize -> thread/start(baseInstructions, developerInstructions, cwd, sandbox)
turn/start(input) -> item/agentMessage/delta ... -> turn/completed
```

**Kimi**（stdin/stdout pipe）：
```bash
kimi --print \
  --input-format stream-json \
  --output-format stream-json \
  --work-dir ~/.persona \
  --agent-file ~/.persona/kimi-agent.yaml
```

输入（写 stdin）：
```json
{"role":"user","content":"消息内容"}
```

输出（读 stdout）：
```json
{"role":"assistant","content":[{"type":"think","think":"..."},{"type":"text","text":"..."}]}
```

完整的 CLI 参数链和会话恢复机制见 [agent-backends.md](agent-backends.md)。

## 领域模型

```
Workspace（持久容器，name 唯一 key）
  ├─ defaultSessionId
  └─ 1:N Session（路由单元，sessionId 是路由标识）
                ├─ archived: boolean
                └─ 1:1 Agent（运行时实例）
                      ├─ role: string
                      ├─ context
                      └─ cwd: string

────────────────────── 领域层 / 基础设施层 ──────────────────────

MessageChannel（基础设施层）
  ├─ WebUI      — 总是接收所有回复
  └─ IM（飞书）  — 按需转发
       ↕ MessagingRouter（转发决策）
```

### Workspace（工作空间）

一个具体的项目或长期追踪的事项。`name` 是唯一 key。

| 属性 | 类型 | 说明 |
|------|------|------|
| name | `string` | 唯一标识。如 `"main"`、`"p.sh维修"`、`"日报助手"` |
| contextFile | `string` | 持久化上下文：`workspaces/{name}/context.md` |
| config | `{ cwd?, agent? }` | 工作目录、默认 agent |
| sessions | `Session[]` | 该 workspace 下的所有 session（含归档） |
| defaultSessionId | `string` | 默认路由的 session |

Workspace 是 Session 的聚合根，Session 的创建、归档、查询都通过 Workspace 操作。

**来源**：
- `main`：系统内置
- 飞书群聊：群名作为 workspace name，首条消息时自动创建
- Web Console：用户手动创建，或发消息时自动创建

### Session（对话实例）

Workspace 下的一次具体会话。Session 和 Agent 同生同灭。**sessionId 是消息路由标识**。

| 属性 | 类型 | 说明 |
|------|------|------|
| sessionId | `string` | 路由标识，由 Claude/Codex 分配 |
| workspace | `string` | 所属 workspace name |
| archived | `boolean` | 归档后 UI 不可见，数据不删除 |
| agent | `Agent` | 绑定的运行时实例 |

同一 Workspace 可以有多个活跃 Session（不同 agent 同时处理不同任务）。

**生命周期事件**：

| 操作 | 结果 |
|------|------|
| 首条消息到达 workspace | 创建 Session + Agent，设为 default |
| FLUSH | 旧 Session 保留，新建 Session + Agent，更新 default |
| 切换 Agent | 旧 Session 保留，新建 Session + 新 Agent，更新 default |
| 切换 Role | 旧 Session 保留，新建 Session + 新 Agent（新 role），更新 default |
| 归档 | 停止 Agent，Session 标记 archived |

### Agent（运行时实例）

> 代码中现命名为 Director / SessionBridge，领域概念上是 Agent。

Session 绑定的 AI 运行时。不是持久实体——Session 创建时 Agent 启动，Session 结束时 Agent 销毁。Agent 不感知消息来源。

| 属性 | 类型 | 说明 |
|------|------|------|
| role | `string` | 当前角色（director / philosopher 等） |
| context | | 对话上下文（历史、system prompt 等） |
| cwd | `string` | 工作目录 |

### 消息路由

```
消息到达
  │
  ├─ 携带 sessionId → 直接路由到 Session → Agent 处理
  │
  └─ 携带 workspace name（飞书群名映射 / Web 未选 session）
        → workspace.defaultSessionId → Session → Agent 处理
```

### 回复路由

Agent 和 Session 不感知消息来源。回复路由由基础设施层处理：

- 总是推送到 WebUI
- 如果上次消息来源是 IM → 同时转发到 IM

### MessageChannel（消息通道）

消息的 UI 展示层，属于基础设施层，不属于领域模型。

| Channel | 说明 |
|---------|------|
| WebUI | Web Console，总是接收所有回复 |
| IM（飞书） | 飞书私聊/群聊，按需转发 |

**MessagingRouter**：负责把 Agent 的回复转发到正确的 Channel。

### 标识符归属

| 标识符 | 归属实体 | 说明 |
|--------|---------|------|
| workspace name | Workspace | 唯一 key，对外 |
| sessionId | Session | 消息路由标识，对外 |

## SessionManager / DirectorPool

SessionManager 是 workspace/session 的业务边界,管理活跃 Session/Agent 实例的生命周期:

```
SessionManager
  ├── entries: Map<sessionId, SessionEntry>   # 活跃实例
  ├── creating: Map<sessionId, Promise>       # 竞态锁
  │
  ├── send(sessionId, text)                   # 消息发送
  ├── createSession(workspace, opts)          # 创建 Session + Agent
  ├── archiveSession(sessionId)               # 归档 Session + 停止 Agent
  ├── flush(sessionId)                        # FLUSH → 新 Session
  ├── restoreEntries()                        # 重启后从 SQLite 恢复
  ├── reapIdle()                              # 空闲回收
  └── evictLRU()                              # 容量淘汰
```

entries 持久化到 SQLite，Shell 重启后恢复。

DirectorPool 位于 SessionManager 下方,只保存 runtime entry、queue、streaming handle 和进程恢复信息。它的 `routingKey` 是内部 Map key,不是 API/UI/Task/Cron 的路由标识。

## FLUSH 机制

长驻 Director 的上下文窗口会持续膨胀。FLUSH 定期重启认知，进程不死：

```
1. Drain    — 等待 in-flight 消息处理完成
2. Checkpoint — Director 将工作状态保存到 daily/state.md
3. Reset    — kill 进程 + 清空 session
4. Bootstrap — 新 Director 读取 state.md 恢复上下文
```

**触发条件**（满足任一即触发）：
- 上下文 token 超过 `flush_context_limit`（默认 700k）
- 距上次 flush 超过 `flush_interval_days`（默认 7 天）
- 手动 `/flush`

**时间同步**：Director session 跨天时 `currentDate` 会过期。Shell 在消息间隔超过 `time_sync_interval_hours` 时自动注入时间前缀。

## 后台任务

```
Agent ──MCP create_task──→ Shell (task-runner)
                               │
                   spawn agent process (Claude -p / Codex exec)
                               │
                   产出写入 outbox/YYYY-MM-DD/
                               │
                   回调：先找原 sessionId，已归档则回到 workspace default session
```

- 任务通过 MCP Server（`task-mcp-server.ts`）暴露给 Agent
- `task-runner.ts` 管理进程 spawn、超时（默认 30 分钟）、重试
- `task-store.ts` 使用 SQLite 持久化任务状态和 Cron 定义
- `scheduler.ts` 轮询 Cron jobs，使用 workspace 的 default session 执行

## 进程容灾

```
Shell 崩溃时：
  Claude Agent (detached)     → 还活着，通过 named pipe 等待重连
  Codex Agent                 → 无常驻进程，无影响
  子角色任务 (detached, -p)    → 还活着，结果写 outbox/

Shell 重启：
  → SessionManager.restoreEntries()：从 SQLite 恢复活跃 session
  → Claude Agent：重新 open named pipe 连接存活进程
  → 如果 Agent 也崩了：spawn 新 Agent，读 context.md 恢复
```

## Web Console

`localhost:3000` 嵌入 shell 进程运行。当前只保留 web-v2:

| 入口 | 定位 |
|------|------|
| `/` | web-v2 主界面,聚焦 Chat / Tasks / Files |

旧 Web v1 已下线,不再提供 fallback。Runtime / Automations / Persona / Logs / Settings 等能力若有真实使用场景,后续只迁移到 web-v2;没有真实使用场景的旧入口直接删除。

Web 前端通过 WebSocket 推送两类数据：

**状态快照（每秒）**：系统状态 + 各 session 状态

**流式 chunk（实时）**：
```jsonc
{ "type": "chunk", "sessionId": "xxx", "text": "增量文本" }
{ "type": "stream-abort", "sessionId": "xxx" }
```

前端渲染 streaming bubble，`stream-abort` 时清除并重新加载完整消息。

**API**：
- `POST /api/send { sessionId, text }` — 发消息（sessionId 必填）
- `POST /api/sessions { workspace }` — 创建 session
- `GET /api/sessions?workspace={name}` — 查询 workspace 下的 session 列表
- `GET /api/messages?sessionId={id}` — 查询某 session 的消息历史

## 技术栈

> **config.yaml 加载时机**：config.yaml 在 Shell 启动时由 `main()` 一次性加载，运行期间不热更新。修改后需通过 `/shell-restart` 重新加载。例外：task-runner 在 spawn 子任务时会重新 `loadConfig()` 获取最新的 agents 配置。

| 组件 | 实现 |
|------|------|
| Shell 进程 | TypeScript (Bun) |
| 通讯层 | MessagingClient 接口 + MessagingRouter |
| 飞书接入 | Lark SDK，WebSocket 长连接 |
| Workspace 管理 | WorkspaceRegistry |
| Session/Agent 编排 | SessionManager → DirectorPool(runtime) → SessionBridge → Adapter → Runtime |
| 后台任务 | task-runner + task-store (SQLite)，MCP 派发 |
| Cron | scheduler + task-store (SQLite) |
| Web 控制台 | Bun.serve + WebSocket |
| 记忆 | Markdown 文件，git 管理 |
| 状态持久化 | SQLite（workspaces / sessions / tasks / cron） |
