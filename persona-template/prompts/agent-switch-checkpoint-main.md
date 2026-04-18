# Agent Switch Checkpoint Prompt（主 Director）

触发时机：主 Director 切换 agent 后端时，旧 agent 保存状态

模板变量：
- {current_agent} — 当前 agent 名称
- {target_agent} — 目标 agent 名称
- {state_path} — 状态文件路径

---

[FLUSH] 当前会话即将从 {current_agent} 切换到 {target_agent}。请先将当前工作状态保存到 {state_path}，包括：进行中的任务、待处理事项、关键上下文、切换后需要继续的动作。保存完成后回复"已保存"。
