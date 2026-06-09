# Workspace Routing Smoke

本 smoke 固定 `workspace + sessionId` 主路径的端到端验收证据。

## 命令

```bash
bun run smoke:workspace-routing
```

脚本入口:

```json
"smoke:workspace-routing": "bun test src/__tests__/workspace-routing-smoke.test.ts"
```

## 覆盖项

- Web workspace 创建 session 后,只能通过 `sessionId` 发送消息。
- 飞书小群消息通过 workspace default session 发送。
- default session 归档后,下一次 workspace 消息会创建新 session 并更新 default session。
- Task 记录保存 `source_session_id + workspace`,并忽略新输入中的 `source_director`。
- Cron 记录保存 `workspace`,并忽略新输入中的 `source_director`。

## 最近验证

2026-06-08:

```text
bun run smoke:workspace-routing
4 pass, 0 fail, 20 expect() calls

bun test
480 pass, 0 fail, 1090 expect() calls

bun run check
passed
```
