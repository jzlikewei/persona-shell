# persona-shell web-v2

web-v2 是 persona-shell 的 React 工作台。它聚焦三件事:

- Chat:按 workspace/session 查看和发送消息,展示 streaming、tool events、Markdown 和附件。
- Tasks:查看后台任务、日志、结果和 Cron 摘要。
- Files:浏览 outbox、attachments、task results 等安全产物。

legacy Web Console 仍保留在 `/v1`。它覆盖 Runtime、Automations、Persona、Logs、Settings 等更完整的管理面。web-v2 当前不是 legacy UI 的全量替代品。

## 启动方式

从仓库根目录启动 shell:

```bash
bun run dev
```

shell 会在需要时构建或托管 web-v2。开发 web-v2 时可单独启动 Vite:

```bash
cd web-v2
bun install
bun run dev
```

常用验证:

```bash
cd web-v2
bun run build
```

仓库根目录的项目级检查:

```bash
bun run check
bun test
bun run smoke:web
```

## 运行配置

web-v2 通过 HTTP API 和 WebSocket 连接 persona-shell,不直接访问 SQLite 或日志文件。

- `VITE_API_BASE`:可选。默认使用当前 origin。
- `auth_token`:浏览器 localStorage 中保存的访问 token,由登录弹窗写入。

## 页面

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | Chat | workspace/session 消息、输入框、附件、tool 可视化 |
| `/tasks` | Tasks | 任务列表、筛选、日志、结果、Cron 摘要 |
| `/files` | Files | 安全文件树、文本/Markdown/图片预览 |
| `*` | NotFound | catch-all 页面 |

## 目录结构

```text
web-v2/
├── src/
│   ├── App.tsx
│   ├── layouts/root-layout.tsx
│   ├── pages/
│   │   ├── chat.tsx
│   │   ├── files.tsx
│   │   └── tasks/
│   ├── components/
│   ├── hooks/
│   └── lib/
├── __tests__/
├── BLUEPRINT.md
└── ARCHITECTURE.md
```

## 当前边界

web-v2 的原则是只保留真实接线的功能。没有稳定后端支撑、没有近期使用场景或只是占位的能力,不应该进入 v2。

当前暂不覆盖:

- Runtime 全量管理面
- Automations 全量创建/编辑/审计视图
- Persona memory/state/TODO 全量编辑器
- Logs / Observability / Settings 全量页面
- 真正的消息 cursor/offset 分页

这些能力要么保留在 `/v1`,要么等使用场景明确后再迁移。
