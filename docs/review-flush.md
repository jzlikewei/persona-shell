# FLUSH 机制代码审查报告

审查人：Critic
日期：2026-04-07

## 审查范围

- `src/director.ts` — FLUSH 核心逻辑
- `src/index.ts` — `/flush` 命令和 response handler
- `src/config.ts` — flush 配置项

## 风险

### 1. Checkpoint 响应误归因（Critical / 中等概率）

如果 Director 还在处理前一条用户消息时触发 flush，前一条消息的 response 会被错误当作 checkpoint 响应消费。

后果：
- 用户那条消息的回复被吞掉，queue 中的 item 成为孤儿
- checkpoint 实际上没做，Director 还没执行 state 保存就被 kill

原因：checkpoint 响应的判定仅靠 `flushing` 布尔值，无法区分前序消息的响应和 checkpoint 的响应。

建议：
- 方案 A：flush() 开头等待当前 in-flight 请求完成再开始 checkpoint
- 方案 B：给 checkpoint 消息加唯一标记（如 `[FLUSH-CID:xxx]`），在 result handler 中检查响应内容是否包含该标记

### 2. Bootstrap 响应泄漏到用户（High / 高概率）

flush() 发送 bootstrap 消息后立即设 `flushing = false`。当新 Director 处理完 bootstrap 并返回 result 时，flushing 已经是 false，result handler 走正常路径 `emit('response')`。如果 queue 中有待处理消息，bootstrap 的回复会被当作那条消息的回复发给用户。

建议：等 bootstrap 的响应也到达后再设 `flushing = false`，用与 checkpoint 相同的 promise 模式。

### 3. flush() 无重入保护（High / 低概率）

如果 auto-flush 正在等待 checkpoint，用户此时发 `/flush`，第二次 `flush()` 覆盖 `flushCheckpointResolve`，第一次 flush 的 promise 永远不会 resolve，导致挂死。

建议：flush() 开头加 `if (this.flushing) return`。

### 4. Checkpoint 无超时（Medium / 中等概率）

`checkpointDone` promise 没有超时。如果 Director 僵死不响应，flush() 永远阻塞。`flushing = true` 期间所有正常响应被过滤，相当于 Bridge 进入静默死亡状态。

建议：用 `Promise.race` 加 30 秒超时，超时后强制走 reset 路径。

### 5. Flush 期间消息丢失（Medium / 中等概率）

flush() 在 `process.kill()` 之后、`restart()` 完成之前，如果新消息到达，`send()` 写入读端已关闭的 FIFO 会失败。消息已在 queue 中但永远无法 resolve。

建议：
- 方案 A：send() 中检查 flushing 状态，通过飞书告知用户"正在刷新中，请稍后"
- 方案 B：flush 期间缓存消息，完成后重新发送

### 6. 队列孤儿（Low / 中等概率）

flush 前已发送但未收到回复的消息永远留在队列中，后续响应通过 `resolveOldest()` 会错配到这些孤儿上。

建议：flush 前遍历 queue，对 pending item 发送"消息因上下文刷新未处理，请重新发送"的回复，然后清空 queue。

### 7. input_tokens 在 checkpoint 时被污染（Low / 高概率）

result handler 先更新 `lastInputTokens` 再检查 flushing 状态，checkpoint 消息的 token 数会暂时污染追踪值。最终被 flush 末尾重置为 0 所以结果正确，但存在隐式依赖。

建议：flushing 状态下跳过 token 追踪，或加注释。

## 优点

- 四步 FLUSH 设计（checkpoint → reset → restart → bootstrap）概念清晰，架构方向正确
- `rl.on('close')` handler 正确区分 interrupted / flushing / normal close 三种状态
- `checkFlush()` 的 fire-and-forget 模式配合 `.catch()` 防止了未处理的 rejection
- 用 result event 的 `usage.input_tokens` 作为上下文窗口指标，务实有效
- 配置阈值合理：700K tokens（约 70% 窗口），7 天间隔

## 结论

**不通过。** 存在两个 critical/high 级别的正确性问题，会在生产中导致消息丢失和错配。根因相同：flush 流程假设消息和响应是严格同步的，但实际上 pipe 是异步的。建议引入消息级别的关联机制或等待 in-flight 完成后再开始 flush，然后加上重入保护和超时机制。修复后重新审查。
