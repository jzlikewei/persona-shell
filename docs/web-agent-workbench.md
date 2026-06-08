# Persona Web Console — 本地操作台升级蓝图

> 当前状态说明（2026-06-08）:
> 这份文档是 Workbench/legacy Web Console 的产品蓝图,记录的是完整本地操作台方向。当前主入口 web-v2 只承诺 Chat / Tasks / Files,并不等同于这里规划的 Runtime / Automations / Persona / Observability / Settings 全量工作台。
>
> 因此,本文适合作为能力迁移候选池和 legacy `/v1` 能力说明;web-v2 当前边界以 `web-v2/README.md`、`web-v2/ARCHITECTURE.md`、`web-v2/BLUEPRINT.md` 为准。

## 定位

Persona Web Console 是 persona-shell 的本地 Web 操作界面。它不是新的 agent，不是 agent 平台，也不是通用工作流搭建器；它只负责把 persona-shell 已有的会话、任务、Cron、persona 文件、产物和日志做成一个日常可用的本地操作台。

当前 Web Console 已具备状态、会话、任务、Cron 和 Web Chat 的基础能力。升级目标是把这些能力重组为完整操作闭环：

- 和 Main Director、Web Chat、飞书群 Director 对话
- 管理已有 Director、会话、后台任务和自动化
- 查看 persona 资产、记忆、产物和运行日志
- 在本地优先、安全可控的前提下提供高密度操作体验

## 非目标

- 不实现新的 agent runtime。
- 不重写 Claude / Codex / Kimi 的推理或工具调用能力。
- 不做通用 agent 平台、插件市场或多用户 SaaS。
- 不做 n8n 类节点式 workflow canvas。
- 不把 Web Console 变成独立产品；它仍然嵌入 persona-shell 进程，服务现有后端能力。

## 产品原则

- **Chat first**：第一屏应该能直接和 Director 工作，而不是只看统计卡片。
- **Execution visible**：底层 CLI、任务和 Cron 做了什么、卡在哪里、产出了什么，应当随时可见。
- **Local first**：数据、日志、persona 文件和产物都以本地文件/SQLite 为核心。
- **Operator friendly**：默认面向高频操作，减少弹窗和隐藏入口，保留必要的危险操作确认。
- **Persona native**：角色、prompt、memory、skills 是一等对象，不只是文件系统细节。
- **Shell boundary**：Web Console 只编排 persona-shell 已有对象，不引入新的 agent 抽象。

## 参考方向

- **Cogpit**：借鉴 conversation timeline、tool call 展示、token/cost、进程监控、多 session 可视化。
- **LangSmith**：借鉴 Messages / Turns / Details 三层视图，用于从会话阅读下钻到具体 run 详情。
- **Codex app**：借鉴 skills、automations、权限/sandbox 的界面组织方式。
- **CoWork OS**：借鉴 heartbeat、完成证据、自动化摘要。
- **Nova Code**：借鉴 self-hosted dashboard、workspace、streaming chat、scheduled automations。
- **n8n executions**：执行历史、状态过滤、失败/运行/成功/等待等运维视角。

## 功能大类

### 1. 会话操作台

用户每天最常用的主工作区，承担会话、消息和即时指挥。

- Chat / Sessions
- Main Director、Web Chat、Feishu 群 Director
- 新建 / 关闭 Web Chat
- 消息发送、流式响应、取消响应
- 会话历史切换
- Session Inspector：查看 / 复制 session id、重命名 session、跳回 live session
- 消息搜索
- Transcript 导出
- Markdown、代码块、表格、链接渲染
- 附件发送入口
- 引用 / 回复某条消息
- 重新发送上一条消息
- 复制消息、复制 Markdown
- Conversation Timeline：用户消息、assistant 回复、tool call、task delegation、附件、错误按时间串起来
- Turn 视图：按轮次折叠 / 展开
- Details 视图：查看某轮输入、输出、metadata、错误、耗时，并支持复制 JSON、跳回所属 session
- 每轮消息元信息：耗时、token、cost、model、后端 provider

### 2. Director 与运行时管理

