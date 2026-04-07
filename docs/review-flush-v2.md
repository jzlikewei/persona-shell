# FLUSH 修复第二轮审查报告

审查人：Critic
日期：2026-04-07

---

## 审查范围

逐项验证"组合 3 修正版"的 8 项修复是否被正确实现，以及是否引入了新的 bug。

审查文件：
- `src/director.ts` — 主要改动
- `src/index.ts` — 错误处理适配
- `src/queue.ts` — cancel/resolve 逻辑

---

## 逐项验证

### 1. Bug 1（Checkpoint 响应误归因）— drain-first

**✅ 通过**

`flush()` 在发送 checkpoint 消息前，先等待 `pendingCount` 归零（`waitForDrain(30_000)`，第 96-104 行）。drain 超时后中止 flush 并 return false，不发送 checkpoint——符合 v1 审查建议的"abort 而非强制继续"。

Checkpoint 和 bootstrap 的 result 在 result handler 中被 `flushCheckpointResolve` / `flushBootstrapResolve` 拦截（第 346-355 行），不会 emit 给用户。

drain 机制本身实现正确：pendingCount 在 `send()` 中 +1，在 result handler 中 -1（用 `Math.max(0, ...)` 防负数），drain 在 pendingCount 归零时 resolve。

### 2. Bug 2（Bootstrap 响应泄漏）— bootstrap await

**✅ 通过**

Bootstrap 消息发送后通过 `flushBootstrapResolve` Promise 等待 result（第 138-153 行），bootstrap 的 result 在 result handler 中被拦截消费（第 351-355 行），不 emit 给用户。

有 30 秒超时保护，超时后清除 resolve 引用并继续完成 flush（这里的设计选择是"bootstrap 超时不阻塞 flush 完成"，合理——bootstrap 是锦上添花，不是核心保障）。

### 3. Time sync bug — 拼接前缀

**✅ 通过**

`send()` 方法（第 168-187 行）将时间信息作为消息前缀拼接：`[${timeStr}] ${message}`，替代了原来独立的 `writeRaw()` 调用。每条用户消息只产生一次 `writeRaw()`，消除了 time sync 导致的双 result 问题。

拼接格式使用 `toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`，足够简洁，不太会污染 Director 的回复。

### 4. 重入保护

**✅ 通过**

`flush()` 开头检查 `if (this.flushing) return false`（第 80-83 行）。简洁有效。

### 5. Checkpoint 超时

**⚠️ 条件通过（存在响应泄漏风险，见新 Bug 1）**

`Promise.race` 实现了 30 秒超时（第 116-125 行），超时后设置 `this.flushing = false` 并 return false。机制本身正确。

但超时后留下了一个 in-flight 的 checkpoint 消息（pendingCount = 1），其响应在稍后到达时会被当作普通用户响应 emit。详见下文"新引入的 Bug"第 1 项。

### 6. send() flushing 期间保护

**✅ 通过**

`send()` 检查 `if (this.flushing) throw new Error('Director is flushing')`（第 172-174 行）。index.ts 捕获这个错误（第 47-54 行），回复用户"正在刷新上下文，请稍后重试"，并通过 `queue.resolve(correlationId)` 清理队列条目。

错误匹配使用字符串检查 `String(err).includes('flushing')`，虽然不优雅但有效。queue 中新增的 `resolve(correlationId)` 方法实现正确。

### 7. flush/interrupt 互斥

**✅ 通过**

双向互斥实现完整：
- `interrupt()` 开头检查 `if (this.flushing) return`（第 59-62 行）——flush 进行中不允许 interrupt
- `flush()` 开头检查 `if (this.interrupted)` 并 await restarted 事件（第 86-90 行）——等待 interrupt 完成后再开始 flush

`interrupt()` 中使用 `process.kill(-pid, 'SIGINT')` 发送到进程组，然后 await `restarted` 事件，确保 restart 完成后才返回。

### 8. pendingCount pipe close 重置

**✅ 通过**

`rl.on('close')` handler（第 379-399 行）开头立即将 `this.pendingCount = 0` 并 resolve pending drain。这确保了 Director 崩溃或 pipe 断开后，pendingCount 不会残留导致后续 drain 挂住。

### 9. 进程组 kill

**✅ 通过**

`interrupt()` 使用 `process.kill(-pid, 'SIGINT')`（第 70 行），`flush()` 使用 `process.kill(-pid, 'SIGTERM')`（第 133 行），负 PID 确保信号发送到整个进程组。配合 `spawn` 的 `detached: true`，sh 和 claude 子进程都会收到信号。

### 10. flush 期间 rl.on('close') 不触发 bridge exit

**✅ 通过**

`rl.on('close')` handler 中新增了 `else if (this.flushing)` 分支（第 393-395 行），只记日志、不 emit `close` 事件。flush 自己管理 kill → restart 的生命周期。index.ts 中 `director.on('close', ...)` 触发 `process.exit(1)` 不会在 flush 期间误触。

---

## 新引入的 Bug

### 新 Bug 1（P0）：index.ts 的 isFlushing 检查在 drain 阶段丢弃用户响应

**位置：** `src/index.ts` 第 63-66 行

**路径：**

