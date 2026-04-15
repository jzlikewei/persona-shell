# Persona 系统架构设计文档

## 一、系统定位

打造一个极度实用主义导向的 AI 代理系统（"分身"）。核心任务是替本体"做事"与"探索"，并通过定期的复盘对齐，持续同步本体的品位、记忆与决策模式。

## 二、底层决策哲学

### 效用至上的逻辑美感

系统的第一优先级是"内在自洽与逻辑美感"，但在现实执行中，严格遵循"一个能用的破烂比完美的理论好一万倍"的实用准则。

### 黑盒封装机制

面对混乱但有效的外部工具/信息，系统不进行深度逻辑解析，而是采用 Adapter Pattern + 效用评估接口直接封装。每个外部工具暴露统一的 `(input, context) → (output, confidence)` 接口，提取其效用的同时，隔离其内部的逻辑矛盾，以维持主干系统的优雅。

## 三、记忆层架构

记忆以 Markdown 文件存储在 `~/.persona/` 目录（独立 git 仓库），按稳定性和更新频率分层。

> **注**：原设计的五层渐进式披露已简化。当前实际运行的记忆结构如下。

### 实际文件结构

```
~/.persona/                          # 身份仓库（git 管理）
├── CLAUDE.md                        # 项目级指令（Claude Code 自动加载）
├── soul.md                          # 灵魂：性格、价值观、行为边界
├── meta.md                          # 运维指令：路径、服务管理等
├── personas/                        # 角色人格定义
│   ├── director.md
│   ├── explorer.md
│   ├── executor.md
│   ├── critic.md
│   └── introspector.md
├── skills/                          # 技能插件（Claude Code plugin）
├── memory/                          # 跨会话记忆（简单 md 文件）
│   └── MEMORY.md                    # 记忆索引
├── daily/                           # 日常层
│   ├── state.md                     # FLUSH 工作记忆
│   └── YYYY-MM-DD.md               # 日报
├── outbox/                          # 子角色产出
│   └── YYYY-MM-DD/
├── TODO.md                          # 跨天待办
└── config.yaml                      # 运行配置
```

### 读取策略

- `CLAUDE.md` + `soul.md`：Claude Code 启动时通过 CLI 参数自动注入（`--append-system-prompt-file`）
- `personas/*.md`：通过 CLI 参数注入角色定义
- `skills/`：通过 `--plugin-dir` 加载
- `memory/`、`daily/state.md`、`TODO.md`：Director bootstrap 时主动读取
- `daily/YYYY-MM-DD.md`：按需读取

### 多 Director 记忆共享

多 Director 实例共享同一个 `~/.persona/` 目录：

- Soul / Memory / Skills — 所有 Director 共享（git 管理）
- `state.md` — 主 Director 读写，群 Director 只读
- 上下文窗口 — 完全隔离，各自独立

## 四、多重人格体系

### 架构模式：导演-演员（Director-Cast）

星型拓扑（Hub-and-Spoke）。所有信息流经 Director 中枢，人格之间不直接通信。

```
                    ┌─────────────────┐
                    │    Director     │
                    │  （导演 + 整合者）│
                    └──┬──────┬──┬───┘
                       │      │  │
              ┌────────┘      │  └────────┐
              ▼               ▼           ▼
        ┌───────────┐  ┌───────────┐  ┌───────────┐
        │  Persona  │  │  Persona  │  │  Persona  │
        │  Instance │  │  Instance │  │  Instance │
        └───────────┘  └───────────┘  └───────────┘
```

### Director 的角色

Director 兼任导演与整合者，职责包括：

1. 解读任务性质，读取记忆层
2. 选择出场阵容与交互模式
3. 撰写 Briefing 分发给人格实例
4. 收集 Report，整合裁决
5. 写回记忆系统，写日报
6. 管理 FLUSH 周期

Director 是有偏好的人格（读取 Soul + Core），代表"本体"的意志。

### 四类人格（类型，非固定实例）

每种类型可按需创建多个专业化实例。

