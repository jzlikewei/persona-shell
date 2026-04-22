# Agent 后端

Persona Shell 不直接调用 LLM API，而是将 CLI agent 作为子进程运行。当前支持两个后端，通过统一的三层架构（SessionBridge → Adapter → Runtime）接入。

---

## Claude Code

> 主力后端。长驻 daemon 进程，FIFO 管道双向通信，stream-json 实时流式输出。

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
├── skills/                         通过 .claude/skills 软链接自动发现
│   ├── code-review/
│   ├── feature-dev/
│   └── ...
└── daily/state.md                  Bootstrap 时由 Director 主动读取
```

- `CLAUDE.md` 通过 `--add-dir ~/.persona` 自动发现加载
- `soul.md`、`meta.md` 通过 `--append-system-prompt-file` 追加到系统提示末尾
- `skills/` 通过 `.claude/skills` → `skills` 软链接被 Claude Code 自动发现（`--add-dir` 会扫描 `.claude/` 子目录）

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

> 典型主 Director 有 50+ 个参数（取决于 skill 数量）。

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

> 后台任务 + 群聊 Director 后端。按 turn spawn 进程，JSON 输出，session resume 保持上下文。

### 运行模式

与 Claude Code 的长驻 daemon 不同，Codex 采用 **turn-based** 模式：

1. 每条消息 spawn 一个 `codex exec` 子进程
2. 进程执行完毕后退出
3. 下一条消息通过 `codex exec resume {thread_id}` 恢复上下文

优势：无需维护长连接，进程管理简单，适合并行群聊场景。

### 身份注入

Codex 不支持 Claude Code 的 `--plugin-dir` / `--append-system-prompt-file` 参数。身份注入通过以下方式：

- `--cd ~/.persona`：设置工作目录，Codex 会自动读取 CLAUDE.md
- **Prompt 拼接**（后台任务）：`buildCodexPrompt()` 将 `soul.md`、`meta.md`、`personas/{role}.md` 的内容拼接到 prompt 前部
- **MCP 工具**：通过 `-c mcp_servers.*` TOML 覆盖参数注入（从 `.mcp.json` 转换）

### 进程启动

```bash
# 新会话
codex exec --json --skip-git-repo-check --cd ~/.persona "prompt"

# 恢复会话
codex exec resume {thread_id} --json --skip-git-repo-check --cd ~/.persona "prompt"
```

- `detached: true`，stdout pipe 读取 JSON 输出
- 进程结束后释放资源，不占用后台

### CLI 参数

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
| `-c mcp_servers.*` | MCP 服务器 TOML 覆盖 |

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

### MCP 工具注入

Codex 不支持 `--mcp-config` 文件，Shell 通过 `-c` TOML 覆盖参数逐一注入：

```bash
codex exec \
  -c 'mcp_servers."persona-tasks".command="bun"' \
  -c 'mcp_servers."persona-tasks".args=["run", "src/task-mcp-server.ts"]' \
  -c 'mcp_servers."persona-tasks".env={ SHELL_PORT = "3000" }' \
  ...
```

转换逻辑在 `persona-process.ts` 的 `buildCodexMcpOverrideArgs()` 中实现。

### 与 Claude Code 的差异总结

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 运行模式 | 长驻 daemon | 按 turn spawn |
| 通信方式 | FIFO named pipe | stdout pipe |
| 流式输出 | ✅ stream_event | ❌ 整段返回 |
| 身份注入 | CLI 参数（plugin-dir 等） | Prompt 拼接 + --cd |
| MCP 注入 | --mcp-config 文件 | -c TOML 覆盖 |
| 会话恢复 | --resume session_id | exec resume thread_id |
| Skills/Plugins | ✅ 原生支持 | ❌ 不支持 |
