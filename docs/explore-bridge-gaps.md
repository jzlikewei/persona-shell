# persona-bridge 功能缺口分析

探索者：Explorer
日期：2026-04-08

---

## 审计范围

逐文件阅读了 `src/` 下全部 8 个源文件（index.ts, config.ts, director.ts, feishu.ts, queue.ts, console.ts, persona-runner.ts, public/index.html），以及 docs/、scripts/、.cron/ 下的辅助文件。以下从四个维度展开分析。

---

## 一、可观测性（Observability）

### 1.1 日志体系：已有但不足（信心：高）

**现状**：
- `console.log/warn/error` 全局包了时间戳前缀，输出到 stdout/stderr
- `queue.log` 记录队列操作（ENQUEUE/RESOLVE/CANCEL/ERROR），用 appendFileSync 写文件
- `director-stderr.log` 捕获 Claude 进程 stderr
- launchd 把 bridge 自身 stdout/stderr 写到 `logs/bridge.stdout.log` 和 `logs/bridge.stderr.log`

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无结构化日志 | 中 | 所有日志都是 `console.log` 拼字符串，无法被日志系统（ELK/Loki）解析。没有 log level 过滤（config 中有 `level` 字段但从未使用）。queue.log 是自造格式，和 stdout 日志格式不统一 |
| 无 FLUSH 全流程日志 | 中 | FLUSH 的每一步有 console.log 但散落在 director.ts 各处，没有 flush ID 串联。出问题时需要对着时间戳人肉关联 drain/checkpoint/reset/bootstrap 的日志 |
| 无消息全链路追踪 | 高 | correlation ID 只在 queue.log 中出现。从飞书收到消息 → 写入 pipe → Director 处理 → result 回来 → 回复飞书，这条链路中间的 pipe I/O 段完全没有 cid 追踪。如果消息丢了，不知道丢在哪一步 |
| Director 输出无旁路留存 | 高 | `listenOutput()` 读 pipe 并解析，但 raw JSON line 没有存档。Director 说了什么、thinking 了什么、用了什么工具，Bridge 这边完全没记录。出了问题只能去 `~/.claude/` 翻 session JSONL（如果还在的话）|
| 无运行时 metrics | 低 | 没有消息处理延迟统计、FLUSH 耗时统计、队列等待时间统计。当前规模不需要，但随着使用增多会成为瓶颈定位的盲区 |

### 1.2 运行时状态可见性：已有但有限（信心：高）

**现状**：
- Web 控制台（Phase 1）每秒推送状态快照：Director alive/pid/session/flushing/pending/tokens/lastFlush + 队列快照 + Bridge uptime/memory
- `director.getStatus()` 和 `queue.getSnapshot()` 提供内存快照

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 控制台未验证可运行 | 高 | Phase 1 代码已提交但从未验证（web-console-plan.md 中 1.1-1.4 全部未勾选）。可能完全跑不起来 |
| 飞书侧无状态查询 | 中 | 本体在飞书里无法查看 Bridge/Director 状态。需要开浏览器访问 Web 控制台。可以加一个 `/status` 命令 |
| 无 Persona 子进程状态 | 中 | spawn 出去的 Persona 进程（persona-runner.ts）完全是 fire-and-forget。没有进程列表、没有存活检查、没有超时监控。Director 不知道有多少子人格在跑 |

### 1.3 告警/异常通知：缺失（信心：高）

**现状**：
- 无任何告警机制
- Director 崩溃 → `process.exit(1)` → launchd 重启 → 发"Bridge 已重启"通知（但不说明崩溃原因）
- FLUSH 失败 → console.warn → 无通知

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无主动异常通知 | 高 | Director 崩溃、FLUSH 失败、飞书断连、消息处理异常——所有这些只写日志，不通知本体。本体不看日志就不知道系统出了问题 |
| 无健康检查端点 | 低 | Web 控制台有 HTTP 但没有 `/healthz` 端点，外部监控无法探测 Bridge 是否健康 |

### 1.4 历史数据追溯：缺失（信心：高）

