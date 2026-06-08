# web-v2 收敛蓝图

> 创建: 2026-06-07
> 目标: 删除占位功能、拆分大文件、补文档，让 web-v2 里"每一个按钮都被点过"
> 驱动: execution-cron-builder

---

## Part 1 — 设计原则

### 定位

web-v2 是 persona-shell 在浏览器里的工作台。它不是飞书的复刻，也不是通用 Claude Code UI。
**每一个功能都要回答：飞书做不了/做不好，凭什么在这里？**

### 判断标准

**该有**（满足任一）：
- 飞书做不了：代码块折叠、Markdown 渲染、Tool 流可视化、文件预览
- 飞书做不好：大消息列表滚动、键盘快捷键、多页面切换
- 跨设备刚需：远程访问、桌面端长会话

**不该有**（满足任一）：
- 占位 / 装饰 / "以后再加"——占位是谎言
- 没有稳定后端支撑——前端硬造 mock
- 5 周内没有真实使用场景

---

## Part 2 — 功能地图

### Layer 1 — 核心（没有就等于没有 web-v2）

| # | 功能 | 状态 |
|---|------|------|
| 1 | Workspace / Session 树形浏览 | ✅ 已有 |
| 2 | Chat 消息流（Virtuoso 虚拟滚动 + Markdown 渲染） | ✅ 已有 |
| 3 | 发送/接收消息 | ✅ 已有 |
| 4 | WebSocket 实时流（streaming + tool events） | ✅ 已有 |
| 5 | 工具调用可视化（ChatToolCall 折叠/展开） | ✅ 已有 |
| 6 | Stop / Interrupt 当前 turn | ✅ 已有 |
| 7 | 任务列表（Tasks 页面：列表 + 日志 + 结果） | ✅ 已有 |
| 8 | 文件浏览（Files 页面：树 + 预览） | ✅ 已有 |
| 9 | Token 鉴权 | ✅ 已有 |
| 10 | 文档侧边预览（DocumentPanel） | ✅ 已有 |

### Layer 2 — 必要增值

| # | 功能 | 状态 |
|---|------|------|
| 11 | 消息搜索（客户端过滤） | ✅ 已有 |
| 12 | 消息隐藏/恢复 | ✅ 已有 |
| 13 | 消息复制 | ✅ 已有 |
| 14 | 附件上传（Paperclip + 粘贴图片） | ✅ 已有 |
| 15 | Director 操作（Flush / Clear / Restart / Interrupt） | ✅ 已有 |
| 16 | 命令面板（Mod+K） | ✅ 已有 |
| 17 | 切换 Agent / Persona | ✅ 已有 |
| 18 | 创建 Workspace | ✅ 已有 |
| 19 | 归档 Session | ✅ 已有 |
| 20 | Restart Shell | ✅ 已有 |
| 21 | Toast 通知 | ✅ 已有 |
| 22 | 日期分隔 | ✅ 已有 |
| 23 | Load earlier 分页 | ⚠️ 简化版 |

### Layer 3 — 可选/未来（本轮不碰）

- 文档编辑（只读→读写）
- 主题/多语言切换
- 导出会话
- 真正的消息分页（offset/cursor）

---

## Part 3 — 收敛 Execution Checklist

### Phase 1: 删除占位功能（P0）

- [x] 1.1 删除 Regenerate 按钮和 `regenerate` 函数
  - `message-actions.tsx`: 删 onRegenerate prop 和 Check 按钮
  - `chat.tsx`: 删 regenerate 传递
  - `use-chat.ts`: 删 `regenerate` 函数（L186-199）和返回值
- [x] 1.2 删除 More 菜单按钮
  - `message-actions.tsx`: 删 MoreHorizontal 按钮和 `open` state
- [x] 1.3 删除 StatusBar 组件
  - 删 `components/status-bar.tsx` 整个文件
  - `root-layout.tsx`: 删 import 和渲染
- [x] 1.4 删除 extraSessionActions 槽位
  - `director-panel.tsx`: 删 `extraSessionActions` prop、类型、渲染分支
- [x] 1.5 删除 Mod+/ 快捷键描述
  - `command-palette.tsx`: 删 toast 描述中的 Mod+/ 文案
- [x] 1.6 验证: `npm run build` 通过 + tsc --noEmit 无错误

### Phase 2: 代码拆分（P1）

- [x] 2.1 拆分 `root-layout.tsx`（652 行 → 主文件 < 350 行）
  - 抽出 `components/sidebar.tsx`（workspace/session 列表）
  - 抽出 `components/header.tsx`（顶栏状态 + 导航）
  - ShellOutletContext 类型不变
