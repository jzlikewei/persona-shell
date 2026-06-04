# 实施计划：Workspace 为中心的路由重构

## 背景

架构文档（`docs/architecture.md`）已更新领域模型。本文档是从当前代码演进到目标模型的实施计划。

## 当前代码 vs 目标模型

| 维度 | 现状 | 目标 |
|------|------|------|
| 路由标识 | routingKey（chatId / workspace name / label 混合） | sessionId |
| 运行时管理 | DirectorPool `Map<routingKey, PoolEntry>` | SessionManager `Map<sessionId, SessionEntry>` |
| Workspace 管理 | 分散在 console.ts buildWorkContext() / KV 存储 | WorkspaceRegistry 独立组件 |
| 前端标识 | directorLabel | sessionId + workspace name |
| WS 事件 | `{ director: label }` | `{ sessionId: "xxx" }` |
| 回复路由 | PoolEntry.feishuChatId / web-console 哨兵 | MessagingRouter 基础设施层 |
| 数据存储 | KV 散落（workspace:config / pool:entries / session:names） | workspaces 表 + sessions 表 |
| Task 回调 | `source_director: label` | `source_session_id`，归档则 fallback default |
| Cron | `source_director: label` | workspace default session |

## 实施阶段

### Phase 1: 数据层

**目标**：建立 workspaces 表和调整 sessions 表，提供 CRUD 接口。

1. **task-store.ts** — 新增 `workspaces` 表
   ```sql
   CREATE TABLE IF NOT EXISTS workspaces (
     name               TEXT PRIMARY KEY,
     default_session_id  TEXT,
     cwd                TEXT,
     agent              TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL
   );
   ```

2. **task-store.ts** — 调整 `sessions` 表
   - 新增 `archived` 字段（INTEGER DEFAULT 0）
   - 新增 `role` 字段（TEXT）
   - 新增 `cwd` 字段（TEXT）
   - 去掉 `message_count`、`alive`、`first_message_at`、`last_message_at`

3. **task-store.ts** — Workspace CRUD 函数
   - `createWorkspace(name, opts)`
   - `getWorkspace(name)`
   - `listWorkspaces()`
   - `updateWorkspace(name, patch)`
   - `setDefaultSession(workspaceName, sessionId)`

4. **task-store.ts** — Session CRUD 调整
   - `createSession(workspace, opts)` — 含 role, cwd
   - `archiveSession(sessionId)` — 设 archived = 1
   - `listSessions(workspace, { includeArchived? })` — 默认不含归档
   - `getSession(sessionId)`

5. **迁移**：启动时检测旧 KV 数据（`workspace:config:*`、`pool:entries`），迁移到新表

### Phase 2: WorkspaceRegistry

**目标**：独立的 workspace 管理组件。

1. **新建 `src/workspace-registry.ts`**
   - `resolve(workspaceName)` → defaultSessionId
   - `getOrCreate(name, opts)` → Workspace
   - `setDefaultSession(name, sessionId)`
   - `listWorkspaces()` → WorkspaceInfo[]
   - 飞书群名 → workspace 映射逻辑从 index.ts 迁入

2. **console.ts** — `buildWorkContext()` 改为调用 WorkspaceRegistry

### Phase 3: SessionManager

**目标**：替换 DirectorPool，以 sessionId 为 Map key。

1. **新建 `src/session-manager.ts`**（或重构 `director-pool.ts`）
   - `entries: Map<sessionId, SessionEntry>`
   - `createSession(workspace, opts)` → 创建 Session + 启动 Agent（SessionBridge）
   - `send(sessionId, text)` → 找到 entry → bridge.send()
   - `archiveSession(sessionId)` → 停止 Agent + 标记归档
   - `flush(sessionId)` → checkpoint → kill → 创建新 session → 更新 workspace default
   - `switchAgent(sessionId, agentName)` → 旧 session 保留 → 新 session
   - `switchRole(sessionId, roleName)` → 旧 session 保留 → 新 session
   - `restoreEntries()` → 从 SQLite 恢复
   - `reapIdle()` / `evictLRU()` → 空闲/容量管理

2. **保留 SessionBridge 三层架构**：SessionBridge → Adapter → Runtime 不变

3. **去掉 routingKey / label**：
   - SessionBridge 的 `label` 属性改为使用 workspace name（pipe 目录、日志目录）
   - `routingKeyToLabel()` 函数删除

