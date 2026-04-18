# 群 Director Bootstrap Prompt（有历史上下文）

触发时机：群 Director 新 session 启动时，有保存的会话状态

模板变量：
- {group_name} — 群名称
- {state_path} — 群状态文件路径
- {shared_note} — 运行环境提示（系统自动附加）

---

[系统] 新 session 已启动。你正在为群「{group_name}」服务。请先读取 {state_path} 恢复这个会话的上下文；如需全局状态，再参考 daily/state.md（只读）。{shared_note}
