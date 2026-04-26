# 安装与配置

## 前置条件

- macOS (Apple Silicon)（Linux 理论可用但未验证，Windows 不支持）
- [Bun](https://bun.sh/) 运行时
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（必需）
- [Codex CLI](https://github.com/openai/codex)（可选，用于多后端支持）
- [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/)（可选，用于多后端支持）

## 快速开始

```bash
git clone https://github.com/jzlikewei/persona-shell.git
cd persona-shell

# 一键初始化（安装依赖 + 创建身份仓库 + 配置飞书凭据）
bun run init

# 自定义你的分身（可选，推荐）
cd ~/.persona && claude /soul-crafting

# 启动
bun run dev
```

## 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，创建一个企业自建应用
2. **开启机器人能力**：应用能力 → 添加应用能力 → 机器人
3. **添加权限**（权限管理 → API 权限）：

   | 权限标识 | 说明 | 用途 |
   |----------|------|------|
   | `im:message:send_as_bot` | 以应用的身份发消息 | 发送消息（必需） |
   | `im:message:readonly` | 获取单聊、群组消息 | 接收和读取消息（必需） |
   | `im:chat:readonly` | 获取群信息 | 获取群名称和成员数（必需） |
   | `im:resource` | 上传图片和文件 | 发送图片/文件附件 |
   | `im:message.reactions:read` | 查看消息表情回复 | 读取 emoji 反应 |
   | `im:message.reactions:write_only` | 发送、删除消息表情回复 | 添加 emoji 反应 |
   | `im:message.pins:read` | 查看 Pin 消息 | 读取置顶消息 |
   | `im:message.pins:write_only` | 添加、取消 Pin 消息 | 管理置顶消息 |
   | `im:message:recall` | 撤回消息 | 撤回已发送的消息 |

4. **事件订阅**：事件与回调 → 事件配置 → 添加 `im.message.receive_v1`（接收消息）
   - ⚠️ **消息接收模式**：务必选择「**接收群中所有消息**」而非「仅接收 @机器人 的消息」，否则小群中不 @ 机器人就无法触发回复
5. **连接方式选择 WebSocket**：事件与回调 → 使用长连接接收事件（非 Webhook）
6. **发布应用**：版本管理与发布 → 创建版本 → 申请发布
7. 复制 **App ID** 和 **App Secret** 到 `~/.persona/im_secret.yaml`

> 已经配置过？直接从[开放平台控制台](https://open.feishu.cn/app)复制凭据即可，确保权限和事件订阅配齐。

## 配置文件

配置文件位于 `~/.persona/config.yaml`，飞书凭据位于 `~/.persona/im_secret.yaml`（均不在项目目录内，避免密钥泄露）。

> **时区**：日志时间戳、日报触发、Cron 调度等全部使用 `Asia/Shanghai`。当前不可配置。

```yaml
agents:
  defaults:
    default: "claude"
    director: "claude"
  roles:                              # 按角色指定 agent 和 model（可选）
    explorer:
      agent: "claude"
      model: "sonnet"                 # 覆盖 provider 默认 model
    executor:
      agent: "claude"
    critic:
      agent: "claude"
    book-researcher:
      agent: "codex"
  providers:
    claude:
      type: "claude"
      command: "claude"
      bare: false                 # false = 完整工具集（含 Agent）; true = --bare（仅 Bash/Edit/Read）
      dangerously_skip_permissions: true
      effort: "max"
    codex:
      type: "codex"
      command: "codex"
      sandbox: "danger-full-access"
      approval: "never"
      search: false
    kimi:
      type: "kimi"
      command: "kimi"
      # agent_file: "kimi-agent.yaml"       # Kimi agent 规范文件（相对 persona_dir）
      # skills_dir: "skills"                # Skills 目录（相对 persona_dir）
      # mcp_config_file: ".mcp.json"        # MCP 配置文件（相对 persona_dir）

feishu:
  master_id: "ou_xxxx"                       # 本体的飞书 open_id（可选）

director:
  persona_dir: "~/.persona"               # 身份/记忆仓库路径
  pipe_dir: "/tmp/persona"                # named pipe 存放
  pid_file: "/tmp/persona/director.pid"
  time_sync_interval_hours: 2             # 时间同步注入间隔（小时）
  flush_context_limit: 700000             # 上下文 token 阈值，超过自动 flush
  flush_interval_days: 7                  # 距上次 flush 最大天数
  quote_max_length: 200                   # 引用消息截断长度

console:
  enabled: true
  port: 3000

pool:
  max_directors: 5              # 最大并发 Director 数
  idle_timeout_minutes: 30      # 空闲超时回收
  small_group_threshold: 5      # 大群/小群人数分界
  parallel_chat_ids: []         # 免 @mention 白名单（chat_id 列表）
```

**Agent 解析优先级**：`roles[role].agent` → `defaults[role]` → `defaults.default` → `"claude"`

**Model 解析优先级**：`roles[role].model` → `providers[agent].model` → 不传（用 CLI 默认）

**热加载**：修改 `roles` / `providers` 后，新派发的子角色任务和新创建的群聊 Director 会自动使用新配置，无需重启 Shell。主 Director 需要 `/session-restart` 才会生效。

`~/.persona/im_secret.yaml`（飞书凭据放在一起维护）：

```yaml
feishu:
  app_id: "cli_xxxx"
  app_secret: "xxxx"
```

## 服务化（launchd）

```bash
# 安装并启动（自动生成 plist，路径从项目目录推断）
bun run install-service

# 管理
launchctl start com.persona.shell
launchctl stop  com.persona.shell

# 卸载
bun run uninstall-service
```

如果服务模式下需要让 Codex 继承 GitHub 凭据，不要只在当前终端 `export`，而是写到 `~/.persona/service.env`：

```bash
cat >> ~/.persona/service.env <<'EOF'
export GH_TOKEN=ghp_xxx
# 或者：export GITHUB_TOKEN=ghp_xxx
EOF

launchctl stop com.persona.shell
launchctl start com.persona.shell
```

`start.sh` 会在 launchd 启动时额外 `source ~/.persona/service.env`，这样 `persona-shell` 以及它再拉起的 Codex 子进程都能继承到同一份 token。

## 身份仓库

`bun run init` 会在 `~/.persona/` 创建身份仓库。建议用独立的 git 仓库维护，和日常项目代码隔离。

```
~/.persona/                    # 身份仓库（独立 git，AI 可读写）
├── soul.md                      # 灵魂：性格、价值观、行为边界
├── meta.md                      # 运维指令
├── CLAUDE.md                    # 项目级指令（Claude Code 自动加载）
├── personas/                    # 角色人格
│   ├── director.md                # 主分身人格
│   ├── explorer.md                # 研究员角色
│   └── critic.md                  # 审查员角色
├── skills/                      # 技能（= Claude Code plugin）
├── prompts/                     # 系统 prompt 模板，可自定义以覆盖默认行为
├── memory/                      # 跨会话记忆
├── daily/                       # 日报 + 工作记忆
│   ├── state.md                   # FLUSH checkpoint
│   └── 2026-04-13.md              # 日报
└── config.yaml                  # 运行配置
```

这些文件通过 CLI 参数在启动时注入 Claude Code（`--append-system-prompt-file`、`--plugin-dir`、`--add-dir`）。Kimi 则通过 `--agent-file` 加载 agent 规范来注入身份。详见 [`agent-backends.md`](agent-backends.md)。

### Agent Provider 配置说明

**Claude Code**：

| 参数 | 说明 |
|------|------|
| `bare` | `true` 时加 `--bare` 参数，去掉默认系统提示并限制工具集为 Bash/Edit/Read；`false` 时不加，保留完整工具集（约 30 个），包括 Agent（spawn sub-agent）等高级工具。**推荐 `false`**，以获得完整能力。 |
| `dangerously_skip_permissions` | 跳过工具执行确认 |
| `effort` | 推理力度：`min` / `low` / `medium` / `high` / `max` |

**Kimi**：

| 参数 | 说明 |
|------|------|
| `agent_file` | Agent 规范 YAML 文件路径（相对 `persona_dir`），指定 `system_prompt_path` 等 |
| `skills_dir` | Skills 目录路径（相对 `persona_dir`），Kimi 通过 `--skills-dir` 加载 |
| `mcp_config_file` | MCP 配置文件路径（相对 `persona_dir`），通过 `--mcp-config-file` 传入 |

> **环境变量**：子角色进程启动时会自动清除继承的 `CLAUDE_CODE_SIMPLE` 环境变量，不再受父进程的工具集限制。无需手动处理。

## 常见问题（FAQ）

### 群聊中必须 @机器人 才能回复

飞书开放平台默认只推送 @机器人 的群消息。即使代码中有小群免 @ 逻辑，如果平台不推送消息，代码层面也收不到。

**解决方法**：飞书开放平台 → 你的应用 → 事件与回调 → 事件配置 → `im.message.receive_v1` → 将消息接收模式改为「**接收群中所有消息**」。

### 权限不足导致功能异常

如果出现发消息失败、无法获取群信息、无法添加表情回复等问题，请检查飞书应用的 API 权限是否全部开通（参见上方权限列表）。添加权限后需要**重新发布应用版本**才能生效。

### 飞书 WebSocket 断连

Shell 内置了 watchdog 机制，断连超过 2 分钟且飞书 API 可达时会自动重启进程。如果使用 launchd 服务化部署，进程退出后会自动拉起。持续断连通常是网络问题，检查代理配置（飞书域名应在 `no_proxy` 列表中）。

### 自定义 Skills 未被 Claude Code 加载

`skills/` 目录下的自定义 Skill（如 abstract-dog-style、code-review、browser-harness 等）没有被 Claude Code 发现和加载。这是因为 Claude Code 只会自动扫描 `--add-dir` 指定目录下的 `.claude/` 子目录来发现 plugins/skills。

**解决方法**：确保身份仓库中存在软链接 `~/.persona/.claude/skills` → `~/.persona/skills`。`bun run init` 会自动创建此软链接。如果是已有身份仓库缺少此链接，手动执行：

```bash
mkdir -p ~/.persona/.claude
ln -sf ../skills ~/.persona/.claude/skills
```
