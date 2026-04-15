# FLUSH 机制最终代码审查

审查人：code-reviewer
日期：2026-04-07

## 已修复确认

- **P0（isFlushing 丢弃用户响应）** — ✅ 已修复。index.ts response handler 中没有 isFlushing 过滤。
- **P1（checkpoint 超时响应泄漏）** — ✅ 已修复。超时后 fall-through 到 kill+restart，进程被杀后 in-flight 响应不会到达。
- **Time sync 响应错配** — ✅ 已修复。time sync 拼接为用户消息前缀，不再独立 writeRaw。
- **重入保护** — ✅ 已实现。
- **send() flushing 保护** — ✅ 已实现。
- **flush/interrupt 互斥** — ✅ 已实现。
- **pendingCount pipe close 重置** — ✅ 已实现。
- **进程组 kill** — ✅ 已实现。

## 仍存在的问题

### 1. Bootstrap 超时后响应泄漏（P1，置信度 88%）

bootstrap 超时后清空 flushBootstrapResolve 并设 flushing=false。但 bootstrap 消息发给的是新进程，result 仍会正常到达。到达时 flushing=false、resolve=null，走 else 分支 emit response — bootstrap 的"已恢复"回复被当作用户消息发给飞书。

建议：bootstrap 超时后增加 discardNextResult 标志，或保持 flushing=true 直到 result 到达并丢弃。

### 2. 旧 rl close 与新 bootstrap 的 pendingCount 竞态（P2，置信度 82%）

restart() 创建新 rl，但旧 rl 的 close 事件可能延迟触发。如果在 bootstrap pendingCount++ 之后才触发，会将 pendingCount 从 1 重置为 0。

建议：增加 generation ID，旧 generation 的事件忽略。

### 3. flush 等待 interrupt 完成时的 TOCTOU 竞态（P2，置信度 82%）

flush() 检查 interrupted 和设置 flushing=true 之间有 await 窗口。如果此时 interrupt() 被调用，两者同时 once('restarted')，只有一个会 resolve，另一个永久挂住。

在当前单用户场景下概率极低。

### 4. feishu.ts MessageHandler 类型不精确（Low）

类型声明返回 void，实际使用 async handler 返回 Promise<void>。运行时正确（await 对 thenable 有效），但类型语义不准确。

## 总体判断

**有保留通过。** 先前的 critical/high 问题均已修复。剩余问题中 #1（bootstrap 超时泄漏）建议上线前修复，#2-4 在个人助手的低并发场景下风险可控，可作为中期优化。
