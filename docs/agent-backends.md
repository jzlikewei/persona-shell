# Agent 后端

Persona Shell 不直接调用 LLM API，而是将 CLI agent 作为子进程运行。当前支持三个后端，通过统一的三层架构（SessionBridge → Adapter → Runtime）接入。

> **维护说明**：新增或下线 agent 后端时，需同步更新以下位置：
> 1. 本文档（添加/移除后端章节）
> 2. `~/.persona/meta.md` 的"可用 Agent 后端"表（Director 运行时参考）
> 3. `~/.persona/config.yaml` 的 `agents.providers` 和 `agents.roles`

---

## Claude Code

> 支持的长驻 daemon 后端。通过 FIFO 管道双向通信，stream-json 实时流式输出。

### 身份注入

Shell 启动 Claude Code 时，将 `~/.persona/` 中的文件通过 CLI 参数注入：

```
~/.persona/                         注入方式                    效果
├── CLAUDE.md                       --add-dir（自动加载）        项目级指令
├── soul.md                         --append-system-prompt-file  灵魂层人格
├── meta.md                         --append-system-prompt-file  运维指令
├── personas/                       --plugin-dir                 plugin 目录
│   ├── director.md                 --append-system-prompt-file  角色人格（按 role 选择）
│   ├── explorer.md                 （子角色任务时注入）
│   └── ...
├── skills/                         通过 .claude/skills 与 .agents/skills 软链接自动发现
│   ├── code-review/
│   ├── feature-dev/
│   └── ...
└── daily/state.md                  Bootstrap 时由 Director 主动读取
```

- `CLAUDE.md` 通过 `--add-dir ~/.persona` 自动发现加载
- `soul.md`、`meta.md` 通过 `--append-system-prompt-file` 追加到系统提示末尾
- `skills/` 通过 `.claude/skills` → `skills` 被 Claude Code 自动发现，通过 `.agents/skills` → `skills` 被 Codex 自动发现

### 进程启动

```bash
sh -c 'claude [args] < /tmp/persona/director-in > /tmp/persona/director-out'
```

- **stdin** ← FIFO 管道 `director-in`（Shell 写入用户消息）
- **stdout** → FIFO 管道 `director-out`（Shell 读取响应）
- **stderr** → `director-stderr.log`
- `detached: true`，PID 记录在 `director.pid`

### CLI 参数

**公共参数**：

| 参数 | 说明 |
|------|------|
| `--print` | 输出到 stdout |
| `--output-format stream-json` | 逐事件 JSON 输出 |
| `--verbose` | 详细事件 |
| `--dangerously-skip-permissions` | 跳过工具确认 |
| `--add-dir ~/.persona` | 身份仓库 |
| `--plugin-dir personas/` | 人格目录 |
| `--append-system-prompt-file soul.md` | 灵魂层 |
| `--append-system-prompt-file meta.md` | 运维指令 |
| `--append-system-prompt-file personas/{role}.md` | 角色人格 |
| `--model {model}` | 指定模型（来自 roles 或 provider 配置） |

**Director（前台）专用**：

| 参数 | 说明 |
|------|------|
| `--input-format stream-json` | 接受 JSON 持续输入 |
| `--bare` | 精简输出 |
| `--effort max` | 最大推理强度 |
| `--include-partial-messages` | token 级流式 |
| `--mcp-config .mcp.json` | MCP 工具配置 |
| `--resume {sessionId}` | 恢复会话 |
| `--name {sessionName}` | 会话显示名 |

**子角色（后台）专用**：

| 参数 | 说明 |
|------|------|
| `--bare` | 精简输出 |
| `-p {prompt}` | 一次性 prompt |

> 典型 main Agent/Director runtime 有 50+ 个参数（取决于 skill 数量）。

### stream-json 协议

Shell 与 Claude Code 通过 FIFO 管道交换 JSON 行。

**写入**（Shell → Claude）：

```json
{"type":"user","message":{"role":"user","content":"消息内容"}}
```

**读取**（Claude → Shell）：

| 事件 | 说明 | 用途 |
|------|------|------|
| `system` (init) | 会话初始化 | 捕获 `session_id` |
| `stream_event` | token 增量 | 流式显示，不写日志 |
| `assistant` | 完整消息 | 构建回复文本 |
| `result` | 轮次结束 | 触发回复分发、指标收集 |

### 会话恢复

