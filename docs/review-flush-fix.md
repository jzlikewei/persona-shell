# FLUSH 修复方案审查报告

审查人：Critic
日期：2026-04-07

---

## 一、Time Sync Bug 验证

**结论：确认存在，且后果比 Explorer 描述的更严重。**

Explorer 的描述准确：`send()` 在 time sync 触发时连续调用两次 `writeRaw()`，产生两个 result 事件。但 Explorer 只说了"用户收到的是 Director 对时间同步的回复"，实际后果要看 index.ts 中的处理链：

1. time sync 的 result 先到达 → `emit('response')` → index.ts 中 `resolveOldest()` 弹出队列中唯一的用户消息 → 用户收到一条类似"好的，我已记录当前时间"的无意义回复
2. 用户消息的 result 随后到达 → `emit('response')` → `resolveOldest()` 返回 undefined → 回复被彻底丢弃，只在 console 留一行 warning

所以不只是"回复错配"——**用户的真正回复被永久丢失了**。这比 Explorer 报告中的措辞要严重一个等级。

验证路径：在 queue log 中搜索 `Got director response but queue is empty` 这条 warning。如果历史日志中出现过，说明这个 bug 已经在生产中发作过。

---

## 二、各方案评价

### 方案 A：Drain-first

Explorer 的分析基本到位，但遗漏了一个实操风险：**pendingCount 的生命周期管理**。`writeRaw()` 是 async 的，如果 `writeHandle.write()` 抛异常（pipe 断了、磁盘满了），pendingCount 已经 +1 但永远不会有对应的 result 来 -1。drain 等待会永远挂住。

这意味着 pendingCount 的 +1 必须在 write 成功之后，但 result 可能在 write resolve 和 +1 之间就到了（虽然在 Node 单线程模型下不太可能，但这种隐式时序依赖本身就是坏味道）。

另外，Explorer 说"没有解决 time sync 的响应被发给用户的问题"——这是对的。Drain 只解决 flush 场景，正常流程中 time sync 仍然会导致响应丢失。所以方案 A 单独使用是不够的。

**评级：不可单独使用。必须配合 F。**

### 方案 B：Shadow Queue

这是六个方案中唯一从结构上消除根因的方案。Explorer 的分析准确。我要补充两个风险点：

**风险 1：stream-json 协议的 result 保证。** Shadow Queue 的核心假设是"每次 writeRaw 恰好产生一个 result 事件"。这个假设在当前 Claude CLI 版本下成立，但它是一个未文档化的行为契约。如果 Claude CLI 未来版本在工具调用链中发出多个 result（比如中间 result 和最终 result），shadow queue 会立刻错位。需要在代码中用注释明确标记这个假设，并在 result handler 中加防御性检查（比如 shadow queue 为空时收到 result，应该 log warning 而不是 crash）。

**风险 2：多 rl 实例并存。** `flush()` 调用 `restart()` → `start()` → `listenOutput()`，创建新的 rl。但旧的 rl 仍然存活，直到它的 underlying stream 关闭。如果旧 rl 在关闭前还触发了 `line` 事件（比如 OS 缓冲区中残留数据），这些事件会操作共享的 `this` 状态（包括 shadow queue）。旧 rl 弹出的条目可能和新 rl 的消息流混在一起。解法：给每个 rl 实例一个 generation ID，旧 generation 的事件直接忽略。

**评级：结构最优，但实现时需要额外的防御措施。**

### 方案 C：State Machine

Explorer 说"本质上是方案 A 的结构化版本"，这个判断正确。状态机本身不解决问题，只是把问题组织得更清楚。

但我要指出一个 Explorer 遗漏的价值：状态机让**非法状态转换变得可检测**。比如在 `checkpointing` 状态收到的 result 如果内容明显不像 checkpoint 响应（没有"已保存"之类的关键词），状态机可以发出警告。这种防御性在 Shadow Queue 方案中是免费获得的，但在 Drain-first 方案中需要额外添加。

**评级：作为代码组织手段有价值，但不解决核心问题。**

