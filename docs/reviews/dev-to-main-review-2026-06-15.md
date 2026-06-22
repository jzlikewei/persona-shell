# dev → main 全量审查报告

生成时间：2026-06-15 16:00:07 +0800
分支：dev
范围：main..dev
merge-base：003c4e06125d3a1a2928d7ae47544b2899b5d7a9
提交数：138

## 结论

`dev` 可以作为个人项目进入 `main`，前提是接受本轮变更带来的 breaking changes：旧 Web 控制台被 web-v2 替换，workspace/session 路由模型切换到 DB SSOT，旧 codex CLI adapter 被 codex app-server 路径取代。

本次审查没有发现会阻断合并的编译、测试或明显启动级错误。发现 3 个合并前建议处理项，其中 1 个是中风险安全边界问题，2 个是低风险工程卫生/运维风险。


## 修复状态

生成报告后的合并前修复：

| 项 | 状态 | 处理 |
|---|---:|---|
| M1 `/api/files/tree/read` 任意 root | 已修复 | root/path 收敛到允许列表：当前仓库、`persona_dir`、agent provider cwd、DB workspace cwd |
| L1 `bun test` 扫描 `dist/__tests__` | 已修复 | `package.json` 增加显式 `test` 脚本：`bun test src/__tests__ web-v2/__tests__` |
| L2 启动时自动 rsync 部署 | 已修复 | 删除 `ensureWebV2Dist` 的 `.deploy.env` / `rsync --delete` 启动副作用，远程同步改为文档里的手动运维步骤 |

修复后新增验证：

| 检查 | 结果 | 备注 |
|---|---:|---|
| `bun run check` | 通过 | `tsc --noEmit` + no-any guard |
| `bun run --cwd web-v2 build` | 通过 | Vite 构建成功，单 chunk 815KB 警告仍存在 |
| `bun run test` | 通过 | 495 pass / 0 fail；测试脚本只扫描 `src/__tests__` 与 `web-v2/__tests__` |

## 审查范围

- 对比范围：`main..dev`
- `dev` 领先 `main`：138 commits
- 文件规模：174 个文件变更，约 `+32366 / -6420`
- 主要模块：
  - `web-v2/` 新控制台
  - `SessionBridge` / `AgentRuntimePool` / `SessionManager`
  - `codex-app-server` runtime 与 dynamic tools
  - workspace/session/task/cron DB SSOT
  - Feishu streaming card、配置卡片、附件传递
  - task runner、shell action、cron routing
  - transcript/log parser 与审计/诊断接口

## 验证结果

| 检查 | 结果 | 备注 |
|---|---:|---|
| `bun run check` | 通过 | `tsc --noEmit` + no-any guard |
| `bun test src/__tests__ web-v2/__tests__` | 通过 | 494 pass / 0 fail |
| `bun test` | 通过 | 941 pass / 0 fail；会同时扫到 `dist/__tests__`，属于重复执行 |
| `bun install --cwd web-v2 --frozen-lockfile` | 通过 | lockfile 一致 |
| `bun run --cwd web-v2 build` | 通过 | Vite 构建成功，单 chunk 815KB 警告 |
| `git diff --check` | 通过 | 最近修复阶段已验证，无 whitespace error |

## 主要架构变化评价

### 1. Session / Workspace SSOT

`SessionManager` 把 workspace/session 路由从 runtime label 和 chatId 中抽出来，改为 `sessionId → routingKey` 的显式映射；DB 中 `workspaces.default_session_id` 成为业务默认 session 的事实来源。这个方向正确，解决了旧模型里“群/Director label/session 混在一起”的根问题。

审查点：
- default session 解析有明确规则：有效 default 优先；无 default 且无 active session 则创建；多 active session 无 default 时报错。
- archived session 过滤存在测试覆盖。
- session restore 后会回填 routing map。
- task/cron 回调使用 `source_session_id + workspace`，比旧 `source_director` 更稳。

评价：架构一致性好，命名边界清晰。

### 2. AgentRuntimePool 重构

