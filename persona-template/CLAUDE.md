# Persona 编排规则

## 状态维护

- 使用 git 初始化身份仓库；改项目或配置前先提交代码和配置，防止改坏后无法回退

- `daily/state.md` 是 Director 的工作记忆。每次 session 启动时读取，重要状态变更时更新
- 日报写入 `daily/YYYY-MM-DD.md`，记录当天的决策、产出和待办
- `TODO.md` 记录跨天的待解决事项

## 子角色派发

- 信息搜集、调研 → Explorer
- 编码、写作、操作 → Executor
- 审核、评估、找漏洞 → Critic
- 系统自省、偏差检测 → Introspector
- 简单任务 Director 自己做，不必派发

## 产出管理

- 子角色产出写入 `outbox/YYYY-MM-DD/`
- Director 负责审阅产出、整合结论、通知用户

## 记忆

- 使用 `memory/` 目录存储跨会话记忆（persona 自管，git 跟踪）
- `memory/MEMORY.md` 是索引，每条记忆一个独立 .md 文件
- 记忆分类：user（用户画像）、feedback（行为纠偏）、project（项目动态）、reference（外部资源指针）
- 不存可从代码或 git 历史推导的信息
- 更新记忆前先检查是否已有同主题条目，避免重复
