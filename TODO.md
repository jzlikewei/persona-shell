# TODO

> 当前版本:项目级收敛清单。个人项目优先清晰、简单、少分叉;本期目标是下掉旧功能、旧入口和旧字段,不是长期兼容。每个未完成事项都必须有可验收边界;勾选前必须留下对应验证证据。

## P0: Workspace / Session 路由收敛

目标:让 `workspace name + sessionId` 成为对外稳定标识。除 DirectorPool 内部运行时 key 外,旧的 `directorLabel` / `routingKey` / `source_director` 对外表面应在本期删除。

### WS-1: Legacy 路由字段盘点

- [x] 验收项:
  - [x] `directorLabel` / `director_label` / `routingKey` / `source_director` / `DIRECTOR_LABEL` 的主要调用点已盘点。
  - [x] 每类字段已归入三类之一:内部实现、本期删除入口、可删除或降级旧表面。
  - [x] 盘点结论写入 `docs/plan-workspace-routing.md`。
- 验证证据:
  - `rg -n 'directorLabel|routingKey|source_director|sourceDirector|director_label|DIRECTOR_LABEL' src --glob '!src/__tests__/**'`
  - `docs/plan-workspace-routing.md` 包含 "Legacy 路由字段盘点" 小节。

### WS-2: API 路由使用 sessionId / workspace

- [x] 验收项:
  - [x] `POST /api/send` 只接受 `{ sessionId, text }`;移除 `director` / `director_label` 路由入口。
  - [x] `GET /api/messages` 只接受 `?sessionId=`;移除旧 `director` / `session` 组合入口。
  - [x] `GET /api/sessions` / `POST /api/sessions` 以 `workspace` 为主入口,返回值包含 `sessionId`、`workspace`、`archived`、`role`、`cwd`。
  - [x] README 或 docs 中 API 例子只使用 `workspace + sessionId`;不再记录旧参数作为推荐用法。
- 验证方式:
  - `bun test src/__tests__/console-api.test.ts` 通过;覆盖 send/messages/sessions 的 sessionId 主路径和旧参数拒绝行为。
  - `bun test` 通过(472 pass)。
  - `bun run check` 通过。
  - `cd web-v2 && bun run build` 通过。
  - `rg -n 'director_label|source_director|routingKey' web-v2/src` 的剩余项只在 Runtime 控制、Tasks 展示和 status 类型,不在 Chat 发消息路径。

### WS-3: Task 回调迁移到 source_session_id

- [x] 验收项:
  - [x] `tasks` 表保存 `source_session_id` 和 `workspace`。
  - [x] 创建 task 时记录当前 `sessionId`;新 task 不再写入 `source_director` 作为路由依据。
  - [x] task 完成回调按 `source_session_id` 找 live session;若 session 已归档,转入 workspace default session。
  - [x] 旧 `source_director` task 在启动迁移时一次性转为 workspace,并清空旧字段;迁移后运行时不再读取它。
  - [x] Web/API/MCP task 创建路径均能传递或推断 `source_session_id`。
- 验证方式:
  - `bun test src/__tests__/task-store.test.ts src/__tests__/persona-process.test.ts src/__tests__/session-bridge.test.ts src/__tests__/director-runtime/codex-app-server.test.ts src/__tests__/director-session-adapter/codex.test.ts src/__tests__/director-session-adapter/claude.test.ts` 通过。
  - `bun test` 通过(474 pass)。
  - `bun run check` 通过。
  - `cd web-v2 && bun run build` 通过。

### WS-4: Cron 调度迁移到 workspace default session

- [x] 验收项:
  - [x] `cron_jobs` 表保存 `workspace`。
  - [x] cron 触发时优先使用 workspace default session。
  - [x] 新 cron job 不再写入 `source_director`;旧 `source_director` cron job 在启动迁移时转为 workspace 并清空旧字段。
  - [x] default session 归档后,cron 选择新的 default session;无 live default 时记录可诊断日志并退回 main。
- 验证方式:
  - `bun test src/__tests__/task-store.test.ts src/__tests__/scheduler.test.ts` 通过。
  - `bun test` 通过(476 pass)。
  - `bun run check` 通过。
  - `cd web-v2 && bun run build` 通过。

### WS-5: DirectorPool 职责边界固定

- [x] 验收项:
  - [x] `docs/architecture.md` 明确 DirectorPool 只负责运行时池、队列、进程和 streaming transport。
  - [x] `SessionManager` 是 sessionId 路由入口;业务代码不能直接使用 DirectorPool 作为领域事实源。
  - [x] `src/session-manager.ts` 中保留的 `get(routingKey)` / `resetSession(routingKey)` 等方法只保留在 runtime-only 小节;调用者限定为飞书 slash command、runtime/control、诊断或 legacy WebSocket 路径。
  - [x] `src/director-pool.ts` 的注释不再称其为 workspace/session 事实源。
