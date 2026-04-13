# Claude Code 启动细节

Persona Shell 不直接调用 Anthropic API，而是将 **Claude Code CLI** 作为子进程运行，通过 FIFO named pipe 双向通信实现长驻会话。

## 身份注入：从 `~/.persona` 到 CLI 参数

Shell 启动 Claude Code 时，会将用户自维护的身份仓库（`~/.persona/`）中的文件通过 CLI 参数注入。这是让 Claude Code "变成"你的分身的核心机制。

### 注入路径

```
~/.persona/                         注入方式                    Claude Code 中的效果
├── CLAUDE.md                       --add-dir（自动加载）        作为项目级指令加载
├── soul.md                         --append-system-prompt-file  追加到系统提示（灵魂层人格）
├── meta.md                         --append-system-prompt-file  追加到系统提示（运维指令）
├── personas/                       --plugin-dir                 作为 plugin 目录加载
│   ├── director.md                 --append-system-prompt-file  角色人格（按 role 参数选择）
│   ├── explorer.md                 （子角色任务时注入）
│   ├── critic.md
│   └── ...
├── skills/                         每个子目录 → --plugin-dir
│   ├── code-review/                → --plugin-dir ~/.persona/skills/code-review
│   ├── feature-dev/                → --plugin-dir ~/.persona/skills/feature-dev
│   ├── soul-crafting/              → --plugin-dir ~/.persona/skills/soul-crafting
│   └── ...
└── daily/state.md                  Bootstrap 时由 Director 主动读取
```

**关键点**：

- `CLAUDE.md` 通过 `--add-dir ~/.persona` 自动被 Claude Code 发现并加载，不需要显式 `--append-system-prompt-file`
- `soul.md` 和 `meta.md` 通过 `--append-system-prompt-file` 追加到系统提示的末尾，优先级高于 CLAUDE.md
- `personas/` 整个目录作为 plugin 加载，其中角色文件（如 `director.md`）再通过 `--append-system-prompt-file` 单独注入
- `skills/` 下每个子目录独立作为 plugin 注入——这意味着 skill 可以包含 Claude Code plugin 的完整结构（commands/、agents/、hooks/、SKILL.md 等）
- `daily/state.md` 不通过 CLI 参数注入，而是在 bootstrap 消息中指示 Director 主动读取

### Skill 结构

每个 skill 目录就是一个标准的 [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins)：

```
skills/feature-dev/           # 一个 skill = 一个 Claude Code plugin
├── README.md                   # plugin 清单
├── commands/                   # slash command 定义
│   └── feature-dev.md
└── agents/                     # subagent 定义
    ├── code-explorer.md
    ├── code-architect.md
    └── code-reviewer.md

skills/research-cron-builder/  # Cron 任务模板 skill
├── SKILL.md                    # skill 定义
└── references/                 # 参考文档
```

用户可以自由增删 `skills/` 下的目录来扩展 Director 的能力，重启后自动生效。

## 进程启动方式

```bash
sh -c 'claude [args] < /tmp/persona/director-in > /tmp/persona/director-out'
```

- **stdin** ← FIFO 管道 `director-in`（Shell 写入用户消息）
- **stdout** → FIFO 管道 `director-out`（Shell 读取 AI 响应）
- **stderr** → 重定向到 `director-stderr.log`
- 进程 `detached: true`，PID 记录在 `director.pid`

## CLI 参数总表

参数由 `persona-process.ts` 分三层构建（`buildCommonArgs` → `buildRoleArgs` → mode-specific）：

### 公共参数

| 参数 | 说明 |
|------|------|
| `--print` | 输出到 stdout（非交互模式） |
| `--output-format stream-json` | 逐事件 JSON 输出协议 |
| `--verbose` | 启用详细事件输出 |
| `--dangerously-skip-permissions` | 跳过工具调用确认 |
| `--add-dir ~/.persona` | 身份仓库加入上下文（CLAUDE.md 自动加载） |
| `--plugin-dir ~/.persona/personas` | 人格目录 |
| `--append-system-prompt-file soul.md` | 灵魂层人格（条件：文件存在） |
| `--append-system-prompt-file meta.md` | 运维指令（条件：文件存在） |
| `--plugin-dir ~/.persona/skills/{name}` | 每个 skill 子目录（动态枚举） |
| `--append-system-prompt-file personas/{role}.md` | 角色人格（条件：文件存在） |

### Director（前台）专用

| 参数 | 说明 |
|------|------|
| `--input-format stream-json` | 接受 JSON 格式持续输入 |
| `--bare` | 精简输出 |
| `--effort max` | 最大推理强度 |
| `--include-partial-messages` | token 级流式输出 |
| `--mcp-config ~/.persona/.mcp.json` | MCP 工具配置 |
| `--resume {sessionId}` | 恢复已有会话（非首次启动） |
| `--name director-{label}-{datetime}` | 会话显示名称 |

### 子角色（后台任务）专用

| 参数 | 说明 |
|------|------|
| `--bare` | 精简输出 |
| `-p {prompt}` | 一次性 prompt，执行完退出 |

> 典型主 Director 有 **50+ 个参数**（取决于 skill 数量）。可在 Web 控制台 Task 详情的 Spawn Args 折叠区查看。

## stream-json 通信协议

Shell 与 Claude Code 通过 FIFO 管道交换 JSON 行（每行一个事件）。

**写入**（Shell → Claude）：

```json
{"type":"user","message":{"role":"user","content":"用户消息内容"}}
```

**读取**（Claude → Shell）：

| 事件类型 | 说明 | 用途 |
|----------|------|------|
| `system` | 会话初始化 | 捕获 `session_id` 用于 `--resume` |
| `stream_event` | token 级增量 | 驱动 WebSocket 流式显示，**不写日志** |
| `assistant` | 完整助手消息 | 构建 `currentResponse` 用于回复分发 |
| `result` | 轮次结束 | 触发回复、指标收集、队列推进 |

## 会话恢复

| 场景 | 行为 |
|------|------|
| **首次启动** | 不带 `--resume`，从 `system.init` 捕获 `session_id` 持久化到 `/tmp/persona/director-session` |
| **重启/崩溃** | 读取已保存的 `session_id` → `--resume` 重新 spawn → Claude Code 恢复上下文 |
| **FLUSH** | 清除 session 文件 → 全新 session → bootstrap 从 `daily/state.md` 恢复工作记忆 |
| **Session 过期** | Claude Code 返回 "No conversation found" → 清除 session → 降级为全新启动 |