| 类型 | 核心驱动 | 职能 | 实例举例 |
|------|---------|------|---------|
| Explorer（探索者） | 好奇心 | 发散、搜集可能性 | 技术探索者、市场探索者、学术探索者 |
| Executor（执行者） | 结果导向 | 动手、产出结果 | 代码执行者、文案执行者、运营执行者 |
| Critic（批判者） | 风险意识 | 挑刺、压力测试 | 安全批判者、逻辑批判者、品位批判者 |
| Introspector（自省者） | 元认知 | 审视系统自身的模式与偏差 | 决策自省、模式自省、偏差自省 |

#### Introspector 的特殊定位

Explorer / Executor / Critic 都朝外看（看任务、看产出、看风险），Introspector 朝内看：

- Director 是否系统性地偏好某类人格？
- 有没有反复出现但未被记忆层捕获的决策模式？
- Critic 的意见被采纳比例是否合理？
- 记忆层是否有过时内容？

通常由定时任务触发（如周度自省），Director 收到自省报告后决定是否调整行为或标记到日报等待本体复盘。

### 人格定义格式

复用 Claude Code 的 plugin agent 体系定义人格。每个人格以 agent frontmatter 格式定义：

```markdown
# personas/explorer.md
---
name: Explorer
description: 好奇心驱动的探索者，发散搜集可能性。用于调研、信息搜集、发现关联等任务。
tools: [Read, Grep, Glob, Bash, Agent]
---

你是一个好奇心驱动的探索者。
你的任务是发现尽可能多的可能性和联系。
你不需要评估可行性——那是别人的工作。
你的产出格式：发现列表 + 意外关联 + 直觉预感
```

同时，Director 的编排逻辑（如何选人格、如何跑 debate）用 Claude Code skill 系统定义。验收逻辑用 hook 系统实现。

## 五、通讯层抽象（MessagingClient）

### 设计原则

通讯平台（飞书、Telegram、Slack、Web 控制台等）是外挂的适配器，路由层不依赖任何平台特有概念。

```
通讯适配器层                  路由层 (index.ts)           Director 层
───────────────              ─────────────────          ──────────────
feishu.ts                    MessagingRouter            director.ts
web (console.ts)               │                       director-pool.ts
telegram.ts (未来)             │
                               ▼
                         平台无关的路由决策
                         引用格式化、模式分流
```

### MessagingClient 接口

所有通讯平台适配器实现同一接口（`src/messaging.ts`）：

```typescript
interface MessagingClient {
  start(): void;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  reply(messageId: string, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string | null>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  uploadAndReplyImage(messageId: string, filePath: string): Promise<void>;
  uploadAndReplyFile(messageId: string, filePath: string): Promise<void>;
  uploadAndSendImage(chatId: string, filePath: string): Promise<string | null>;
  uploadAndSendFile(chatId: string, filePath: string): Promise<string | null>;
  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
```

### IncomingMessage（平台无关的入站消息）

```typescript
interface IncomingMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  memberCount?: number;
  groupName?: string;
  threadId?: string;         // 子对话（飞书话题、Slack thread）
  quotedText?: string;       // 引用回复的原文
  senderOpenId?: string;     // 发送者 ID（用于本体识别）
  attachments?: Attachment[]; // 附件（图片、文件、语音）
}
```

关键设计：不暴露平台特有字段（如飞书的 `chatMode: 'topic'`），用通用的 `threadId` 表达子对话概念。

### MessagingRouter（多渠道路由器）

```
              MessagingRouter
              ┌─────────────┐
              │ messageOrigin│  ← messageId → client 映射
              │   Map        │
              └──┬────────┬─┘
                 │        │
         ┌───────┘        └───────┐
         ▼                        ▼
  FeishuClient              WebMessagingClient
  (primary)                 (console WebSocket)
```

- 所有 client 的入站消息汇入同一个 handler
- Director 回复时，按 messageId 查 origin 路由到正确的 client
- `sendMessage`（主动通知）默认走 primary
- 新增渠道只需：实现 `MessagingClient` + `router.addClient()`

### 引用消息处理