| 场景 | 行为 |
|------|------|
| 首次启动 | 从 `system.init` 捕获 `session_id`，持久化到文件 |
| 重启/崩溃 | 读取 `session_id` → `--resume` 恢复上下文 |
| FLUSH | 清除 session → 全新 session → bootstrap 恢复工作记忆 |
| Session 过期 | "No conversation found" → 清除 session → 全新启动 |

---

## Codex

> 主力后端。Director 默认使用 App Server 模式（长驻 JSON-RPC 进程，流式输出）；`codex-app-server` provider 的后台任务也使用临时 App Server task runtime。

### 运行模式

Codex 只保留 App Server 运行模式：

| 场景 | 模式 | 说明 |
|------|------|------|
| Director（对话） | **App Server**（默认） | 长驻 `codex app-server --listen stdio://` 进程，JSON-RPC 2.0 协议 |
| 后台任务 | **临时 App Server** | 每个任务启动一个临时 `codex app-server --listen stdio://`，`turn/completed` 后关闭 |

默认 provider 配置：

```yaml
agents:
  providers:
    codex:
      type: codex-app-server
      command: codex
      sandbox: danger-full-access
      approval: never
      mcp_mode: dynamic
      transport: stdio
```

`mcp_mode` 支持四种值：

| 值 | 行为 |
|------|------|
| `dynamic` | （默认）通过 Codex App Server experimental `dynamicTools` 注册 task/cron 工具，由 Shell runtime 直接处理工具调用并自动绑定当前 `threadId` 作为 `source_session_id` |
| `mcp` | 兼容模式：通过 MCP 协议暴露工具给 Codex，Codex 可调用 Persona 注册的 MCP tools |
| `cli` | 通过 CLI 子命令方式调用工具，不走 MCP 协议 |
| `off` | 不向 Codex 暴露任何外部工具 |

legacy turn-based `codex exec` provider 已下线，配置层不再接受 `type: codex`。

### 身份注入

Codex 不支持 Claude Code 的 `--plugin-dir` / `--append-system-prompt-file` 参数。当前主线身份注入走 Codex App Server instructions：

- **App Server instructions**：`thread/start` 注入 `baseInstructions` / `developerInstructions`，其中 `soul.md`、`meta.md`、`personas/{role}.md`、provider `system_prompt_file`，以及当前 workspace 的 `context.md` 在启动线程时进入 Codex instruction 层。`context.md` 同时保留为可写的持久工作记忆文件。
- **Skills 发现**：当前不通过 `codex app-server` 启动参数显式传 `skills_dir`。Codex App Server 依赖 Codex 原生 skill 发现机制读取当前工作根下的 `.agents/skills`，因此身份仓库必须保持 `~/.persona/.agents/skills -> ~/.persona/skills` 软链接。Workspace Director 若配置了 provider/workspace `cwd`，仍建议保留该软链接作为 Persona skills 的统一入口；变更 skill 后用 flush 开新线程加载最新资产。
- **Codex 原生配置**：Codex harness 支持通过 `model_instructions_file` / `developer_instructions` 等配置读取 instruction 内容；Persona Shell 已下线 Tenbase 时代的手工拼 prompt 方案。
- **任务系统**：Codex App Server 默认 `mcp_mode: dynamic`，直接用 Codex experimental `dynamicTools` 暴露 task/cron 工具；这样 Agent 不需要知道 session UUID，Shell runtime 在收到 `item/tool/call` 时用请求里的 `threadId` 补 `source_session_id`。需要原生 MCP 兼容时可设 `mcp_mode: mcp`，关闭则设 `off`。

### MCP 参数

| 参数 | 说明 |
|------|------|
| `exec` | 执行模式 |
| `resume {thread_id}` | 恢复已有 thread |
| `--json` | JSON 输出格式 |
| `--skip-git-repo-check` | 跳过 git 仓库检查 |
| `--cd {dir}` | 工作目录 |
| `--model {model}` | 指定模型 |
| `--sandbox {mode}` | 沙箱模式 |
| `--ask-for-approval {mode}` | 审批策略 |
| `--search` | 启用搜索 |
| `-c mcp_servers.*` | MCP 服务器 TOML 覆盖（仅 `mcp_mode: mcp`） |

### JSON 输出协议

Codex 输出也是逐行 JSON，但事件类型不同：

