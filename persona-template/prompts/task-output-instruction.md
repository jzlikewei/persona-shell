# 任务产出系统指令

触发时机：后台任务 spawn 时附加在 prompt 末尾

模板变量：
- {output_path} — 产出文件路径
- {task_id} — 任务 ID
- {description} — 任务描述
- {desc_header} — 描述头部指令（description 为空时为空字符串）

---

[系统指令] 将输出结果保存到 {output_path}。{desc_header}完成后只回复"done"，不要输出总结。