通讯层只提取引用原文（`quotedText`），不做截断。路由层根据目标模式决定截断策略：

| 目标 | 截断 | 原因 |
|------|------|------|
| Director / Pool | 截断到 `quote_max_length` | 原文已在上下文中 |
| One-shot | 不截断 | 无上下文，需要完整引用 |

## 六、隔离与通信机制

### 硬隔离

每个人格实例是一个独立的 agent 进程，拥有：

- 独立的上下文窗口
- 独立的工具配置
- 只接收 Director 通过 MCP 投喂的 prompt，无其他上下文污染

### Director 三层架构

Director 的进程管理经过重构，分为三层：

```
SessionBridge (session-bridge.ts)
  ├─ 会话编排：FLUSH / 消息队列 / bootstrap / 事件发射
  ├─ 不关心底层是 Claude 还是 Codex
  │
  └─ DirectorSessionAdapter (director-session-adapter/)
      ├─ claude.ts — Claude stream-json 双向协议（解析 init/assistant/result 事件）
      ├─ codex.ts — Codex turn-based 协议（每轮 spawn → 等结果 → 返回）
      │
      └─ DirectorRuntime (director-runtime/)
          ├─ claude.ts — Claude daemon 进程（FIFO named pipe，长驻）
          └─ codex.ts — Codex 按 turn spawn（短驻，session resume）
```

**SessionBridge** 是对外的统一接口（EventEmitter），负责：
- 消息排队、去重、丢弃过期消息
- FLUSH 生命周期（drain → checkpoint → kill → bootstrap）
- 自动 flush 策略（token 阈值 / 时间间隔）
- 统一事件：`chunk` / `response` / `stream-abort` / `alert` / `close` 等

**DirectorSessionAdapter** 封装协议差异：
- Claude adapter：管理 FIFO 读写句柄，解析 stream-json 行协议，提取响应文本和 metrics
- Codex adapter：每轮消息 spawn 一次 `codex exec --resume`，解析 stdout，返回结果

**DirectorRuntime** 封装进程生命周期：
- Claude runtime：spawn detached daemon、PID 追踪、FIFO 创建/清理、进程信号
- Codex runtime：按需 spawn、session 文件管理

#### Claude Director 通信协议

通过 named pipe（FIFO）与 Shell 双向通信：

```bash
# 创建通信管道
mkfifo /tmp/persona/director-in /tmp/persona/director-out

# 启动 Director（detached，独立于 Shell）
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  < /tmp/persona/director-in \
  > /tmp/persona/director-out &
```

输入协议（写 director-in）：
```json
{"type":"user","message":{"role":"user","content":"消息内容"}}
```

输出协议（读 director-out）：
```json
{"type":"system","subtype":"init","session_id":"xxx"}
{"type":"assistant","message":{"role":"assistant","content":"..."}}
{"type":"result","subtype":"success","cost":"...","duration":"..."}
```

#### Codex Director 通信

Codex 不保持常驻进程，每轮消息通过 `codex exec --resume` 续接 session：

```bash
codex exec --resume SESSION_ID "用户消息" \
  --full-auto --sandbox danger-full-access
```

输出从 stdout 逐行读取，遇到 `turn_completed` 事件表示本轮结束。

#### Persona 进程（子角色任务）

子角色通过 `task-runner.ts` 管理，不再使用手动 Briefing/Report 文件协议：

1. Director 通过 MCP `create_task` 指定角色、prompt、描述
2. `task-runner` 按配置的 agent 后端 spawn 进程（Claude `-p` 模式或 Codex `exec`）
3. 任务产出写入 `~/.persona/outbox/YYYY-MM-DD/`
4. 完成后 Shell 将结果回调给发起方 Director
5. 任务有超时保护（默认 30 分钟）、重试、取消，通过 SQLite 持久化

### 进程容灾

