# Contributing to Persona Shell

感谢你对 Persona Shell 的关注！欢迎提交 Issue 和 Pull Request。

## 开发环境

```bash
# 前置要求
# - Bun >= 1.0
# - TypeScript >= 5.7
# - Claude Code CLI (用于端到端测试)

# 克隆并安装
git clone https://github.com/jzlikewei/persona-shell.git
cd persona-shell
bun install

# 类型检查
bun run check

# 开发模式运行
cp config.example.yaml ~/.persona/config.yaml
# 编辑 config.yaml 填入飞书凭据
bun run dev
```

## 提交 Pull Request

1. Fork 本仓库
2. 从 `main` 创建特性分支：`git checkout -b feat/your-feature`
3. 编写代码，确保 `bun run check` 通过
4. 提交（commit 规范见下方）
5. 推送到你的 fork 并创建 PR

### Commit 规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新增功能
fix: 修复 bug
docs: 文档变更
refactor: 重构（不改变行为）
chore: 构建/工具链变更
```

消息语言不限（中文或英文均可），保持简洁清晰即可。

## 项目结构

```
src/
├── index.ts             # 入口，编排层
├── feishu.ts            # 飞书 WebSocket 客户端
├── messaging.ts         # MessagingClient 接口
├── messaging-router.ts  # 多渠道路由
├── director.ts          # Director 进程管理 + named pipe + FLUSH
├── director-pool.ts     # 多 Director 实例管理（群聊）
├── queue.ts             # 消息队列
├── console.ts           # Web 控制台 + API
├── config.ts            # 配置加载
└── public/              # Web 控制台前端
```

详细架构说明见 `docs/architecture.md`。

## 代码风格

- TypeScript strict mode
- 使用 Bun 原生 API（文件 I/O、子进程、SQLite）
- 错误处理：关键路径用 try-catch，非关键路径用 `.catch()` 记日志
- 不引入非必要依赖——当前只有 2 个运行时依赖，请保持精简

## 报告 Bug

请使用 [GitHub Issues](https://github.com/jzlikewei/persona-shell/issues) 提交，包含：

- 复现步骤
- 期望行为 vs 实际行为
- 运行环境（OS、Bun 版本、Claude Code 版本）
- 相关日志（见 README 中日志路径说明）

## 安全漏洞

请勿在 Issue 中公开安全漏洞，详见 [SECURITY.md](SECURITY.md)。
