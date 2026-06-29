# 微信接入实现计划

> 基于 [weixin-openclaw-integration.md](./weixin-openclaw-integration.md) 设计文档，覆盖 Phase 1（文本私聊 MVP）+ Phase 2（媒体收发）+ QR 登录脚本。

## Context

p-shell 当前只有飞书和 Web Console 两个消息通道。需要把微信作为第三个 IM 通道接入，复用现有的 `MessagingClient` / `MessagingRouter` 架构。协议层基于 iLink API（`ilinkai.weixin.qq.com`），不引入 OpenClaw Gateway 依赖。

## 设计决策

### 1. Lifecycle: stop() 接口

**问题**：`MessagingClient` 只有 `start()`，无 `stop()`；gracefulShutdown 也只停 sessionManager/director。

**方案**：
- `MessagingClient` 新增可选方法 `stop?(): Promise<void> | void`
- `MessagingRouter` 实现 `stop()` — 遍历所有 clients 调 `client.stop?.()`
- `gracefulShutdown` 加入 `messaging.stop()` 调用（与 sessionManager.detachAll 并行 allSettled）
- `WeixinMessagingClient.stop()` — abort 所有 pollers、best-effort 调 notifyStop、不阻塞退出太久（setTimeout 2s 兜底）

### 2. 命令权限：通道级 master 判断

**问题**：当前 `isMaster` 判断是 `!config.feishu.master_id || msg.senderOpenId === config.feishu.master_id`，微信用户的 senderOpenId 永远不等于飞书 master_id，导致微信侧 /flush 等命令被拒。

**方案**：
- config 新增 `weixin.master_user_ids: string[]`（微信侧的本体用户 ID 列表）
- `isMaster` 判断改为通道感知：
  ```
  chatId 以 weixin: 开头 → 检查 weixin.master_user_ids（空数组 = 全放行）
  否则 → 原有 feishu.master_id 逻辑
  ```
- 也给 `IncomingMessage` 补一个可选 `channel?: string` 字段（`'feishu' | 'weixin' | 'web'`），让 `isMaster` 不依赖 chatId 前缀解析

### 3. getLastChatId：跨通道最近活跃

**问题**：`getLastChatId()` 只返回 primary 的，定时 flush / cron 通知 / crash 通知都依赖它，微信作为 secondary 时这些不会发到最近微信会话。

**方案**：
- `MessagingRouter` 自己维护 `lastChatId`，在 `onMessage` 回调中记录 msg.chatId（仅 p2p）
- `getLastChatId()` 返回 router 级的最近 p2p chatId，而非委托 primary
- 这样定时通知自然发到最近活跃通道（无论飞书还是微信），再通过 `resolveClientByChatId` 路由到正确 client

### 4. QR 渲染依赖

**问题**：package.json 没有 qrcode-terminal。

**方案**：添加 `qrcode-terminal` 到 dependencies。该包轻量（~20KB，零依赖），且 Bun 兼容。

### 5. State 目录统一

**问题**：账号写 `~/.persona/weixin/openclaw-weixin/accounts/`，sync buffer 写 `~/.persona/weixin/accounts/`，两个 accounts 层级冲突。

**方案**：统一到 `state_dir`（默认 `~/.persona/weixin`）下的单一目录树：
```
~/.persona/weixin/
├── accounts.json                          # 账号索引
├── accounts/
│   ├── <accountId>.json                   # 账号凭据（兼容 openclaw-weixin 格式）
│   ├── <accountId>.sync-buf.json          # getUpdates 游标
│   └── <accountId>.context-tokens.json    # 按 userId 存的 context_token
└── attachments/                           # 入站媒体下载目录
```
登录脚本和 poller 读写同一个 `state_dir`，不再有 openclaw-weixin 子目录。

### 6. 投递语义：at-least-once

**问题**：get_updates_buf 先存还是后存决定了丢消息还是重复处理。

**方案**：**at-least-once**：
- handler 成功后才推进 sync buffer 并写盘
- 近期 processed messageId 集合也短期持久化到 `<accountId>.processed-ids.json`（最近 1000 条），重启后加载用于去重
- 重启后可能重复投递少量消息，但 handler 有去重保护，不会造成重复回复

## 新增文件

### `src/messaging/weixin/` 目录（9 个文件）