**现状**：
- queue.log 是唯一的持久化操作日志，但只是 appendFileSync，没有轮转
- Director 会话 JSONL 在 `~/.claude/` 目录下，不受 Bridge 管理
- 无消息历史存档

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无日志轮转 | 中 | queue.log 和 stdout/stderr 日志无限增长。launchd 的日志文件每次重启被截断（plist 中用 StandardOutPath 而非 append），但长期运行时仍会膨胀 |
| 无消息历史查询 | 低 | 飞书消息 → Director 回复的完整对话历史没有在 Bridge 侧存档。要回溯只能去飞书或 `~/.claude/` JSONL |

---

## 二、可恢复性（Resilience & Recovery）

### 2.1 进程崩溃恢复：已有但不完整（信心：高）

**现状**：
- Bridge 崩溃 → launchd KeepAlive 自动重启 → 重连 Director（如果 Director 还活着）或重新 spawn
- Director 崩溃 → `rl.on('close')` 触发 → `restart()` 重新 spawn + `--resume`（如果有 session）
- Director session expired → 清 session 文件，让 close handler 用新 session 重启

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| Bridge 重启后内存状态全丢 | **高** | `pendingCount`, `lastFlushAt`, `lastInputTokens`, `lastTimeSyncAt`, `currentDate`, `writingDailyReport` — 全部是内存变量，Bridge 重启后归零。后果：(1) lastFlushAt 重置为 Date.now()，推迟了本应触发的自动 FLUSH；(2) lastInputTokens 归零，即使 Director 上下文已接近满，也不会触发 FLUSH；(3) pendingCount 归零但 Director 可能还在处理之前的消息，queue 和 Director 失去同步 |
| 队列内容重启后丢失 | **高** | MessageQueue 是纯内存 Map。Bridge 重启后，之前在队列中等待的消息（已发给 Director 但未收到回复的）全部丢失。用户看到消息已发送但永远收不到回复。Director 的回复回来后 `resolveOldest()` 返回 undefined，回复被静默丢弃 |
| 重启后无法恢复 Director 的真实状态 | 高 | Bridge 重连 Director 后，不知道 Director 的 input_tokens 是多少（只有下一次 result 事件才会更新）。在这个窗口期内，FLUSH 判断完全失灵 |

### 2.2 FLUSH 失败降级：已有但有隐患（信心：中）

**现状**：
- Drain 超时 → 放弃 flush，返回 false
- Checkpoint 超时 → 跳过 checkpoint，强制 kill + restart（无 state 保存）
- Bootstrap 超时 → 设 flushBootstrapResolve = null，finishFlush()

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| Bootstrap 超时后响应泄漏 | **高**（code-review-final.md #1 已指出） | bootstrap 超时 → finishFlush() 设 flushing=false → 迟来的 bootstrap result 走正常 emit('response') 路径 → bootstrap 的"已恢复工作上下文"被当作用户消息发到飞书。code-review 建议保持 flushing=true 直到 result 到达后丢弃，当前代码未修复 |
| Checkpoint 超时 = 状态丢失 | 中 | checkpoint 超时后直接 kill，Director 的工作记忆没有保存。FLUSH 后新 Director bootstrap 读 state.md 拿到的是上次的旧状态。这是设计 tradeoff，但没有告知用户"本次 FLUSH 丢失了 checkpoint" |
| FLUSH 后队列残留消息无处理 | 中 | 如果 drain 超时后放弃 flush，队列中的消息会继续等待。但如果不放弃而是强制 flush，kill Director 会导致 rl close → pendingCount 重置为 0 → drainResolve 被触发。此时队列中还有消息但 Director 已经死了，这些消息的飞书回复永远不会到达 |

### 2.3 消息丢失风险点（信心：高）

| 风险点 | 严重度 | 说明 |
|--------|--------|------|
| FIFO pipe 无 ACK | **高** | `writeRaw()` 写入 pipe 后没有任何确认。如果 Director 进程在 writeRaw 之后、处理消息之前崩溃，消息丢失。用户不知道消息没被处理 |
| `director.send()` 在 interrupt/restart 期间的竞态 | 中 | `restart()` 会 close writeHandle 再 open 新的。如果此时恰好有 `send()` 调用，`writeHandle` 为 null 抛异常。index.ts 中 catch 了 flushing 错误但没 catch restart 期间的 null handle。architecture.md 已记录此已知问题 |
| 飞书 reply 失败后无重试 | 中 | `feishu.reply()` 失败后只 log error，消息从队列中已删除。Director 的回复就这样丢了。没有重试机制，也没有通知用户 |
| 飞书 WS 断连期间的消息 | 低 | 飞书 SDK 断连期间的消息由飞书服务端缓存（SDK 重连后推送），风险较低。但 watchdog forceReconnect 创建新 WSClient 时，旧连接上缓存的消息可能丢失 |