管理 persona-shell 已有的 Director、Pool、子角色任务、后端 provider 和运行队列。

- Main Director 状态面板
- Runtime snapshot / process / queue JSON 复制与导出
- DirectorPool 状态列表
- 单个 Director 操作：Flush、Clear、Esc、Restart、Detach / Shutdown
- 切换后端 provider：Claude / Codex / Codex app-server / Kimi
- 切换 persona role
- 查看 session id / Codex thread id / session name
- 查看 workspace cwd
- 查看当前 prompt 注入文件
- 查看 MCP 配置状态
- Director 进程监控：PID、alive、重启次数、最近 crash
- 当前运行消息预览
- 队列查看
- 取消单条队列消息
- 清空队列

### 3. 任务中心

后台任务、子任务、长任务的完整工作台。

- 任务列表
- 状态筛选：dispatched、running、completed、failed、cancelled
- role 筛选
- provider / model 筛选
- 来源筛选：Main、某个群、某个 Web Chat、Cron
- 创建任务表单
- 创建任务字段：role、provider、model、description、prompt、project_dir、timeout_ms、max_retry
- 任务详情页
- 实时任务日志
- 结构化日志：thinking、tool call、tool result、text、error、result，并支持单条详情、复制 JSON / 文本和单条导出
- 任务结果 Markdown 渲染
- 结果文件路径展示
- 发送结果附件
- 取消任务
- 重试任务
- 从已有任务复制创建
- 查看 spawn args、PID、duration、cost、codex thread id
- 子任务关联父 Director / parent Codex thread，并可跳回父会话或父 Director
- 完成证据面板：产物、摘要、发送状态、后续动作
- 批量操作：取消多个失败 / 运行任务、清理历史
- 任务运行历史趋势

### 4. 自动化与调度

Cron、定时任务、持续运行工作流的管理中心。

- Cron job 列表
- Cron 搜索、启停状态/action/source/health 筛选
- Cron 详情操作：复制 / 导出 job JSON、打开 source Director、按 Cron 跳到 Tasks 查看运行记录
- 创建 Cron
- 编辑 Cron
- 删除 Cron
- 启用 / 禁用
- 手动立即运行
- schedule 编辑器：every Nm、every Nh、daily HH:MM
- action 类型：spawn_role、director_msg、shell_action
- 下一次运行时间预览
- 上次运行时间
- 运行历史
- 运行结果关联 task
- 运行历史可打开关联 task、打开结果产物、复制/导出单次运行 JSON、导出运行历史
- 失败重试配置
- timeout 配置
- source_director 配置
- Cron 日志
- Cron 模板：日报、周报、定期巡检、定期 flush、数据同步
- Automation 健康状态：连续失败次数、最近错误
- shell_action 风险提示：内置动作、未知动作、本地 bash 命令分级展示

### 5. Persona 资产管理

管理人格、角色、prompt、memory、skills 和 MCP 配置。