**weixin-types.ts** — 协议类型定义
- iLink API 请求/响应类型：`GetUpdatesResponse`, `SendMessagePayload`, `QrCodeResponse`, `QrCodeStatusResponse`
- 消息 item 类型：TEXT=1, IMAGE=2, FILE=3, VOICE=4
- message_type=2 (BOT), message_state: GENERATING=1, FINISH=2
- 错误码常量：`SESSION_EXPIRED_ERRCODE = -14`

**weixin-api.ts** — HTTP API 层
- `WeixinApi` 类，封装所有 iLink 端点
- 每个请求附 headers: `iLink-App-Id`, `iLink-App-ClientVersion`, `AuthorizationType: Bearer`, `Authorization: <token>`, `X-WECHAT-UIN: <userId>`
- 每个请求体带 `base_info: { bot_agent: "PersonaShell/0.1.0" }`
- 端点：`getQrCode`, `getQrCodeStatus`, `getUpdates`, `sendMessage`, `notifyStart`, `notifyStop`, `getConfig`, `sendTyping`
- baseUrl 可变（登录后切换到返回的 baseurl）

**weixin-account-store.ts** — 账号持久化
- 读写 `<state_dir>/accounts.json` (索引) 和 `<state_dir>/accounts/<accountId>.json`
- 兼容 openclaw-weixin 格式：`{ token, baseUrl, userId, savedAt }`
- accountId normalize：替换 `@`, `.` 等为 `_`，保证文件名安全
- 文件权限 0600

**weixin-context-store.ts** — context_token + sync buffer + processed IDs 持久化
- context_token 按 `(accountId, userId)` 存取，内存 Map + 磁盘 `<accountId>.context-tokens.json`
- sync buffer 按 accountId 存取：`<accountId>.sync-buf.json`
- processed IDs 持久化：`<accountId>.processed-ids.json`（最近 1000 条，重启后加载）

**weixin-text.ts** — 文本处理工具
- `chunkText(text, 4000)` — 按换行 > 空格 > 硬切分片
- `stripMarkdown(text)` — 去除 `**`, `__`, `[text](url)` → `text (url)`, 代码围栏等
- `parseChatId` / `makeChatId` — `weixin:<accountId>:<userId>` 解析/构造
- `parseMessageId` / `makeMessageId` — `weixin:<accountId>:<rawId>` 解析/构造
- `generateClientId()` — UUID 生成

**weixin-poller.ts** — 长轮询循环
- 每个 account 一个 poller 实例
- `POST ilink/bot/getupdates`，带 sync buffer
- 解析 inbound message 为 `IncomingMessage`（chatType 固定 `'p2p'`，channel 固定 `'weixin'`）
- LRU 去重集合（1000 条），启动时从磁盘加载
- 退避策略：1-2 次失败 → 2s, 3+ → 30s, 成功清零
- errcode=-14 → 暂停 account 1 小时
- AbortController 支持优雅关停
- **at-least-once**：handler 成功后才推进 sync buffer 和 processed IDs
- 入站媒体：下载图片/文件/语音到 attachmentDir，转为 `attachments[]`

**weixin-client.ts** — MessagingClient 实现 + `createWeixinClient()` 工厂函数
- 管理多 account，每个启一个 WeixinPoller
- 实现完整 `MessagingClient` 接口 + `stop()` + `canHandleChatId()`
- `reply()` — 从 messageIndex 查 account/user/contextToken → sendMessage
- `sendMessage()` — 从 chatId 解析 account/user → sendMessage
- 文本分片 + markdown 过滤后发送
- messageIndex: LRU Map（10,000 条），存 `{ accountId, userId, contextToken }`
- `addReaction()` — no-op
- `startStreamingReply()` — 返回 null
- 媒体发送：CDN 上传（Phase 2）
- `start()` 调 notifyStart，`stop()` abort pollers + best-effort notifyStop

**weixin-media.ts** — Phase 2 媒体处理
- 入站下载：从 CDN URL 下载 + AES-ECB 解密图片
- 出站上传：AES-ECB 加密 + 上传 CDN + 构造 media item_list
- SILK 语音暂不转码，保存原始文件
- CDN base: `https://novac2c.cdn.weixin.qq.com/c2c`

**index.ts** — barrel export `createWeixinClient`

### `scripts/weixin-login.ts` — QR 登录 CLI