`DirectorPool` 替换为 `AgentRuntimePool` 后，职责更聚焦：进程生命周期、队列、流式回复、runtime recovery。业务路由上移到 `SessionManager`。这符合“决策权给信息最充分的层”。

审查点：
- 并发创建用 `creating` Map 做竞态保护。
- idle reaper / detach / closed entries 仍保留。
- streaming reply 与 system streaming reply 分开维护，避免普通回复和系统回调互相污染。

评价：重构方向正确。当前代码量仍偏大，后续可继续拆 streaming reply 管理器。

### 3. Codex app-server runtime

新增 `CodexAppServerRuntime`，用 JSON-RPC stdio 与 `codex app-server` 通信，支持 thread start/resume、turn start/steer/interrupt、dynamic tools、workflow events、token usage。

审查点：
- app-server thread options 注入 baseInstructions/developerInstructions/workspace context。
- dynamic MCP tools 在 `mcp_mode=dynamic` 下注册。
- `thread/tokenUsage/updated` 使用 last input tokens，避免累计 token 误触发 flush。
- commandExecution outputDelta 流成 Bash tool 状态。

评价：功能完整，测试覆盖较好。默认 `approval=never` + `dangerFullAccess` 是个人项目可接受策略，文档和配置摘要已暴露危险 provider 信息。

### 4. Web-v2 控制台

旧 `src/public` 被删除，web-v2 成为默认 UI。后端启动时会检查并构建 `web-v2/dist`。

审查点：
- session-based chat API 清晰化：`/api/send` 需要 sessionId。
- chat live turn、tool status、workflow snapshot 都有前后端字段。
- Files / Tasks / Sessions / Workspace 管理进入统一 UI。
- API token 在前端用 `Authorization: Bearer`，WebSocket 使用 query token。

评价：作为个人项目可合并。单 bundle 815KB 有 Vite 警告，当前规模可接受。

### 5. Task / Cron / Callback

任务表与 cron 表增加 workspace/source_session_id；cron scheduler 支持 per-job isolation，shell_action 日志落盘。

审查点：
- `create_task`/`create_cron_job` 绑定 caller session/workspace。
- cron director_msg/spawn_role 会解析 target session，必要时 revive。
- shell_action 使用 detached process group + timeout + log file，解决 maxBuffer 和孤儿子进程问题。

评价：正确性比 main 明显提升。shell_action 是高权限能力，默认可用意味着使用者要信任当前 Director。

## 发现项

### M1：`/api/files/tree` 和 `/api/files/read` 允许读取任意本机目录下的文本文件

位置：`src/console.ts:2854-2893`

现状：接口接受任意 `root`，只验证 `dir/path` 在 `root` 内。只要控制台 token 可用，调用方可以把 `root=/Users/ilike`，再读取任意小于 512KB 的文本文件。

影响：
- 在本机个人控制台场景风险可控。
- 一旦开启远程访问或 token 泄漏，这个接口扩大为本机文件浏览器。
- 这和 Workbench 其他接口的 allowlist 风格不一致，例如 outbox/attachments/task result 路径有显式限制。

建议：
- 将 `root` 限制为 `buildWorkContext()` 产生的 project/workspace cwd/persona_dir。
- 或复用一个 `isAllowedProjectRoot(root)`，只允许 DB workspace cwd、agents.providers.cwd、process.cwd、persona_dir。
- 若保留任意 root，报告和 UI 都应标成“本机文件浏览器能力”。

优先级：中。

### L1：`bun test` 会扫描 `dist/__tests__`，导致测试重复执行

现象：
- `bun test`：941 pass。
- `bun test src/__tests__ web-v2/__tests__`：494 pass。

原因：`dist/` 虽在 `.gitignore`，本地构建后 `bun test` 仍会递归发现 `dist/__tests__`。

影响：
- CI/本地全量测试耗时增加。
- dist 里的旧测试可能掩盖真实测试范围，造成噪音。

建议：
- 增加明确测试脚本：`"test": "bun test src/__tests__ web-v2/__tests__"`。
- 或清理 dist 后运行测试。

优先级：低。

