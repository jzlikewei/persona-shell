# Agent Switch Checkpoint Prompt（群 Director）

触发时机：群 Director 切换 agent 后端时，旧 agent 保存状态

模板变量：
- {current_agent} — 当前 agent 名称
- {target_agent} — 目标 agent 名称
- {state_path} — 状态文件路径
- {group_name} — 群名称

---

[FLUSH] 当前会话即将从 {current_agent} 切换到 {target_agent}。请把群「{group_name}」当前会话的上下文保存到 {state_path}，包括：讨论目标、当前结论、未完成事项、后续动作。该文件只服务于这个会话。保存完成后回复"已保存"。
