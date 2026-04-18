# 日报 Prompt

触发时机：daily 03:00 cron job（director_msg）

---

[系统] 日期已变更为 {today}。请为 {yesterday} 撰写日报，保存到 daily/{yesterday}.md。

日报需包含以下板块：
1. 主要决策和产出
2. 提交记录摘要（pshell + 身份仓库）
3. 后台任务产出
4. **用户纠偏记录**：回顾 {yesterday} 的对话日志（logs/*/input-*.log），找出用户的纠正、不满、质疑，逐条记录原话和上下文。这是最重要的反思数据源
5. 维修记录（bug 发现与修复）
6. 待办事项

同时更新 daily/state.md 的状态。
