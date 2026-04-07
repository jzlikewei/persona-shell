# FLUSH 修复方案探索

探索者：Explorer
日期：2026-04-07

## 前置发现：被忽略的第三个 Bug

在分析 Bug 1 和 Bug 2 的过程中，发现 time sync 机制存在同样的归因问题。`send()` 在发送用户消息前可能插入一条 time sync 消息：

```typescript
await this.writeRaw(`[系统时间同步] 当前时间: ${timeStr}`);
await this.writeRaw(message); // 用户消息
```

两次 `writeRaw()` 都以 `type: 'user'` 发送，Director 会分别产生两个 result 事件。time sync 的 result 先到达，被 `resolveOldest()` 匹配到队列中的用户消息 — 用户收到的是 Director 对"当前时间是 XX"的回复，而不是对自己问题的回复。

这个 bug 与 Bug 1/2 同根同源：所有通过 `writeRaw()` 发送的消息共享同一个 result 处理通道，没有任何区分机制。下面的方案探索中会一并考虑。

---

## 根因分析

三个 Bug 的共同根因是：**发送端有多种消息类型（用户消息、time sync、checkpoint、bootstrap），但接收端只有一个 result handler，靠一个布尔值做路由。**

stream-json 协议没有 correlation ID，但 Director 是单进程顺序处理的 — 消息按 FIFO 顺序进入，result 按 FIFO 顺序产生。这个顺序性保证是所有方案的基础锚点。

---

## 方案空间

### 方案 A：Drain-first（先排空再 flush）

**核心思路**：flush() 开始前，先等所有 in-flight 消息处理完毕。当发送端和接收端同步后，再发 checkpoint，此时下一个 result 必然是 checkpoint 的响应。

**实现**：
- 维护一个 `pendingCount` 计数器：writeRaw() 时 +1，收到 result 时 -1
- flush() 开头：如果 pendingCount > 0，等待一个 `drained` 事件
- 所有等待期间的 result 正常走 emit('response') 路径

**优点**：
- 概念简单，不改变 result handler 的核心逻辑
- checkpoint 和 bootstrap 的归因问题自然解决：drain 完后发 checkpoint，checkpoint 完后发 bootstrap，每一步都是"当前唯一 in-flight 消息"
- 顺便解决 time sync 的归因问题（time sync 也被计入 pendingCount）

**缺点**：
- 如果前一条消息的 Director 响应很慢（比如执行了一个耗时工具），flush 会被长时间阻塞
- "等待 drain"本身需要超时保护，引入又一层复杂度
- 没有解决 time sync 的响应被发给用户的问题 — drain 只是保证 flush 前清空，但正常流程中 time sync 响应仍然会错配

**适用场景**：最简单的修复路径，如果 time sync 响应问题可以另外处理（比如让 time sync 不触发 Director 响应）。

---

### 方案 B：Shadow Queue（影子队列）

**核心思路**：为每一次 `writeRaw()` 调用在内部维护一个有序队列，记录"我发了什么类型的消息"。当 result 事件到达时，从影子队列头部弹出一个条目，根据其类型决定如何路由响应。

**实现**：
```
type SentMessage =
  | { type: 'user'; correlationId: string }
  | { type: 'time-sync' }
  | { type: 'checkpoint'; resolve: () => void }
  | { type: 'bootstrap'; resolve: () => void }
```

- `writeRaw()` 变为私有，对外暴露语义化方法：`sendUser()`、`sendTimeSync()`、`sendCheckpoint()`、`sendBootstrap()`，每个方法同时 push 到 shadow queue
- result handler 中：`const sent = shadowQueue.shift()`，根据 `sent.type` 路由：
  - `user` → emit('response')
  - `time-sync` → 丢弃
  - `checkpoint` → resolve checkpoint promise
  - `bootstrap` → resolve bootstrap promise

**优点**：
- 从根因上解决所有归因问题 — 每个 result 都知道它对应哪条消息
- 统一模型，不需要为每种消息类型加特殊逻辑
- 利用了 Director FIFO 顺序保证，不需要协议层的 correlation ID
- 自然解决 time sync 的归因问题
- flush 不需要等待 drain，可以直接发 checkpoint — shadow queue 会正确路由前序消息的响应

**缺点**：
- 依赖一个强假设：**每次 writeRaw() 恰好产生一个 result 事件**。如果 Director 对某些消息不产生 result（比如被 SIGINT 打断），shadow queue 会永久错位
- 需要考虑异常情况的重置机制（pipe 断开时清空 shadow queue）
- 比方案 A 侵入性更大，需要重构 writeRaw 的调用方式

**适用场景**：如果追求一个"正确性从结构上保证"的方案，这是最优解。

---

### 方案 C：State Machine（状态机）

**核心思路**：把 `flushing: boolean` 升级为完整的状态机，每个状态有明确的 result 处理规则。

**状态定义**：
```
idle → draining → checkpointing → killing → bootstrapping → idle
```

