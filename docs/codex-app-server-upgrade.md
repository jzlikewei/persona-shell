# Codex App-Server 适配升级方案

> 对比 [codex-app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 协议规范与当前实现（`codex-app-server.ts`），梳理已完成能力、缺失能力和升级优先级。

---

## 当前实现概况

核心文件：

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/director-runtime/codex-app-server.ts` | 756 | App-Server JSON-RPC runtime（进程管理、协议收发、事件处理） |
| `src/director-session-adapter/codex-app-server.ts` | 100 | SessionAdapter 薄包装（桥接 runtime ↔ SessionBridge hooks） |
| `src/codex-thread-injector.ts` | 381 | 一次性 JSON-RPC 客户端（任务回调注入已有 thread） |

运行模型：每个 `SessionBridge` 持有一个 `codex app-server --listen stdio://` 子进程，通过 stdin/stdout 交换 JSON-RPC 2.0 消息。

---

## 已完成能力

### 连接生命周期

| 能力 | 协议方法 | 实现位置 | 说明 |
|------|----------|----------|------|
| 初始化握手 | `initialize` | `startInternal()` L222-233 | 发送 `clientInfo` + `capabilities.experimentalApi: true`；**未发送 `initialized` 通知**（协议要求） |
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
| Prompt 分层 | `soul.md`+`meta.md` → `baseInstructions`；`personas/{role}.md` + `system_prompt_file` → `developerInstructions` |
| MCP 注入 | `mcp_mode: mcp` 时通过 `-c` TOML 覆盖参数注入 MCP 服务器 |
| 进程组管理 | `detached: true` + `process.kill(-pid)` 终止进程组 |
| 日志 | stderr 重定向到 `codex-app-server-stderr.log`；所有 JSON-RPC 收发通过 `logOutput` 记录 |

---

## 缺失能力（Gap 清单）

按优先级分组。

### P0 — 协议合规

| Gap | 协议要求 | 影响 | 修复成本 |
|-----|----------|------|----------|
| **缺少 `initialized` 通知** | `initialize` 后必须发送 `{"method":"initialized"}` | 未来 app-server 版本可能拒绝后续请求 | 低：1 行 `write` |
| **`turn/start` 缺少 `sandboxPolicy` 字段** | 实际传的是 `sandboxPolicy` 没问题，但 `thread/start` 传的是 `sandbox`（string shorthand） | `thread/start` 的 `sandbox` 是 legacy shorthand，新版本推荐 `sandboxPolicy` 或 `permissions` profile | 低：改 `threadOptions()` |

### P1 — 事件处理增强（提升流式体验）

| Gap | 协议事件 | 当前状态 | 价值 |
|-----|----------|----------|------|
| **推理事件** | `item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta` | 完全忽略 | 前端可展示 "思考中" 过程；对 reasoning-heavy 模型（o3 等）体验提升大 |
| **计划事件** | `turn/plan/updated`、`item/plan/delta` | 忽略 | 展示 agent 的 step-by-step 计划 |
| **文件变更流式** | `item/fileChange/patchUpdated` | 忽略 | 实时展示代码 diff，不用等 `item/completed` |
| **命令输出流式** | `item/commandExecution/outputDelta` | 忽略 | 实时展示命令 stdout/stderr |
| **Item 生命周期** | `item/started` → delta → `item/completed` | 仅处理 `item/completed` | `item/started` 可用于 UI 立即渲染 "工具执行中" 状态 |
| **Turn diff 快照** | `turn/diff/updated` | 忽略 | 聚合展示整轮文件变更 |

### P2 — 线程管理

| Gap | 协议方法 | 当前状态 | 价值 |
|-----|----------|----------|------|
| **线程分叉** | `thread/fork` | 未实现 | 从当前对话分叉新分支；配合 Web UI 的"分支对话"功能 |
| **线程归档** | `thread/archive` / `thread/unarchive` | 未实现 | 配合 Workspace Session 归档（已有 DB 层 `archiveSession`） |
| **线程列表** | `thread/list` / `thread/read` | 未实现 | 替代当前 SQLite 直接查 sessions 的方式 |
| **历史分页** | `thread/turns/list` | 未实现 | 分页加载 turn 历史，避免一次性拉全部 |
| **上下文压缩** | `thread/compact/start` | 未实现 | 手动触发压缩，避免 context window 超限 |
| **Turn 回滚** | `thread/rollback` | 未实现 | 撤销最近 N 轮 |
| **线程退订** | `thread/unsubscribe` | 未实现 | 不再接收某线程事件（多线程共享进程场景） |

### P3 — 错误处理增强

| Gap | 协议能力 | 当前状态 | 价值 |
|-----|----------|----------|------|
| **`codexErrorInfo` 分类** | `ContextWindowExceeded`、`UsageLimitExceeded`、`HttpConnectionFailed` 等 | 仅 `summarize(error)` 提取 message 文本 | 可按错误类型自动恢复：context exceeded → 自动 compact；usage limit → 通知用户 |
| **背压处理** | JSON-RPC `-32001` "Server overloaded; retry later" | 未处理 | 应指数退避重试 |
| **`turn/completed` 错误详情** | `error.codexErrorInfo`、`error.additionalDetails` | 仅取 `message` | 丢失结构化错误信息 |

### P4 — 高级功能

| Gap | 协议方法 | 当前状态 | 价值 |
|-----|----------|----------|------|
| **代码审查** | `review/start` | 未实现 | Codex 内置 reviewer，可直接触发 |
| **Shell 命令** | `thread/shellCommand` | 未实现 | `!` 命令不经过 sandbox |
| **命令执行** | `command/exec` | 未实现 | 沙箱内一次性命令 |
| **进程管理** | `process/spawn` / `kill` / `writeStdin` | 未实现 | 脱离 sandbox 的进程生命周期管理 |
| **文件系统** | `fs/readFile` / `fs/writeFile` / `fs/watch` 等 | 未实现 | 通过 app-server 操作文件，不直接访问文件系统 |
| **线程目标** | `thread/goal/set` / `get` / `clear` | 未实现 | 持续目标 + token 预算管理 |
| **线程设置** | `thread/settings/update` | 未实现 | 动态修改模型、effort 等设置 |
| **实时音频** | `thread/realtime/*` | 未实现 | 语音交互，WebRTC 传输 |
| **动态工具** | `dynamicTools` + `item/tool/call` | 未实现 | 在 `thread/start` 时注册自定义工具 |
| **MCP 服务器状态** | `mcpServerStatus/list`、`mcpServer/startupStatus/updated` | 未实现 | 监控 MCP 服务器健康状态 |
| **账号/认证** | `account/*` 系列 | 未实现 | 认证管理（当前靠环境变量 / CLI 登录） |
| **配置读写** | `config/read`、`config/value/write` 等 | 未实现 | 运行时调整 Codex 配置 |
| **Notification opt-out** | `initialize.capabilities.optOutNotificationMethods` | 传空数组 | 可按需过滤不关心的通知减少噪声 |

---

## 实现建议

### 阶段一：协议修复 + 核心事件（推荐先做）

**目标**：协议合规 + 流式体验对齐。

1. **`initialized` 通知**：`initialize` 响应后立即 `write('{"method":"initialized"}\n')`
2. **`item/started` 事件**：处理 `item/started`，向前端发出 `tool_started` turn event
3. **Reasoning 事件**：`item/reasoning/summaryTextDelta` 转为前端可展示的 "thinking" 块
4. **命令输出流式**：`item/commandExecution/outputDelta` 转为 `tool_progress` turn event
5. **错误分类**：解析 `codexErrorInfo` 枚举，自动处理 `ContextWindowExceeded`（触发 compact）

代码变更集中在 `handleNotification()` 的 switch-case 和 `AssistantTurnEvent` 类型扩展。

### 阶段二：线程管理

**目标**：支持 Web UI 的会话管理操作。

1. **`thread/fork`**：配合 Web UI "分支对话" 功能
2. **`thread/archive`**：与现有 `archiveSession` DB 操作联动
3. **`thread/compact/start`**：前端/自动触发上下文压缩
4. **`thread/rollback`**：撤销最近 N 轮

需要在 `CodexAppServerRuntime` 中暴露新方法，`SessionAdapter` 透传，`SessionBridge` 提供入口。

### 阶段三：高级功能

按需评估，优先级取决于产品方向：

- `review/start`：如果 Web UI 需要 "一键 code review"
- `thread/goal/*`：如果需要自主循环任务（token 预算管理）
- `dynamicTools`：如果需要把 persona 的 MCP tools 作为 Codex dynamic tools 注册
- `thread/settings/update`：如果需要运行时切换模型/effort

---

## 当前协议映射速查

```
Codex App-Server 协议              persona-shell 映射
─────────────────────              ──────────────────
Thread                             ≈ Session（sessionId = thread.id）
Turn                               ≈ 一次消息 round-trip
Item                               ≈ AssistantTurnEvent 内的子事件

initialize                         → startInternal()
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
