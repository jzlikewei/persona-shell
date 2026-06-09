# Codex App-Server 适配升级方案

> 对比 [codex-app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 协议规范与当前实现（`codex-app-server.ts`），梳理已完成能力、缺失能力和升级优先级。

---

## 当前实现概况

核心文件：

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/director-runtime/codex-app-server.ts` | 768 | App-Server JSON-RPC runtime（进程管理、协议收发、事件处理） |
| `src/director-session-adapter/codex-app-server.ts` | 100 | SessionAdapter 薄包装（桥接 runtime ↔ SessionBridge hooks） |
| `src/codex-thread-injector.ts` | 391 | 一次性 JSON-RPC 客户端（任务回调注入已有 thread） |

运行模型：每个 `SessionBridge` 持有一个 `codex app-server --listen stdio://` 子进程，通过 stdin/stdout 交换 JSON-RPC 2.0 消息。

---

## 已完成能力

### 连接生命周期

| 能力 | 协议方法 | 实现位置 | 说明 |
|------|----------|----------|------|
| 初始化握手 | `initialize` + `initialized` | `startInternal()` | 发送 `clientInfo` + `capabilities.experimentalApi: true`，收到响应后发送 `initialized` 通知 |
| 新建线程 | `thread/start` | `startFreshThread()` L257-269 | 传入 cwd / approvalPolicy / sandbox / model / baseInstructions / developerInstructions |
| 恢复线程 | `thread/resume` | `startInternal()` L236-251 | 优先 resume，失败则 clearSession + 新建 |
| 线程命名 | `thread/name/set` | `setThreadName()` L554-557 | 让线程在 Codex 应用中可见 |

### 对话交互

| 能力 | 协议方法 | 实现位置 | 说明 |
|------|----------|----------|------|
| 发送消息 | `turn/start` | `send()` L126-162 | 传入 approvalPolicy / sandboxPolicy / model |
| 追加消息 | `turn/steer` | `send()` L140-146 | 当 `activeTurnId` 存在时走 steer，含 `expectedTurnId` |
| 中断 | `turn/interrupt` | `interrupt()` L173-183 | JSON-RPC 优先，失败退回 SIGINT |

### 事件处理（通知）

| 事件 | 协议方法 | 实现位置 | 说明 |
|------|----------|----------|------|
| 线程创建 | `thread/started` | `handleNotification` L384-387 | 持久化 threadId |
| Turn 开始 | `turn/started` | L389-396 | 记录 activeTurnId、重置计数器 |
| 文本增量 | `item/agentMessage/delta` | L399-409 | → `onChunk()` 流式推送前端 |
| Item 完成 | `item/completed` | L412-419 | agentMessage → `onPartialAgentMessage`；tool-like → `onToolCall` + `RuntimeToolCall` |
| Turn 完成 | `turn/completed` | `handleTurnCompleted()` L473-499 | 提取最终文本、计算 duration、处理 failed 状态 |
| Token 用量 | `thread/tokenUsage/updated` | `handleTokenUsage()` L502-514 | 用 `last`（非 `total`）避免累积计数 |
| 错误 | `error` | L430-436 | → `onTurnFailure()` + 清理活跃 turn |

### 审批（Server Request）

| 审批类型 | 协议方法 | 处理方式 |
|----------|----------|----------|
| 命令执行 | `item/commandExecution/requestApproval` | 自动 `accept` |
| 文件变更 | `item/fileChange/requestApproval` | 自动 `accept` |
| 权限请求 | `item/permissions/requestApproval` | 返回空 permissions（不授予额外权限） |
| 补丁审批 | `applyPatchApproval` | 自动 `accept` |
| 命令审批 | `execCommandApproval` | 自动 `accept` |
| 用户输入 | `item/tool/requestUserInput` | 返回空 `input` |
| MCP 弹窗 | `mcpServer/elicitation/request` | 自动 `decline` |

### 工具调用提取

| 来源 | 映射 | 说明 |
|------|------|------|
| `commandExecution` | name=`'Bash'`，提取 command/cwd/status/exitCode/output | 结构化 `RuntimeToolCall` |
| `fileChange` | name=`'File change'`，提取 changes/status | 结构化 `RuntimeToolCall` |
| 其他 tool-like items | 从 item.name/tool_name 字段提取 | 通用 fallback |

### 其他

| 能力 | 说明 |
|------|------|
| 沙箱策略映射 | `read-only` → `readOnly`；`workspace-write` → `workspaceWrite` + `writableRoots`；default → `dangerFullAccess` |
| Prompt 分层 | `soul.md`+`meta.md` → `baseInstructions`；`personas/{role}.md` + `system_prompt_file` + 当前 workspace `context.md` → `developerInstructions`。Codex 原生也支持通过配置读取 `model_instructions_file` / `developer_instructions`；Tenbase 时代的手工拼 prompt 方案已下线。 |
| MCP 注入 | `mcp_mode: mcp` 时通过 `-c` TOML 覆盖参数注入 MCP 服务器 |
| 进程组管理 | `detached: true` + `process.kill(-pid)` 终止进程组 |
| 日志 | stderr 重定向到 `codex-app-server-stderr.log`；所有 JSON-RPC 收发通过 `logOutput` 记录 |

---

## 最小兼容复核结论

本项目不追求实现完整 Codex App Server 客户端。当前主线目标是：Director 对话、后台任务、任务回调注入、流式文本、工具摘要、token usage 和进程生命周期稳定可用。

### 已收口

| 项 | 结论 |
|----|------|
| 初始化协议 | `initialize` 后已发送 `initialized` 通知，长驻 runtime 和一次性 thread injector 都覆盖 |
| sandbox 字段 | `turn/start` 已使用 `sandboxPolicy`；`thread/start`/`thread/resume` 仍保留 `sandbox` shorthand，当前 Codex schema 仍兼容 |
| Prompt 注入 | 主线使用 `baseInstructions` / `developerInstructions`；Tenbase 手工拼 prompt 方案已下线 |
| 后台任务 | `codex-app-server` provider 已使用临时 App Server task runtime；legacy turn-based provider 已删除 |
| MCP 注入 | `mcp_mode: mcp` 时通过 `-c` TOML overrides 注入 `.mcp.json` |
| 基础事件 | 覆盖 `thread/started`、`turn/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed`、`thread/tokenUsage/updated`、`error` |

### 保留关注

这些项只在能直接改善当前体验时实现，不作为协议追齐任务：

| 能力 | 协议事件/方法 | 触发条件 |
|------|---------------|----------|
| 工具运行中状态 | `item/started` | Web v2 需要更早展示 tool running，而不是等 `item/completed` |
| 命令输出流式 | `item/commandExecution/outputDelta` | 前端需要实时 tail 命令输出 |
| 文件 diff 快照 | `turn/diff/updated`、`item/fileChange/patchUpdated` | 前端要展示实时变更 diff |
| 错误分类 | `codexErrorInfo` / JSON-RPC `-32001` | 出现 context exceeded、usage limit 或 app-server overloaded 的实际故障 |
| 上下文压缩 | `thread/compact/start` | 需要把 Codex 原生 compact 接入现有 `/flush` 或 context health |
| 线程归档联动 | `thread/archive` / `thread/unarchive` | Workspace/session 归档 SSOT 收敛时再决定是否联动 Codex thread |

### 明确不追齐

以下能力暂不维护，除非后续产品需求明确进入 TODO：

| 能力 | 原因 |
|------|------|
| `thread/list` / `thread/read` / `thread/turns/list` 全量历史客户端 | 当前 session/workspace 事实源在 `state.db`，消息正文仍从日志读取；不把 app-server 当 session DB |
| `thread/fork` / `thread/rollback` | 当前 Web/飞书没有分支对话和 turn 回滚入口 |
| `review/start` | Code review 可继续通过普通任务/提示词实现，暂不绑定 Codex reviewer API |
| `command/exec` / `process/spawn` / `thread/shellCommand` | persona-shell 已有本地 shell/task runner 路径，不额外暴露 app-server process 管理面 |
| `fs/*` | 文件读写由 Shell 自身 API 和本地工具负责，不通过 app-server 代理 |
| `thread/goal/*` | Codex thread goal 与 persona-shell 当前 task/cron 模型重叠，先不引入第二套目标系统 |
| `thread/realtime/*` | 当前项目没有语音/WebRTC 交互目标 |
| `dynamicTools` / `item/tool/call` | 现阶段继续使用 MCP 和 persona task CLI，不做自定义 dynamic tools 客户端 |
| `account/*` / `config/*` | 认证和配置仍交给 Codex CLI / 本地 config 管理 |

---

## 当前协议映射速查

```
Codex App-Server 协议              persona-shell 映射
─────────────────────              ──────────────────
Thread                             ≈ Session（sessionId = thread.id）
Turn                               ≈ 一次消息 round-trip
Item                               ≈ AssistantTurnEvent 内的子事件

initialize                         → startInternal()
initialized                        → notify()（initialize 响应后发送）
thread/start                       → startFreshThread()
thread/resume                      → startInternal()（优先恢复）
turn/start                         → send()（无 activeTurn 时）
turn/steer                         → send()（有 activeTurn 时）
turn/interrupt                     → interrupt()

item/agentMessage/delta            → onChunk() → turn_event(assistant_delta)
item/completed(agentMessage)       → onPartialAgentMessage()
item/completed(commandExecution)   → onToolCall(RuntimeToolCall)
item/completed(fileChange)         → onToolCall(RuntimeToolCall)
turn/completed                     → onTurnComplete() → turn_event(turn_completed)
thread/tokenUsage/updated          → onMetrics()
error                              → onTurnFailure()

approval requests                  → 自动 accept/decline
```

---

## 参考资源

- 协议规范：`codex-rs/app-server/README.md`（[GitHub](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)）
- 当前 runtime 实现：`src/director-runtime/codex-app-server.ts`
- 当前 adapter：`src/director-session-adapter/codex-app-server.ts`
- 流式事件设计：`docs/streaming-turn-events.md`
- Agent 后端总览：`docs/agent-backends.md`
- Codex 集成设计：`docs/codex-persona-integration-handoff.md`
