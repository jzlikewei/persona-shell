# 修复: No Local History SSOT — 用 state.db 作为唯一数据源

## 背景

"No Local History" workspace 分组和 session 管理违反 SSOT：

1. **3 个 API 独立解析同一份日志文件**，产生不一致的计数
2. **Director label 这个中间概念不应暴露到数据模型** — 它只是 AI 进程实例 ID
3. **Session 元数据散落**在 KV 表、pool 内存快照、日志文件三处
4. **前端 active session 被 2 个 hook 修改**（`use-sessions.ts` + `use-chat.ts`）
5. **日志目录按 director label 组织**，但应按 workspace 组织

---

## 数据模型

### 层级关系

```
Workspace 1:N Session
```

Session 直接归属 Workspace。director label 降级为 bridge 内部实现细节。

### sessions 表（新建，`src/task/task-store.ts`）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  workspace        TEXT NOT NULL,       -- workspace name（如 'main', '日报助手'）
  session_name     TEXT,
  message_count    INTEGER NOT NULL DEFAULT 0,
  first_message_at TEXT,
  last_message_at  TEXT,
  alive            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace);
```

**导出函数**：

| 函数 | 说明 |
|------|------|
| `upsertSession(workspace, sessionId, patch)` | 创建或更新 session（increment message_count、更新时间戳） |
| `markSessionAlive(sessionId, alive)` | 设置 session 存活状态 |
| `setSessionNameInDb(sessionId, name)` | 设置/清除 session 名称（替代旧的 `session:names` KV） |
| `listSessionsFromDb(workspace)` | 查某 workspace 的所有 sessions，按 last_message_at DESC |
| `getWorkspaceSessionStats(workspace)` | 返回 `{ sessionCount, messageCount, lastMessageAt }`（用于侧边栏分组） |
| `importSessionsFromLogs(workspace, parsedSessions[])` | 批量导入旧日志数据（事务） |
| `deleteSessionsByWorkspace(workspace)` | workspace 删除时清理 |

---

## 当前问题详解

### 问题 1：3 API 独立解析日志

```
/api/work-context → localHistoryForWorkspace() → parseSessionsFiles() → localMessageCount
/api/sessions    → resolveDirectorLogTarget()  → parseSessionsFiles() → session[].messageCount
/api/messages    → resolveDirectorLogTarget()  → parseConversationLogFiles() → 实际消息
```

三个 API 各自从文件系统解析日志，使用不同的 director label 解析路径，产出的计数互相矛盾。

**修复后**：sessions 表是 workspace 分组和 session 列表的唯一数据源。`/api/messages` 仍读日志文件（消息内容不入 DB）。

### 问题 2：Director label 解析有两套实现

`buildWorkContext()` 使用 3 层 spread fallback：
```typescript
const routing = {
  ...unlinkedDirectorForWorkspace(name),    // sha256 hash
  ...legacyDirectorForWorkspace(name),      // 正则匹配
  ...directorForWorkspace(name),            // pool 查找
};
```

`resolveDirectorLogTarget()` 使用完全不同的路径：
```typescript
const entry = pool?.getPoolStatus().find(item => item.label === requested);
```

同一个 workspace 两个 API 可能解析出不同的 director label → 查到不同日志目录 → 返回不同数据。

**修复后**：删除 director label 解析层。workspace name 直接对应日志目录和 DB 查询。

### 问题 3：前端 active session 多点写入

`use-chat.ts` 的 `liveEventMatches()` 在检测到 session 不匹配时：
```typescript
// use-chat.ts:106-109 — 越权修改 session 状态
localStorage.setItem(storageKeyForDirector(eventDirector), eventSessionId)
window.dispatchEvent(new CustomEvent(ACTIVE_SESSION_EVENT, ...))
```

同时 `use-sessions.ts:128-143` 也监听同一组 WebSocket 事件修改 session 状态。一个事件触发 2 次 localStorage 写入 + 2 次 setState。

**修复后**：`use-chat.ts` 只做事件过滤（纯函数），`use-sessions.ts` 是 session 状态唯一所有者。

---

## 改动步骤

### Step 1: task-store.ts — 添加 sessions 表和 CRUD

添加建表语句到 `openDb()`，实现上述 7 个导出函数。

### Step 2: session-bridge.ts — 写入 DB + 日志路径改用 workspace name

关键改动点：

- **日志目录**：`logDir` getter 从 `join(getLogDir(), this.label)` 改为 `join(getLogDir(), this.workspaceName)`
  - 新增 `workspaceName` 属性：main bridge 用 `'main'`，pool bridge 用 `groupName`
  - bridge 已持有 `groupName`（`session-bridge.ts:73,127`），main bridge 可默认 `'main'`
- **turn 完成时**（`handleTurnComplete`，约 line 1401）：调用 `upsertSession(workspace, sessionId, { messageCount: 1 })`
- **session 初始化时**：调用 `markSessionAlive(sessionId, true)`
- **bridge shutdown 时**：调用 `markSessionAlive(sessionId, false)`
- **setSessionName**（约 line 1627）：用 `setSessionNameInDb()` 替代 `getState/setState('session:names')`

### Step 3: console.ts — 统一数据源

**`/api/work-context`（line 2961）**：
- 删除 `localHistoryForWorkspace()`（不再解析日志）
- 删除 `directorForWorkspace()` / `legacyDirectorForWorkspace()` / `unlinkedDirectorForWorkspace()`（不再需要 director label 解析）
- 用 `getWorkspaceSessionStats(workspaceName)` 获取 `{ localSessionCount, localMessageCount, lastMessageAt }`

**`/api/sessions`（line 3031）**：
- 用 `listSessionsFromDb(workspace)` 替代 `parseSessionsFiles()` + name 注入 + alive 注入
- 保留 live director status 叠加（当前 session 可能还没完成 turn，DB 里还没记录）

**`resolveDirectorLogTarget()`（line 94）**：
- 改为接受 workspace name 而非 director label
- 日志路径改为 `logs/{workspace}/`，同时兼容读取旧路径 `logs/{oldLabel}/`

**`/api/messages`（line 3024）**：
- 调用方传 workspace name，底层仍用 `parseConversationLogFiles()` 读日志内容

### Step 4: console.ts — 启动时回填

bridge 启动时（或 `buildWorkContext()` 发现 sessions 表对某 workspace 为空时）：
- 从旧日志路径解析一次 `parseSessionsFiles()`
- 调用 `importSessionsFromLogs(workspace, sessions)` 填充 DB
- 之后只通过 DB 写入维护数据

### Step 5: 日志路径兼容

| 操作 | 路径策略 |
|------|---------|
| **写入** | 只写 `logs/{workspace}/` |
| **读取** | 同时扫描 `logs/{workspace}/` 和 `logs/{oldLabel}/`，合并结果 |

旧路径通过 pool persisted entries 或 legacy 正则推导 `workspace → oldLabel` 映射。随时间推移旧日志自然过期。

### Step 6: 前端 — active session SSOT

**`web-v2/src/hooks/use-chat.ts`**：

移除 `liveEventMatches()` 中的 session 切换副作用（line 106-109），改为 `return false`。`use-sessions.ts` 是唯一的 session 状态管理者。

### Step 7: 前端 — API 参数调整

`use-sessions.ts` 和 `use-chat.ts` 中的 API 调用参数从 `director` 改为 `workspace`，匹配后端 API 变更。

---

## 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/task/task-store.ts` | 新增 sessions 表 + CRUD 函数 |
| `src/session-bridge.ts` | logDir 改用 workspace name；turn 完成写 DB；session name 写 DB |
| `src/console.ts` | 删除 director label 解析层；API 改读 DB；日志路径兼容；启动回填 |
| `src/director-pool.ts` | 日志路径适配（bridge 创建时传 workspace name） |
| `web-v2/src/hooks/use-chat.ts` | 移除 session 切换副作用 |
| `web-v2/src/hooks/use-sessions.ts` | API 参数 director → workspace |
| `src/log-parser.ts` | 不修改（`/api/messages` 仍需读取实际消息内容） |