### 2.4 网络中断处理：已有（信心：中）

**现状**：
- 飞书 WS watchdog 每 60s 检查，断连 > 3 分钟 + SDK 放弃重连 → forceReconnect
- Director 通信通过本地 FIFO，不受网络影响

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| forceReconnect 中事件分发器丢失 | 中 | `forceReconnect()` 创建新 WSClient 并调用 `start({ eventDispatcher })`。旧 client close 后，如果有未分发的事件会丢失。新 client 的事件分发器是同一个实例，应该没问题，但没有测试验证 |
| 无网络状态反馈 | 低 | 飞书连接断了本体不知道。可以在 watchdog 检测到断连时向 Web 控制台推送告警 |

---

## 三、用户易用性（UX）

### 3.1 消息延迟感知：不足（信心：高）

**现状**：
- 用户发消息后，等 Director 完整处理完才收到回复（非流式）
- 无"正在处理"反馈
- 无消息 ACK

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无消息 ACK | **高** | 用户发消息后完全没有反馈，不知道消息是否被收到、是否在队列中、还是丢了。如果 Director 处理需要几分钟（比如执行工具），用户会以为系统挂了。最简做法：收到消息后立即 reply 一个"收到，处理中..."（甚至可以用飞书的消息反应 emoji 代替文本回复） |
| 非流式输出 | 中 | Director 可能用 30 秒甚至更久才产出完整回复。其间用户看不到任何输出。docs/research-claude-cli-streaming.md 提到了 `--include-partial-messages` 选项可以拿到 token 级流式输出，但飞书消息不支持真正的流式（需要更新消息而非追加）。可以做"分段发送"：每 N 秒发送当前累积的部分回复 |
| 无处理耗时提示 | 低 | 回复时没有告诉用户这条消息处理了多久。加一个 `(耗时 12s)` 后缀可以帮助用户建立预期 |

### 3.2 错误反馈清晰度：不足（信心：高）

**现状**：
- `/flush` 失败 → 回复"FLUSH 未能完成（超时或正在进行中），请稍后重试"
- 发消息时 Director 在 flush → 回复"正在刷新上下文，请稍后重试"
- 其他异常 → 直接抛到 main catch → `process.exit(1)` → 用户看到的是突然没反应了

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 未捕获异常导致沉默失败 | 高 | `feishu.onMessage` 的 handler 中，`director.send()` 的 catch 只处理了 flushing 错误。其他异常（如 writeHandle null、pipe 写入失败）会穿透到 handler 的 try-catch，最终只在 console.error 中出现。用户发的消息石沉大海 |
| 非文本消息无反馈 | 中 | 用户发图片、文件等非文本消息 → `if (msgType !== 'text') return;` 静默忽略。应该回复"暂不支持该消息类型" |
| /esc 取消消息后 Director 的残留回复 | 中 | `/esc` 取消消息后，如果 Director 的回复已经在 pipe 中，`resolveOldest()` 会跳过 cancelled 项目但同时丢弃 Director 的回复。如果 interrupt 没有成功阻止 Director 产出完整回复，这个回复就无声消失了 |

### 3.3 操作便捷性：基本可用（信心：中）

**现状**：
- `/esc`, `/flush`, `/restart` 三个命令
- Web 控制台 f/e/r 快捷键

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 缺少 `/status` 命令 | 中 | 本体在飞书内无法查看系统状态。需要单独打开浏览器看 Web 控制台 |
| 缺少 `/help` 命令 | 低 | 没有命令列表。本体需要记住有哪些命令可用 |
| 缺少消息引用回复 | 低 | 当前所有 Director 回复都 reply 到原消息。如果用户连续发了多条消息，每条的回复会分别 reply 到各自的原消息上，这其实是好的 UX |
| 飞书富文本不支持 | 低 | Director 的回复以纯文本发送。Markdown 格式的代码块、列表等在飞书中不会被渲染。飞书支持 post 类型的富文本消息 |

### 3.4 多轮对话体验：基本可用但有隐患（信心：中）