1. `flush()` 在第 93 行设置 `this.flushing = true`
2. 随后进入 drain 等待（第 96-104 行），等 pendingCount 归零
3. drain 期间，in-flight 用户消息的 result 到达
4. director.ts result handler：`this.flushing` 为 true，但 `flushCheckpointResolve` 和 `flushBootstrapResolve` 都是 null（还没发 checkpoint），走到 `else` 分支 → 正确 emit response
5. index.ts response handler：**`director.isFlushing` 为 true → 直接 return，响应被丢弃**

**后果：** 不仅用户丢失了这条响应，而且 `resolveOldest()` 没被调用，队列中残留一个未消费的条目。flush 完成后，下一条真正的用户响应会被 `resolveOldest()` 匹配到这个残留条目——导致**级联的响应错配**。用户 A 收到用户 B 的回复，用户 B 的回复丢失。

**修复建议：** 删除 index.ts 中的 `isFlushing` 检查。director.ts 的 result handler 已经通过 `flushCheckpointResolve` / `flushBootstrapResolve` 正确过滤了 flush 内部消息，index.ts 的二次检查是多余的且有害的。

### 新 Bug 2（P1）：Checkpoint 超时后，残余响应泄漏给用户

**位置：** `src/director.ts` 第 111-125 行

**路径：**

1. Checkpoint 消息发出，`pendingCount++`（第 111 行）
2. 30 秒超时触发（第 121 行）
3. `this.flushCheckpointResolve = null`，`this.flushing = false`，return false（第 123-125 行）
4. 稍后 Director 终于回复了 checkpoint——result 到达
5. result handler：`pendingCount` 递减，`this.flushing` 为 false，`flushCheckpointResolve` 为 null → 走到 `else` 分支 → emit response
6. index.ts：`isFlushing` 为 false → `resolveOldest()` → checkpoint 的"已保存"回复被当作用户消息的响应发出去

**后果：** 用户收到一条 "已保存" 的无意义回复，且他的真正问题的回复（如果有后续消息）会错位。

**修复建议：** Checkpoint 超时后，不应简单地重置 flushing 状态。两种选择：
- (a) 超时后仍然执行 kill + restart（强制丢弃 in-flight 消息），放弃"中止"语义
- (b) 保持 flushing = true，增加一个 `checkpointAborted` 标记，在 result handler 中遇到 flushing = true 但两个 resolve 都为 null 时，丢弃该响应而不是 emit

选项 (a) 更简单可靠——既然 checkpoint 都超时了（Director 可能卡住），kill 重启也是合理的恢复手段。

### 新 Bug 3（P2）：旧 rl 实例的 close 事件可能在新 rl 活跃后触发

**位置：** `src/director.ts` 第 379 行 `rl.on('close')`

**路径：** flush 的 step 2 执行 `process.kill(-pid, 'SIGTERM')`（第 133 行）后立即调用 `await this.restart()`（第 136 行）。restart 内部调用 `this.start()` 创建新的 rl。旧 rl 的 close 事件是异步的——可能在新 rl 已经开始接收事件后才触发。

旧 rl 的 close handler 会将 `this.pendingCount` 重置为 0。如果此时新 rl 的 bootstrap 消息已发出（`pendingCount = 1`），被重置为 0 后，bootstrap 的 result 到达时 `pendingCount` 会变为 `Math.max(0, -1) = 0`——数值不会出错，但语义上 pendingCount 的计数已经不准确。

**当前影响有限：** flush 流程中不再依赖 drain 等待 bootstrap result（直接用 Promise resolve），所以 pendingCount 的短暂不准确不会导致功能错误。但这是一个隐性的时序依赖，如果将来有代码在 flush 后续阶段依赖 pendingCount 精确值，会出问题。

**修复建议（中期）：** 给每个 rl 实例一个 generation ID。close handler 检查 generation，旧 generation 的事件直接忽略。这也是 v1 审查中"方案 B 风险 2"提到的防御措施。

---

## 亮点

1. **drain-then-abort 设计**正确实现了 v1 审查的核心建议：drain 超时中止 flush 而非强制继续。这是最关键的决策，做对了。
2. **互斥保护**双向覆盖（interrupt 跳过 flush、flush 等待 interrupt），没有遗漏方向。
3. **进程组 kill** 使用 `-pid` 确保 sh 和 claude 都被终止，解决了 v1 审查发现的僵尸进程风险。
4. **queue.ts 的 cancel/resolve 分离**设计合理——cancel 标记但不移除，resolveOldest 跳过 cancelled 条目。配合 /esc + interrupt 的流程，逻辑自洽。

---

## 总体判断

**8 项原计划修复中，7 项完全通过，1 项条件通过（checkpoint 超时有泄漏风险）。但引入了 2 个新 bug，其中 1 个是 P0。**

P0 bug（drain 阶段响应丢弃）必须在上线前修复——它直接导致用户丢消息和响应错配，恰好是这整套修复试图解决的同一类问题。好消息是修复很简单：删掉 index.ts 第 63-66 行的 `isFlushing` 检查即可。

P1 bug（checkpoint 超时响应泄漏）发生概率较低（需要 Director 处理 checkpoint 恰好超过 30 秒），但后果是用户收到"已保存"的垃圾回复。建议把 checkpoint 超时改为"超时即 kill+restart"而非"超时即中止"。

修复这两个问题后，组合 3 修正版可以上线。