### Phase 4: 回复路由

**目标**：Agent 不感知消息来源，回复由 MessagingRouter 层处理。

1. **MessagingRouter 扩展**：
   - 跟踪每个 session 最后一条消息的来源 channel（web / feishu）
   - 回复时：总是推送 WebUI + 如果来源是 feishu 则同时转发
   - 流式回复管理（streamingReplies）从 DirectorPool 迁入 MessagingRouter

2. **SessionBridge 事件简化**：
   - 事件携带 `sessionId` 而非 `label`
   - `{ type: "chunk", sessionId, text }`

### Phase 5: API 层

**目标**：console.ts API 全部用 sessionId 路由。

1. **`POST /api/send`**：`{ sessionId, text }` — sessionId 必填
2. **`POST /api/sessions`**：`{ workspace }` — 创建 session，返回 sessionId
3. **`GET /api/sessions`**：`?workspace={name}` — 列出 workspace 的 sessions
4. **`GET /api/messages`**：`?sessionId={id}` — 按 sessionId 查消息
5. **`PATCH /api/sessions/:id`**：归档 / 设为 default
6. **WS 事件**：`director` 字段全部改为 `sessionId`
7. **WS chat handler**：`msg.sessionId` 必填

### Phase 6: 飞书入口

**目标**：飞书消息通过 workspace → default session 路由。

1. **index.ts onMessage handler**：
   - 群名 → `workspaceRegistry.getOrCreate(groupName)` → workspace
   - `workspace.defaultSessionId` → `sessionManager.send(sessionId, text)`
   - 如果没有 default session → 创建
   - 私聊 → main workspace → default session

2. **Task 回调路由**：
   - `source_director` → `source_session_id`
   - 回调时找 session，已归档则 fallback workspace default

3. **Cron 调度**：
   - `source_director` → `workspace`
   - 使用 workspace default session

### Phase 7: 前端

**目标**：去掉 directorLabel，全部换成 workspace name + sessionId。

1. **use-chat.ts**：
   - `sendMessage` → `POST /api/send { sessionId, text }`
   - WS 事件匹配按 `sessionId` 过滤
   - 去掉 `director` 参数

2. **use-sessions.ts**：
   - 按 workspace name 查 sessions
   - 管理 active session 选择

3. **root-layout.tsx**：
   - 去掉 `directorLabel`
   - Outlet context 传 `workspaceName` + `sessionId`

4. **chat.tsx**：
   - `useChat(sessionId)` 而非 `useChat(directorLabel, sessionId, ..., workspaceName)`

5. **状态快照**：解析新的 sessionId 格式

### Phase 8: 迁移 & 清理

1. 启动时从旧 KV / pool:entries 数据迁移到新 workspaces/sessions 表
2. 删除 `routingKeyToLabel()`
3. 删除 `DirectorPool`（被 SessionManager 替代）
4. 删除 `resolveWorkspace()`（临时补丁）
5. 清理 console.ts 中的 `directorLabel` / `routingKey` 引用
6. 清理前端的 `directorLabel` 相关代码

## 依赖关系

```
Phase 1 (数据层)
  ↓
Phase 2 (WorkspaceRegistry) ──→ Phase 6 (飞书入口)
  ↓
Phase 3 (SessionManager) ──→ Phase 4 (回复路由)
  ↓
Phase 5 (API 层) ──→ Phase 7 (前端)
  ↓
Phase 8 (迁移 & 清理)
```

Phase 1→2→3 是核心路径，必须串行。Phase 4/5/6 可以在 Phase 3 完成后并行推进。Phase 7 依赖 Phase 5（API 变更）。Phase 8 最后做。

## 验证方案

每个 Phase 完成后：
- `bun test` 全部通过
- `tsc --noEmit` 无错误

最终验证：
1. Web 端选 workspace → 创建 session → 发消息 → 回复正确显示
2. 飞书群聊消息 → workspace 自动创建 → default session → 回复转发到飞书
3. FLUSH → 旧 session 保留可查看 → 新 session 成为 default
4. 切换 Agent → 旧 session 保留 → 新 session 自动使用
5. 归档 session → UI 不可见 → 数据仍在
6. Task 完成回调 → 回到原 session（或 default 如已归档）
7. Cron 触发 → 使用 workspace default session
