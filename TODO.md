# TODO

> 当前版本:项目级收敛清单。不要把这里当作所有想做功能的堆栈;只记录需要把 persona-shell 带回稳定事实源的事项。

## P0: Workspace / Session 路由收敛

目标:让 `workspace name + sessionId` 成为对外稳定标识,把 `directorLabel` / `routingKey` 降回运行时实现细节。

- [ ] 盘点 `directorLabel` / `routingKey` / `source_director` 的剩余调用点,按"兼容 API / 内部实现 / 可删除 legacy"分类。
- [ ] `/api/send`、`/api/messages`、`/api/sessions` 优先走 `sessionId` / `workspace`,保留 legacy 参数只做兼容入口。
- [ ] Task 回调从 `source_director` 迁移到 `source_session_id` 或 workspace default session 策略;旧字段保留迁移期兼容。
- [ ] Cron 调度从 `source_director` 迁移到 workspace default session 策略;旧字段保留迁移期兼容。
- [ ] 明确 `DirectorPool` 的剩余职责:运行时池和兼容层,不要再作为领域模型事实源。
- [ ] 补一组端到端验证:Web 创建 workspace/session -> 发消息 -> sessionId 路由;飞书小群 -> workspace default session;归档 session 后 fallback 正确。

参考:
- `docs/architecture.md`
- `docs/plan-workspace-routing.md`
- `src/session-manager.ts`
- `src/workspace-registry.ts`

## P0: Session SSOT / No Local History 收尾

目标:用 `state.db` 的 sessions/workspaces 作为 session 列表和 workspace 统计的唯一事实源;日志只负责消息正文读取。

- [ ] 复核 `importSessionsFromLogs()` 回填幂等性:部分回填失败后重启不应永久跳过旧日志。
- [ ] 明确 `message_count` 是派生缓存;若 UI 依赖强一致,增加重算/校准路径。
- [ ] 给旧日志路径兼容设置 sunset 策略:启动迁移或 30 天后停止双路径扫描。
- [ ] 清理 `ConsoleWorkspace` 中仍暴露但不该作为领域事实源的 `directorLabel` / `routingKey` 字段。
- [ ] 验证重启后 sessions 表、旧日志读取和 live session 合并不漂移。

参考:
- `docs/plan-session-ssot.md`
- `src/task/task-store.ts`
- `src/session-bridge.ts`
- `src/console.ts`

## P1: Web v1 / web-v2 双轨策略

目标:明确 web-v2 是主界面还是实验界面,避免 legacy Web Console 和 web-v2 的功能口径互相打架。

- [x] 删除 web-v2 已落地功能的过期 TODO 口径,以 `web-v2/BLUEPRINT.md` 为 v2 收敛事实源。
- [ ] 明确入口策略:`/` 指向 web-v2,`/v1` 作为 legacy fallback;补到 README / docs。
- [ ] web-v2 只覆盖 Chat / Tasks / Files,不要声称已覆盖 legacy 的 Runtime / Automations / Persona / Logs / Settings 全量能力。
- [ ] 决定 legacy 功能迁移方式:按真实使用场景逐项迁移,还是长期保留 `/v1` 管理面。
- [ ] 补 web-v2 最终冒烟记录:认证、workspace/session、chat、tasks、files、断线重连、无 console.error。

参考:
- `web-v2/BLUEPRINT.md`
- `web-v2/README.md`
- `web-v2/ARCHITECTURE.md`
- `docs/web-agent-workbench.md`

## P1: 项目文档校准

目标:让 README、架构文档、计划文档和代码现状一致。

- [x] 重写 `TODO.md` 为项目级收敛清单。
- [x] 重写 `web-v2/README.md`,替换 Vite 模板内容。
- [x] 新增 `web-v2/ARCHITECTURE.md`,记录模块边界和数据流。
- [x] 更新 `docs/architecture.md`:标注目标模型与当前兼容层的差异。
- [x] 更新 `docs/plan-workspace-routing.md`:从理想实施计划改成"当前状态 + 剩余迁移点"。
- [x] 更新 `docs/plan-session-ssot.md`:把审阅结论变成可执行收尾 checklist。
- [x] 清理已落地的 WP 注释,只保留仍有设计价值的注释。

## P2: Codex App Server 最小兼容复核

暂缓到单独讨论。这里不做"全量协议升级"。

- [x] Codex `codex-app-server` provider 的后台任务改为临时 App Server task runtime;`type: codex` 保留 turn-based `codex exec` 回退。
- [ ] 复核哪些协议 TODO 已经被当前实现覆盖。
- [ ] 只保留必要兼容项和直接改善当前体验的事件处理。
- [ ] 明确不追齐的协议能力,避免把项目范围扩成 app-server 客户端全量实现。

参考:
- `docs/codex-app-server-upgrade.md`
