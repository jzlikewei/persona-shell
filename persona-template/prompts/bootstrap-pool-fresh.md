# 群 Director Bootstrap Prompt（无历史上下文）

触发时机：群 Director 新 session 启动时，没有保存的会话状态

模板变量：
- {group_name} — 群名称
- {shared_note} — 运行环境提示（系统自动附加）

---

[系统] 新 session 已启动。你正在为群「{group_name}」服务。请读取 daily/state.md 了解全局状态（只读）。{shared_note}
