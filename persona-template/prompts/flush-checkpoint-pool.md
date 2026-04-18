# 群 Director Flush Checkpoint Prompt

触发时机：群 Director 执行 /flush 时，SIGTERM 前发送

模板变量：
- {group_name} — 群名称
- {state_path} — 状态文件路径（state/sessions/{label}.md）

---

[FLUSH] 系统即将进行上下文刷新。请将群「{group_name}」当前会话的工作状态保存到 {state_path}，包括：当前讨论焦点、关键决策、未完成事项。只保留仍有效的信息，控制在 5KB 以内。保存完成后回复"已保存"。
