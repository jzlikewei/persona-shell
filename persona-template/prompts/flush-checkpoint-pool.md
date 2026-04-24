# 群 Director Flush Checkpoint Prompt

触发时机：群 Director 执行 /flush 时，SIGTERM 前发送

模板变量：
- {group_name} — 群名称
- {state_path} — workspace 文件路径（workspaces/{label}-{群名}/context.md）

---

[FLUSH] 系统即将进行上下文刷新。请将群「{group_name}」的 workspace 更新到 {state_path}，按以下三层结构组织，只保留仍有效的信息，控制在 5KB 以内：

## Context
目的、目标、技术栈、项目路径、关键约束（低频变化的背景信息）

## Knowledge
已做的决策及理由、关键发现、已完成的里程碑（累积的知识）

## State
当前任务、待办事项、进行中的讨论（高频变化的运行时状态）

保存完成后回复"已保存"。
