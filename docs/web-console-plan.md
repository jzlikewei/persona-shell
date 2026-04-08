# Web 管理控制台 — 执行方案

## 目标

给 persona-bridge 加一个 Web 管理控制台，能**完整管理**这个应用：看状态、看操作、看当前和历史会话、执行常用操作。用 xterm.js 做 Web TUI 风格。

## 数据源

| 数据 | 来源 | 访问方式 |
|------|------|----------|
| Director 状态（pid/flushing/tokens/pending） | Director 实例内存 | 进程内直接读 |
| 消息队列 | MessageQueue 实例内存 | 进程内直接读 |
| 当前会话消息 | `~/.claude/projects/-Users-ilike--persona/{sessionId}.jsonl` | 读文件 |
| 历史会话列表 | 同目录下所有 `.jsonl` 文件 | 扫描目录 |
| 实时 Director 输出 | FIFO 管道（当前 Bridge 单消费者） | Bridge 读后 fan-out 广播 |
| 日志 | `logs/queue.log`、`bridge.stdout.log`、`director-stderr.log` | 读文件 + tail |
| 系统统计 | `~/.claude/stats-cache.json` | 读文件 |

## 架构

```
Browser (xterm.js)
    ↕ WebSocket
persona-bridge (Bun)
    ├── index.ts          ← 现有：飞书 ↔ Director
    ├── console.ts        ← 新增：Web 控制台服务
    │     ├── Bun.serve()         HTTP + WebSocket
    │     ├── GET /               单文件 HTML (xterm.js TUI)
    │     └── WebSocket           双向：推状态 + 收命令
    └── console-state.ts  ← 新增：统一状态采集
          ├── 定时采集 Director/Queue 内存状态
          ├── 监听 Director 事件（response/flush/restart）
          └── 对外暴露 getSnapshot() + EventEmitter
```

嵌入 Bridge 进程，不独立部署。原因：Queue 状态在内存里，Director 实例引用在进程内。

## 功能分期

### Phase 1：状态 + 操作（MVP）

最小可用版本。一个页面，能看能操作。

**状态面板（只读）：**
- Director：alive / pid / session_id / flushing / pending_count
- Token：当前用量 / 阈值 / 使用率百分比
- 上次 flush 时间 / 距下次自动 flush
- 队列：深度 + 每条消息摘要
- Bridge uptime

**操作：**
- Flush（手动触发）
- Esc（取消最旧消息）
- Restart Director

**技术：**
- 后端：`Bun.serve()` + WebSocket
- 前端：单 HTML 文件，内联 xterm.js (CDN)
- 数据：WebSocket 定时推送状态快照（1s 间隔）+ 事件驱动推送
- TUI 渲染：服务端生成 ANSI 序列发给 xterm.js

### Phase 2：日志 + 会话查看

**日志查看器：**
- 多日志源切换（queue.log / bridge.stdout / director-stderr）
- 实时 tail（新日志追加显示）
- 搜索（xterm-addon-search）

**当前会话查看：**
- 解析当前 session 的 JSONL
- 渲染 user/assistant 消息对
- 折叠 thinking/tool_use 块，展开 text 块
- 实时追加新消息（Director 响应时）

### Phase 3：历史会话 + 高级功能

**历史会话：**
- 会话列表（按时间排序，显示消息数/大小/时长）
- 会话详情查看（复用 Phase 2 的渲染器）
- 会话搜索（关键词搜索消息内容）

**高级功能：**
- 手动发消息给 Director（绕过飞书）
- Token 用量趋势图（基于 stats-cache.json）
- Persona 子人格/技能目录查看
- outbox 任务列表和结果查看

## TUI 界面布局（Phase 1）

```
┌─ Persona Console ──────────────────────────────────────┐
│                                                         │
│  Director: ● ALIVE  pid=54858  session=4cc11ced...      │
│  Tokens:   ████████░░░░░░░░░░░░  125,000 / 700,000     │
│  Flush:    2h30m ago  │  Next auto-flush: ~4h           │
│  Queue:    1 pending                                    │
│  Uptime:   6h 23m                                       │
│                                                         │
│  ── Queue ──────────────────────────────────────────     │
│  [cid-1775570251] "看下代码，FLUSH 未能完成..."  12s ago  │
│                                                         │
│  ── Keys ───────────────────────────────────────────    │
│  [f] Flush   [e] Esc   [r] Restart   [q] Quit          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 需要改造的现有代码

1. **Director 类**：暴露状态 getter（目前大部分字段是 private）
   - `getStatus()` → 返回 `{ alive, pid, sessionId, flushing, interrupted, pendingCount, lastInputTokens, lastFlushAt }`
   - 事件扩展：emit `flush:start`, `flush:complete`, `restart` 等

2. **MessageQueue 类**：暴露队列快照
   - `getSnapshot()` → 返回当前队列项列表

3. **index.ts**：启动控制台服务
   - 创建 Console 实例，注入 Director 和 Queue 引用

## 文件结构（新增）

```
src/
  console.ts            # Web 服务 + WebSocket 处理
  console-state.ts      # 状态采集 + 事件聚合
  console-tui.ts        # ANSI TUI 渲染器
  public/
    index.html          # 单文件前端（xterm.js + WebSocket 客户端）
```

## 先做 Phase 1

预估工作量：~300-400 行新代码 + ~50 行现有代码改造。