### 方案 D：Content Nonce

Explorer 的判断完全正确："让 AI 输出特定格式的字符串来做协议握手"是 fragile pattern。补充一点：即使 Claude 100% 输出了 nonce，如果 checkpoint 消息触发了工具调用（比如 Director 决定先读取文件再保存），工具调用的中间 result 可能不包含 nonce，但最终 result 包含。这取决于 stream-json 的事件粒度，引入了不必要的协议层耦合。

**评级：不推荐。**

### 方案 E：Checkpoint Fence

Explorer 识别了"安全点可能迟迟不出现"的风险，但对后果的分析不够深入。具体场景：

1. auto-flush 触发（token 超限）
2. 持续有消息进来，安全点不出现
3. token 继续增长，逼近 Claude 的 hard limit
4. 如果 hard limit 触发 Director 自己拒绝响应，系统进入死锁：需要 flush 来清理 token，但 flush 在等安全点，安全点需要 Director 响应完成，但 Director 因 token 超限拒绝响应

这不是理论风险——如果 `flush_context_limit` 设得太接近 Claude 的实际上下文上限，这个场景完全可能发生。

另外，Explorer 说"加最大等待时间后强制 flush"作为 fallback，但他自己也承认"强制 flush 就又回到了需要处理 in-flight 归因的老问题"。所以这个 fallback 本质上是在说"大部分时候用方案 E，小概率退化到没有修复的状态"。这不是一个可接受的工程方案。

**评级：风险不可控，不推荐作为主方案。**

### 方案 F：分离 Time Sync 通道

F1（拼接前缀）是务实的选择。但有一个细节需要确认：**拼接后的消息是否会影响 Director 的响应质量？** 如果每条用户消息都带一个 `[系统时间同步] 当前时间: 2026-04-07 14:30:22` 的前缀，Director 可能会在回复中提及时间或产生不必要的上下文污染。建议用更隐式的注入方式，比如放在 JSON payload 的 metadata 字段（如果 stream-json 支持的话），或者缩短为极简格式 `[T:14:30]`。

F3（去掉 time sync）也值得认真考虑。time sync 的价值前提是"Director 不知道当前时间"。但如果 Director 的 CLAUDE.md 中已有日期信息，或者 Director 可以通过工具获取时间，那 time sync 可能是一个不必要的复杂性来源。在砍掉之前需要验证 Director 的实际时间感知能力。

**评级：F1 可行，F3 值得调研。**

---

## 三、组合方案评价

### Explorer 的组合 1（E + F + bootstrap await）

不推荐。核心原因：方案 E 的安全点死锁风险没有被组合解决。F 和 bootstrap await 解决的是另外两个问题，不能弥补 E 的根本缺陷。

### Explorer 的组合 2（Shadow Queue 独立）

结构最优，但 Explorer 低估了实现复杂度。除了他列出的改动，还需要：
- generation ID 防旧 rl 串扰（见上文方案 B 风险 2）
- shadow queue 为空时的防御性处理
- 充分的集成测试覆盖异常路径（pipe 断开、Director 崩溃、SIGINT 中断）

如果团队有充足的时间和测试条件，这是正确选择。

### Explorer 的组合 3（Drain + F + bootstrap await）

Explorer 推荐的"务实路径"。我基本认同，但要修正一个关键点：**drain 超时后应该中止 flush，而不是强制继续。**

Explorer 没有明确说超时后怎么办。如果超时后强制执行 checkpoint → kill → restart，就回到了原始 Bug 1 的状态。正确的做法是：drain 超时 → 放弃本次 flush → 重置 flushing 状态 → 下一个安全窗口再尝试。这样 flush 可能被推迟，但不会产生错误行为。

另外，组合 3 需要处理一个 Explorer 没提到的边界：**pendingCount 在 pipe close 时的重置。** 如果 Director 崩溃，pipe close 触发 rl.on('close')，此时 pendingCount 可能不为 0。restart 后 pendingCount 必须重置为 0，否则后续 drain 等待会永远挂住。

---

## 四、Explorer 遗漏的风险

