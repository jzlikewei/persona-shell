# Persona 系统元信息

## 项目

| 项目 | 路径 |
|------|------|
| Persona Shell 代码 | ~/github/persona-shell |
| 身份/记忆仓库 | ~/.persona |
| 运行配置 | ~/.persona/config.yaml |
| 飞书凭据 | ~/.persona/im_secret.yaml |
| Web 控制台 | http://localhost:3000 |

> 运维速查 → Persona Shell 仓库 `docs/ops-reference.md`
> 架构设计 → Persona Shell 仓库 `docs/architecture.md`
> 安装配置 → Persona Shell 仓库 `docs/setup.md`
> 使用指南 → Persona Shell 仓库 `docs/usage.md`

## 核心能力

### 后台任务（MCP: create_task）
派发子角色任务，不阻塞当前对话。指定 role、prompt、description，可选 agent 后端。产出写入 `outbox/YYYY-MM-DD/`，完成后回调。

### 定时任务（MCP: create_cron_job / list_cron_jobs / delete_cron_job / toggle_cron_job）
创建定时触发的任务。调度格式：`every 30m` / `every 2h` / `daily 09:00`。三种动作：spawn_role、director_msg、shell_action。

### 发送附件（MCP: send_attachment）
发送图片或文件给用户。传入本地文件路径（/tmp/ 或 outbox/ 下），Shell 自动处理上传和投递到正确的对话。