```
Shell 崩溃时：
  Claude Director (detached)  → 还活着，通过 named pipe 等待重连
  Codex Director              → 无常驻进程，无影响
  子角色任务 (detached, -p)    → 还活着，结果写 outbox/

Shell 重启：
  → DirectorPool.restoreEntries()：从 SQLite 恢复 pool entries
  → Claude Director：重新 open named pipe 连接存活进程
  → 如果 Director 也崩了：spawn 新 Director，读 state.md 恢复
  → killUnknownOrphans()：清理不在记录中的孤儿进程
```

### 任务编排

当前实现的编排模式是 **Solo（独奏）**：Director 通过 MCP `create_task` 派发任务给单个子角色，收到回调后自行整合。

子角色的 prompt 由 Director 根据任务需求即时组装，不使用固定的 Briefing 格式。产出写入 `outbox/YYYY-MM-DD/` 目录，由 Director 审阅。

> **未来方向**：Relay（接力：Explorer → Executor → Critic 链式）和 Debate（辩论：多角色多轮交锋）模式在设计中但尚未实现。

## 七、多会话与群聊路由

### 消息路由决策树

飞书消息到达 Shell 后，按以下规则分流到不同的处理模式：

```
飞书消息到达
    │
    ├─ 私聊(p2p) ──────────────────────→ 主 Director（长驻）
    │
    └─ 群聊(group)
         │
         ├─ 单人群（user_count ≤ 1）───→ DirectorPool（不需要 @，直接响应）
         │
         ├─ 大群（成员 > threshold）───→ One-shot（无状态，用完即释放）
         │
         └─ 小群（成员 ≤ threshold）──→ DirectorPool（需要 @mention）
```

**单人群模式**：只有一个用户和 bot 的群，等同于私聊体验——收到消息直接响应，不需要 @mention。适合拉一个专属"干活群"让 bot 持续跟进某个话题。

### 三种处理模式

| 模式 | 适用场景 | 进程模型 | 上下文 | 记忆 |
|------|---------|---------|--------|------|
| 主 Director | 私聊 | 长驻 daemon，named pipe | 跨消息保持 | 完整读写 |
| DirectorPool | 单人群 / 小群 | 按需创建，idle 超时回收 | 群级隔离 | 共享 soul/memory，只读 state.md |
| One-shot | 大群 @mention | 一次性 `claude -p`，回复后退出 | 无状态 | 无 |

### DirectorPool 机制

管理多个非主 Director 实例的生命周期：

```
DirectorPool
  ├── entries: Map<routingKey, PoolEntry>   # 活跃的 Director 实例
  ├── closedEntries: Map<routingKey, ...>   # 已退出的 session（最多 50 条，UI 可查看历史）
  ├── creating: Map<routingKey, Promise>    # 竞态锁，防止并发创建
  │
  ├── getOrCreate(key, name)               # 有则复用，无则创建
  ├── reapIdle()                           # 每分钟检查，≤3 个不回收，超时才回收
  ├── evictLRU()                           # 达到上限时淘汰最久未活跃的
  ├── restoreEntries()                     # 重启后从 SQLite 恢复 + reconnect 存活进程
  └── killUnknownOrphans()                 # 清理不在记录中的孤儿进程
```

**持久化**：pool entries 和 closed entries 均持久化到 SQLite `state` 表（key: `pool:entries` / `pool:closed`），Shell 重启后自动恢复。

**配置参数**：

```yaml
pool:
  max_directors: 5          # 最大并发 Director 数（默认 5）
  idle_timeout_minutes: 30  # 空闲超时回收（≤3 个 Director 时不回收）
  small_group_threshold: 5  # 大群/小群人数分界（user_count）
  parallel_chat_ids: []     # 免 @mention 白名单（chat_id 列表）
```

**路由键（routingKey）**：

- 所有群聊统一按 `chat_id` 路由（一个群一个 Director）
- 私聊：无路由键，走主 Director

**@mention 规则**：

- 单人群（`user_count ≤ 1`）：不需要 @，直接响应
- `parallel_chat_ids` 白名单中的群：不需要 @
- 其他群：需要 @mention bot 才响应

### One-shot 大群响应

大群消息不值得维持长驻 Director（成本高、上下文利用率低）。改为事件驱动：

