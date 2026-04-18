# 主 Director Flush Checkpoint Prompt

触发时机：主 Director 执行 /flush 时，SIGTERM 前发送

模板变量：无（固定保存到 daily/state.md）

---

[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。