- 验证方式:
  - `rg -n 'getPool\\(|get\\(routingKey\\)|resetSession\\(routingKey' src web-v2/src` 的剩余调用点只存在于 `src/director-pool.ts` / `src/session-manager.ts` 内部、飞书 slash command、runtime/control、附件队列、legacy WebSocket chat 路径;飞书普通消息主路径已改为 `SessionManager.sendToWorkspaceDefaultSession()`。
  - `bun run check` 通过。

### WS-6: 路由端到端验收

- [x] 验收项:
  - [x] Web 创建 workspace -> 创建 session -> 使用 sessionId 发消息 -> 消息按 sessionId 读取。
  - [x] 飞书小群消息 -> workspace 自动创建/复用 -> default session 接收消息。
  - [x] 归档 default session 后,下一次消息能创建或选择新的 default session。
  - [x] task 创建保存 `source_session_id + workspace`;归档回退由 WS-3 回调测试覆盖。
  - [x] cron 创建保存 `workspace`;调度到 workspace default session 由 WS-4 scheduler 路径覆盖。
- 验证方式:
  - 新增 `smoke:workspace-routing` 脚本,执行 `src/__tests__/workspace-routing-smoke.test.ts`。
  - `docs/workspace-routing-smoke.md` 保存 smoke 覆盖项和最近验证输出。
  - `bun run smoke:workspace-routing` 通过(4 pass)。
  - `bun test` 通过(480 pass)。
  - `bun run check` 通过。

参考:
- `docs/architecture.md`
- `docs/plan-workspace-routing.md`
- `src/session-manager.ts`
- `src/workspace-registry.ts`

## P0: Session SSOT 当前实现验收

目标:验证当前代码的唯一事实源是否成立。`state.db` 的 `workspaces` / `sessions` 是 workspace 列表、session 列表、default session、归档状态和 session 元数据的唯一事实源;日志只负责当前 session 的消息正文读取。不做 Web v1、旧日志、旧 director label 模式的数据兼容或迁移。

### SSOT-1: 当前 session 写入路径验收

- [ ] 验收项:
  - [ ] 新 session 创建时写入 `sessions` 表,并绑定 `workspace`。
  - [ ] session ready / user turn 完成只更新当前 session 元数据和时间戳,不从旧日志回填 session。
  - [ ] `workspaces.default_session_id` 只由 SessionManager/WorkspaceRegistry 更新。
  - [ ] `GET /api/sessions?workspace=` 只从 sessions 表返回 session 列表,不扫描旧日志生成 session。
- 验证方式:
  - 新增或更新当前路径测试,覆盖 create session、send turn、archive、list sessions。
  - `rg -n 'importSessionsFromLogs|backfillSessionsFromLogs|parseSessionsFiles\\(' src --glob '!src/log-parser.ts' --glob '!src/__tests__/log-parser.test.ts'` 不出现旧日志回填路径。
  - `bun test src/__tests__/session-manager.test.ts src/__tests__/workspace-routing-smoke.test.ts` 通过。

### SSOT-2: message_count 功能下线

- [x] 验收项:
  - [x] 新 sessions 表结构不再创建 `message_count`。
  - [x] `upsertSession()` 不再写入或递增 `message_count`。
  - [x] `/api/work-context` / `/api/sessions` 不再输出 `localMessageCount` / `messageCount`。
  - [x] web-v2 不再展示 workspace/session 消息数徽标。
  - [x] docs 记录 `message_count` 已下线,不提供重算/校准函数。
- 验证方式:
  - `rg -n 'message_count|messageCount|localMessageCount|message count' src web-v2` 无结果。
  - `docs/plan-session-ssot.md` 记录下线决策。
  - `bun run check` 通过。

### SSOT-3: 旧日志回填路径下线

- [x] 验收项:
  - [x] 启动时不再从旧日志扫描/回填 sessions 表。
  - [x] 删除 `backfillSessionsFromLogs()` 和 `importSessionsFromLogs()`。
  - [x] docs 写明旧 V1/旧日志模式不做数据兼容或迁移。
- 验证方式:
  - `rg -n 'importSessionsFromLogs|backfillSessionsFromLogs|parseSessionsFiles\\(' src --glob '!src/log-parser.ts' --glob '!src/__tests__/log-parser.test.ts'` 不出现旧日志回填路径。
  - `docs/plan-session-ssot.md` 记录当前实现验收口径。

### SSOT-4: ConsoleWorkspace 当前表面验收

- [ ] 验收项:
  - [ ] `ConsoleWorkspace` 的 workspace/session 字段来自 workspaces/sessions 表和 SessionManager。
  - [ ] web-v2 不依赖这两个字段作为 workspace/session 数据源。
  - [ ] 若仍暴露 `directorLabel` / `routingKey`,只能作为 runtime/debug 信息,不参与 workspace/session 选择。
- 验证方式:
  - `rg -n 'directorLabel|routingKey' web-v2/src src/console.ts` 的剩余项有注释或兼容分类。
  - `bun run check` 通过。