**现状**：
- Director 是有状态的 session，支持多轮对话
- 队列保证消息按序处理

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 队列无序风险 | 中 | MessageQueue 用 Map 存储，`resolveOldest()` 遍历找最小 timestamp。如果两条消息 timestamp 相同（理论上 Date.now() 精度为 ms，连续 enqueue 可能相同），行为取决于 Map 迭代顺序（V8 保证 insertion order）。实际风险低但逻辑不严谨 |
| FLUSH 后上下文断裂无提示 | 中 | FLUSH 后 Director 是全新上下文。如果用户不知道发生了 FLUSH，会困惑为什么"它忘了我刚才说的话"。自动 FLUSH 后应该通知用户 |
| 多 chat 支持问题 | 低 | `lastChatId` 只保存最后一个 chat。如果本体在飞书中有多个群或对话与机器人交互，重启通知只发到最后一个。当前单用户场景不是问题 |

---

## 四、多 Agent 并发交互

### 4.1 Spawn 机制：已有但极度原始（信心：高）

**现状**：
- `persona-runner.ts` 提供 `spawnPersona()` 和 `waitForResult()` 两个函数
- spawn 用 `claude -p` 单次执行，stdout 重定向到 `outbox/task-{id}.json`
- waitForResult 用 polling（每 2s 检查文件是否存在）
- 默认超时 5 分钟

**缺口**：

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 完全无集成 | **高** | `persona-runner.ts` 导出了函数但**没有任何调用者**。index.ts 和 director.ts 都没有 import 它。这意味着 Director 当前完全不能从 Bridge 层 spawn 子人格。Director（Claude Code）只能自己通过 Agent 工具 spawn sub-agent，走的是 Claude Code 内置路径而非 Bridge 管理的路径 |
| 无任务注册表 | **高** | spawn 出去的进程没有注册。没有全局的"当前运行中的任务"列表。不知道有几个 Persona 在跑、跑了多久、是否超时、是否还活着 |
| 无结果回收通路 | **高** | `waitForResult()` 是同步 polling。在当前架构中，Director 是 Claude Code 进程在 pipe 后面运行，它无法调用 TS 侧的 `waitForResult()`。outbox/ 目录的结果文件没有任何主动通知机制——没有 file watcher，没有 inbox 投递。Director 必须自己 `cat outbox/task-xxx.json` 来获取结果 |
| 无超时强制终止 | 中 | waitForResult 超时只是抛异常，不 kill 子进程。超时的 Persona 进程会一直跑下去，消耗 API token |
| 无错误处理 | 中 | Persona 进程如果崩溃，stdout 重定向的 JSON 文件可能是空的、截断的、或不存在的。waitForResult 有空文件检查但没有截断检查 |

### 4.2 并发任务生命周期管理：缺失（信心：高）

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无并发控制 | 高 | 没有最大并发数限制。Director 可以同时 spawn 任意多个 Persona，每个都是独立 Claude 进程，每个都消耗一个 API 连接 + context window |
| 无资源预算 | 高 | spawn 时没有传 `--max-budget-usd`。一个失控的 Persona 可以消耗无限 token |
| 无优雅取消 | 中 | 没有取消正在运行的 Persona 任务的机制。一旦 spawn 就只能等它结束或超时 |
| 无任务优先级 | 低 | 所有任务平等，没有紧急/普通之分 |

### 4.3 任务结果回收通路：缺失（信心：高）

**这是架构层面最大的缺口。** architecture.md 描述了完整的 Briefing → Report 协议和 inbox/outbox 通信机制，但 Bridge 侧完全没有实现。

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 无 outbox watcher | **高** | Director 不知道子人格什么时候完成了任务。需要 Bridge 侧 watch outbox/ 目录，发现新文件后通过 pipe 通知 Director |
| 无 inbox 投递 | **高** | architecture.md 描述了 inbox/ 作为消息接收目录，但没有任何代码写入 inbox/。子人格结果应该写入 Director 的 inbox/ 并通知 |
| 无任务状态推送 | 中 | Web 控制台不显示当前运行的 Persona 任务。应该像显示队列一样显示 task 列表 |

