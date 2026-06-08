# Codex 与 Persona Shell 深度集成交接

## 背景

当前目标是让 persona-shell 和 Codex app 深度结合：

1. persona-shell 创建的 Codex 会话能在 Codex app 中以正确 workspace 出现。
2. Codex app 能复用 persona-shell 的 Persona、多 agent、memory、outbox 和 audit 能力。
3. 公共项目目录与个人代理上下文保持边界清楚：项目文件属于协作空间，context/memory/outbox/audit 属于 persona-shell 的个人或团队代理空间。

当前分支：

```text
codex/deep-codex-persona
```

关键提交：

```text
4e71593 feat: web console workbench upgrade & codex thread injection
aa55d6d fix: scope codex pool sessions to workspace cwd
5de75a8 feat: expose persona orchestration to codex app
ab9eaa2 feat: surface codex live sessions in app
```

## 已完成内容

### Codex app 可见性

`ab9eaa2` 让 Codex app-server 创建的 thread 使用 app 可见元数据：

- `threadSource: "user"`
- `sessionStartSource: "startup"`
- `thread/name/set`
- provider `cwd`

### Persona 编排能力暴露

`5de75a8` 增加了 `src/persona-orchestration.ts`，并通过 MCP/API 暴露：

- `persona_list`
- `persona_prompt`
- `persona_memory_read`
- `persona_memory_write`
- `persona_delegate`
- `persona_session_link`

Prompt 分层约定：

```text
soul.md + meta.md                 -> baseInstructions
provider system_prompt_file       -> developerInstructions
personas/{role}.md                -> developerInstructions
用户任务                           -> turn/start.input
```

注：旧 Tenbase/Codex 方案会在 `codex exec` prompt 前手工拼接 `soul.md`、`meta.md` 和角色文件。该路径已经下线；主线使用 App Server instructions / Codex 原生 instruction 配置。

### Pool cwd fallback

`aa55d6d` 把 pool Director 的 Codex cwd 从全局 provider cwd 改为群/话题 workspace 目录：

```text
~/.persona/workspaces/{label}-{group}/
```

这个修复解决了“所有 pool Codex thread 都落到 persona-shell repo”的问题。

## 当前主要问题

`4e71593` 改动很大，包含 Web Console 扩展和 Codex thread injection。方向上存在偏差：

1. 把 Codex thread 当成任务回调总线。
   `src/codex-thread-injector.ts` 会临时启动 app-server，resume 旧 thread，再注入模拟用户消息。

2. 通用任务协议被 Codex app 字段污染。
   `persona_delegate/create_task` 增加了 `callback_codex_thread_id`、`callback_cwd`、`callback_on_done`。

3. Run / Project / MemoryScope 还没有成为底层事实。
   现有 `persona:session-links` 仍是薄映射，缺少 `run_id`、`primary_project_cwd`、`memory_scope_id`、`project_refs`。

4. Web Console 提前膨胀。
   UI 一次性引入大量任务、日志、文件、审批、debug 能力，但底层模型边界仍未定型。

建议把 `CodexThreadInjector` 保留为实验能力，核心路径回到 Run / Task / Artifact / AuditEvent。

## 核心概念

### Persona

谁在工作。

包含：

- `soul.md`
- `meta.md`
- `personas/{role}.md`
- skills
- agent provider 配置
- prompt 注入策略

### Project

公共工作对象。

通常是一个真实 repo 或目录，承载源码、项目文档、团队认可的产物。Codex app 的 workspace 语义对应 Project，因此 Codex thread 的 `cwd` 应绑定当前主 Project 的真实目录。

### Run

一次工作语义连续的代理轨迹。

Run 是审计主轴，串起：

- 目标
- 发起入口
- Persona
- Project 集合
- MemoryScope
- Session
- Task
- Artifact
- AuditEvent

### Session

技术连续性。

Session 表示某个对话或执行通道是否能继续恢复，例如：

- Codex thread id
- Claude session id
- Web chat id
- 飞书话题 id
- `/tmp/persona/{label}/session`

Session 可以关闭、恢复、替换；Run 保持工作语义连续。

### Task

可执行事项。

Task 是后台可调度、可重试、可完成或失败的执行单元。一个 Run 可以创建多个 Task；长时间独立子 agent 可以同时拥有 Task 和 sub-run。

### MemoryScope

上下文与记忆边界。

定义 context、memory、outbox、audit 的归属与可见性。默认位于 `~/.persona`，不直接混进公共项目目录。

### Artifact

过程产物或交付物。

包括任务报告、附件、patch、commit、生成文档等。默认先落在 persona outbox；进入 Project 时需要显式发布、写入或提交，并保留 provenance。

## 目标关系

```text
Run
  ├─ Persona
  ├─ MemoryScope
  ├─ Project[] / primary Project
  ├─ Session[]
  ├─ Task[]
  └─ Artifact[]
```

运行规则：

```text
Codex thread.cwd = Run.primaryProject.cwd
Bootstrap context = Run.memoryScope.contextPath
Task.project_dir = Run.primaryProject.cwd by default
Task.result_file = ~/.persona/outbox/...
AuditEvent records run/session/task/artifact/project relation
```

## 当前数据映射

当前 `~/.persona` 已有很多原始数据，可以映射到新模型：