### L2：`ensure-web-v2-dist` 启动时会根据 `.deploy.env` 自动 rsync 部署

位置：`src/ensure-web-v2-dist.ts:78-104`

现状：只要本地存在 `web-v2/.deploy.env`，启动 Shell 后构建完成会 fire-and-forget 执行 `rsync --delete` 到远程。

影响：
- 个人机器上可用，但“启动本地服务”隐含远程部署副作用。
- `--delete` 使目标目录同步为 dist 镜像，配置错误时破坏性较强。

建议：
- 加环境变量开关，例如 `PERSONA_DEPLOY_WEB_DIST=1` 才执行。
- 或改成独立脚本，不挂在启动路径。

优先级：低。

## 已接受的 breaking changes

这些变化符合当前个人项目合并前提，本报告不把它们视为阻塞：

- 旧 Web 控制台 `src/public` 删除，web-v2 成为默认 UI。
- `codex` 旧 CLI adapter 删除，统一走 `codex-app-server` provider。
- workspace/session 路由从 label/chatId 转为 DB sessionId/default session 模型。
- `/api/send` 强制 sessionId，旧 director label 路由被移除。
- 默认 Codex provider 是 `danger-full-access + approval=never + dynamic tools`。
- task/cron callback 语义从 `source_director` 迁移到 `source_session_id/workspace`。

## 安全性审查

正向点：
- Console API 有 token 机制，未配置 token 时明确本地信任模型。
- 文件上传限制数量、单文件大小、总大小，并写入 persona attachments 子目录。
- outbox/attachments/task result 下载和发送路径有 allowlist。
- MCP config 写入在 `PERSONA_TEST=1` 下默认禁用，避免测试污染生产 `~/.persona/.mcp.json`。
- dynamic cron tools 限制在当前 workspace 可见范围内删除/切换。

风险点：
- `/api/files/tree/read` 的 root 范围过宽。
- shell_action 支持 `!bash` 任意命令，属于受信 Director 能力。
- Claude 默认 `--dangerously-skip-permissions`，Codex 默认 danger full access；这是当前产品定位的一部分。

## 正确性审查

覆盖良好的路径：
- session restore / archive / default 切换。
- workspace routing smoke tests。
- turn streaming、tool status、workflow snapshot。
- task source metadata 与 Codex callback。
- cron schedule、scheduler isolation。
- Claude/Codex transcript parser。
- shell bash timeout/logging。

仍建议补充的测试：
- `/api/files/tree/read` root allowlist 行为（已补）。
- web-v2 restart shell button 的 API base 行为。
- Feishu `/config` main 新 session 竞态路径。
- `ensureWebV2Dist` 启动构建路径保持纯本地构建。

## 架构一致性审查

整体一致：
- SessionManager = 业务路由边界。
- AgentRuntimePool = runtime/process/queue/stream 管理边界。
- SessionBridge = 单 session 适配器边界。
- task-store = DB SSOT。
- director-session-adapter = agent 协议差异层。

局部可继续整理：
- `src/console.ts` 已超过 4k 行，API routing、file workbench、workspace config、diagnostics、WebSocket bridge 混在一起。后续可拆成 `console/routes/*`。
- `AgentRuntimePool` streaming card 状态较多，可抽 `StreamingReplyRegistry`。
- `CodexAppServerRuntime` JSON-RPC parsing 复杂但内聚，目前可接受。

## 合并建议

建议流程：

1. 合并前至少修 M1，或明确接受“控制台 token 等于本机文件读权限”。
2. L1/L2 可合并后处理。
3. 合并时保留本报告作为 dev → main 的风险记录。
4. 合并后第一轮操作建议：启动 Shell、打开 Web 控制台、创建新 session、发送一条消息、创建一个测试 task、看 task callback 是否回到正确 session。

## 最终判断

当前 `dev` 没有发现编译/测试阻塞项。架构方向清晰，关键边界比 `main` 更稳。合并风险主要来自已接受的 breaking changes 和控制台文件读取能力边界。作为个人项目，可以合并；若要把控制台暴露到远程环境，先收紧 `/api/files/tree/read`。
