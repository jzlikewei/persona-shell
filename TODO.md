# TODO

## Codex App-Server 适配升级

详见 `docs/codex-app-server-upgrade.md`。

- [ ] **P0 协议修复**：`initialize` 后发送 `initialized` 通知；`thread/start` 从 legacy `sandbox` 切换到 `sandboxPolicy`/`permissions`
- [ ] **P1 事件增强**：处理 `item/started`、`item/reasoning/summaryTextDelta`（思考过程）、`item/commandExecution/outputDelta`（命令输出流式）、`item/fileChange/patchUpdated`（文件变更流式）
- [ ] **P1 错误分类**：解析 `codexErrorInfo` 枚举，`ContextWindowExceeded` 自动触发 compact，`UsageLimitExceeded` 通知用户
- [ ] **P2 线程管理**：`thread/fork`（分支对话）、`thread/archive`（与 DB archiveSession 联动）、`thread/compact/start`（手动压缩）、`thread/rollback`（撤销 N 轮）
- [ ] **多 thread 共享 app-server 进程**：Codex 官方未支持，等支持后再做（详见"Workspace 路由重构后续"的 2026-06 评估）

## Workspace 路由重构后续(2026-06 评估)

- [x] ~~DirectorPool 内部 wireEvents 回复路由迁移到 SessionManager 层~~ — 实际审查后无需迁移:当前架构已经是 **console → SessionManager.forwardPoolEvents → DirectorPool.wireEvents → bridge**,SessionManager 已在转发层中心位置;pool emit 已带 `bridge.label` 作为首参,console.ts 在 sessionManager 层面订阅并 `resolveSessionId(label)`。继续迁移收益微小、改动风险大。`src/session-manager.ts:293-299`。
- [x] ~~运行时测试:启动 shell,通过 web/feishu 发消息验证路由正确性~~ — runtime test 在无真实 persona 配置 + feishu 凭证的环境下无法执行;逻辑路径通过静态分析已确认(`forwardPoolEvents` re-emit pool events,console.ts listener 接 `label, text` 并 `resolveSessionId`)。生产部署前需补一次冒烟。
- [x] **多 thread 共享单 app-server 进程评估** — 结论:**不实现**。每个 `SessionBridge` 当前持有一个 Codex `app-server` 子进程(由 `codex-thread-injector.ts` 启动,见 `src/index.ts:439`)。Codex app-server 协议层目前不支持多 thread 共享一个进程(`thread/start` 创建 thread,每个 thread 仍是独立 subprocess 关系),官方也未给出推荐。**建议**:等 Codex 官方支持后再做。期间如果 thread 数膨胀,优化点是减少 LRU eviction 频率(`director-pool.ts:1111` `evictLRU`)。

## 飞书卡片交互增强

- [ ] 利用飞书消息卡片实现 Session 初始化配置（选择 agent 类型、模型、sandbox 模式等）
- [ ] 卡片式 workspace/session 路径选择（cwd 配置、workspace 切换）
- [ ] 探索卡片 action 回调驱动 session 生命周期（创建/归档/切换 session，而非纯命令行 `/flush` `/switch`）

## Web UI 问题（web-v2）

> 当前 Web-v2 覆盖 Chat / Tasks / Files 三个页面。
> `docs/web-agent-workbench.md` 规划的 Runtime / Automations / Persona / Observability / Settings 页面均未实现。

### Chat 页面

- [ ] 缺少「停止生成 / 中断」按钮（streaming 时无法主动终止）
- [ ] 缺少消息编辑、删除、重新生成、复制功能
- [ ] 消息列表无搜索、无分页（硬编码 limit=100）
- [ ] 缺少消息日期分隔线
- [ ] 用户消息不渲染 markdown（只有 assistant 消息走 react-markdown）
- [ ] **已知问题**：streaming 追加消息时无平滑滚动动画。`followOutput` 被改成 `'auto'` 是切 session 不持续滚动的代价；未来要分清"切会话"与"流式追加"两种意图，可考虑： (a) ref 区分两种状态分别设 `'auto'` / `'smooth'`；(b) 关掉 followOutput，改成在 streaming 增量时手动 `scrollBy`

### Session / Workspace 管理

- [ ] Workspace 下缺少「新建 Session」入口（侧边栏只展示已有 sessions，无新建按钮）
- [ ] Workspace cwd 配置：当前只有文件夹浏览器选择，需要支持直接粘贴路径地址
- [ ] 缺少 Session 归档操作入口
- [ ] 侧边栏 "Bind project" 按钮是空操作（未接线）

### Director 运行时操作（后端 API 已有，UI 无入口）

- [ ] Flush（`/api/flush`）— 需要按钮或命令面板入口
- [ ] Restart（`/api/restart`）— 仅侧边栏底部 "Restart Shell" 会发 `/shell-restart`，无 Director 级别重启
- [ ] Interrupt（`/api/interrupt`）— streaming 时应显示停止按钮
- [ ] Switch agent（`/api/switch-agent`）— 运行时切换 Agent 后端（claude/codex/kimi）
- [ ] Switch persona（`/api/switch-persona`）— 运行时切换人格角色

### Tasks 页面

- [ ] 任务结果面板关闭后无法重新打开（需选另一个 task 才能恢复）
- [ ] "Sent" 完成度指示器始终显示 "not sent"（未接线）
- [ ] 无法查看 result_file 内容（只显示路径）
- [ ] 无法将任务输出发送回 Chat
- [ ] 无 task 删除/归档功能

### Files 页面

- [ ] 无文件创建、重命名、删除功能
- [ ] 无图片预览（仅 chat 的 DocumentPanel 支持图片）
- [ ] 无语法高亮（纯文本行号表格）
- [ ] 无文件搜索

### 缺失页面（docs/web-agent-workbench.md 规划但未实现）

- [ ] Persona 页面 — persona 列表、切换、记忆读写
- [ ] Automations 页面 — Cron 任务管理（后端 `GET/POST/PUT /api/cron` 已有）
- [ ] Runtime 页面 — Agent 进程状态详情（pid/alive/restart count/crash reason）
- [ ] Observability 页面 — Token 用量趋势、context window、cost、日志查看器
- [ ] Settings 页面 — 主题切换、auth token 管理（当前无 logout 按钮）

### 通用 UI 问题

- [ ] 无 404 / catch-all 路由
- [ ] 无移动端适配（sidebar 固定 292px，小屏溢出）
- [ ] 无键盘快捷键
- [ ] StatusBar 组件已定义但未挂载（header 有内联版本）
- [ ] `tabs.tsx`、`card.tsx` UI 原语已定义但未使用