### 4.4 资源隔离与并发冲突（信心：中）

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| cwd 共享 | 中 | 所有 Persona 进程 cwd 都是 `persona_dir`（~/.persona/）。如果两个 Persona 同时写同一个文件（如 state.md），会冲突。当前 Director 是唯一能 spawn Persona 的角色，可以通过编排避免，但没有强制保证 |
| 无 git 冲突处理 | 中 | 如果 Persona 修改了 `~/.persona/` 下的文件并 commit，并发的 Persona 可能产生 merge conflict |
| 无沙盒隔离 | 低 | 所有 Persona 都用 `--dangerously-skip-permissions`，可以做任何操作。architecture.md 中提到了工具白名单（tools: [Read, Grep, ...]），但 `spawnPersona()` 没有传 `--allowedTools` |

---

## 五、其他发现

### 5.1 安全隐患

| 问题 | 严重度 | 说明 |
|------|--------|------|
| Web 控制台无认证 | **高** | `Bun.serve()` 无任何认证。HTTP/WS 直接暴露。任何能访问 localhost:3000 的人都可以执行 flush/restart 操作。在本地个人使用可接受，但如果端口意外暴露到公网则危险 |
| config.yaml 在项目根目录 | 中 | `.gitignore` 中有 `config.yaml`，但 `loadConfig()` 默认读 `import.meta.dirname/../config.yaml`（项目根）。实际使用中可能同时存在项目根和 `~/.persona/config.yaml` 两份配置，容易混淆。README 说配置放 `~/.persona/config.yaml` 但代码默认不读那个位置 |
| `--dangerously-skip-permissions` | 低 | Director 和所有 Persona 都跳过权限检查。这是设计选择（"分身"需要完全自主权），但意味着 Director 可以执行任意代码 |

### 5.2 代码质量

| 问题 | 严重度 | 说明 |
|------|--------|------|
| 旧 rl close 竞态 | 中 | code-review-final.md #2 已指出：restart() 创建新 readHandle 和 rl，但旧 rl 的 close 事件可能延迟触发，重置 pendingCount。未修复 |
| flush/interrupt TOCTOU 竞态 | 低 | code-review-final.md #3 已指出。当前单用户低并发场景风险极低 |
| feishu.ts handler 类型不精确 | 低 | MessageHandler 返回 void 而非 Promise\<void\>。运行时正确但类型语义不准 |
| `console.ts` 中 `any` 类型 | 低 | `const clients = new Set<any>()` — WebSocket 类型未标注 |

### 5.3 直觉预感

1. **pipe I/O 是最脆弱的链路**。named pipe 是无缓冲的、无 ACK 的。一旦 Director 进程异常退出但 pipe 没有触发 close（理论上不太可能但边界情况下可能），整个 Bridge 会卡死。可能需要一个 Director 心跳检测机制。

2. **persona-runner.ts 可能是死代码**。它被精心设计了但没有调用者。Director（Claude Code）使用的是 Claude Code 内置的 Agent 功能来 spawn 子人格，而不是通过 Bridge。这意味着 Bridge 对子人格完全没有可见性和控制力。需要确认 Director 实际是如何 spawn 子人格的。

3. **FLUSH 的"认知连续性"问题可能比技术问题更严重**。FLUSH 后 Director 从 state.md 恢复，但 state.md 是 Director 自己写的。如果 Director 对"什么是重要的"的判断有偏差，每次 FLUSH 都会丢失一些上下文。这是一个渐进的记忆衰减问题，不会立即显现。

4. **当前架构的真正瓶颈不是 Bridge，而是 Director 的单点性**。所有消息串行经过一个 Director session。如果 Director 在处理一个耗时任务（比如 spawn Persona 然后等结果），后续消息会排队等待。没有"紧急通道"让本体的消息优先处理。

---

## 六、按优先级排序的功能清单

### P0：必须修复（影响基本可用性）

| # | 功能 | 类别 | 当前状态 | 预估工作量 |
|---|------|------|----------|-----------|
| 1 | **消息 ACK**：收到消息后立即回复"收到"或添加 emoji 反应 | UX | 缺失 | 小（~20 行） |
| 2 | **Bootstrap 超时响应泄漏修复**：保持 flushing=true 直到迟来的 result 被丢弃 | 可恢复性 | 已有但有 bug | 小（~10 行） |
| 3 | **Web 控制台运行验证**：启动测试 + 修复问题 | 可观测性 | 未验证 | 中 |
| 4 | **关键状态持久化**：`lastFlushAt` 和 `lastInputTokens` 写入 state/ 目录，重启后恢复 | 可恢复性 | 缺失 | 中（~60 行） |
| 5 | **自动 FLUSH 后通知用户** | UX | 缺失 | 小（~15 行） |