- [x] 2.2 拆分 `tasks.tsx`（996 行 → 3-4 文件）
  - 抽出 `pages/tasks/task-list.tsx`
  - 抽出 `pages/tasks/task-detail.tsx`
  - 抽出 `hooks/use-task-logs.ts`
  - `pages/tasks/index.tsx` 作为组装入口

### Phase 3: 测试覆盖（P1）

- [x] 3.1 hook 单测（bun:test，已有 chat-tools.test.ts 作为模板）
  - `use-chat.ts`: tool status 状态机（running → completed on turn_completed）
  - `use-chat.ts`: turn_failed / turn_aborted 清理逻辑
  - `chat-tools.ts`: 补充 edge case（无 id 合并、status 覆盖）
- [x] 3.2 测试模式启动（不阻塞正常使用）
  - `config.ts`: feishu 配置改为可选（缺少时跳过飞书初始化，不 throw）
  - `src/index.ts`: 支持 `PERSONA_TEST=1` 环境变量，跳过飞书 client 创建，仅启动 web console + director
  - `package.json`: 新增 `"test:shell"` script，用独立端口（如 3099）+ 临时 persona_dir 启动测试实例
  - 测试实例和正产实例互不干扰（不同端口、不同 persona_dir、不同 SQLite）
- [x] 3.3 后端 API 冒烟测试（bun:test + fetch localhost）
  - 前置：测试实例通过 `test:shell` 启动
  - `/api/messages`: 按 sessionId 查询、limit 参数
  - `/api/tasks`: group_name 过滤（本次修的 bug）
  - `/api/send`: 发送消息后 WS 收到 turn_event
  - `/api/esc`: 中断当前 turn
- [x] 3.4 端到端流程测试（脚本化，无飞书）
  - 启动 shell → 连接 WS → 发送消息 → 等待 turn_completed → 验证 tool status
  - 发送消息 → 中途 /api/esc → 验证 turn_aborted
  - create_task → list_tasks(group_name) → 验证返回
- [x] 3.5 构建验证
  - `npx tsc --noEmit` 无错误
  - `npm run build` 无错误
  - `bun test` 全部通过

### Phase 4: 补文档（P1）

- [ ] 4.1 重写 `web-v2/README.md`（替换 Vite 模板默认内容）
  - 项目说明、启动方式、环境变量、目录结构
- [ ] 4.2 写 `web-v2/ARCHITECTURE.md`（200 行内）
  - 模块边界图、数据流（REST / WS）、组件树
- [ ] 4.3 清理 WP 注释
  - 扫描所有 WP1-WP7 注释，已落地的删除注释，仅保留"设计决策"型注释

### Phase 5: 验证（P0，与每个 Phase 并行）

- [ ] 5.1 Phase 1 完成后：全流程冒烟测试（见下方测试方案）
- [ ] 5.2 Phase 2 完成后：全流程冒烟测试
- [ ] 5.3 Phase 3 完成后：`bun test` 全部通过
- [ ] 5.4 最终验证：build 通过 + 全流程测试 + 无 console.error

---

## Part 4 — 测试方案（无飞书，纯 Web 端到端）

### 前置条件

persona-shell 在本地运行，web-v2 dev server 或 dist 构建可访问。
不需要飞书，所有测试通过浏览器 + shell 后端完成。

### 4.1 认证与连接

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-AUTH-1 | 打开 web-v2 首页 | 弹出 Token Dialog |
| T-AUTH-2 | 输入正确 token，确认 | Dialog 关闭，左侧栏加载 workspace 列表 |
| T-AUTH-3 | Header 显示连接状态 | 显示 "Healthy" 或绿色指示 |
| T-AUTH-4 | 输入错误 token | 提示错误，不放行 |

### 4.2 Workspace 与 Session 管理

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-WS-1 | 左侧栏可见 workspace 列表 | 至少有 Main director |
| T-WS-2 | 点击某个 workspace | 展开 session 列表 |
| T-WS-3 | 点击 "+" 新建 session | 弹出 New Session Dialog，创建后列表刷新 |
| T-WS-4 | 点击 session | 中间区域加载该 session 消息 |
| T-WS-5 | 点击 Archive 按钮 | 确认后 session 从列表消失 |
| T-WS-6 | 点击 "Create workspace" | 弹出 Sheet，填写名称后创建 |