```
@mention 到达 → spawn `claude -p` → 等待回复（60s 超时）→ 回复飞书 → 进程退出
```

- 无状态：不保持对话历史，每次独立处理
- 轻量：不占用 DirectorPool 名额
- Prompt 注入群聊上下文：`你在飞书群聊「{群名}」中被 @ 提问。请简洁回复。`

### 记忆共享模型

详见"三、记忆层架构"。群 Director 的 bootstrap 消息明确其角色边界：
- 主 Director：`读取 daily/state.md 恢复工作上下文，了解当前待处理事项。`
- 群 Director：`你正在为群「{群名}」服务。请读取 daily/state.md 了解全局状态（只读）。`

### Director 事件体系

SessionBridge（EventEmitter）发出以下事件：

| 事件 | 载荷 | 触发时机 |
|------|------|----------|
| `chunk` | `(text: string)` | 每个 assistant 事件中的 text block 到达时（仅用户可见的响应，排除 flush/bootstrap/system） |
| `response` | `(text: string, durationMs?: number)` | 一轮完整回复结束时 |
| `system-response` | `(text: string, replyTo: string)` | 任务通知等系统消息的响应，需回复到指定 messageId |
| `cron-response` | `(text: string)` | Cron 触发的消息的响应 |
| `stream-abort` | `()` | Director 进程异常关闭或重启时，通知上层清理流式状态 |
| `alert` | `(message: string)` | 异常告警，转发给用户 |
| `close` | `()` | 管道关闭（非主 Director 用于 pool 清理） |
| `restarted` | `()` | Director 进程成功重启 |
| `auto-flush-complete` | `()` | 自动 flush 完成 |
| `flush-drain-complete` | `()` | flush drain 阶段完成，队列中的孤儿消息应清理 |

DirectorPool 继承 EventEmitter，将池内 Director 的 `chunk` 和 `stream-abort` 事件 re-emit 到 pool 级别（附带 director label），供 Web Console 统一订阅。

### Web Console 与 Pool 集成

Web Console（`localhost:3000`）通过 WebSocket 向前端推送两类数据：

**1. 状态快照（每秒）**

```jsonc
{
  "type": "status",
  "data": {
    "system": { ... },
    "activity": { ... },
    "context": { ... },
    "pool": [                          // ← DirectorPool 状态
      {
        "chatId": "oc_xxx",
        "groupName": "群名",
        "label": "2da0f077",           // chatId 的 sha256 前 8 位
        "activity": "processing",      // idle | processing | flushing
        "alive": true,
        "queueLength": 0,
        "sessionId": "uuid"
      }
    ]
  }
}
```

**2. 流式 chunk（实时）**

```jsonc
{ "type": "chunk", "director": "main", "text": "增量文本" }
{ "type": "stream-abort", "director": "2da0f077" }
```

前端在 session view 中渲染 streaming bubble（带光标 ▍ 和脉冲动画），`processing→idle` 或 `stream-abort` 时清除 bubble 并重新加载完整消息。

**API 路由扩展**：`/api/messages` 和 `/api/sessions` 支持 `?director={label}` 查询参数，用于查看 pool Director 的会话历史。

## 八、Director Daemon 运行机制

### 运行形态

长驻 daemon 进程。进程层面持续存活，认知层面通过 FLUSH 机制定期刷新。

### 消息来源

```
┌─────────┐  ┌──────────┐  ┌─────────────┐
│ 用户消息 │  │ 任务回调  │  │  定时触发    │
│ (CLI /  │  │ (persona │  │  (cron /    │
│  IM bot)│  │  report) │  │   timer)    │
└────┬────┘  └────┬─────┘  └──────┬──────┘
     └────────────┼───────────────┘
                  ▼
            Director 消息队列
```

### 消息处理循环

```
收到消息
    │
    ▼
1. 读 state.md         ← "我现在在干什么"
2. 读 inbox/           ← "有什么新消息"
3. 读 soul.md + core/  ← "我是谁"
4. 按需读 project/     ← "相关上下文"
    │
    ▼
5. 决策：自己处理 / spawn 人格实例
6. 整合结果
    │
    ▼
7. 更新 state.md / daily / project
8. 检查是否需要 FLUSH
```