---

## 验证计划

1. 启动 shell → 验证旧日志数据回填到 sessions 表
2. 发消息 → 验证新日志写入 `logs/{workspace}/`，sessions 表 message_count 递增
3. 侧边栏 → 验证 "No Local History" 分组与实际消息数一致
4. 切换 session → 验证无状态漂移（前端不再双写）
5. 重启 shell → 验证 sessions 表持久化，旧日志仍可读取
6. `npm test` 通过

---

## Review 结论（2026-06-04，Philosopher 审阅）

### 必须修复

- **回填幂等性**：当前"sessions 表为空才回填"的逻辑有漏洞——部分回填后事务回滚，重启时表不为空就永远不再回填，导致数据永久丢失。`importSessionsFromLogs` 需改为 upsert 语义（已存在则跳过），或用独立信号（如 `migration:sessions-imported` KV 标记）判断是否需要回填。

### 可优化项

- **message_count 定位**：它是派生量（可从日志重算），当主数据存有不一致风险（crash 时日志已写但 DB 未 increment）。明确定位为"缓存/近似值"即可接受，或加定期重算机制。
- **旧日志路径 sunset**：设定明确期限（如 30 天），或启动时做一次文件迁移（mv `logs/{oldLabel}/` → `logs/{workspace}/`），避免长期维护双路径扫描。
- **`alive` 字段**：kill -9 后永远为 true，语义不可靠。从 DB 删除，改为从 bridge 运行时状态实时派生（前端已有 `liveSessionId` 做这件事）。
- **`ConsoleWorkspace` 接口**：同步清理 `directorLabel` 等将被废弃的字段。

### 已澄清（无需修改）

- **中文 workspace name 做路径**：macOS APFS / Linux ext4 原生 UTF-8，无兼容性问题。现有 `safeGroupName` 已处理特殊字符。
- **Session 概念的必要性**：Session 是 workspace 下的并行对话实例，不是可以消除的实现细节。一个 workspace 可以有多个并行 session（不同 agent 同时工作）。数据模型 `Workspace 1:N Session` 正确。

---

## 当前收尾清单（2026-06-08）

当前代码已经有 sessions/workspaces 表、`WorkspaceRegistry`、`SessionManager`、session 归档和 web-v2 的 session 选择逻辑。剩余问题集中在一致性和兼容层收窄:

- [ ] **回填幂等性复核**:确认 `importSessionsFromLogs()` 对部分失败、重复启动、旧日志新增都能安全 upsert。
- [ ] **message_count 语义**:文档和 UI 中明确它是派生缓存;若要强一致,增加日志重算入口。
- [ ] **旧日志路径 sunset**:决定保留双路径读取多久,或在启动时迁移旧 `logs/{label}` 到 `logs/{workspace}`。
- [ ] **ConsoleWorkspace 字段清理**:把 `directorLabel` / `routingKey` 标为兼容字段,逐步从领域模型和 v2 UI 中移除。
- [ ] **重启验证**:覆盖 shell 重启、live session 合并、归档 session 不回流、旧日志仍可读。
