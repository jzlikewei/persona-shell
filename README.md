# Persona Shell

[![Test](https://github.com/jzlikewei/persona-shell/actions/workflows/test.yml/badge.svg)](https://github.com/jzlikewei/persona-shell/actions/workflows/test.yml)

> 把你最顺手的 agent 当虾养。

你精心维护的 prompt 才是核心资产。Persona Shell 不造 agent，只让现成的 agent（Claude Code、Codex）用你的 prompt 来干活——接入 IM、7×24 替你在线。你只需要把 Markdown 写好。

不知道怎么用？clone 下来，让你的 agent 来读。

> **⚠️ 早期项目**：仅在 macOS (Apple Silicon) 上开发和日常使用。Linux 理论可用但未验证，Windows 不支持（依赖 named pipe / mkfifo）。

> **⚠️ 安全提示**：Persona Shell 以 `--dangerously-skip-permissions` 模式运行 Claude Code，即 AI 可以无需确认地执行 shell 命令、读写文件。仅在你信任的机器上运行，不要暴露到公网。详见 [安装指南](docs/setup.md)。

## TL;DR

外挂IM，让Agent用你精心维护的prompt干活、并行干，后台干、定时干、用不同身份干。

## 设计理念

- **不重复造轮子** — agent 的推理、工具调用、代码能力已经被 Claude Code / Codex 做好了，Persona Shell 不重新实现这些，只做编排和消息转发
- **Prompt 是你的核心资产** — soul.md（人格）、personas/（角色）、prompts/（系统行为模板）、memory/（记忆）—— 全部是 Markdown，你用 git 管理、精心迭代，这才是你的 AI 分身区别于别人的地方
- **持久运行，自动刷新** — daemon 模式 + 自动上下文刷新（FLUSH），你维护的 prompt 和记忆会被持久保存，跨会话生效，不怕 context window 耗尽
- **多实例，多后端** — 主分身 + 群聊 Director Pool，并行任务、后台任务、定时任务；同一套 prompt 可以被不同 agent 后端使用

## 支持的 Agent 后端

| Agent | 状态 |
|-------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ 主力后端 |
| [Codex](https://github.com/openai/codex) | ✅ 后台任务 + 群聊 Director |
| [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/) | ✅ 长驻 Director + 后台任务 |

完整功能矩阵和详细用法见 [使用指南](docs/usage.md)。

## 效果展示

通过飞书和你的 agent 分身对话：
![飞书会话](docs/feishu-chats.png)

agent 自主产出结构化日报和工作记录：
![日报](docs/daily-md.png)

Web 控制台查看运行状态：
![Web 控制台](docs/webui-screenshot.png)

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

需要先创建飞书应用，详见 [安装指南](docs/setup.md)。

## 身份仓库结构

你的 prompt 资产存放在 `~/.persona/`，由 git 管理：

```
~/.persona/
├── soul.md              # 人格定义 — 你的 AI 分身是谁
├── personas/            # 角色 — 不同场景下的行为模式
├── prompts/             # 系统行为模板 — 编排指令
├── memory/              # 记忆 — 跨会话持久保存
├── daily/               # 日报与工作记忆
├── TODO.md              # 待办事项
└── config.yaml          # 运行配置
```

## 架构概览

```
IM 消息 → TS Shell → MessageQueue → SessionBridge (主 Director)
              │                         │
              │                    ┌────┴────┐
              │                    │ Adapter  │ ← Claude / Codex 协议适配
              │                    │ Runtime  │ ← 进程生命周期
              │                    └─────────┘
              │
              │  群聊 → DirectorPool ─→ SessionBridge (群1, 群2, ...)
              │
              └── Web Console (localhost:3000)
```

技术细节见 [架构文档](docs/architecture.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [安装与配置](docs/setup.md) | 飞书应用创建、配置文件、服务化、身份仓库 |
| [使用指南](docs/usage.md) | 命令、群聊策略、任务、Cron、Web 控制台、人格自定义 |
| [技术架构](docs/architecture.md) | 三层架构、通讯层、消息路由、FLUSH、进程容灾 |
| [Agent 后端](docs/agent-backends.md) | Claude Code / Codex 启动机制、协议、参数、会话恢复 |
| [运维速查](docs/ops-reference.md) | 命令、日志路径、运行时文件 |

## License

[MIT](LICENSE)