### FLUSH 机制（激进上下文刷新）

解决长驻 daemon 的上下文膨胀问题。进程不死，认知定期重启。

#### 触发条件（满足任一即触发）

```yaml
flush_policy:
  max_messages_per_cycle: 20         # 处理 20 条消息后
  max_tokens_estimate: 80000         # 上下文估计达到 80k 时
  max_cycle_duration: "2h"           # 每个 cycle 最长 2 小时
  on_major_decision: true            # 重大决策完成后
  on_persona_debate_complete: true   # debate 结束后
```

#### FLUSH 过程

```
1. Checkpoint（写盘）
   ├─ state.md      ← 当前进行中的任务、等待中的消息
   ├─ daily/today   ← 追加本 cycle 的决策摘要
   └─ project/*     ← 如有更新

2. Reset（清空上下文）
   └─ 开启新的对话轮次，旧上下文被丢弃

3. Reload（重新加载）
   ├─ 读 soul.md
   ├─ 读 core/*
   ├─ 读 state.md   ← 恢复"我在干什么"
   └─ 读 inbox/     ← 检查新消息
```

#### state.md 结构（工作记忆的持久化）

```markdown
# Director State
last_flush: 2026-04-05T14:30:00

## Active Tasks
- task-001: Explorer 正在调研 X，预计 15:00 前返回 report
- task-003: 等待本体确认 Core 层更新

## Pending Inbox
- [unread] 定时触发：每日 HN 扫描
- [unread] 用户消息："帮我看看 Y 项目的进展"

## This Cycle Summary
- 处理了 task-002（Executor 完成代码重构，已验收通过）
- 新发现已写入 work/discoveries.md

## Carry-over Context
（跨 cycle 需要保留的关键临时信息）
```

## 九、对齐机制

不采用复杂的治理/审批层，而是两个轻量机制：

### 有标准的任务 → 验收

任务有明确的完成标准时，直接用断言/测试/检查清单自动验收。通过即完成，失败则重做或上报。

### 无标准的偏好决策 → 记忆同步

涉及品位、偏好等无客观标准的决策时：

1. Director 按当前记忆（Soul + Core）做决策
2. 决策过程记录到日报
3. 本体在复盘时审阅决策
4. "不像我" → 更新 Core 层记忆
5. "很像我" → 强化确认
6. 下次 Director 的决策自然更准

**记忆精度就是对齐精度。**

## 十、迭代与同步

通过日报/周报 + 关键决策点复盘，让本体介入并微调系统的价值锚点。

- 日报：Director 自动生成，写入 `daily/YYYY-MM-DD.md`
- 周报：Introspector 定时生成系统自省报告
- 复盘接口：本体审阅日报/周报，更新 Core 层

## 十一、技术栈

| 组件 | 实现 |
|------|------|
| TS Shell | TypeScript (Bun) 进程，消息路由 + 进程管理 |
| MessagingRouter | 多渠道路由器，按 messageId 路由回复到正确渠道 |
| 飞书适配器 | MessagingClient 实现，WebSocket 长连接 + 飞书 SDK |
| Web 控制台适配器 | MessagingClient 实现，复用控制台 WebSocket |
| SessionBridge | 会话编排层（FLUSH / 队列 / bootstrap），多后端统一接口 |
| DirectorSessionAdapter | 协议适配层（Claude stream-json / Codex turn-based） |
| DirectorRuntime | 进程生命周期层（Claude daemon FIFO / Codex per-turn spawn） |
| DirectorPool | 多 Director 实例管理，按群路由，idle 超时回收。继承 EventEmitter |
| One-shot 响应 | Claude Code CLI（`-p` 模式），大群无状态事件响应 |
| 子角色任务 | task-runner + task-store (SQLite)，通过 MCP 派发，支持 Claude / Codex |
| Cron 调度 | scheduler.ts + task-store (SQLite)，支持 spawn_role / director_msg / shell_action |
| Web Console 流式 | SessionBridge chunk 事件 → Pool re-emit → Console WS 广播 → 前端 streaming bubble |
| 记忆存储 | 本地 Markdown 文件（git 管理） |
| 状态持久化 | SQLite（pool entries、任务、cron jobs） |
| 日报输出 | 本地 Markdown 文件 |