| 事件 | 说明 | 用途 |
|------|------|------|
| `thread.started` | Thread 创建 | 捕获 `thread_id` 用于 resume |
| `item.completed` | Agent 消息完成 | 累积回复文本 |
| `turn.completed` | 轮次结束 | 触发回复分发 |

### 会话恢复

| 场景 | 行为 |
|------|------|
| 首次消息 | `codex exec` → 从 `thread.started` 捕获 `thread_id` |
| 后续消息 | `codex exec resume {thread_id}` 恢复上下文 |
| FLUSH | 清除 `thread_id` → 下次 spawn 新 thread |

### Dynamic persona tools（默认）

Codex 默认使用 `mcp_mode: dynamic`：Shell 在 `thread/start` 注册 persona task/cron 工具，Codex 调用工具时 App Server 发 `item/tool/call` 给 Shell runtime。该请求自带 `threadId`，Shell 用它作为 `source_session_id`，因此 Agent 不需要知道 session UUID，也不经 HTTP token 认证链路。

当前 dynamic 工具清单：

| 工具 | 说明 |
|------|------|
| `create_task` / `list_tasks` / `get_task` | 创建、列出、查询后台任务 |
| `create_cron_job` / `list_cron_jobs` | 创建、列出当前 workspace 的 cron jobs |
| `delete_cron_job` / `toggle_cron_job` | 删除、启停当前 workspace 可见的 cron job |


### App Server 长程线程编排

Codex App Server 的优势是 thread 可恢复、turn 可持续追加。Codex 官方 CLI 也支持恢复旧会话以保留 transcript、plan history 和 approvals；因此在 persona-shell 中，持续推进型自动化应优先复用长程 thread，而不是把每个小步骤都变成一次新的后台任务。

推荐模式：

- **Master thread**：持有 blueprint / checklist 的总控权，负责读取 workspace state、判断下一步、验收、checkpoint、合并。
- **Worker thread**：绑定一个 lane / worktree / cwd，长期推进该 lane；tick 到来时继续 `turn/start`，而不是重新创建临时 Codex 任务。
- **Cron tick**：只做“鞭子”，提醒 master/worker 推进；若目标 thread 或 lane 正在运行，tick 应跳过或记录 heartbeat，不应重入。
- **create_task**：只作为升级路径，用于大块、并行、隔离、可独立重试的任务。任务完成后用 `callback_codex_thread_id` 把结果注入回 master thread。

当前可用拼装件：

- `SessionBridge.sendCronMessage()` / `sendSystemMessage()`：向已有 session 发送提醒。
- `CodexThreadInjector`：通过 `thread/resume` 后执行 `thread/inject_items` 或 `turn/start`。
- `POST /api/codex/inject`：HTTP 方式向指定 Codex thread 注入消息。
- Dynamic persona tools：Codex 调用 `create_task` / `create_cron_job` 时，Shell 用 app-server 请求里的 `threadId` 自动补 `source_session_id`。

后续若需要强约束，应把上述拼装沉淀成 `continueCodexThread` 或 cron `codex_thread_tick` 原语，以系统层保证 no-overlap 和 source-thread 路由。

### CLI 工具注入（兼容）

将 Codex provider 配成 `mcp_mode: cli` 后，Shell 会在首轮 prompt 中注入 task CLI 用法，Codex 可通过 shell 命令调用任务系统：

```bash
SHELL_PORT=3000 PERSONA_DIR=~/.persona DIRECTOR_LABEL=main \
  bun run ~/.persona/../persona-shell/src/task/task-mcp-server.ts cli list_tasks '{"limit":20}'
```

这个模式不向 Codex 注册 MCP tools，仅作为兼容路径保留。

### MCP 工具注入（兼容）

将 Codex provider 配成 `mcp_mode: mcp` 后，Shell 通过 `-c` TOML 覆盖参数逐一注入。MCP server 通过 `PERSONA_SESSION_FILE` lazy read 获取当前 sessionId，避免启动时 env 为空或过期：

```bash
codex exec \
  -c 'mcp_servers."persona-tasks".command="bun"' \
  -c 'mcp_servers."persona-tasks".args=["run", "src/task-mcp-server.ts"]' \
  -c 'mcp_servers."persona-tasks".env={ SHELL_PORT = "3000" }' \
  ...
```

转换逻辑在 `persona-process.ts` 的 `buildCodexMcpOverrideArgs()` 中实现。

### App Server 模式（默认）

