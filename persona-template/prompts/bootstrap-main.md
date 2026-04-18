# 主 Director Bootstrap Prompt

触发时机：主 Director 新 session 启动时（非 flush）

模板变量：
- {state_path} — 状态文件路径（默认 daily/state.md）
- {shared_note} — 运行环境提示（系统自动附加）

---

[系统] 新 session 已启动。请读取 {state_path} 恢复工作上下文，了解当前待处理事项。{shared_note}