- 角色列表和详情
- 角色 name、description、文件路径
- 角色 prompt 预览
- prompt bundle 预览：baseInstructions、developerInstructions
- soul.md 查看
- meta.md 查看
- personas/*.md 查看
- prompts/*.md 查看
- memory/MEMORY.md 查看
- daily/state.md 查看
- TODO.md 查看
- workspace context 查看
- session memory 查看
- 轻量编辑 memory / state / TODO
- 角色切换前预览：role 详情、prompt 文件/大小摘要、复制 / 导出预览、切换当前 Director
- persona 文件变更提示
- skills 列表
- skill 详情查看
- MCP server 列表和配置预览

### 6. 产物与文件

任务结果、附件、outbox 的浏览和投递。

- outbox 文件浏览
- attachments 文件浏览
- task result 文件浏览
- 文件搜索、类型筛选、来源筛选
- 图片预览
- Markdown 预览
- 普通文件下载
- 在本地文件管理器中打开允许的产物路径
- 发送附件到当前会话
- 文件来源关联：由哪个 task / session 产生，并可跳转回来源 task、session 或 Director
- 最近产物列表
- 文件大小、创建时间、路径
- 可见文件 manifest 复制 / 导出、单文件 metadata / preview 复制
- 安全限制提示：哪些路径允许发送

### 7. 观测与调试

运行状态、日志、指标、错误诊断和开发辅助。

- 全局状态栏
- 系统日志 tail
- Director input / output log
- Task stdout / stderr log
- Feishu 消息日志
- Queue log
- 按 Director label 切换日志源
- 日志搜索
- 日志级别筛选
- 错误聚合
- 最近 crash / restart 历史
- token 用量趋势，可汇总为排障任务草稿
- cost 趋势，可汇总为排障任务草稿
- response latency 趋势，可汇总为排障任务草稿
- context window 趋势，可汇总为排障任务草稿
- cache / context live 状态，可基于整体或单项生成排障任务草稿
- 每个 provider 的使用统计，可基于整体或单项生成排障任务草稿
- 每个 role 的任务成功率，可基于整体或单项生成排障任务草稿
- 每个 cron 的失败率，可基于整体或单项生成自动化修复任务草稿
- WebSocket event viewer：事件筛选、搜索、payload/raw 下钻、单条复制/导出、筛选报告或选中事件一键生成排障任务草稿
- API explorer：测试 /api/tasks、/api/cron-jobs、/api/persona/*，支持 GET / POST / PUT / DELETE、JSON body 和危险请求确认
- Snapshot JSON 查看，以及带连接 / Runtime / Context / Tasks / WebSocket 摘要的 Snapshot report 复制导出和一键生成快照排障任务草稿
- parse log 结果查看：可打开关联 session/task、复制单条结构化 JSON
- 模拟 incoming message，并可把执行证据转为跟进任务草稿
- 模拟 task completion，并可把执行证据转为跟进任务草稿
- 导出 debug bundle，并可把导出证据汇总为排障任务草稿
- 打开本地日志路径
- 打开 persona 文件路径
- 环境检查：bun、claude、codex、kimi 是否可用

### 8. 安全与设置

配置、权限、危险操作、人类确认和界面偏好。

- config.yaml 只读预览
- feishu 配置状态
- console port / token 状态
- director 配置：persona_dir、pipe_dir、flush limit、flush interval
- pool 配置：max directors、idle timeout、small group threshold
- 后端 providers 配置
- roles 默认 provider / model 配置
- logging level
- scheduler enabled / interval
- sandbox / approval / network / search 权限展示
- Security Posture：本机监听、token、危险 provider、search provider、审批队列摘要
- 配置摘要和安全姿态报告复制 / 导出
- 高风险操作确认队列
- shell_action 风险提示
- 发送附件确认
- 删除 / 清空 / 重启二次确认
- 操作审计日志：搜索、状态筛选、action 筛选、复制和导出
- Web console token 状态提示
- 仅本机监听提示
- 危险配置警告
- 主题设置
- 密度设置：compact / comfortable
- 时间格式设置
- 自动刷新频率设置

## 建议主导航

Web Console 的一级导航建议保持稳定，不直接暴露过多技术细节：

1. **Overview**：跨模块操作摘要、注意事项、快速入口
2. **Console**：Chat、当前 session、实时运行状态
3. **Runtime**：Director、Pool、provider、queue、process
4. **Tasks**：任务日志、结果
5. **Automations**：Cron、调度、运行历史
6. **Persona**：roles、prompts、memory、skills、MCP
7. **Files**：outbox、attachments、artifacts
8. **Observability**：logs、metrics、errors、debug tools
9. **Settings**：config、safety、UI preferences

## 分期建议

### Phase 1: Console MVP

目标是把现有 Web Console 从“监控拼装页”升级成可日常使用的操作台。

- 重做主布局和导航
- Chat / Sessions 作为第一屏
- Session 分组：Main、Web Chats、Feishu Groups、Closed
- 全局状态栏：连接、Director、queue、context、tasks
- Tasks 完整中心：列表、创建、详情、日志、结果、取消
- Automations 基础中心：列表、启停、删除、创建
- Persona 只读库：roles、state、TODO、prompt bundle
- Logs 基础 tail：Director、Task、Queue
- 保留必要危险操作确认

### Phase 2: 操作闭环

- Conversation Timeline / Turn / Details 三层视图
- 任务完成证据面板
- Cron 编辑、立即运行、运行历史
- 文件 / 产物浏览与发送
- Session 内搜索和 transcript 导出
- Director provider / role 切换 UI
- Persona memory/state/TODO 轻量编辑

### Phase 3: 可观测性与安全控制

- 全文搜索 session/task/log，结果可直接跳转到对应 session、task 或 log tail
- token/cost/latency/context 趋势
- 错误聚合和失败诊断
- session link / context graph
- human-in-the-loop 审批队列
- API explorer / WebSocket event viewer / debug bundle
- 操作审计日志

## 当前落地进度

截至 2026-05-30，Web Console 已完成以下切片：

- 主导航、Chat-first Console、独立 Overview 入口，以及跨模块 Workbench Overview（自动补齐 Director/任务/自动化/Persona/文件/审批摘要、可带筛选/选中目标跳转的 operator attention、快速入口、Persona Handoff Task 草稿创建、整体报告复制/导出并可一键生成跨模块巡检/修复 Tasks 创建草稿）。
- Console 的 Session 分组（Main、Web Chats、Feishu Groups、Closed）、closed Director 按自身日志目录读取完整历史并支持跨日 session 聚合、新建 / 关闭 Web Chat（带本地审批和操作审计）、Session Inspector（session id 复制、内联重命名、live session 跳转、会话统计、会话结构化 JSON 复制 / 导出、当前 Messages / Turns / Timeline 视图报告复制 / 导出，并可基于当前视图/搜索条件一键生成 Tasks 创建草稿）、支持 Messages / Turns / Timeline 的消息搜索与上一条/下一条命中定位、Transcript Markdown 复制 / 导出、Messages / Turns / Timeline 视图、Conversation Timeline（消息、从消息 metadata 提取的 tool call / tool result、任务委派、队列项、附件发送、失败任务、WebSocket 错误和诊断聚合错误）和事件 Details 下钻（结构化 JSON 复制 / 导出并跳回 message/task/file/session/log/search，tool 事件支持 tool payload 复制 / 导出，单条 message / turn / timeline event 可一键生成 follow-up Tasks 创建草稿）、Turn 折叠/展开、Turn 级 provider/model/token/cost/duration 聚合展示并进入会话 JSON bundle、消息/Turn Details、消息元信息展示、Details JSON 复制 / 导出、生成单条会话证据 follow-up Tasks 创建草稿和所属 session 跳转、带可见引用预览和可取消上下文的结构化 Quote/Reply、Resend、Copy Markdown、代码块一键复制、当前响应 Stop 取消，以及聊天栏本地附件选择 / 上传 / 发送确认入口。
- Runtime 的 Main Director、Runtime snapshot / process / queue JSON 复制与导出，并可基于 Runtime snapshot / Active Work / Context Health / Runtime Context 一键生成运行态排障 Tasks 创建草稿（仍走任务创建审批）、Main Director 命令面和 provider/persona 切换意图可带当前进程、队列、context、runtime context 与目标选择生成操作前检查 Tasks 创建草稿、Director Pool（行级状态、队列、provider/persona、命令面和运行上下文证据可一键生成排障 Tasks 创建草稿）、进程监控（PID、alive、重启次数、最近 crash，整体 process report 和单个 Director JSON 复制/导出、可跳回关联 session，并可基于整体/单 Director 进程证据生成排障 Tasks 创建草稿）、Active Work 面板（Main/Pool 当前运行消息和队列预览、Director/Session 跳转、单项与整体复制/导出、单条 Active Work 一键生成排障 Tasks 创建草稿、对 Main/Pool 排队项执行带审批和审计的取消）、Context Health（live/stale、context window、flush limit、auto flush 状态、最高占用 Director，支持报告复制/导出，并可基于整体或单行 context/cache live 证据生成排障 Tasks 创建草稿）、workspace cwd、当前 prompt 注入文件、MCP 配置状态和 Runtime Context 报告复制/导出，并可基于整体报告、单 Director、单 prompt file 或单 MCP config 生成运行上下文排障 Tasks 创建草稿、主队列查看、整体 JSON 复制/导出、整体或清空队列前检查生成排障 Tasks 创建草稿、单条 JSON 复制/导出、单条生成排障 Tasks 创建草稿、单条取消、清空队列、Pool Director 单个 Flush / Clear / Esc / Restart / Detach / Shutdown，以及 provider / persona role 切换。
- Tasks 的筛选、纳入 Safety 审批队列的创建运行、详情、结构化日志（thinking、tool call、tool result、text、error、result）筛选/搜索/导出、单条详情、单条 JSON / 文本复制、单条导出和基于单条日志事件一键生成 follow-up Tasks 创建草稿、结果输出预览/复制/导出并可一键生成结果复盘或交付跟进 Tasks 创建草稿、可复制/导出的运行元信息（spawn args、PID、Codex thread、parent Director / parent session、project / cron / retry 关联）并可一键生成运行链路排查 Tasks 创建草稿、父会话/父 Director 跳转、可复制/导出的完成证据面板并可一键生成 completion follow-up Tasks 创建草稿、包含运行元信息/完成证据/可见日志/结果预览的任务交接包复制与导出并可一键生成 handoff follow-up Tasks 创建草稿、取消、纳入 Safety 审批队列的重试、复制创建、批量选择、批量取消运行中任务、纳入 Safety 审批队列的批量重试失败任务、已选任务 JSON 导出并可一键生成批量任务复盘/收敛 Tasks 创建草稿、按当前筛选展示 14 天吞吐 / 状态 / 耗时 / 成本 / provider / role 成功率并支持复制导出和一键生成排障/优化 Tasks 创建草稿的任务运行趋势报告，以及带预览、报告复制/导出、清理前复盘/安全检查 Tasks 创建草稿和审计的终态任务历史清理。
- Automations 的纳入 Safety 审批队列的创建 / 编辑 / 启停 / 删除 / 立即运行、下一次运行预览、Cron 搜索和启停/action/source/health 筛选、按当前筛选复制/导出自动化巡检报告（调度器状态、健康摘要、可见 Cron、最近运行和审计摘要）并可一键生成自动化巡检/修复 Tasks 创建草稿、Cron 详情复制/导出 job JSON、source Director 跳转、按 Cron 跳到 Tasks 查看运行记录、基于 Cron 配置/健康/运行历史/审计证据一键生成跟进 Tasks 创建草稿（仍走任务创建审批）、Cron 模板（日报、周报、定期巡检、定期 flush、数据同步）、健康状态、运行历史摘要，以及运行历史到 task/result artifact 的追踪、单次运行 JSON 复制/导出、结果产物发送、运行日志复制/导出、单次运行一键生成跟进 Tasks 创建草稿、历史复制/导出并可一键生成运行历史复盘 Tasks 创建草稿、单个 Cron 的操作审计轨迹（支持单条复制/导出、生成复盘/修复 Tasks 创建草稿并打开关联 task / file / Director / Cron），以及运行证据包复制/导出并可一键生成自动化运行证据跟进 Tasks 创建草稿。
- Persona 的 roles、角色切换前预览（role 详情、prompt 文件/大小摘要、复制/导出预览、生成切换前检查 Tasks 创建草稿、切换当前 Director）、prompt bundle 预览与完整 JSON 复制/导出并可一键生成 prompt/context 审核 Tasks 创建草稿、skills / MCP 总览、skill 详情查看与证据包复制/导出并可一键生成 skill 使用/修复 Tasks 创建草稿、MCP 配置与单 server 证据包复制/导出并可一键生成 MCP 排查/修复 Tasks 创建草稿、资产文档浏览/搜索/分类和新鲜度筛选、可见资产 manifest 复制/导出并可一键生成上下文资产复盘 Tasks 创建草稿、单文档预览/交接包复制导出并可一键生成文档复盘/修复 Tasks 创建草稿、纳入 Safety 审批队列的 Markdown 编辑保存、本地文件位置打开、workspace/session memory 分类提示、persona 文件变更提示、Memory Snapshot 高频入口（自动定位 memory 文档、打开预览、Markdown 复制和包含 state/TODO 摘要的交接包复制/导出，并可一键生成记忆复盘/整理 Tasks 创建草稿）、Context Graph 复制/导出并可一键生成上下文图复盘 Tasks 创建草稿、Context Handoff 就绪检查、运行上下文交接包复制/导出以及一键生成 Tasks 创建草稿（仍走任务创建审批）、纳入 Safety 审批队列的 state/TODO 轻量编辑保存、文档交接包复制/导出并可一键生成 state/TODO 整理 Tasks 创建草稿，以及支持整体/单条 JSON 复制导出、带 open target 的 session links 查看、创建、编辑、打开关联上下文、从审计日志回跳定位和删除（删除纳入 Safety 审批队列），并可基于整体或单条 session link 生成映射复盘/修复 Tasks 创建草稿。
- Files 的 outbox/attachments/task results 分区、文件搜索/类型筛选/来源筛选、最近产物列表、可见文件 manifest 复制/导出并可一键生成产物复盘 Tasks 创建草稿、可见文件诊断摘要（visible/sent/source traceable/bytes/preview 状态）和按当前筛选复制/导出文件诊断报告（scope/type/source/director 分布、发送状态、来源可追踪性、最新/最大文件、预览错误和安全根信息）并可一键生成产物排查 Tasks 创建草稿、单文件 metadata/preview 复制/导出（含文本/Markdown 内容和图片 data URL / 预览图导出）、文件 Delivery Evidence 展示与复制/导出（可从浏览器本地记录和最近 `attachment.send` 审计日志恢复）并可一键生成投递跟进 Tasks 创建草稿、包含 metadata / preview 摘要 / 发送状态 / 安全边界 / 来源跳转信息的单文件交接包复制与导出、基于单文件交接包一键生成 Tasks 创建草稿（仍走任务创建审批）、文件来源关联（task / Director / source session / role / description）、来源 task/session/Director 跳转、安全边界提示、文本/Markdown/图片预览、普通文件下载、本地文件位置打开、附件上传和附件发送；当目标是 Web Console 时，附件发送会通过 WebSocket 显示下载链接和图片预览，不再静默 no-op，且不再依赖外部 messaging 客户端可用。
- Logs 的全局全文搜索（session / task / log，结果可直接跳转到对应 session、task 或 log tail，支持搜索报告、单条结果 JSON 复制/导出，并可基于整份搜索报告或单条结果一键生成 follow-up Tasks 创建草稿）、日志源分组（Director / Task / Queue / Feishu / Shell）和 source manifest 复制/导出，并可基于 manifest 或单个 source row 一键生成日志源排障 Tasks 创建草稿、tail、搜索、级别筛选、原始 tail 导出和 tail 证据包复制/导出、本地日志位置打开，并可基于当前 tail 证据包一键生成排障 Tasks 创建草稿（仍走任务创建审批）、parse log 结果报告复制/导出并可一键生成解析报告排查 Tasks 创建草稿、解析后单条 conversation/task log 证据复制/导出、关联 session/task 跳转、单条结构化 JSON 复制并可一键生成 follow-up Tasks 创建草稿、Diagnostics 报告复制/导出并可一键生成整体排障 Tasks 创建草稿、错误聚合源复制/搜索/导出并跳转到 task 或 log、且可基于单条错误聚合一键生成排障 Tasks 创建草稿（仍走任务创建审批）、最近 crash / restart 历史报告复制/导出与单事件复制/导出、可打开对应 Director，并可基于历史报告或单事件一键生成运行态排障 Tasks 创建草稿、provider/role 使用统计与成功率报告复制/导出（任务占比、成本占比、平均耗时、最近任务）和单项证据导出，并可按 provider/role 跳转到 Tasks 筛选视图或基于整体/单项一键生成指标排障 Tasks 创建草稿、cron 失败率报告复制/导出与单项证据导出，并可跳转到对应 Cron 的 Tasks 运行筛选视图或基于整体/单项一键生成自动化修复 Tasks 创建草稿、任务趋势报告复制/导出与单日证据导出并可跳转到当天 Tasks 筛选视图或基于整体/单日一键生成趋势排障 Tasks 创建草稿、cost/latency/response/context-token 指标趋势报告复制/导出并可一键生成指标排障 Tasks 创建草稿、支持多 HTTP 方法和 JSON body 的 API Explorer（请求/响应报告复制导出、当前请求与最近历史 cURL 复制、最近请求 replay/copy/export、历史报告复制/导出，并可基于当前请求、历史请求或历史报告一键生成排障 Tasks 创建草稿）、可下钻 payload/raw 且支持单事件/payload/raw 复制、单事件导出、带筛选/类型统计/target 汇总/选中事件的整体报告复制导出、实时流节流渲染、按事件 target 打开 Director/Task，并可基于筛选报告或选中事件一键生成排障 Tasks 创建草稿的 WebSocket event viewer、Snapshot JSON 查看和带连接/Runtime/Context/Tasks/WebSocket 摘要的 Snapshot report 复制导出，并可基于连接、Runtime、Context、Tasks、WebSocket 警示一键生成快照排障 Tasks 创建草稿、纳入 Safety 审批队列且支持执行结果证据复制/导出并可一键生成跟进 Tasks 创建草稿的 incoming message / task completion 模拟、debug bundle 导出、导出证据复制/导出，并可基于 bundle filename/生成时间/日志任务审计环境摘要、当前 snapshot 和 diagnostics 线索一键生成排障 Tasks 创建草稿，以及环境检查报告复制/导出并可一键生成环境修复 Tasks 创建草稿。
- Settings 的配置摘要、分组 Runtime Config 详情（Console / Feishu / Director / Pool / Task / Scheduler / Logging / Provider risk）、配置摘要 JSON 复制/导出并可一键生成配置复盘/修复 Tasks 创建草稿、集中展示 sandbox / approval / network / search / MCP / cwd / elevated 状态且支持行级和整体复制导出、整体/单行均可生成权限收敛 Tasks 创建草稿的 Provider Permissions Matrix、单个 provider / role default / role override 配置证据包复制导出并可一键生成配置复盘/修复 Tasks 创建草稿、config.yaml 只读红acted 预览、Config Preview 报告复制/导出并可一键生成配置资产复盘/修复 Tasks 创建草稿、单个配置文件路径/内容复制与导出并可一键生成配置修复 Tasks 创建草稿、MCP 配置预览和单项 JSON 复制/导出并可一键生成 MCP 配置修复 Tasks 创建草稿、Security Posture（本机监听、token、危险 provider、search provider、审批队列摘要和警告；配置不可用时明确显示 Unknown / unverified）、安全姿态报告复制/导出并可一键生成安全整改 Tasks 创建草稿、单条安全 warning / provider risk 证据复制导出并可一键生成安全整改 Tasks 创建草稿、覆盖 Director、queue、task 创建/取消/重试/清理、automation、attachment、debug simulator、persona memory/doc 保存、审批历史清空等高影响操作且支持带结构化 payload 的队列/单项/带等待与运行耗时的决策历史 JSON 复制导出，并可基于待审批队列、单项、审批历史整体或单条决策生成审批复盘/整改 Tasks 创建草稿的本地确认队列、UI 偏好（主题、密度、时间格式、自动刷新）报告复制/导出并可生成偏好调整 Tasks 创建草稿、环境检查摘要与报告复制/导出并可一键生成环境修复 Tasks 创建草稿、单项证据复制/导出和一键生成环境修复 Tasks 创建草稿，以及支持搜索/状态/action 筛选、整体复制/导出并可一键生成操作审计复盘 Tasks 创建草稿、单条 JSON 复制/导出、单条生成操作复盘 Tasks 创建草稿、task/session/file/Director/Cron/state/debug task completion 等常见审计目标跳转、queue 取消/清理审计跳回 Runtime 并定位 Active Work 队列项、persona session link 审计跳回 Persona 并定位/预填 link 和 target 跳转的操作审计日志。
- 新增 `bun run smoke:web`，用于对本地 Web Console 执行关键链路冒烟：前端 shell / static assets（`/`、`/js/app.js`、`/css/style.css` 的主导航、Chat 容器、主视图渲染函数、API Explorer、WebSocket Events、Debug Bundle Evidence、Safety queue 和附件事件标记）、主 session/messages、从日志源自动抽样 closed Director 历史 sessions/messages（也可用 `PERSONA_SMOKE_DIRECTOR` 指定）、主导航只读数据模型（Tasks / Automations / Persona / Files / Logs / Settings / Observability）、二级读路径（Persona prompt bundle / Persona doc content / session links / log tail / global search / task detail / task logs / task output / file preview / file download / Cron detail / task cleanup preview / debug bundle）、mutation guard 边界（创建缺必填字段的 Task/Cron 必须返回 400、`ok:false` 并写入失败审计；取消或重试不存在的 Task 必须返回 404 并写入失败审计；删除、启停、立即运行、编辑不存在的 Cron 必须返回 404 并写入失败审计；写入 state/TODO 或 Persona Markdown 文档的校验失败必须返回 `ok:false` 并写入失败审计；创建缺必填字段的 session link 或删除不存在的 session link 必须返回 `ok:false` 并写入失败审计；发送附件的早期校验失败、打开本地路径缺参数或校验失败必须返回 `ok:false` 并写入失败审计；关闭不存在的 Web session 必须返回 404 并写入失败审计）、WebSocket 初始 `status` 快照结构（system / activity / context / queue / tasks / pool）和 WebSocket 附件发送事件，并校验附件接口返回的 `target_channel` 是 `web`。

## 当前后端能力映射

| 能力 | 当前基础 |
|------|----------|
| 状态快照 | WebSocket `status`，包含 context live/cache、context window、flush limit、auto flush 状态 |
| 流式响应 | WebSocket `chunk` / `stream-abort` |
| Web Chat | WebSocket `chat` / `chat_reply`，`POST/DELETE /api/web-sessions` |
| 会话消息 | `GET /api/messages` |
| 会话列表 | `GET /api/sessions` |
| 会话重命名 | `PUT /api/sessions/name` |
| Director provider 切换 | `POST /api/directors/switch-agent` |
| Director persona 切换 | `POST /api/directors/switch-persona` |
| Director 运行时操作 | `POST /api/directors/command` |
| Pool Director 关闭 | `POST /api/directors/shutdown` |
| 任务列表 / 创建 | `GET/POST /api/tasks` |
| 任务详情 | `GET /api/tasks/{id}` |
| 任务日志 | `GET /api/tasks/{id}/logs` |
| 任务结果 | `GET /api/tasks/{id}/output` |
| 任务取消 | `POST /api/tasks/{id}/cancel` |
| Cron 列表 / 创建 | `GET/POST /api/cron-jobs` |
| Cron 更新 / 删除 | `PUT/DELETE /api/cron-jobs/{id}` |
| Cron 启停 | `POST /api/cron-jobs/{id}/toggle` |
| Cron 立即运行 | `POST /api/cron-jobs/{id}/run` |
| Persona roles | `GET /api/persona/roles` |
| Persona prompt bundle | `GET /api/persona/prompt` |
| Persona docs | `GET /api/persona/docs` |
| Persona doc content | `GET/PUT /api/persona/docs/content` |
| Session links | `GET/POST/DELETE /api/persona/session-links` |
| state / TODO | `GET /api/state` |
| 附件上传 | `POST /api/files/upload` |
| 附件发送 | `POST /api/send-attachment` |
| 文件下载 | `GET /api/files/download` |
| 打开本地允许路径 | `POST /api/open-path` |
| 环境检查 | `GET /api/env-check` |
| Debug bundle | `GET /api/debug-bundle` |
| Observability diagnostics | `GET /api/observability/diagnostics` |
| Debug 模拟事件 | `POST /api/debug/simulate-message`, `POST /api/debug/simulate-task-completion` |
| 操作审计日志 | `GET /api/audit-log` |
| Config / MCP / skills 摘要 | `GET /api/config-assets` |
| 全局全文搜索 | `GET /api/search?q=...` |

## 明确暂缓

- 节点式 workflow canvas
- 复杂 time-travel debugger
- 多用户权限系统
- 远程公网部署体验
- 大屏展示型 dashboard