`type: codex-app-server` 使用 `codex app-server --listen stdio://` 作为长驻 JSON-RPC runtime。这是 Director 的默认模式。

如需为特定 Director 显式指定 app-server（与默认 `codex` 同名 provider 区分），可另起一个 provider 名：

```yaml
agents:
  providers:
    codex-custom:
      type: codex-app-server
      command: codex
      sandbox: workspace-write
      approval: on-request
      transport: stdio
      cwd: ~/github/jzlikewei/persona-shell
  defaults:
    director: codex-custom
```

关键行为：

| 能力 | 实现 |
|------|------|
| 流式输出 | 监听 `item/agentMessage/delta` 并转发为 bridge `chunk` |
| 多 turn | 首轮 `thread/start`，后续普通消息走 `turn/start` |
| active turn 追加用户消息 | 当前 turn 未完成时，新用户消息走 `turn/steer` + `expectedTurnId` |
| Skills | 通过 Codex 原生 `.agents/skills` 发现；初始化脚本维护 `~/.persona/.agents/skills -> ../skills` |
| session 持久化 | 保存 `thread.id`，重启 runtime 后优先 `thread/resume` |
| Codex app 可见性 | thread 写入 `threadSource=user`，并将 `sessionName` 同步到 `thread/name/set` |
| Dynamic persona tools | `mcp_mode: dynamic` 时在 `thread/start` 注册 task/cron 工具，runtime 响应 `item/tool/call` |
| 中断 | 优先 `turn/interrupt`，失败时退回进程信号 |

注意事项：

- `cwd` 可选；main Director 使用 provider `cwd`，默认回落到 `director.persona_dir`。pool runtime entry 会把 Codex cwd 设为当前群/话题的 workspace 目录：`~/.persona/workspaces/{workspace}/`，除非 workspace 表配置了真实项目 `cwd`。Codex app 按 workspace 精确过滤会话，查看某个群/话题会话时打开对应 workspace 目录或配置的项目目录。
- `turn/steer` 会改变当前 active turn，不产生独立 turn。Shell 会清理追加消息的队列项，最终回复仍归属原始 active turn。
- 当前实现采用每个 `SessionBridge` 一个 app-server 进程，优先保证群聊隔离；未来再评估多 thread 共享单进程。
- 初期审批策略建议继续使用 `approval: never` + 明确 sandbox，避免 JSON-RPC approval 回调阻塞。

### Codex app 复用 Persona 编排

Shell 写入 `~/.persona/.mcp.json` 时注册 `persona-tasks` MCP server。Claude Code 使用该 MCP 暴露 Persona 编排能力；Codex 仅在 `mcp_mode: mcp` 兼容模式下使用它：

| 工具 | 作用 |
|------|------|
| `persona_list` | 列出 `personas/*.md` 中可用人格 |
| `persona_prompt` | 返回 Codex `baseInstructions` / `developerInstructions` 注入包 |
| `persona_memory_read` / `persona_memory_write` | 读写 daily、memory、workspace、session 记忆文件 |
| `persona_delegate` | 按 persona-shell task 系统派发子角色任务 |
| `persona_session_link` | 绑定外部会话、persona session、Codex thread |

`persona_delegate` 会把 `parent_codex_thread_id`、`persona_session_id`、`channel`、`external_id` 写入 task `extra`。Codex 子任务 stdout 中的 `thread.started` 会被 TaskRunner 捕获为 `extra.codex_thread_id`，用于把 Codex app 当前 thread、persona session 和后台子任务 thread 串起来。

如需在后台任务完成/失败后，把通知作为一条“模拟用户消息”插回某个已有 Codex 会话，创建任务时传：

```json
{
  "callback_codex_thread_id": "thread_xxx",
  "callback_cwd": "/path/to/workspace"
}
```

Shell 会在 task `extra.codex_callback` 中记录该回调，任务进入终态后通过 `codex app-server` 执行 `thread/resume` + `turn/start`。也可以直接调用 Web Console API 手动插入：

```bash
curl -X POST http://127.0.0.1:3000/api/codex/inject \
  -H 'Content-Type: application/json' \
  -d '{"thread_id":"thread_xxx","text":"[TASK_DONE] ...","cwd":"/path/to/workspace"}'
```

Prompt 分层约定：

