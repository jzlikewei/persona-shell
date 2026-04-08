# persona-bridge 完整 Blueprint

> **来源**: Explorer 功能缺口分析 + Critic 架构审查
> **日期**: 2026-04-08
> **目标**: 从"能用的 MVP"升级为"可靠的个人基础设施"

---

## 当前状态

persona-bridge 是飞书 ↔ Claude CLI Director 的桥接层。7 个文件、~1100 行代码，核心消息收发可用。但存在三个结构性缺口：

1. **状态不持久** — Bridge 重启后关键状态归零，FLUSH 判断失灵，队列消息丢失
2. **用户无反馈** — 消息发出后零确认，出错后静默失败，自动 FLUSH 无通知
3. **安全与正确性隐患** — Console 无认证、bootstrap 超时泄漏、FIFO 响应错位风险

---

## Execution Checklist

> 唯一需求来源。cron tick 只读此文件确定进度和下一批任务。
> 规则：严格 layer gate，只做最细粒度的未完成层。下层未关闭时上层保持 `[ ]`。

### Phase 0: Critical Bug Fixes

立即修复的安全和正确性问题。每项 5-20 行改动，无新功能。

- [ ] 0.1 `console.ts`: `Bun.serve()` 绑定 `127.0.0.1`（当前默认 `0.0.0.0`），阻止非本机访问 [H1]
- [ ] 0.2 `director.ts`: bootstrap 超时后保持 `flushing=true`，等迟来的 result 到达后丢弃再 `finishFlush()`。当前超时后立即 `finishFlush()` 导致迟来 result 被当正常响应发到飞书 [Explorer P0#2]
- [ ] 0.3 `director.ts`: `writeRaw()` 开头加 `if (!this.writeHandle) throw new Error('pipe not open')`，替代 `this.writeHandle!` 非空断言 [M3]
- [ ] 0.4 `director.ts`: `checkDailyReport` 中 `this.writeRaw(...)` 加 `.catch(err => console.error(...))`，防止 unhandled rejection [L6]
- [ ] 0.5 `feishu.ts`: `start()` 中 `wsClient.start()` 加 await 或 `.catch()`；`forceReconnect()` 调用处加 `.catch()` [M5]
- [ ] 0.6 `config.ts`: `expandHome` 改为只替换行首 `~/`：`p.startsWith('~/') || p === '~' ? homedir() + p.slice(1) : p` [L2]

### Phase 1: UX Quick Wins

用户体验最高优先级改进，每项 5-40 行。

- [ ] 1.1 **消息 ACK**: `index.ts` 收到非命令消息后，立即调用飞书 API 给原消息添加 emoji 反应（如 👀），让用户知道消息已收到 [Explorer P0#1]
- [ ] 1.2 **自动 FLUSH 通知**: `director.ts` 自动触发 flush 时（`checkFlush()`），flush 完成后通过 emit 事件通知 `index.ts`，由 `index.ts` 向最后活跃 chat 发送"上下文已自动刷新"消息 [Explorer P0#5]
- [ ] 1.3 **非文本消息反馈**: `index.ts` 的 feishu onMessage handler 中，非 text 类型消息回复"暂不支持该消息类型" [Explorer P1#9]
- [ ] 1.4 **`/status` 命令**: `index.ts` 新增 `/status` 命令，返回 Director 状态摘要（alive/pid/tokens/pending/lastFlush/uptime）[Explorer P1#10]
- [ ] 1.5 **`/help` 命令**: `index.ts` 新增 `/help` 命令，返回所有可用命令列表 [Explorer P2#20]

### Phase 2: State Persistence

Bridge 重启后恢复关键状态，解决"重启归零"问题。

- [ ] 2.1 创建 `src/state-store.ts`：简单的 JSON 文件读写模块。`save(key, data)` / `load(key)` → 读写 `state/{key}.json`。写入用 write-rename 模式保证原子性
- [ ] 2.2 `director.ts`: `lastFlushAt` 和 `lastInputTokens` 在变更时持久化到 `state/director.json`；启动时恢复
- [ ] 2.3 `queue.ts`: 队列变更（enqueue/resolve/cancel）时持久化到 `state/queue.json`；启动时恢复未完成的消息
- [ ] 2.4 `index.ts` / `director.ts`: Bridge 启动时从 state 恢复后，日志打印恢复摘要（恢复了几条队列消息、lastFlushAt 距今多久等）
- [ ] 2.5 `.gitignore`: 添加 `state/` 目录排除

### Phase 3: Resilience Fixes

修复已知的竞态条件和异常处理漏洞。

- [ ] 3.1 `director.ts`: 引入 generation ID（递增计数器），`listenOutput` 的 close handler 检查 generation，防止旧 readline close 事件重置新 Director 的 pendingCount [Critic M1 / Explorer P1#11]
- [ ] 3.2 `director.ts`: restart 加指数退避。记录最近重启时间，5 分钟内连续重启 >= 3 次则停止并 `process.exit(1)` 让 launchd 接管 [Critic M2]
- [ ] 3.3 `index.ts`: `enqueue` 和 `send` 的顺序修正 — send 失败时确保 queue 状态一致。当前 enqueue 在 send 之前，send 的 flushing 异常走 `queue.resolve()` 清理，但其他异常不清理。统一为：所有 send 异常路径都 `queue.resolve(correlationId)` [Critic H4]
- [ ] 3.4 `feishu.ts`: reply 失败后指数退避重试 2 次（延迟 1s, 3s），仍失败则 log error [Explorer P1#8]

### Phase 4: Observability

让系统异常可见、可追踪。

- [ ] 4.1 **异常通知到飞书**: Director 崩溃、FLUSH 失败、飞书断连 > 3 分钟时，向最后活跃 chat 发送告警消息 [Explorer P1#6]
- [ ] 4.2 **Director 输出旁路留存**: `director.ts` 的 `listenOutput` 在解析 JSON line 之前，把 raw line appendFileSync 到 `logs/director-output.log` [Explorer P1#7]
- [ ] 4.3 **消息处理耗时**: `queue.ts` 记录 enqueue 和 resolve 的时间差；`index.ts` 回复时附加 `(耗时 Xs)` 信息 [Explorer P2]

### Phase 5: Web Console Validation

Phase 1 代码已提交（`5f619ab`），需运行验证。

- [ ] 5.1 运行验证：启动 Bridge（`bun run dev`），访问 `http://localhost:3000`，确认 TUI 界面渲染
- [ ] 5.2 状态推送验证：确认 WebSocket 1s 间隔推送 Director 状态，数据刷新正常
- [ ] 5.3 快捷键验证：按 f/e/r 触发 Flush/Esc/Restart，确认命令执行和反馈显示
- [ ] 5.4 修复验证中发现的问题（如有）
- [ ] 5.5 Console 认证：从 config.yaml 读取 `console.token`，HTTP 和 WebSocket 连接需携带 bearer token [H1 完整修复]

### Phase 6: Director Refactor (设计先行)

> 此阶段需先产出设计文档，再执行。直接改代码风险太高。

- [ ] 6.1 设计文档：`docs/director-refactor-design.md` — 定义显式状态机 enum、模块拆分方案（ProcessManager / PipeIO / FlushOrchestrator / SessionStore）、接口定义 [H3]
- [ ] 6.2 抽取 `DirectorState` 显式枚举：`'idle' | 'processing' | 'flushing:drain' | 'flushing:checkpoint' | 'flushing:reset' | 'flushing:bootstrap' | 'interrupted' | 'daily_report'`，替代多个 boolean flag
- [ ] 6.3 抽取 `SessionStore`：save / read / clear session 文件逻辑
- [ ] 6.4 抽取 `PipeIO`：FIFO 创建、open、write、listen 逻辑
- [ ] 6.5 抽取 `FlushOrchestrator`：drain → checkpoint → kill → bootstrap 全流程
- [ ] 6.6 验证重构后 bun run check 通过，手动测试消息收发 + flush 正常

### Phase 7: Multi-Agent Infrastructure (远期)

> 当前 persona-runner.ts 是死代码。此阶段把多 Agent 做到最小可用。

- [ ] 7.1 设计文档：`docs/multi-agent-design.md` — 任务生命周期、注册表 schema、outbox watcher 机制、并发控制策略
- [ ] 7.2 `src/task-registry.ts`：任务注册表（spawn 时注册、完成/超时时注销、状态查询）
- [ ] 7.3 Outbox watcher：`fs.watch` 监听 outbox/ 目录，新文件到达时通过 pipe 通知 Director
- [ ] 7.4 spawn 并发控制：最大并发数（config 可配）+ `--max-budget-usd` 传递
- [ ] 7.5 spawn 超时强制终止：超时后 kill 子进程，清理注册表
- [ ] 7.6 Console 集成：Web 控制台显示当前运行的任务列表

### Phase 8: Console Phase 2 — Logs + Sessions (远期)

- [ ] 8.1 日志源抽象：读取 + tail 三个日志文件
- [ ] 8.2 WebSocket 日志频道：按源订阅/取消订阅，实时推送
- [ ] 8.3 日志视图前端：标签栏切换 + xterm-addon-search
- [ ] 8.4 Session JSONL 解析器：提取 user/assistant 消息
- [ ] 8.5 会话查看前端：消息渲染 + 折叠 thinking/tool_use

---

## 来源追溯

| Blueprint 项 | Explorer 编号 | Critic 编号 | 说明 |
|---|---|---|---|
| 0.1 Console 绑定 127.0.0.1 | 5.1#1 | H1 | 安全最小修复 |
| 0.2 Bootstrap 超时泄漏 | P0#2 | — | 迟来 result 被当正常响应 |
| 0.3 writeRaw null guard | — | M3 | 非空断言 → 显式检查 |
| 0.4 checkDailyReport catch | — | L6 | unhandled rejection |
| 0.5 feishu start await | — | M5 | unhandled rejection |
| 0.6 expandHome 修复 | — | L2 | 只替换行首 ~ |
| 1.1 消息 ACK | P0#1 | — | 用户体验最痛点 |
| 1.2 自动 FLUSH 通知 | P0#5 | — | 上下文断裂无提示 |
| 1.3 非文本消息反馈 | P1#9 | — | 静默忽略 → 告知 |
| 1.4 /status 命令 | P1#10 | — | 飞书内查状态 |
| 1.5 /help 命令 | P2#20 | — | 命令发现性 |
| 2.1-2.5 状态持久化 | P0#4, P1#12 | — | Bridge 重启后恢复 |
| 3.1 rl close generation | P1#11 | — | 旧 close 事件竞态 |
| 3.2 Restart backoff | — | M2 | 快速重启循环 |
| 3.3 enqueue/send 顺序 | — | H4 | 队列状态不一致 |
| 3.4 reply 重试 | P1#8 | — | 回复丢失 |
| 4.1 异常通知 | P1#6 | — | 出错不知道 |
| 4.2 Director 输出留存 | P1#7 | — | 调试盲区 |
| 5.1-5.5 Console 验证 | P0#3 | H1 | 已有代码验证 + 认证 |
| 6.x Director 重构 | — | H3 | God Object 拆分 |
| 7.x 多 Agent | P2#16-18 | M4 | persona-runner 是死代码 |

---

## 未纳入本 Blueprint 的项目

以下来自 Explorer/Critic 的建议暂不纳入执行计划（可能永远不做，或需求出现时再评估）：

| 项 | 来源 | 原因 |
|---|---|---|
| H2 FIFO 响应关联 ID | Critic H2 | 需要 Claude CLI 支持 metadata 透传，当前不可行。单用户场景下 FIFO 对齐足够 |
| 结构化日志 (JSON) | Explorer P2#14 | 当前规模用 console.log 足够，引入日志框架收益 < 成本 |
| 消息全链路 correlation ID | Explorer P2#13 | 与 H2 相关，需整体设计 |
| 飞书流式/分段输出 | Explorer P2#19 | 飞书不支持真流式，需消息更新 API，复杂度高 |
| 飞书富文本 (post) 回复 | Explorer P2#21 | 增值有限，plain text 够用 |
| 消息优先级队列 | Explorer P3#23 | 过度设计，单用户不需要 |
| Director 心跳检测 | Explorer P3#24 | FIFO close 事件已能检测，补充价值低 |
| Persona 沙盒隔离 | Explorer P3#25 | 个人工具，信任 Director |
| 完整 Briefing/Report 协议 | Explorer P3#26 | 远期架构升级，非当前优先 |
| 日志轮转 + 历史查询 | Explorer P3#27 | 手动清理即可 |
| 消息历史存档 | Explorer P3#28 | 飞书已有历史记录 |
| console.log monkey-patching | Critic L5 | 改法简单但影响面广，暂不动 |
| Queue O(n) resolveOldest | Critic L1 | 队列长度 ≤5，无性能问题 |
| Console readFileSync 缓存 | Critic L3 | 开发体验 > 性能优化 |
| Queue 日志轮转 | Critic L4 | 同 P3#27 |
| kill(-pid) stale PID 问题 | Critic M1 | 低概率 + 单用户环境可接受 |
| Console setInterval 清理 | Critic M6 | 进程退出 OS 回收，实际无泄漏 |
| 测试 | Critic 架构评估 | 个人工具不搞形式主义 |
