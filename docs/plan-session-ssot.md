# Session SSOT 当前实现验收

## 目标

本页记录当前代码的 SSOT 验收口径,不是旧 Web v1、旧日志或旧 director label 模式的迁移计划。

当前决策:

- `workspaces` 表是 workspace 列表、配置和 default session 的事实源。
- `sessions` 表是 session 列表、归档状态、session 名称、agent 快照和时间戳的事实源。
- 日志只负责当前 session 的消息正文读取,不负责生成 session 列表或 workspace 统计。
- 旧 Web v1 已下线,旧日志/旧 label 数据不做兼容迁移。
- `message_count` 功能已下线,不展示、不写入、不重算。

## 当前数据模型

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  name               TEXT PRIMARY KEY,
  default_session_id  TEXT,
  cwd                TEXT,
  agent              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  workspace        TEXT NOT NULL,
  session_name     TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  role             TEXT,
  cwd              TEXT,
  agent_name       TEXT,
  agent_type       TEXT,
  model            TEXT,
  created_at       TEXT,
  first_message_at TEXT,
  last_message_at  TEXT,
  alive            INTEGER NOT NULL DEFAULT 0
);
```

历史 DB 如果已经有额外旧列,新代码不依赖、不读取、不展示。

## 事实源边界

| 数据 | 唯一事实源 | 不再使用 |
|------|------------|----------|
| workspace 列表 | `workspaces` 表 / `WorkspaceRegistry` | 文件目录扫描作为业务事实源 |
| workspace default session | `workspaces.default_session_id` | director label / routingKey |
| session 列表 | `sessions` 表 / `SessionManager` | `parseSessionsFiles()` 旧日志回填 |
| session 归档 | `sessions.archived` | live pool entry 推断 |
| session 消息正文 | 当前日志按 `sessionId` 过滤读取 | 消息正文入 DB |
| message count | 不提供 | `message_count` / `localMessageCount` / `messageCount` |

## 已下线内容

- Web v1 静态管理面已删除,`/v1` 返回 410。
- `message_count` 功能已删除。
- 启动时旧日志回填 sessions 表已删除。
- `importSessionsFromLogs()` / `backfillSessionsFromLogs()` 已删除。

## 当前验收项

### 1. 当前 session 写入路径

- 新 session 创建时写入 `sessions` 表,并绑定 workspace。
- session ready / user turn 完成只更新当前 session 元数据和时间戳。
- `workspaces.default_session_id` 只由 `SessionManager` / `WorkspaceRegistry` 更新。
- `GET /api/sessions?workspace=` 只从 `sessions` 表返回 session 列表。

验证:

```bash
rg -n 'importSessionsFromLogs|backfillSessionsFromLogs|parseSessionsFiles\(' src --glob '!src/log-parser.ts' --glob '!src/__tests__/log-parser.test.ts'
bun test src/__tests__/session-manager.test.ts src/__tests__/workspace-routing-smoke.test.ts
```

### 2. message_count 下线

- `src` / `web-v2` 中没有 `message_count`、`messageCount`、`localMessageCount` 功能引用。
- web-v2 不展示 workspace/session 消息数。

验证:

```bash
rg -n 'message_count|messageCount|localMessageCount|message count' src web-v2
```

### 3. 当前重启一致性

- Shell 重启后,live session 与 DB session 合并不重复。
- 归档 session 不因为 live restore 回流为 default session。
- 当前 session 消息能按 sessionId 读取。

这部分仍需要补专门 restore/smoke 测试。