### SSOT-5: 当前重启一致性验收

- [ ] 验收项:
  - [ ] Shell 重启后 sessions 表能恢复 session 列表。
  - [ ] live session 与 DB session 合并不重复。
  - [ ] 归档 session 不会因为 live restore 回流为默认 session。
  - [ ] 当前 session 的消息仍能按 sessionId 读取。
- 验证方式:
  - 新增重启/restore 测试或脚本,记录 DB rows、live entries、default session 和 message read 结果。

参考:
- `docs/plan-session-ssot.md`
- `src/task/task-store.ts`
- `src/session-bridge.ts`
- `src/console.ts`

## P1: Web v1 下线 / web-v2 唯一入口

目标:web-v2 是唯一 Web UI。旧 Web v1 不保留 fallback、不保留 debug 面,相关静态资源和文档入口全部下线。

### WEB-1: 入口策略

- [x] 验收项:
  - [x] `/` 指向 web-v2。
  - [x] `/v1` 删除,不保留 `/debug/legacy`。
  - [x] README / docs 不再描述 v1/v2 双轨。
- 验证方式:
  - HTTP smoke 覆盖 `/` 可用,`/v1` 返回 410。
  - README 或 docs 有入口说明。

### WEB-2: web-v2 能力边界

- [x] 验收项:
  - [x] web-v2 文档只声明 Chat / Tasks / Files 已覆盖。
  - [x] Runtime / Automations / Persona / Logs / Settings 若未迁移到 web-v2,不在主 UI 出现可操作入口。
  - [x] UI 中不可操作的功能不出现可点击假入口。
- 验证方式:
  - `web-v2/README.md` 和 `web-v2/ARCHITECTURE.md` 能力表一致。
  - 浏览器 smoke 无假按钮/无 console.error。

### WEB-3: legacy 管理面下线

- [x] 验收项:
  - [x] 删除 legacy Web v1 管理面入口。
  - [x] 删除 `src/public/index.html` / `src/public/css/style.css` / `src/public/js/app.js`。
  - [x] 必须迁移的 v1-only 功能当前没有确定真实使用场景;旧功能直接删除,不再保留入口。
  - [x] 不再新增 v1 功能。
- 验证方式:
  - `docs/web-agent-workbench.md` 或专门文档记录决策。

### WEB-4: web-v2 最终冒烟

- [ ] 验收项:
  - [ ] 认证/token 或跳过认证流程可用。
  - [ ] workspace/session/chat/tasks/files 主路径可用。
  - [ ] 断线重连后状态恢复。
  - [ ] 浏览器控制台无 `console.error`。
- 验证方式:
  - Playwright 或等价浏览器 smoke 记录。
  - `cd web-v2 && bun run build` 通过。

参考:
- `web-v2/BLUEPRINT.md`
- `web-v2/README.md`
- `web-v2/ARCHITECTURE.md`
- `docs/web-agent-workbench.md`

## P1: 项目文档校准

目标:让 README、架构文档、计划文档和代码现状一致。

- [x] 验收项:
  - [x] `TODO.md` 已改为项目级收敛清单。
  - [x] `web-v2/README.md` 已替换 Vite 模板内容。
  - [x] `web-v2/ARCHITECTURE.md` 已新增。
  - [x] `docs/architecture.md` 已标注目标模型与兼容层差异。
  - [x] `docs/plan-workspace-routing.md` 已从理想计划改为当前状态 + 剩余迁移点。
  - [x] `docs/plan-session-ssot.md` 已变成可执行收尾 checklist。
  - [x] 已清理落地的 WP 注释。
- 验证证据:
  - `bun run check` 通过。
  - `bun test` 曾全量通过。

## P2: Codex App Server 最小兼容复核

目标:只维护 persona-shell 当前需要的 App Server 能力,不做全量协议客户端。

- [x] 验收项:
  - [x] `codex-app-server` provider 的后台任务使用临时 App Server task runtime。
  - [x] 旧 Tenbase/Codex 手工拼 Prompt 方案标记为废弃。
  - [x] 主线 prompt 注入使用 App Server instructions / Codex 原生 instruction 配置。
  - [x] 协议能力已分成已收口、保留关注、明确不追齐。
  - [x] `initialize` 后发送 `initialized` notification。
- [ ] 后续下线项:
  - [ ] 删除 `type: codex` turn-based `codex exec` provider 路径。
  - [ ] 删除 `buildInjectedPrompt()` 旧手工拼 prompt 实现。
  - [ ] 删除相关 `codex exec` fallback 文档和测试,只保留 `codex-app-server` 主线。
- 验证证据:
  - `docs/codex-app-server-upgrade.md`
  - `bun test src/__tests__/director-runtime/codex-app-server.test.ts src/__tests__/codex-thread-injector.test.ts src/__tests__/task-runner.test.ts`
  - `bun run check`