| 当前数据 | 目标模型 |
|----------|----------|
| `soul.md`、`meta.md`、`personas/`、`skills/` | Persona |
| `pool:entries` / `pool:closed` | Run 候选与入口元数据 |
| `director:{label}` | Run runtime state |
| `/tmp/persona/{label}/session` | Session |
| `session:names` | Session display name |
| `workspaces/{label}-{name}/context.md` | MemoryScope context |
| `daily/state-*.md` | 全局或机器隔离 MemoryScope |
| `memory/` | 长期 MemoryScope |
| `tasks` 表 | Task |
| `tasks.extra.project_dir` / spawn args `--cd` | ProjectRef 候选 |
| `outbox/YYYY-MM-DD/*.md` | Artifact |
| `attachments/` | Artifact |
| `logs/{label}/`、`task-*.stdout.log` | AuditEvent 原始材料 |

## 需要修改的层

### 1. 数据模型

新增 SQLite 表或等价 store：

```text
projects(id, name, cwd, repo_url, default_branch, created_at, updated_at)
memory_scopes(id, owner, visibility, context_path, outbox_path, audit_path)
runs(id, title, status, persona_role, primary_project_id, memory_scope_id, created_at, updated_at)
run_sessions(run_id, kind, session_id, parent_id, cwd, name, status)
run_tasks(run_id, task_id, relation)
artifacts(id, run_id, task_id, type, path, project_id, provenance)
audit_events(id, run_id, event_type, target_type, target_id, payload, created_at)
```

先做 lazy upsert：遇到 main/pool/task 时补 Run，不做一次性全量迁移。

### 2. 运行时

引入 `RunContext`：

```ts
interface RunContext {
  runId: string;
  primaryProjectCwd: string;
  memoryScopeId: string;
  contextPath: string;
  projectRefs: ProjectRef[];
}
```

改动点：

- `SessionBridgeOptions` 增加 `runContext`
- Codex app-server `thread/start` / `thread/resume` 的 `cwd` 取 `runContext.primaryProjectCwd`
- bootstrap prompt 注入 `runContext.contextPath`
- flush checkpoint 写 `runContext.contextPath`
- `getStatus()` 暴露 `runId`、`projectCwd`、`contextPath`

### 3. DirectorPool / main 路由

创建或恢复 Director 前先解析 Run：

- main：默认 Run，绑定默认 Project
- pool：按 routingKey 找 Run；没有则创建 Run + MemoryScope
- web chat：每个 web session 一个 Run
- Codex app MCP：从 cwd / metadata 创建或绑定 Run

`pool:entries` 可以保留为兼容缓存；新逻辑以 `runs` 为准。

### 4. Task / 多 agent

Task 必须挂 Run：

- `CreateTaskInput` 增加 `run_id`
- `task.extra` 保留兼容字段
- 核心关系写 `run_tasks`
- `persona_delegate` 默认继承当前 Run 的 primary Project
- 子任务 `project_dir` 默认取 `Run.primaryProject.cwd`
- Task 完成后登记 Artifact
- Codex 子任务 stdout 中的 `thread.started` 登记到 `run_sessions`

`callback_codex_thread_id` 保留为实验字段，默认关闭。

### 5. API / MCP

新增通用 API：

```text
GET/POST /api/runs
GET /api/runs/:id
POST /api/runs/:id/bind-project
POST /api/runs/:id/sessions
GET/POST /api/projects
GET /api/memory-scopes/:id
```

MCP 工具收敛：

```text
persona_current_run
persona_bind_project
persona_delegate
persona_memory_read
persona_memory_write
```

`persona_session_link` 后续降级为兼容接口，内部写 `run_sessions`。

## 实施顺序

1. 增加 schema、store、单元测试。
2. 从现有 main/pool 懒创建 RunContext，保留旧行为 fallback。
3. 改 Codex cwd 和 bootstrap/flush context path 从 RunContext 读取。
4. 改 Task 绑定 Run 和 Project。
5. Web Console 先只读展示 Run / Project / MemoryScope。
6. 降级或移除默认 `CodexThreadInjector` 回插路径。
7. 再决定是否把 Web Console 的大 UI 改造拆成小提交重做。

## 推荐处理当前分支

当前 `4e71593` 已经推到 `origin/codex/deep-codex-persona`。建议不要在这条提交上继续堆核心模型。

推荐策略：

1. 从 `aa55d6d` 或 `5de75a8` 切新分支做模型改造。
2. 把 `4e71593` 作为实验分支保留，用于参考 Web Console 与 injector 实现。
3. 新分支先提交纯数据模型和运行时改动。
4. UI 改动拆到模型稳定之后。

## 验证重点

基础验证：

```bash
bun test
bun run check
```

模型验证：

- 新建 main Run 后，Codex thread cwd 等于 primary Project cwd。
- 新建 pool Run 后，context path 仍在 `~/.persona`，Codex cwd 可以绑定真实项目。
- `persona_delegate` 创建 Task 时自动写 `run_id` 和 `project_dir`。
- Task 完成后 `artifacts` 与 `audit_events` 有记录。
- 切换 Project 时新 Session 挂同一 Run。
- 清 session / flush / crash 后 Run 不丢。

回归验证：

- 现有飞书群 Director 可恢复。
- Web Console 会话历史仍可读。
- `persona_list`、`persona_prompt`、`persona_memory_read/write` 仍可用。
- 已有 `tasks` 表不需要立即迁移即可继续工作。