### P1：应该做（提升可靠性和体验）

| # | 功能 | 类别 | 当前状态 | 预估工作量 |
|---|------|------|----------|-----------|
| 6 | **异常通知到飞书**：Director 崩溃、FLUSH 失败、飞书断连时主动发消息通知 | 可观测性 | 缺失 | 中（~50 行） |
| 7 | **Director 输出旁路留存**：raw JSON line 写文件存档 | 可观测性 | 缺失 | 小（~20 行） |
| 8 | **飞书 reply 失败重试**：指数退避重试 2-3 次 | 可恢复性 | 缺失 | 小（~30 行） |
| 9 | **非文本消息反馈**：回复"暂不支持该消息类型" | UX | 缺失 | 小（~5 行） |
| 10 | **`/status` 飞书命令**：在飞书中查看 Bridge/Director 状态摘要 | UX | 缺失 | 中（~40 行） |
| 11 | **旧 rl close 竞态修复**：引入 generation ID | 可恢复性 | 已有 bug | 小（~20 行） |
| 12 | **队列持久化**：队列写入文件，重启后恢复 | 可恢复性 | 缺失 | 中（~60 行） |

### P2：值得做（增强能力）

| # | 功能 | 类别 | 当前状态 | 预估工作量 |
|---|------|------|----------|-----------|
| 13 | **消息全链路 correlation ID 追踪** | 可观测性 | 已有但不足 | 中（~50 行） |
| 14 | **结构化日志**（JSON 格式 + log level 过滤） | 可观测性 | 不足 | 大（~100 行重构） |
| 15 | **FLUSH 全流程 ID 追踪** | 可观测性 | 缺失 | 小（~20 行） |
| 16 | **Persona 任务注册表 + 状态查看** | 多 Agent | 缺失 | 大（~150 行） |
| 17 | **Outbox watcher + Director 通知** | 多 Agent | 缺失 | 大（~100 行） |
| 18 | **Persona spawn 并发控制 + 预算限制** | 多 Agent | 缺失 | 中（~50 行） |
| 19 | **飞书流式/分段输出** | UX | 缺失 | 大（~100 行） |
| 20 | **`/help` 命令** | UX | 缺失 | 小（~10 行） |
| 21 | **飞书富文本 (post) 回复** | UX | 缺失 | 中（~40 行） |
| 22 | **Web 控制台认证**（Basic Auth 或 token） | 安全 | 缺失 | 小（~30 行） |

### P3：远期（架构升级）

| # | 功能 | 类别 | 当前状态 | 预估工作量 |
|---|------|------|----------|-----------|
| 23 | **消息优先级队列**（紧急通道） | UX / 多 Agent | 缺失 | 大 |
| 24 | **Director 心跳检测** | 可恢复性 | 缺失 | 中 |
| 25 | **Persona 沙盒隔离**（allowedTools + 独立 cwd） | 多 Agent | 缺失 | 大 |
| 26 | **完整 Briefing/Report 协议实现** | 多 Agent | 缺失 | 极大 |
| 27 | **日志轮转 + 历史查询** | 可观测性 | 缺失 | 大 |
| 28 | **消息历史存档 + 搜索** | 可观测性 | 缺失 | 大 |

---

## 总结

persona-bridge 作为"飞书 ↔ Director"的桥接层，核心消息收发已经可用，FLUSH 机制经过一轮修复也基本稳固。最大的三个结构性缺口是：

1. **状态不持久**——Bridge 重启后关键状态归零，FLUSH 判断失灵，队列消息丢失
2. **用户无反馈**——消息发出后零确认，出错后静默失败，自动 FLUSH 无通知
3. **多 Agent 交互是空壳**——persona-runner.ts 是死代码，没有任务注册/回收/监控

P0 中 5 个项目（ACK、bootstrap 泄漏修复、控制台验证、状态持久化、FLUSH 通知）加起来约 100 行代码改动，可以在一个工作日内完成，但会显著提升系统的可靠性和使用体验。
