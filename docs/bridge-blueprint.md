# persona-shell Blueprint

> **日期**: 2026-04-08
> **定位**: Agent Shell — 类比 Unix shell，为 AI 人格提供运行环境

---

## Shell 是什么

persona-shell 是 AI 人格的运行环境，类比 Unix shell 之于程序。

```
Unix shell                    persona-shell
─────────────                 ─────────────
运行程序                       运行 Director（主人格 Claude Code 进程）
管道通信 (stdin/stdout)        FIFO 管道通信 (stream-json)
后台任务 (cmd &)               子角色派发 (Agent tool + run_in_background)
任务管理 (jobs/fg/kill)        Task 系统 (tasks.db + outbox watcher)
定时任务 (cron)                内置 scheduler (setInterval 驱动)
终端 (tty)                    飞书 + Web Console
```

### Shell 的职责

1. **进程管理** — 启动、重启、flush Director 进程，管理其生命周期
2. **消息路由** — 飞书消息 → Director，Director 回复 → 飞书
3. **任务调度** — 子角色的 spawn、追踪、结果回收、失败重试
4. **定时执行** — 内置 scheduler 驱动 blueprint 自动执行
5. **可观测性** — 状态持久化、日志、异常通知、Web Console
6. **上下文管理** — 自动 flush（token 超限/时间超限）、state.md checkpoint

### Shell 不做的事

- 不做决策 — 决策是 Director（Claude）的事
- 不理解消息内容 — 只路由，不解析语义
- 不管子角色内部逻辑 — 只管生命周期（spawn/超时/结果），不管它们做了什么

---

## 已完成

Phase 0-5 已完成，不再赘述。详见 git 历史。

核心成果：安全修复、UX（消息 ACK/命令/通知）、状态持久化、可靠性修复、可观测性、Web Console 验证。

Phase 6（outbox watcher 最简版）：fs.watch + pipe 通知 Director + flush 前检查 + 删除死代码。需要 Phase 7 Task 系统才能真正闭环。

---

## Execution Checklist

### Phase 7: Task 系统 — 可靠的异步后台自动化

> 目标：可靠、可追踪、可异步的后台任务管理。
> Shell 通过 MCP 工具暴露 task CRUD，负责全生命周期。
> 所有 task 完成后通知主人格（Director）。
> 存储用 SQLite（bun:sqlite 原生支持，零依赖）。
> outbox 按日期分文件夹。

#### Shell 在 Task 系统中的角色

```
Shell 提供:
  - MCP 工具: task 的增删改查（Director 调用）
  - 生命周期管理: spawn 进程、超时、重试、结果回收
  - 通知: task 完成/失败后通过 pipe 通知主人格

Director 只做:
  - 通过 MCP 工具创建/查询 task
  - 收到 [TASK_DONE] 通知后按需读取结果
```

#### 交互流程

**Director 主动派发：**

```
Director                         Shell (MCP Server)             子角色进程
   │                               │                               │
   ├─ 调用 create_task ───────────→│                               │
   │  {role, description, prompt}  │                               │
   │                               ├─ 写 tasks.db (dispatched)     │
   │←─ 返回 {taskId, status} ─────│                               │
   │                               ├─ spawn CC 进程 ──────────────→│
   │  (Director 不阻塞，继续工作)   ├─ 更新 tasks.db (running)      │
   │                               │                    干活，写 outbox/
   │                               │←── outbox watcher / 进程退出   │
   │                               ├─ 更新 tasks.db (completed)    │
   │                               ├─ 飞书通知本体                  │
   │←── [TASK_DONE] pipe 通知 ─────│                               │
   │                               │                               │
   │  调用 get_task / list_tasks   │                               │
   │  按需 Read 结果文件            │                               │
```

**Shell 定时触发：**

```
Scheduler (setInterval)          Shell                          主/子人格进程
   │                               │                               │
   ├─ 时间到 ─────────────────────→│                               │
   │                               ├─ 写 tasks.db (dispatched)     │
   │                               ├─ spawn 主/子人格 + 任务 ─────→│
   │                               ├─ 更新 tasks.db (running)      │
   │                               │                    执行任务
   │                               │←── 完成 / 失败                 │
   │                               ├─ 更新 tasks.db                │
   │                               ├─ 失败 → retry_count++ → 重试? │
   │                               ├─ 飞书通知本体                  │
   │                               ├─ [TASK_DONE] 通知主人格 ──────→│
```

#### 7.1 数据层

- [ ] 7.1.1 `src/task-store.ts`：SQLite 封装，建表 + CRUD
  ```sql
  CREATE TABLE tasks (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,       -- 'role' | 'cron'
    role         TEXT NOT NULL,       -- 'explorer' | 'critic' | 'cron-builder'
    description  TEXT NOT NULL,       -- 简短描述，列表展示用
    prompt       TEXT NOT NULL,       -- 完整输入 prompt
    status       TEXT NOT NULL,       -- 'dispatched' | 'running' | 'completed' | 'failed'
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    completed_at TEXT,
    result_file  TEXT,                -- 'outbox/2026-04-08/explore-deepforge.md'
    error        TEXT,
    retry_count  INTEGER DEFAULT 0,
    max_retry    INTEGER DEFAULT 3,
    cost_usd     REAL,
    duration_ms  INTEGER,
    extra        TEXT                 -- JSON 扩展字段兜底
  );
  ```
