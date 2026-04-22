# 技术架构

## 系统概览

Persona Shell 是一个 TypeScript (Bun) 进程，负责：
- 接收 IM 消息（飞书 WebSocket / Web Console）
- 路由到对应的 Director 实例
- 管理 Director 进程的生命周期（启动、通信、FLUSH、容灾）
- 派发子角色任务、调度 Cron

Shell 本身不做 AI 推理，所有智能由底层 agent（Claude Code / Codex）提供。

```
通讯层                     路由层 (index.ts)              Director 层
─────────                 ─────────────────             ──────────────
FeishuClient        ─┐                               ┌─ SessionBridge (主)
WebMessagingClient   ├→  MessagingRouter  ─→  分流  ──┤
                    ─┘                               ├─ DirectorPool → SessionBridge (群1, 群2...)
                                                     └─ One-shot (大群, 无状态)
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
  addReaction(messageId: string, emoji: string): Promise<void>;
  uploadAndReplyImage / uploadAndReplyFile / uploadAndSendImage / uploadAndSendFile
  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
```

`IncomingMessage` 使用平台无关字段：`text`、`messageId`、`chatId`、`chatType`、`threadId`（通用子对话）、`quotedText`、`senderOpenId`、`attachments`。不暴露飞书特有概念。

### MessagingRouter

多渠道路由器，所有 client 的入站消息汇入同一个 handler。Director 回复时按 `messageId` 查 origin 路由到正确的 client。`sendMessage`（主动通知）默认走 primary client。新增渠道只需实现 `MessagingClient` + `router.addClient()`。

### 引用消息

通讯层只提取引用原文（`quotedText`），不做截断。路由层根据目标模式决定截断策略：Director/Pool 截断到 `quote_max_length`（原文已在上下文中），One-shot 不截断。

## 消息路由

```
消息到达
  │
  ├─ 私聊 ──────────────────────────→ 主 Director（长驻 daemon）
  │
  └─ 群聊
       ├─ 单人群（user_count ≤ 1）──→ DirectorPool（免 @mention）
       ├─ 大群（> threshold）───────→ One-shot（无状态）
       └─ 小群（≤ threshold）───────→ DirectorPool（需 @mention）
```

## Director 三层架构

```
SessionBridge (session-bridge.ts)
  ├─ 会话编排：消息队列 / FLUSH / bootstrap / 事件发射
  ├─ 不关心底层是 Claude 还是 Codex
  │
  └─ DirectorSessionAdapter (director-session-adapter/)
      ├─ claude.ts — stream-json 双向协议
      ├─ codex.ts — turn-based 协议
      ├─ kimi.ts — stream-json stdin/stdout 协议
      │
      └─ DirectorRuntime (director-runtime/)
          ├─ claude.ts — daemon 进程（FIFO named pipe，长驻）
          ├─ codex.ts — 按 turn spawn（短驻，session resume）
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
- **Codex**：每轮 spawn `codex exec --resume`，解析 stdout 直到 `turn_completed`
- **Kimi**：维护 stdin/stdout pipe，逐行解析 print stream-json（assistant → tool → assistant），不含 tool_calls 的 assistant message 触发 turn complete

### DirectorRuntime

封装进程生命周期：
- **Claude**：spawn detached daemon、PID 文件追踪、FIFO 创建/清理、SIGINT/SIGTERM
- **Codex**：按需 spawn、session 文件管理、无常驻进程
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

**Codex**（per-turn spawn）：
```bash
codex exec --resume SESSION_ID "用户消息" \
  --full-auto --sandbox danger-full-access
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

## DirectorPool

管理多个非主 Director 实例的生命周期：

```
DirectorPool
  ├── entries: Map<routingKey, PoolEntry>   # 活跃实例（按 chat_id 路由）
  ├── closedEntries: Map<routingKey, ...>   # 已退出的 session（UI 可查看历史）
  ├── creating: Map<routingKey, Promise>    # 竞态锁
  │
  ├── getOrCreate(key, name)               # 有则复用，无则创建
  ├── reapIdle()                           # 每分钟检查，≤3 个不回收
  ├── evictLRU()                           # 满时淘汰最久未活跃的
  ├── restoreEntries()                     # 重启后从 SQLite 恢复
  └── killUnknownOrphans()                 # 清理孤儿进程
```

Pool entries 持久化到 SQLite（key: `pool:entries` / `pool:closed`），Shell 重启后自动恢复并 reconnect 存活的 Claude daemon 进程。

DirectorPool 继承 EventEmitter，将池内 Director 的 `chunk` / `stream-abort` 事件 re-emit 到 pool 级别（附带 label），供 Web Console 统一订阅。

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
Director ──MCP create_task──→ Shell (task-runner)
                                │
                    spawn agent process (Claude -p / Codex exec)
                                │
                    产出写入 outbox/YYYY-MM-DD/
                                │
                    回调给发起方 Director
```

- 任务通过 MCP Server（`task-mcp-server.ts`）暴露给 Director
- `task-runner.ts` 管理进程 spawn、超时（默认 30 分钟）、重试
- `task-store.ts` 使用 SQLite 持久化任务状态和 Cron 定义
- `scheduler.ts` 轮询 Cron jobs，按时触发

## 进程容灾

```
Shell 崩溃时：
  Claude Director (detached)  → 还活着，通过 named pipe 等待重连
  Codex Director              → 无常驻进程，无影响
  子角色任务 (detached, -p)    → 还活着，结果写 outbox/

Shell 重启：
  → DirectorPool.restoreEntries()：从 SQLite 恢复 pool entries
  → Claude Director：重新 open named pipe 连接存活进程
  → 如果 Director 也崩了：spawn 新 Director，读 state.md 恢复
  → killUnknownOrphans()：清理孤儿进程
```

## Web Console

`localhost:3000`，通过 WebSocket 推送两类数据：

**状态快照（每秒）**：系统状态 + DirectorPool 状态（activity / alive / queueLength）

**流式 chunk（实时）**：
```jsonc
{ "type": "chunk", "director": "main", "text": "增量文本" }
{ "type": "stream-abort", "director": "2da0f077" }
```

前端渲染 streaming bubble，`stream-abort` 时清除并重新加载完整消息。

API 路由支持 `?director={label}` 参数查看 pool Director 的会话历史。

## 技术栈

| 组件 | 实现 |
|------|------|
| Shell 进程 | TypeScript (Bun) |
| 通讯层 | MessagingClient 接口 + MessagingRouter |
| 飞书接入 | Lark SDK，WebSocket 长连接 |
| Director 编排 | SessionBridge → Adapter → Runtime 三层 |
| 多实例管理 | DirectorPool，SQLite 持久化 |
| 后台任务 | task-runner + task-store (SQLite)，MCP 派发 |
| Cron | scheduler + task-store (SQLite) |
| Web 控制台 | Express + WebSocket |
| 记忆 | Markdown 文件，git 管理 |
| 状态持久化 | SQLite（pool / tasks / cron） |