- 独立脚本，不在 Shell 主进程运行
- 调 `getQrCode()` → 用 `qrcode-terminal` 在终端渲染 QR
- 轮询 `getQrCodeStatus()` 每 2s
- 处理所有登录状态：wait, scaned, confirmed, expired, scaned_but_redirect, need_verifycode, verify_code_blocked, binded_redirect
- `need_verifycode` → 从 stdin 读取验证码
- `scaned_but_redirect` → 切换到 redirect_host 继续轮询
- 成功后写入 WeixinAccountStore
- 用法：`bun scripts/weixin-login.ts [--state-dir ~/.persona/weixin]`

### 测试文件

**src/__tests__/weixin-text.test.ts** — 纯函数测试
- chunkText 分片、stripMarkdown、ID 解析/构造、generateClientId

**src/__tests__/weixin-client.test.ts** — 集成测试（mock fetch）
- getUpdates 返回消息 → handler 调用
- 去重：同消息不处理两次
- sendMessage 请求体结构验证
- errcode=-14 → account 暂停
- router chatId 路由：`weixin:*` 到 weixin client，其余到 primary
- at-least-once 语义：handler 失败时 sync buffer 不推进

## 修改文件

### `src/messaging/messaging.ts`
- `MessagingClient` 新增可选方法：`canHandleChatId?(chatId: string): boolean`
- `MessagingClient` 新增可选方法：`stop?(): Promise<void> | void`
- `IncomingMessage` 新增可选字段：`channel?: 'feishu' | 'weixin' | 'web'`

### `src/messaging/messaging-router.ts`
- 新增 `private lastP2pChatId: string | null = null`，在 `onMessage` 中当 chatType='p2p' 时记录
- 新增 `private resolveClientByChatId(chatId)` — 遍历 clients 找 `canHandleChatId?.(chatId)` 返回 true 的，未找到则 primary
- `sendMessage()` 改为用 `resolveClientByChatId(chatId)` 而非 `this.primary`
- `uploadAndSendImage()` 和 `uploadAndSendFile()` 同理
- `sendInteractiveCard()` 同理
- `getLastChatId()` 改为返回 `this.lastP2pChatId ?? this.primary.getLastChatId()`
- 新增 `async stop()` — 遍历 clients 调 `client.stop?.()`

### `src/config.ts`
- Config 接口新增 `weixin` 字段（含设计文档的 12 个配置项 + `master_user_ids: string[]`）
- `loadConfig()` 中解析 weixin 配置段，所有字段有默认值，`enabled` 默认 false

### `src/index.ts`
- 在 feishu client 创建后、web console 添加前，条件创建 weixin client 并 `messaging.addClient(weixinClient)`
- `isMaster` 判断改为通道感知：微信通道检查 `weixin.master_user_ids`
- `gracefulShutdown` 中加入 `messaging.stop()` 调用

### `package.json`
- dependencies 新增 `qrcode-terminal`

### `docs/setup.md`
- 新增微信配置段说明和 QR 登录步骤

### `docs/ops-reference.md`
- 新增微信运维注意事项（token 过期、poller 排障、不要与 OpenClaw 同时消费）

## 实现顺序

```
Step 1: 依赖 + 基础设施（package.json, messaging.ts, messaging-router.ts, config.ts）
Step 2: 协议层（weixin-types.ts, weixin-api.ts, weixin-text.ts）
Step 3: 存储层（weixin-account-store.ts, weixin-context-store.ts）
Step 4: 轮询（weixin-poller.ts）
Step 5: 媒体（weixin-media.ts）
Step 6: 客户端（weixin-client.ts, index.ts barrel）
Step 7: 登录脚本（scripts/weixin-login.ts）
Step 8: 接入主进程（src/index.ts — weixinClient 创建 + isMaster 改造 + gracefulShutdown）
Step 9: 测试
Step 10: 文档（setup.md, ops-reference.md）
```

## 验证方式

1. `bun run check`（类型检查 + lint）通过
2. 单测覆盖 text 工具函数、API 请求构造、ID 解析、router 路由、at-least-once 语义
3. `bun scripts/weixin-login.ts` 能展示 QR、完成登录、写入账号文件到 `~/.persona/weixin/`
4. 配置 `weixin.enabled=true` 启动 Shell，微信发消息能到 main session，Director 回复能回到微信
5. Shell 重启后不重复消费旧消息（processed IDs 从磁盘恢复）
6. 飞书/Web 原有链路不回归
7. 微信用户可执行 /flush 等命令（master_user_ids 匹配时）
8. Shell 优雅关停时 pollers 正确退出，notifyStop 被调用