- [ ] 7.1.2 outbox 按日期分文件夹：`outbox/{YYYY-MM-DD}/{filename}`
- [ ] 7.1.3 数据库位置：`~/.persona/state/tasks.db`，`.gitignore` 排除

#### 7.2 MCP 工具（Shell 暴露给 Director）

- [ ] 7.2.1 `create_task`：创建 task 并 spawn 进程。参数 `{ role, description, prompt, max_retry? }`，返回 `{ taskId, status }`
- [ ] 7.2.2 `get_task`：按 taskId 查询单条 task 详情
- [ ] 7.2.3 `list_tasks`：列出最近 N 条 task（可按 status/role 过滤）
- [ ] 7.2.4 `cancel_task`：取消运行中的 task（kill 进程 + 更新 db）

#### 7.3 生命周期管理

- [ ] 7.3.1 spawn 子进程：参考 DeepForge forge-runner.ts 的 stream-json 协议 + 进程组 kill
- [ ] 7.3.2 超时保护：可配置 timeoutMs，超时 kill 整个进程组
- [ ] 7.3.3 失败重试：task 失败时 retry_count++，未达 max_retry 则重新 spawn
- [ ] 7.3.4 结果回收：outbox watcher 检测到文件 → 更新 tasks.db (completed) + result_file
- [ ] 7.3.5 通知主人格：task 完成/失败后通过 pipe 发 `[TASK_DONE]` / `[TASK_FAILED]` 给 Director
- [ ] 7.3.6 飞书通知：task 完成/失败时向最后活跃 chat 发送摘要

#### 7.4 内置 Scheduler（替代系统 cron）

- [ ] 7.4.1 `src/scheduler.ts`：Shell 进程内 setInterval 驱动
- [ ] 7.4.2 可配置执行间隔（config.yaml `scheduler.interval_minutes`，默认 30）
- [ ] 7.4.3 定时任务通过 create_task 走统一流程（type='cron'）
- [ ] 7.4.4 重叠保护：上一个 cron task 还在跑时跳过

#### 7.5 验证

- [ ] 7.5.1 `bun run check` 通过
- [ ] 7.5.2 Director 调用 create_task 派出 Explorer，确认全链路：db 记录 → spawn → 结果落盘 → db 更新 → pipe 通知 → 飞书通知

### Phase 8: 飞书消息增强

- [ ] 8.1 支持接收富文本（post 类型）消息，提取纯文本内容传给 Director
- [ ] 8.2 Console 认证：从 config.yaml 读取 `console.token`，bearer token 校验

### Phase 9: Console Phase 2 — Logs + Sessions (远期)

- [ ] 9.1 日志源抽象：读取 + tail 日志文件
- [ ] 9.2 WebSocket 日志频道：按源订阅/取消订阅，实时推送
- [ ] 9.3 Task 状态面板：展示 tasks.db 中的任务列表和状态
- [ ] 9.4 Session JSONL 解析器 + 会话查看

---

## 设计决策记录

### 2026-04-08: 多角色方案选择

**决策**：使用 Agent tool + run_in_background（方案 A），不自建 MCP 调度框架（方案 B）。

**评估人**：Critic + Introspector

**理由**：
- Critic：方案 A 必须解决结果闭环（已做：outbox watcher），约 70 行代码够用
- Introspector：方案 B 与"目的高于手段"、"效用至上"、"先正确再优化"三条价值观都有摩擦。persona-runner.ts 是前车之鉴（建了 168 行没人用）
- 共识：先 A，等痛了再 B。当前每天几次调用不需要 500 行调度框架

**升级到 B 的信号**：使用频率 > 10次/天、API 月账单跳变、反复出现幽灵结果

### 2026-04-08: 命名 bridge → shell

**决策**：全量替换 bridge → shell

**理由**：类比 Unix shell，这个项目是 agent 的运行环境（shell），不是桥接层（bridge）

### 2026-04-09: 子角色身份继承与派发路径

**决策**：
1. 子角色默认继承主人格身份（加载 CLAUDE.md），除非有特殊要求
2. task-runner 不加 `--bare`，加载 `--plugin-dir`（personas + skills），与 Director 环境一致
3. persona 文件的 YAML frontmatter 在注入 prompt 时剥离，只取正文

**两条并行派发路径**：

```
路径 A：Director 内部派（Claude Code Agent tool）
  Director → Agent(subagent_type="Critic") → 子进程
  快，进程内完成。无 DB 记录、无重试、无超时保护。

路径 B：Shell 派（Task 系统）
  Director → create_task MCP → Shell → task-runner spawn → 子进程
  有 DB 记录、超时、重试、飞书通知、日志。
```

Director 根据场景选：快速的事用 A，重要的后台任务用 B。

**子角色可以嵌套派发**：子进程加载了 `--plugin-dir personas`，可以再用 Agent 工具派更深层子 agent。当前无限制，也无此需求。

**persona 文件双重消费**：
- Plugin 系统：读完整文件（frontmatter + 正文），注册 agent 类型供 Agent 工具使用
- Task runner：只读正文（剥离 frontmatter），拼到 prompt 前面注入角色身份