## 十二、全局日志与可追踪性

所有决策链路可追踪：

- 每条消息的来源（用户 / 任务回调 / 定时触发）
- Director 的编排决策（选了谁、用什么模式）
- 每个 Persona 实例的 Briefing 和 Report
- Director 的整合裁决过程
- FLUSH 的 checkpoint 记录
- 记忆层的变更历史（git 管理）

日志存储于 `audit_log/` 目录，按日组织。

## 附录 A：生命周期命令语义

### 命令总览

| 命令 | 作用域 | 说明 |
|------|--------|------|
| `/esc` | 当前会话 | 取消当前正在处理的消息（SIGINT → resume 旧 session） |
| `/flush` | 当前会话 | 有状态的上下文刷新（checkpoint → 杀进程 → 新 session → bootstrap） |
| `/clear` | 当前会话 | 清空上下文（不保存，直接重置） |
| `/session-restart` `/restart` | 当前会话 | 重启 Director，保留 session |
| `/shell-restart` `/restart-shell` | 全局 | 重启整个 Shell 进程（launchd 自动拉起，Shell 代码更新生效） |
| `/start-with-codex` | 当前小群 | 切换到 Codex Director |
| `/start-with-claude` | 当前小群 | 切回 Claude Director |
| `/status` | 当前会话 | 查看 Director 状态摘要 |
| `/help` | 全局 | 列出所有可用命令 |

### 语义对比

| | `/esc` | `/flush` | `/clear` | `/restart` | `/shell-restart` |
|---|---|---|---|---|---|
| 信号 | SIGINT | SIGTERM | SIGTERM | SIGTERM | SIGTERM（全部） |
| 对话历史 | 保留（`--resume`） | 清空（新 session） | 清空 | 保留 | N/A |
| 状态保存 | 无 | checkpoint → state.md | 无 | 无 | 无 |
| 新 skill/配置 | 生效 | 生效 | 生效 | 生效 | 生效 |
| 场景 | 取消卡住的请求 | token 过长 | 彻底重置 | 加载新配置 | 代码更新 |

### `--resume` 与新 skill 的关系

`--resume` 恢复的是对话历史（conversation context），不影响 CLI 参数。每次 `spawnDirector()` 都会重新调用 `buildCommonArgs()`，扫描 `skills/` 目录并构建 `--plugin-dir` 列表。因此即使 resume 旧 session，新安装的 skill 也会被加载。

### 实现要点

- **`/esc`**（`session-bridge.ts: interrupt()`）：设 `this.interrupted = true` → SIGINT → pipe close 回调检查标志 → `restart()`（保留 session）→ emit `restarted`
- **`/flush`**（`session-bridge.ts: flush()`）：drain 等待 → checkpoint（让 Director 写 state.md）→ SIGTERM → `clearSession()` + `restart()`（新 session）→ bootstrap（让新 Director 读 state.md）
- **`/clear`**（`session-bridge.ts: clear()`）：直接 SIGTERM → `clearSession()` + `restart()`（新 session），不执行 checkpoint
- **`/restart`**（`session-bridge.ts: sessionRestart()`）：SIGTERM → `restart()`（保留 session）
- **`/shell-restart`**（`index.ts`）：SIGTERM 全部 Director → `process.exit(0)` → launchd 拉起新 Shell

## 附录 B：已知问题与后续优化

### /esc 中断期间的消息缓冲

`/esc` 通过 SIGINT + restart 实现真正的请求取消。`interrupt()` 期间（约 2-3 秒），`director.send()` 会因 writeHandle 为 null 抛异常。当前依赖消息队列缓冲后续消息，实际触发概率低。

### Shell 反复重启

4/13 曾出现 30 分钟内重启 3 次（SIGTERM），原因未查明。