### 1. 进程 kill 可能不彻底

`spawnDirector()` 用 `spawn('sh', ['-c', cmd + ' < pipe > pipe'])` 启动。shell 因为有管道重定向不会 exec 掉自己，所以实际运行的是两个进程：sh 和 claude。`process.kill(pid)` 杀的是 sh 的 PID，claude 进程可能变成孤儿继续运行。这不直接影响 flush 的正确性（pipe 断了 claude 也会退出），但如果 pipe 文件被 unlink 后重建，旧 claude 进程可能还持有旧 pipe 的文件描述符，不会自动退出。累积多次 flush 后可能有多个僵尸 claude 进程。

建议：用 `process.kill(-pid)` 发送到进程组（因为 detached: true 创建了新进程组），或者用 `sh -c 'exec ...'` 让 shell 替换自身（需要改造管道重定向的写法）。

### 2. flush 期间 send() 的竞态

index.ts 中 `/flush` 走 `await director.flush()`，但 `feishu.onMessage` 是事件驱动的，不会因为 flush 在 await 就暂停。如果用户在 flush 期间发消息，`director.send()` 会在 restart 的中间状态调用 `writeRaw()`——此时 `writeHandle` 可能是 null（restart 过程中被 close 了）。代码会抛 `TypeError: Cannot read properties of null` 并在 main 的 catch 中杀掉整个进程。

Explorer 在"其他问题"章节提到了"拒绝路线"和"缓冲路线"，但没有强调这是一个**会导致进程崩溃的 P0 问题**，而不只是"用户体验稍差"。这个问题的修复应该和 flush bug 同等优先级。

### 3. interrupt 和 flush 的互斥

Explorer 在"值得注意的边界情况"中提到了这个问题，分析正确。但他只说了"需要互斥锁"而没有给出方案。补充：最简单的做法是在 `flush()` 开头检查 `this.interrupted`，如果为 true 则等待 `restarted` 事件后再开始 flush。反过来，`interrupt()` 开头检查 `this.flushing`，如果为 true 则直接 return（flush 会自己 kill 和 restart，interrupt 没有意义）。

---

## 五、我的推荐

**短期（立即修复）：组合 3 的修正版 + send() 保护。** 具体改动：

1. **Time sync 拼接**（方案 F1）：把 time sync 内容拼接到用户消息前缀，消除独立的 writeRaw 调用
2. **Drain-first with abort**：flush 开头等待 pendingCount 归零，超时后**中止 flush 而不是强制继续**，下次机会再试
3. **Bootstrap await**：用 promise 等待 bootstrap 的 result 再设 `flushing = false`
4. **重入保护**：`if (this.flushing) return`
5. **Checkpoint 超时**：Promise.race + 30s timeout，超时后中止 flush
6. **send() 保护**：flushing 期间 send() 直接 throw，index.ts catch 后告知用户稍后重试
7. **互斥保护**：flush 和 interrupt 互斥
8. **pendingCount 在 pipe close 时重置为 0**

**中期（稳定后重构）：Shadow Queue。** 组合 3 虽然解决了已知问题，但它的正确性依赖"所有调用方都正确使用 time sync 拼接"这个约定。如果将来有人新增一种 writeRaw 调用（比如新的系统消息类型），同样的归因 bug 会重现。Shadow Queue 从结构上封堵了这类问题——任何新消息类型只需要在 SentMessage union type 中加一个 variant，result handler 自动路由。

---

## 六、总体判断

Explorer 的探索报告质量高，根因分析准确，方案空间覆盖全面，推荐的两条路径方向正确。Time sync bug 是真实存在的，且后果比报告措辞暗示的更严重（响应永久丢失，不只是错配）。

主要遗漏是：对 send() 竞态导致进程崩溃的严重程度判断不足，以及对方案 E 安全点死锁的分析不够深入。这两个问题如果不在第一批修复中解决，生产环境会出事。

一句话：**先做组合 3 修正版堵住所有已知的崩溃和丢消息路径，稳定运行后再用 Shadow Queue 做结构性重构。**
