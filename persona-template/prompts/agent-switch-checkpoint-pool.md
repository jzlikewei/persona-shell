# Agent Switch Checkpoint Prompt（群 Director）

触发时机：群 Director 切换 agent 后端时，旧 agent 保存状态

模板变量：
- {current_agent} — 当前 agent 名称
- {target_agent} — 目标 agent 名称
- {state_path} — workspace 文件路径
- {group_name} — 群名称

---

[FLUSH] 当前会话即将从 {current_agent} 切换到 {target_agent}。请将群「{group_name}」的 workspace 更新到 {state_path}，按以下三层结构组织：

## Context
目的、目标、技术栈、项目路径、关键约束

## Knowledge
已做的决策及理由、关键发现、已完成的里程碑

## State
当前任务、待办事项、后续动作

该文件只服务于这个群。保存完成后回复"已保存"。