### 4.3 Chat 核心交互

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-CHAT-1 | 在输入框输入 `!pwd`，按 Enter | 消息发送，等待 assistant 回复 |
| T-CHAT-2 | 观察 streaming 过程 | 显示 thinking → streaming → tool_running 状态 |
| T-CHAT-3 | 回复完成后 | Tool 状态显示 "done"（非 running），StreamingBlock 消失 |
| T-CHAT-4 | 展开 Tools 折叠 | 显示 tool name、input、result |
| T-CHAT-5 | 发送 `请列出当前目录文件` | 回复中有 Markdown 代码块，正确渲染 |
| T-CHAT-6 | 点击回复中的文件路径 | 右侧弹出 DocumentPanel 预览文件内容 |
| T-CHAT-7 | 流式回复过程中点 Stop | 回复中断，UI 恢复到可输入状态 |
| T-CHAT-8 | Shift+Enter | 输入框换行，不发送 |

### 4.4 消息操作

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-MSG-1 | 悬停 assistant 消息 | 显示 Copy / Hide 按钮（无 Regenerate、无 More） |
| T-MSG-2 | 点击 Copy | Toast 提示已复制，剪贴板有内容 |
| T-MSG-3 | 点击 Hide | 消息隐藏，顶部提示 "N 条已隐藏" |
| T-MSG-4 | 点击 "显示已隐藏" | 消息恢复 |
| T-MSG-5 | 消息搜索框输入关键词 | 消息列表过滤，显示匹配数 |

### 4.5 附件上传

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-ATT-1 | 点击 Paperclip 图标选择文件 | 输入框下方显示附件名 |
| T-ATT-2 | 粘贴剪贴板图片 | 自动上传，显示附件 |
| T-ATT-3 | 点击附件 X 移除 | 附件从列表消失 |
| T-ATT-4 | 带附件发送消息 | 消息发送成功，附件传递到后端 |

### 4.6 Director 控制

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-DIR-1 | Cmd+K 打开命令面板 | 显示命令列表 |
| T-DIR-2 | 选择 Flush Director | 执行成功（Toast 或无报错） |
| T-DIR-3 | 选择 Interrupt | 如有 streaming 则中断 |
| T-DIR-4 | 选择 Clear context | 执行成功 |
| T-DIR-5 | 点击 Switch… 按钮 | 弹出 Agent/Persona 切换面板 |
| T-DIR-6 | 点击 Restart Shell | 确认弹窗，确认后 shell 重启，WS 断线后自动重连 |

### 4.7 Tasks 页面

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-TASK-1 | 导航到 Tasks 页面 | 显示当前 workspace 的任务列表 |
| T-TASK-2 | 切换到 "All" scope | 显示所有 workspace 的任务 |
| T-TASK-3 | 在 Chat 中发送 `派一个后台 agent 执行 pwd` | 回到 Tasks 页面可见新任务 |
| T-TASK-4 | 点击任务 | 右侧显示任务详情（日志、结果） |
| T-TASK-5 | 任务完成后 | 状态从 running → completed |
| T-TASK-6 | 过滤 tab 切换（All/Running/Completed/Failed） | 列表正确过滤 |

### 4.8 Files 页面

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-FILE-1 | 导航到 Files 页面 | 左侧显示文件树 |
| T-FILE-2 | 展开目录 | 显示子文件/子目录 |
| T-FILE-3 | 点击 .md 文件 | 右侧显示文件内容 |
| T-FILE-4 | 点击 .ts 文件 | 右侧显示代码内容 |

### 4.9 异常与边界

| 步骤 | 操作 | 预期 |
|------|------|------|
| T-ERR-1 | Shell 未启动时打开 web-v2 | WS 断线，Header 显示 Offline，可自动重连 |
| T-ERR-2 | Shell 重启后 | WS 自动重连，消息列表重新加载 |
| T-ERR-3 | 快速连续发送 3 条消息 | 消息入队，按序处理，UI 不卡死 |
| T-ERR-4 | 切换 session 期间有 streaming | streaming 清除，新 session 消息加载 |
| T-ERR-5 | 浏览器 F5 刷新 | 重新鉴权后恢复到之前的 workspace/session |

### 测试通过标准

- [ ] 所有 T-AUTH / T-CHAT / T-MSG / T-DIR / T-TASK / T-FILE 测试通过
- [ ] 无 console.error（浏览器 DevTools）
- [ ] `npm run build` 无错误
- [ ] `npx tsc --noEmit` 无错误
- [ ] 删除的 5 个占位功能在 UI 中不可见

---

## Part 5 — 不做清单（明确排除）

- 主题切换 / 多语言
- 文档编辑（只读 → 读写）
- 任何新的占位代码
- use-chat.ts 拆分（后续独立 PR）
