# TurnPhase 状态机改造 — 改动说明

**任务**: T-0604-16-003
**日期**: 2026-06-04
**分支**: dev

## 改动清单

### 1. P0 修复：handleRuntimeClosed 补发 turn_failed

**文件**: `src/session-bridge.ts`
**位置**: `handleRuntimeClosed` 方法（约 line 1559-1619）

修改前：runtime 意外关闭时直接清空 `pendingTurns`，前端收不到终止事件，StreamingBlock 永远卡着。

修改后：在清空 `pendingTurns` 之前对所有 `isVisibleTurn` 的 pending turn 发射 `turn_failed` 事件（error = "Director 进程意外退出"），确保每个 `turn_started` 都有对应的终止事件。

```typescript
if (!this.flushing) {
  for (const pending of this.pendingTurns) {
    if (this.isVisibleTurn(pending)) {
      this.emitTurnEvent(pending, { type: 'turn_failed', error: 'Director 进程意外退出' });
    }
  }
  this.pendingTurns = [];
  // ... 原有清理逻辑
}
```

flush 期间不补发——flush 流程自己管理 turn 状态（checkpoint → terminate → restart → bootstrap），补发会和重启流程抢事件。

### 2. TurnPhase 状态机实现

**文件**: `web-v2/src/hooks/use-chat.ts`

新增类型：
```typescript
export type TurnPhase = 'thinking' | 'streaming' | 'tool_running' | null
```

新增 state：`const [turnPhase, setTurnPhase] = useState<TurnPhase>(null)`

事件转换（在 turn_event handler 内）：

| 事件 | 动作 |
|------|------|
| `turn_started` | `setTurnPhase('thinking')` + arm timeout |
| `assistant_delta` | `setTurnPhase('streaming')` + arm timeout |
| `tool_started` / `tool_completed` | `setTurnPhase('tool_running')` + arm timeout |
| `turn_completed` / `turn_failed` / `turn_aborted` | `clearLiveTurn()` → `setTurnPhase(null)` + 清除 timeout |

`clearLiveTurn` 同步重置 `turnPhase` 和 `streamingTools`，并调用 `clearTurnPhaseTimeout()`。

`activity` 状态保留（旧通道兼容），但不再驱动 `StreamingBlock` 可见性。

### 3. 超时安全阀

**文件**: `web-v2/src/hooks/use-chat.ts`

实现 120 秒事件 watchdog：

```typescript
const turnPhaseTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

const armTurnPhaseTimeout = useCallback(() => {
  clearTurnPhaseTimeout()
  turnPhaseTimeoutRef.current = setTimeout(() => {
    setTurnPhase(null)
    turnPhaseTimeoutRef.current = undefined
  }, 120_000)
}, [clearTurnPhaseTimeout])
```

每次收到 turn 事件调用 `armTurnPhaseTimeout()` 重置倒计时；`clearLiveTurn()` 或 session reset 时调用 `clearTurnPhaseTimeout()` 取消定时器。

设计意图：`turn_completed` / `turn_failed` / `turn_aborted` 事件因网络丢包或后端异常丢失时，120 秒后自动回退 IDLE，避免 UI 永远卡着。

### 4. StreamingBlock 渲染条件更新

**文件**: `web-v2/src/pages/chat.tsx`

`StreamingBlock` 组件签名从 `{ text, activity, tools }` 改为 `{ phase, text, tools }`：

```tsx
{turnPhase && <StreamingBlock phase={turnPhase} text={streaming} tools={streamingTools} />}
```

组件内部按 phase 决定 UI：
- `'thinking'` → Spinner + "思考中…"
- `'streaming'` → 渐进式 Markdown + 光标（仅当有 text）
- `'tool_running'` → Spinner + "执行 {lastRunningTool.name}…"

工具名称从 `streamingTools` 数组中派生（取最后一个 `status === 'running'`），不再依赖 `activity` 字符串。

Empty conversation 条件同步更新为 `!streaming && !activity && !turnPhase`。

### 5. 文档更新

**文件**: `docs/streaming-turn-events.md`

- "前端 TurnPhase 状态机"一节标注为已实现
- "已知问题"问题 1（thinking 空窗期）和问题 2（activity 语义混合）标注为已修复
- "改进方向"标注为已实施
- 新增"超时安全阀（前端）"小节
- 新增"P0 修复：handleRuntimeClosed 补发 turn_failed"小节

## 兼容性

- `usingTurnEventsRef` 切换逻辑保留：未收到首个 turn_event 时，旧通道（chunk / tool-call / chat_reply / stream-abort）继续工作
- `activity` 状态保留旧值，不再被新逻辑修改（仅在 turn_event 路径下 set null），保持向后兼容
- 旧通道驱动的路径不受 turnPhase 影响（因为旧路径不调用 setTurnPhase）

## 验证

- `npx tsc --noEmit`（后端）— 通过
- `cd web-v2 && npx tsc --noEmit`（前端）— 通过
- `bun test` — 2 pass, 0 fail