- `idle`：正常模式，result → emit('response')
- `draining`：flush 已触发，等待 in-flight 消息完成。result → emit('response')，完成后自动转 checkpointing
- `checkpointing`：checkpoint 消息已发送，等待响应。result → checkpoint done，转 killing
- `killing`：正在 kill + restart，不应有 result
- `bootstrapping`：bootstrap 消息已发送，等待响应。result → bootstrap done，转 idle

**优点**：
- 每个状态的行为明确、可审计
- 可以为每个状态设置独立的超时
- 状态转换图可以作为文档，降低后续维护者的理解成本
- draining 状态自然解决 Bug 1 的误归因问题

**缺点**：
- 状态数量多，实际上 draining 阶段仍然面临 time sync 响应错配的问题
- 本质上是方案 A 的结构化版本，没有解决更深的归因问题
- 如果和方案 B 结合使用会很强，但单独使用不够

**适用场景**：作为代码组织方式的升级。建议和其他方案组合使用，而不是独立使用。

---

### 方案 D：Content Nonce（内容标记）

**核心思路**：在 checkpoint 消息中嵌入一个唯一标记（nonce），在 result handler 中检查响应内容是否包含该标记。

**实现**：
- 发送：`[FLUSH-CID:a3f2] 请将当前工作状态保存...保存完成后回复"FLUSH-ACK-a3f2"`
- 接收：检查 `currentResponse.includes('FLUSH-ACK-a3f2')`

**优点**：
- 不依赖消息顺序，直接从内容判断
- 实现简单，改动小

**缺点**：
- 依赖 Director（Claude）在回复中包含指定字符串 — 这不是确定性保证。Claude 可能改写、省略、或者在工具调用后忘记输出标记
- 只解决 checkpoint，不解决 bootstrap 和 time sync
- 如果前序消息的回复恰好包含标记字符串（极低概率但非零），会误判
- "让 AI 输出特定格式的字符串来做协议握手"是 fragile pattern

**适用场景**：作为辅助验证手段可以考虑，不建议作为主要方案。

---

### 方案 E：等待同步点（Checkpoint Fence）

**核心思路**：不在 Director 通信层解决归因问题，而是在 flush 的业务逻辑层面保证：flush 只在"安全点"触发。

**实现**：
- `checkFlush()` 不在 result handler 中触发，而是在"队列为空且无 in-flight 消息"时触发
- 手动 `/flush` 也需要等待当前处理完成
- 一旦确认处于安全点，发 checkpoint 后的下一个 result 必然是 checkpoint 的响应

**具体**：在 result handler 末尾，检查条件：`queue.length === 0 && pendingCount === 0 && needsFlush()`，此时触发 flush。由于是在 result handler 中同步触发，不存在竞态。

**优点**：
- 逻辑最简单 — 不需要影子队列或状态机
- 正确性由"触发时机"保证，而不是由"响应路由"保证
- 对现有代码的改动最小

**缺点**：
- 不解决 time sync 归因问题
- 如果消息源源不断，可能永远找不到安全点（需要设置最大等待时间后强制 flush）
- 手动 `/flush` 的用户体验变差 — 需要等当前消息处理完

**适用场景**：最保守的方案。如果 time sync 问题可以通过其他方式解决（见下文），这是改动最小的路径。

---

### 方案 F：分离 Time Sync 通道

**核心思路**：time sync 不作为用户消息发送，而是通过系统提示词或其他机制注入，避免它产生独立的 result 事件。

**可能的实现**：
1. 将 time sync 信息作为用户消息的前缀拼接，而不是独立的 writeRaw()
2. 利用 stream-json 的 system 消息类型（如果支持的话）
3. 完全去掉 time sync — 让 Director 的 CLAUDE.md 指导它在需要时自己检查时间

**优点**：
- 消除一个 writeRaw() 调用 = 消除一个潜在的 result 错配源
- 简化了整体的消息流

**缺点**：
- 方案 1（拼接前缀）最可行，但改变了消息语义
- 方案 2 取决于 stream-json 协议是否支持非 user 类型的消息注入
- 方案 3 最简单但失去了 time sync 能力
- 单独使用不解决 flush 的归因问题

**适用场景**：作为辅助方案，和方案 A/B/E 组合使用。

---

## 其他问题的修复路径

### 重入保护

所有方案共用，直接在 flush() 开头加 guard：

```typescript
if (this.flushing) {
  console.log('[director] FLUSH already in progress, skipping');
  return;
}
```

如果希望调用者知道 flush 被跳过了（比如 `/flush` 命令需要回复用户），可以改为返回 boolean 或抛异常。

### Checkpoint 超时

所有方案共用，用 Promise.race：

```typescript
const timeout = new Promise<void>((_, reject) =>
  setTimeout(() => reject(new Error('checkpoint timeout')), 30_000)
);
await Promise.race([checkpointDone, timeout]);
```