| 层级 | Persona 文件 | Codex 字段 |
|------|--------------|------------|
| 全局身份 | `soul.md` + `meta.md` | `baseInstructions` / Codex `instructions` |
| Agent 覆盖 | provider `system_prompt_file` | `developerInstructions` |
| 人格角色 | `personas/{role}.md` | `developerInstructions` |
| 用户任务 | 飞书/Web/Codex app 输入 | `turn/start.input` |

---

## Kimi

> 长驻 daemon 后端，基于 `kimi --print` 的 stream-json stdin/stdout 通信。支持 `--agent-file` 身份注入和 `--skills-dir` 技能加载。

### 身份注入

Kimi 的 print 模式通过 `--agent-file` 加载 agent 规范文件（YAML），其中可指定 `system_prompt_path`：

```yaml
# ~/.persona/kimi-agent.yaml
version: 1
agent:
  name: "Persona"
  system_prompt_path: ./soul.md
  tools: ["kimi_cli.tools.shell:Shell", ...]
```

同时支持 `--skills-dir` 加载外部 skills 目录：

```bash
kimi --print --agent-file ~/.persona/kimi-agent.yaml --skills-dir ~/.persona/skills
```

### 进程启动

```bash
kimi --print \
  --input-format stream-json \
  --output-format stream-json \
  --work-dir ~/.persona \
  --agent-file ~/.persona/kimi-agent.yaml \
  --skills-dir ~/.persona/skills \
  --mcp-config-file ~/.persona/.mcp.json
```

- **stdin** ← stream-json user messages（Shell 写入）
- **stdout** → stream-json assistant messages（Shell 读取）
- **stderr** → `kimi-stderr.log`
- `detached: true`，PID 直接追踪子进程

### CLI 参数

**公共参数**：

| 参数 | 说明 |
|------|------|
| `--print` | 非交互式 print 模式（隐式 `--yolo`） |
| `--work-dir` | 工作目录 |
| `--agent-file` | Agent 规范 YAML |
| `--skills-dir` | Skills 目录 |
| `--mcp-config-file` | MCP 配置文件 |
| `--model` | 指定模型 |
| `--session` | 恢复已有 session |

**Director（前台）专用**：

| 参数 | 说明 |
|------|------|
| `--input-format stream-json` | 接受 JSON 持续输入 |
| `--output-format stream-json` | JSON 行输出 |

**子角色（后台）专用**：

| 参数 | 说明 |
|------|------|
| `--prompt` | 一次性 prompt |

### stream-json 协议

Shell 与 Kimi 通过 stdin/stdout 交换 JSON 行。

**写入**（Shell → Kimi）：

```json
{"role":"user","content":"消息内容"}
```

**读取**（Kimi → Shell）：

```json
{"role":"assistant","content":[{"type":"think","think":"..."},{"type":"text","text":"..."}]}
```

| 消息类型 | 说明 | 用途 |
|----------|------|------|
| `assistant` (无 tool_calls) | 最终回复 | 构建回复文本，触发 onTurnComplete |
| `assistant` (含 tool_calls) | 中间步骤 | 忽略（内部工具调用） |
| Resume hint | 纯文本 | 捕获 session ID 用于恢复 |

### 会话恢复

| 场景 | 行为 |
|------|------|
| 首次启动 | 新 session |
| 重启/崩溃 | 从 resume hint 捕获 session ID → `--session` 恢复 |
| FLUSH | 不恢复 session，全新启动 |

### 与 Claude Code / Codex 的差异总结

| 维度 | Claude Code | Codex | Kimi |
|------|------------|-------|------|
| 运行模式 | 长驻 daemon | App Server（Director）/ 临时 App Server（任务） | 长驻 daemon |
| 通信方式 | FIFO named pipe | JSON-RPC stdio | stdin/stdout pipe |
| 流式输出 | ✅ stream_event | ✅ agentMessage/delta（Director）；任务以 `turn/completed` 收尾 | ⚠️ 整段 JSON 行（非 token 级） |
| 身份注入 | CLI 参数（plugin-dir 等） | App Server instructions / Codex 原生 instructions | `--agent-file` + `--skills-dir` |
| MCP 注入 | --mcp-config 文件 | -c TOML 覆盖 | `--mcp-config-file` |
| 会话恢复 | --resume session_id | exec resume thread_id | `--session` |
| Skills/Plugins | ✅ `.claude/skills` | ✅ `.agents/skills` | ✅ `--skills-dir` |