超时后跳过 checkpoint 直接走 reset。可以记录一条警告日志。需要考虑：超时后 `flushCheckpointResolve` 要清理掉，否则后续迟来的 result 还会触发它。

### Flush 期间新消息处理

两条路线：

**拒绝路线**：`send()` 检查 flushing 状态，抛异常或返回 false。index.ts 中 catch 后回复用户"正在刷新上下文，请稍后重试"。简单，用户体验稍差。

**缓冲路线**：flush 期间 `send()` 不写入 pipe，而是暂存到缓冲区。flush 完成后依次发送。复杂度更高，但用户无感知。需要考虑缓冲区溢出、消息的时间戳语义等。

建议先用拒绝路线，简单可靠。

### 队列孤儿清理

flush 前遍历队列，对每个 pending item：
1. 通过飞书回复"该消息因上下文刷新未能处理，请重新发送"
2. 从队列中移除

或者更简单：flush 完成后，将队列中剩余的消息重新发给新 Director。但这改变了用户消息的处理顺序语义，可能引入新问题。

---

## 组合方案评估

| 组合 | 解决 Bug 1 | 解决 Bug 2 | 解决 Time Sync | 复杂度 | 侵入性 |
|------|-----------|-----------|---------------|--------|--------|
| A + F1 | Yes | Yes (加 bootstrap await) | Yes | 低 | 低 |
| B 独立 | Yes | Yes | Yes | 中 | 中 |
| C + B | Yes | Yes | Yes | 中高 | 高 |
| E + F1 | Yes | Yes (加 bootstrap await) | Yes | 低 | 低 |

### 组合 1：方案 E + F（拼接 time sync） + bootstrap await

**改动清单**：
1. time sync 消息拼接到用户消息前缀，不独立发送
2. flush() 只在安全点触发（队列空 + 无 in-flight）
3. bootstrap 响应用同样的 promise 模式等待
4. 加重入保护 + 超时 + 队列清理

这是改动最小的路径。利用"安全点触发"回避了归因问题，用 time sync 拼接消除了额外的 result。

**风险**：如果持续有消息进来，安全点可能迟迟不出现。需要设置"最大等待时间"后强制 flush — 而强制 flush 就又回到了需要处理 in-flight 归因的老问题。

### 组合 2：方案 B（Shadow Queue）独立

**改动清单**：
1. 新增 SentMessage 类型和 shadow queue 数组
2. writeRaw() 变私有，暴露语义化发送方法
3. result handler 改为从 shadow queue 弹出并路由
4. pipe close 时清空 shadow queue
5. 加重入保护 + 超时 + 队列清理

这是"做一次做对"的路径。从结构上保证每个 result 都被正确路由。代价是改动较大，但改完后整个消息流的心智模型变得非常清晰：发什么消息就在 shadow queue 里记一笔，收到 result 就弹一笔，类型对应决定行为。

**风险**：shadow queue 和 Director 实际处理失去同步（比如 Director 崩溃但没产生 result）。需要在 pipe close 事件中做 reset。

### 组合 3：方案 A（Drain-first） + F（拼接 time sync）+ bootstrap await

**改动清单**：
1. time sync 拼接到用户消息前缀
2. 维护 pendingCount，flush 前等待 drain
3. bootstrap await
4. 加重入保护 + 超时 + 队列清理

比组合 1 更主动 — 不等安全点自然出现，而是 flush 触发后主动 drain。和组合 1 的关键区别：组合 1 是"等到安全再 flush"，组合 3 是"flush 触发后等安全点到来"。

实际上差别不大，但组合 3 的代码流程更直觉：flush() 调用后，先 drain，再 checkpoint，再 kill，再 bootstrap。每一步顺序明确。

---

## 一个值得注意的边界情况

`interrupt()` 方法发送 SIGINT 后等待 restart。如果 interrupt 和 flush 同时发生：
- interrupt 设 `this.interrupted = true`
- flush 设 `this.flushing = true`
- kill 导致 pipe close，`rl.on('close')` 检查 `this.interrupted` 在前，`this.flushing` 在后
- 如果两个都是 true，走 interrupt 路径，flush 的逻辑被跳过

任何方案都需要在 flush() 开头检查：如果当前正在 interrupt，等待 interrupt 完成或拒绝 flush。或者用一个互斥锁让 interrupt 和 flush 不能并发。

---

## 总结

从根因出发，最干净的方案是 **Shadow Queue**（方案 B）— 它从结构上消除了所有归因问题，包括 time sync 这个现有的隐性 bug。代价是改动量较大。

最务实的方案是 **组合 3**（Drain + Time sync 拼接 + Bootstrap await）— 改动量小，理解成本低，解决所有已知问题。唯一的隐患是 pendingCount 的同步，需要在 pipe close 时重置。

两者不矛盾：可以先用组合 3 快速修复，后续在需要时升级为 Shadow Queue。
