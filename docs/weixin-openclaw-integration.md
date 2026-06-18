# 微信接入方案：基于 openclaw-weixin 协议层

> 状态：设计文档，尚未实现。
>
> 参考源码：`~/github/openclaw-weixin`，对应 npm 包 `@tencent-weixin/openclaw-weixin`。
> 该仓库当前形态是 **OpenClaw Gateway 的 channel plugin**，不能直接被 p-shell 当成消息通道加载；但其中微信协议层可以复用/移植。

## 目标

把微信作为 p-shell 的第二个 IM 输入/输出通道，和现有飞书通道一样接入 `MessagingClient` / `MessagingRouter`：

```text
微信用户消息
  → WeixinMessagingClient
  → MessagingRouter
  → p-shell 路由层
  → SessionManager / Director
  → MessagingRouter
  → WeixinMessagingClient 回复微信
```

核心原则：

1. **不把 OpenClaw Gateway 嵌进 p-shell**。OpenClaw 的 Agent/session/routing 与 p-shell 已有领域模型重复，直接嵌入会制造双路由事实源。
2. **复用 openclaw-weixin 的微信协议层**。包括扫码登录、getUpdates 长轮询、sendMessage、context token、CDN 媒体上传下载。
3. **先私聊文本，后媒体，最后再评估群聊**。当前 openclaw-weixin 明确声明 `capabilities.chatTypes = ["direct"]`，不能假设微信群能力已经完整可用。
4. **p-shell 的 workspace/session 仍为唯一事实源**。微信只是消息通道，不拥有会话模型。

## 依赖定位：只使用 `@tencent-weixin/openclaw-weixin`

本文只讨论如何利用 `@tencent-weixin/openclaw-weixin` 接入 p-shell。

这个包里有两层东西：

1. **OpenClaw plugin 外壳**：`index.ts`、`src/channel.ts`。这层只能被 OpenClaw Gateway 加载，p-shell 不使用。
2. **微信协议实现**：扫码登录、getUpdates、sendMessage、context token、CDN 媒体收发。这层是 p-shell 要复用的部分。

对 p-shell 来说，`@tencent-weixin/openclaw-weixin` 的角色是：

```text
上游微信协议实现 / 参考实现
  → 抽取协议层
  → 封装成 p-shell 的 WeixinMessagingClient
```

不是：

```text
p-shell 直接加载 OpenClaw channel plugin
```

### 需要复用的模块

| 能力 | openclaw-weixin 源码 | p-shell 用法 |
|------|----------------------|--------------|
| 协议类型 | `src/api/types.ts` | 复制/改写为 p-shell 微信协议类型 |
| HTTP API | `src/api/api.ts` | 抽取 `getUpdates` / `sendMessage` / `getUploadUrl` / `getConfig` / `sendTyping` / `notifyStart` / `notifyStop`；重写请求头和 `base_info` 构造，剥离 OpenClaw config/state 依赖 |
| 文本发送 | `src/messaging/send.ts` | 抽取 `SendMessageReq` 构造和 `sendMessageWeixin` |
| 入站解析 | `src/messaging/inbound.ts` | 抽取 text/item/context token 逻辑，输出 `IncomingMessage` |
| 长轮询 | `src/monitor/monitor.ts` | 参考 poll/backoff/sync-buf 逻辑，去掉 OpenClaw runtime |
| 账号存储 | `src/auth/accounts.ts` | 兼容账号文件格式；p-shell 自己实现 store，并把所有路径解析改为 `config.weixin.state_dir` |
| Account ID normalize | `openclaw/plugin-sdk/account-id` 的 `normalizeAccountId` | 不引入 plugin-sdk；移植/重写 normalize 规则，确保 `xxx@im.bot` 等 ID 能稳定映射为文件安全 accountId |
| QR 登录 | `src/auth/login-qr.ts` | Phase 1 移植到独立 p-shell CLI/script；不能在 Shell 主进程 stdin 阻塞 |
| 媒体 | `src/cdn/*`、`src/media/*`、`src/messaging/send-media.ts` | 二期移植媒体上传下载 |

### 不复用的模块

| 模块 | 原因 |
|------|------|
| `index.ts` | OpenClaw plugin 注册入口 |
| `src/channel.ts` | 绑定 OpenClaw `ChannelPlugin`、`PluginRuntime`、Gateway lifecycle |
| `openclaw/plugin-sdk/*` 相关逻辑 | 与 p-shell 的 workspace/session/reply 事实源重复 |

### 为什么建议“抽取/复制”，而不是生产代码直接 import 包内部路径

`@tencent-weixin/openclaw-weixin` 不是一个面向外部 SDK 使用者设计的库，它发布的是 OpenClaw 插件。直接在 p-shell 里 import 诸如：

```ts
import { sendMessageWeixin } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js';
```

会有几个问题：

- 这些 subpath 不是稳定 public API，包升级可能改路径或依赖关系。
- `api.ts` / `accounts.ts` 等模块会牵出 OpenClaw config、logger、`plugin-sdk` 语义。
- `api.ts` 的 `buildBaseInfo()` / `buildCommonHeaders()` / `buildHeaders()` 会读取 `openclaw.json`、`routeTag`、`botAgent`、包内 `package.json` 的 `ilink_appid` 与 `version`；p-shell 需要重写这些函数，显式配置 `bot_agent` / `ilink_app_id` / `client_version` 或保留与上游一致的默认值。
- `accounts.ts`、`sync-buf.ts`、`inbound.ts` 的 context-token 持久化都会通过 `resolveStateDir()` 指向 OpenClaw state 目录；移植时必须统一替换为 `config.weixin.state_dir`，否则会误读写 `~/.openclaw`。
- p-shell 需要自己的配置、日志、state dir、session 路由，不能让 OpenClaw 的运行时假设渗进来。

因此推荐落地方式是：

1. 在开发期把 `@tencent-weixin/openclaw-weixin` 作为上游参考源。
2. 将协议层最小代码复制/改写进 p-shell，例如 `src/messaging/weixin-protocol/*`。
3. 在代码注释和文档中标注来源与上游版本。
4. 后续升级时用 diff 对照上游包，选择性同步协议变化。

这样“使用”的是它的微信协议实现，而不是把 OpenClaw 插件宿主也带进 p-shell。

## 为什么不能直接加载 openclaw-weixin 插件

`openclaw-weixin` 的插件主体依赖 OpenClaw SDK 和 Gateway 运行时：

- `openclaw/plugin-sdk/core`
- `openclaw/plugin-sdk/channel-runtime`
- `channelRuntime.reply`
- `channelRuntime.routing`
- `channelRuntime.session`
- `channelRuntime.media`
- `channelRuntime.commands`

这些能力在 p-shell 中分别已有对应实现：

| OpenClaw 概念 | p-shell 对应概念 |
|---------------|------------------|
| Gateway routing | `SessionManager` + workspace default session |
| Gateway session store | SQLite `sessions` + agent native transcript |
| Reply dispatcher | `MessagingRouter` + streaming/card/file helpers |
| Channel media save | `IncomingMessage.attachments` |
| Command authorization | p-shell slash command + `master_id` |

所以正确做法是：**把微信作为一个新的 `MessagingClient` 适配器实现，而不是把 OpenClaw 插件系统接入 p-shell。**

## 总体架构

新增一个平台适配器：

```text
src/messaging/weixin.ts
```

实现现有接口：

```ts
interface MessagingClient {
  start(): void;
  onMessage(handler: MessageHandler): void;
  reply(messageId: string, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string | null>;
  startStreamingReply?(messageId: string, initialText?: string): Promise<StreamingReplyHandle | null>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  uploadAndReplyImage(messageId: string, filePath: string): Promise<void>;
  uploadAndReplyFile(messageId: string, filePath: string): Promise<void>;
  uploadAndSendImage(chatId: string, filePath: string): Promise<string | null>;
  uploadAndSendFile(chatId: string, filePath: string): Promise<string | null>;
  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
```

微信没有等价的表情反应 API，`addReaction()` 在 `WeixinMessagingClient` 中实现为 no-op；MVP 也不实现 `startStreamingReply()`，只在最终回复完成后一次性发送。

启动时由 `src/index.ts` 选择性加入：

```ts
const feishu = createFeishuClient(...);
const messaging = new MessagingRouter(feishu);

if (config.weixin?.enabled) {
  const weixin = createWeixinClient(config.weixin, ...);
  messaging.addClient(weixin);
}
```

回复路由继续由 `MessagingRouter.messageOrigin` 决定：

- 来自微信的 `messageId` 记录到 `messageOrigin`
- `reply(messageId, text)` 自动回到微信
- cron/task 主动推送暂不默认推微信，除非后续建立 workspace ↔ weixin chat 映射

## ID 映射

微信原始 ID 不直接泄漏到 p-shell 路由层，而是封装成稳定字符串。

### `chatId`

私聊微信用户：

```text
weixin:<accountId>:<fromUserId>
```

示例：

```text
weixin:abc-im-bot:wx_user_xxx@im.wechat
```

含义：

- `accountId`：扫码登录得到的 bot account，openclaw-weixin 会 normalize 成文件安全 ID
- `fromUserId`：微信用户 ID，通常形如 `xxx@im.wechat`

### `messageId`

```text
weixin:<accountId>:<message_id|seq|client_id>
```

必须可反查到发送目标，所以 `WeixinMessagingClient` 内部维护：

```ts
messageIndex: Map<string, { accountId: string; userId: string; contextToken?: string }>
```

`messageIndex` 必须有上限，避免长驻进程内存泄漏。建议复用 `MessagingRouter` 的思路做 capped LRU（例如 10,000 条）：超过上限删除最旧记录。主动发送不依赖 `messageIndex`，而是从 `chatId` 解析 account/user，并从 context-token store 读取最近 token。

### workspace/session 路由

MVP 中微信私聊进入 `main` workspace，行为对齐飞书私聊。

后续如果要支持“每个微信联系人一个 workspace”，可新增配置：

```yaml
weixin:
  dm_scope: main | per-contact-workspace
```

但第一版不要引入，避免微信联系人和 p-shell workspace 关系过早复杂化。

## 配置设计

新增配置段：

```yaml
weixin:
  enabled: false
  state_dir: "~/.persona/weixin"     # p-shell 自己维护微信凭据与游标
  accounts: []                      # 空数组 = 自动读取 accounts.json 中全部账号
  poll_timeout_ms: 35000
  retry_delay_ms: 2000
  backoff_delay_ms: 30000
  attachment_dir: "~/.persona/attachments/weixin"
  cdn_base_url: "https://novac2c.cdn.weixin.qq.com/c2c"
  bot_agent: "PersonaShell/0.1.0"    # 写入 base_info.bot_agent；仅用于服务端观测
  ilink_app_id: "bot"                # 对齐上游 package.json 的 ilink_appid，用于 iLink-App-Id header
  client_version: "2.4.4"            # 用于计算 iLink-App-ClientVersion；默认跟随上游协议版本
  streaming_reply_enabled: false    # MVP false；微信侧先按最终文本发送
```

`Config` 类型中增加：

```ts
weixin?: {
  enabled: boolean;
  state_dir: string;
  accounts: string[];
  poll_timeout_ms: number;
  retry_delay_ms: number;
  backoff_delay_ms: number;
  attachment_dir: string;
  cdn_base_url: string;
  bot_agent: string;
  ilink_app_id: string;
  client_version: string;
  streaming_reply_enabled: boolean;
};
```

配置解析原则：

- 默认 `enabled=false`，避免未配置时影响现有飞书运行。
- `state_dir` 默认 `~/.persona/weixin`，由 p-shell 自己维护，不依赖 OpenClaw Gateway。
- token 凭据继续放在 state dir，不写入 git 仓库。
- 微信扫码登录产生的 token 敏感，文件权限按 `0600` 写入。

## 凭据与登录

第一版就应该把 `@tencent-weixin/openclaw-weixin` 的 QR 登录流程抽进 p-shell，而不是要求用户先安装/运行 OpenClaw Gateway。

复用来源：

- `src/auth/login-qr.ts`：`startWeixinLoginWithQr` / `waitForWeixinLogin` / `displayQRCode`
- `src/auth/accounts.ts`：账号文件结构与 accountId normalize 规则
- `src/api/api.ts`：`apiGetFetch` / `apiPostFetch` 请求头与 base info 构造

p-shell 落地成自己的登录脚本：

```bash
bun scripts/weixin-login.ts
```

后续如果 p-shell 有正式 CLI，再包一层：

```bash
persona-shell weixin login
```

登录流程：

1. 调 `ilink/bot/get_bot_qrcode?bot_type=3` 获取二维码。`bot_type=3` 来自上游 `DEFAULT_ILINK_BOT_TYPE`，含义以微信 iLink 后端为准；p-shell 不自行解释，只保持与上游一致。
2. 用 `qrcode-terminal` 在终端展示二维码。
3. 轮询 `ilink/bot/get_qrcode_status`。登录请求使用固定 base URL `https://ilinkai.weixin.qq.com`，但轮询过程中可能遇到 `scaned_but_redirect` 并按 `redirect_host` 切换 IDC；登录成功后的业务 API 再使用返回的 `baseurl`。
4. 成功后得到：
   - `bot_token`
   - `ilink_bot_id`
   - `baseurl`
   - `ilink_user_id`
5. 将 `ilink_bot_id` normalize 成文件安全的 `accountId`。
6. 写入 p-shell 的微信 state dir。

QR 登录脚本必须是独立 CLI 进程，不在 p-shell 主进程内运行。原因是上游 `login-qr.ts` 在 `need_verifycode` 场景下会从 stdin 读取验证码；Shell 长驻服务不应该被 stdin 阻塞。实现时要把登录状态机完整移植并显式处理这些状态：

- `wait`
- `scaned`
- `confirmed`
- `expired`
- `scaned_but_redirect`
- `need_verifycode`
- `verify_code_blocked`
- `binded_redirect`

其中 `binded_redirect` 表示服务端认为该 bot 已绑定到当前/其他实例，迁移 OpenClaw 账号到 p-shell 时尤其要记录清楚，不能误判为普通失败。

推荐存储路径：

```text
~/.persona/weixin/openclaw-weixin/accounts.json
~/.persona/weixin/openclaw-weixin/accounts/<accountId>.json
```

账号文件格式保持兼容 openclaw-weixin，方便后续对照和迁移：

```json
{
  "token": "...",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "userId": "...",
  "savedAt": "..."
}
```

为什么放到 `~/.persona/weixin` 而不是直接使用 `~/.openclaw`：

- p-shell 应该拥有自己的运行态文件，避免与 OpenClaw Gateway 抢账号游标。
- token 生命周期、日志、备份、权限都归 p-shell 管。
- 仍保留 openclaw-weixin 的账号文件结构，方便从 `~/.openclaw` 手动迁移。

可选迁移命令（二期再做，不作为 MVP 依赖）：

```bash
bun scripts/weixin-import-openclaw-accounts.ts ~/.openclaw
```

这个命令只复制账号 token，不启动 OpenClaw，也不读取 OpenClaw Gateway session。

## 入站消息流程

### 长轮询

每个 account 启动一个 poll loop：

```text
load account token
load get_updates_buf
while running:
  POST ilink/bot/getupdates { get_updates_buf }
  save new get_updates_buf
  for each msg:
    dedupe
    save context_token
    convert to IncomingMessage
    dispatch handlers
```

参考 openclaw-weixin：

- `src/monitor/monitor.ts`
- `src/storage/sync-buf.ts`
- `src/messaging/inbound.ts`

### 游标持久化

保存到 p-shell state 下，避免和 OpenClaw Gateway 同时运行时互相抢游标：

```text
~/.persona/weixin/accounts/<accountId>.sync-buf.json
```

不要直接复用 OpenClaw 的 sync-buf 文件。原因：如果 OpenClaw Gateway 与 p-shell 同时读取同一账号，两个消费者共享游标会互相吞消息。

> 运行约束：同一个微信账号同一时间只应由一个消费者长轮询。生产中要么停 OpenClaw Gateway 的微信 channel，要么 p-shell 不启用该账号。

### 去重

维护 LRU set：

```ts
processedMessageIds: Set<string> // capped 1000
```

key：

```text
<accountId>:<message_id || seq || client_id || create_time_ms>
```

### 文本转换

复用 `bodyFromItemList` 的语义：

- `TEXT` → 文本
- `VOICE` 若带 `voice_item.text` → 使用语音转文字
- 引用文本 → 加前缀 `[引用: ...]`

转换为：

```ts
IncomingMessage {
  text,
  messageId,
  chatId,
  chatType: 'p2p',
  senderOpenId: fromUserId,
  attachments?: ...
}
```

这里复用 `senderOpenId` 字段存微信 `from_user_id`，是为了保持 `IncomingMessage` 接口最小改动；实现时应把接口注释从“飞书 open_id”改成更通用的“发送者平台 ID（飞书 open_id / 微信 user_id）”，或后续新增 `senderPlatformId`。

## 出站文本流程

收到 Director 回复后：

```text
MessagingRouter.reply(messageId, text)
  → WeixinMessagingClient.reply(messageId, text)
  → 根据 messageIndex 找 accountId/userId/contextToken
  → POST ilink/bot/sendmessage
```

主动发送：

```text
MessagingRouter.sendMessage(chatId, text)
  → parse weixin:<accountId>:<userId>
  → get latest contextToken(accountId,userId)
  → sendmessage
```

微信 sendMessage 请求结构：

```json
{
  "base_info": {
    "bot_agent": "PersonaShell/0.1.0"
  },
  "msg": {
    "from_user_id": "",
    "to_user_id": "<userId>",
    "client_id": "<generated-id>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [
      { "type": 1, "text_item": { "text": "..." } }
    ],
    "context_token": "<latest-context-token>"
  }
}
```

注意：`base_info` 和请求头不是装饰字段。上游 `api.ts` 会给每个请求附加 `base_info`，并设置 `iLink-App-Id` / `iLink-App-ClientVersion` / `AuthorizationType` / `Authorization` / `X-WECHAT-UIN` 等 header。p-shell 移植时必须保留协议要求的 header，并把 OpenClaw 配置读取替换成 p-shell 配置或上游默认值。

### 文本长度

openclaw-weixin 的 `textChunkLimit: 4000` 是在 `src/channel.ts` 声明，由 OpenClaw Gateway 框架负责分片；`send.ts` 本身不会自动分片。p-shell 不使用 Gateway，所以必须在 `WeixinMessagingClient.reply()` / `sendMessage()` 内实现分片：

```ts
for (const chunk of splitText(text, 4000)) {
  await sendMessageWeixin(...chunk...)
}
```

微信文本不按 Markdown 渲染。上游使用 `StreamingMarkdownFilter` 过滤 Markdown 链接/图片等格式；p-shell 至少应移植这层过滤或提供等价清洗，避免把 `![alt](url)`、复杂 Markdown 表格原样刷到微信。

上游 `outbound-hooks.ts` 是 OpenClaw 的消息发送钩子机制，p-shell MVP 不移植；如果未来需要审计/拦截发送，应接 p-shell 自己的 hook，而不是复刻 OpenClaw hook。

## Typing 状态（二期）

上游 `monitor.ts` 会通过 `WeixinConfigManager.getForUser()` 缓存 `typing_ticket`，再用 `sendTyping` 发送/取消“正在输入”。MVP 不实现 typing indicator；但 API 抽取时保留 `getConfig` / `sendTyping`，避免后续补能力时重做协议层。

## 媒体接入（二期）

### 入站媒体

复用：

- `src/media/media-download.ts`
- `src/cdn/pic-decrypt.ts`
- `src/media/silk-transcode.ts`

映射到 p-shell：

```ts
IncomingMessage.attachments = [{
  type: 'image' | 'file' | 'audio',
  filePath,
  fileName,
}]
```

图片文本保持简洁：

```text
[用户发送了图片]
```

这和当前飞书图片链路一致，后续由 `DirectorInputAttachment` 结构化传给 Codex app-server。

### 出站媒体

复用：

- `src/messaging/send-media.ts`
- `src/cdn/upload.ts`
- `src/cdn/cdn-upload.ts`
- `src/cdn/aes-ecb.ts`

实现：

```ts
uploadAndReplyImage(messageId, filePath)
uploadAndReplyFile(messageId, filePath)
uploadAndSendImage(chatId, filePath)
uploadAndSendFile(chatId, filePath)
```

MVP 可先抛出明确错误或退化为文本：

```text
[生成了文件，但当前微信通道尚未启用文件发送: /path/to/file]
```

## 流式回复策略

微信 API 支持 `message_state = GENERATING / FINISH`，但 p-shell 第一版不使用。

MVP：

- `streaming_reply_enabled=false`
- 不实现 `startStreamingReply`
- Director 最终回复完成后一次性发送

二期再评估：

- 是否用 `GENERATING` 更新同一条消息
- 或按时间窗口合并 chunk 后多条发送

默认不做流式，避免刷屏和协议不稳定。

## 群聊策略

当前不承诺微信群接入。

原因：

- openclaw-weixin 插件声明 `chatTypes: ["direct"]`
- 入站类型里虽然有 `group_id` 字段，但现有 `weixinMessageToMsgContext` 固定 `ChatType: "direct"`
- 路由实现按 `from_user_id` 私聊用户处理

如果后续实际 getUpdates 能收到群消息，需要另开设计：

```text
chatId = weixin-group:<accountId>:<groupId>
workspaceName = 群名或 groupId
```

但必须先真实抓包验证字段：

- `group_id` 是否稳定
- 群名是否可获得
- `from_user_id` 是群成员还是群 ID
- 回复是否需要 `to_user_id=group_id` 还是其他字段
- `context_token` 是否按群会话有效

未验证前不进入实现范围。

## 错误处理与生命周期

### session expired

openclaw-weixin 中 `SESSION_EXPIRED_ERRCODE = -14`。上游处理不是简单重试，而是通过 `session-guard.ts` 暂停整个 account，默认暂停 1 小时。

p-shell 也应实现 account-level pause：

```ts
if (ret === -14 || errcode === -14) {
  pauseAccount(accountId, 60 * 60 * 1000)
  notify main log / optional alert
  sleep remainingPauseMs
}
```

要求：

- 入站 poll loop 遇到 `-14` 后暂停该 account，不要疯狂重试。
- 出站 `reply()` / `sendMessage()` / 媒体发送前也要检查 `isAccountPaused(accountId)`；暂停期间直接抛出明确错误，不继续打微信 API。
- 暂停状态需要在内存中维护即可；如需 Shell 重启后保留，可二期持久化。

### backoff

连续失败策略：

- 1~2 次失败：`retry_delay_ms`，默认 2s
- 3 次连续失败：`backoff_delay_ms`，默认 30s
- 成功后清零

### stop

Shell 启动 account poll loop 前，best-effort 调 `notifyStart`；Shell 关闭或重启时：

- abort 所有 long-poll fetch
- best-effort 调 `notifyStop`
- 不阻塞 Shell 退出太久

### watchdog

飞书目前有 WebSocket watchdog；微信是主动长轮询，不需要 WebSocket watchdog，但需要状态：

```ts
runningAccounts
lastInboundAt
lastPollAt
lastError
```

`getConnectionStatus()`：只要有一个 enabled account poll loop 正常运行即 `connected`。

## 安全与权限

- 微信 token 是敏感凭据，默认只写入 `~/.persona/weixin`，不进仓库；从 `~/.openclaw` 迁移时只复制 token 文件。
- 日志要打码 token：只显示前后少量字符。
- `chatId` 中包含微信用户 ID，Web UI/API 展示时可保持原样，但日志中避免打印完整 token，不必隐藏 userId。
- 同一微信账号不要被 OpenClaw Gateway 和 p-shell 同时消费，否则游标会互相影响。

## 实现步骤

### Phase 0：准备

- [ ] 确认第一版只做微信私聊文本
- [ ] 确认是否需要从 `~/.openclaw` 迁移已有账号 token；不把 OpenClaw Gateway 作为运行依赖
- [ ] 确认同一个微信账号不会同时被 OpenClaw Gateway 和 p-shell 长轮询消费

### Phase 1：文本私聊 MVP

Phase 1 保持为一个完整可用闭环：QR 登录、账号保存、私聊文本收发、context token、sync buf、去重一起完成。原因是没有登录与账号 store，文本链路无法真实验证；只做 mock 或手动 token 注入不能证明接入方案可交付。可以在开发调试时临时手动放置 account JSON，但不作为正式阶段边界。

新增文件：

```text
src/messaging/weixin.ts
src/messaging/weixin-api.ts              # 可选：从 openclaw-weixin api.ts 移植最小 API
src/messaging/weixin-account-store.ts    # p-shell 微信账号 store，兼容 openclaw-weixin account json
src/messaging/weixin-context-store.ts    # context_token + sync buf
scripts/weixin-login.ts                 # 复用 openclaw-weixin QR 登录流程
src/__tests__/weixin-messaging.test.ts
```

改动文件：

```text
src/config.ts
src/index.ts
src/messaging/messaging-router.ts        # 如需按 chatId 选择非 primary sendMessage，见下文
src/messaging/messaging.ts               # 如需补 channel 字段，MVP 可不补
```

MVP 功能：

- [ ] QR 扫码登录并保存账号
- [ ] 读取账号
- [ ] long-poll 收文本
- [ ] 转 `IncomingMessage`
- [ ] `reply()` 回微信
- [ ] `sendMessage()` 支持 `weixin:<accountId>:<userId>` chatId
- [ ] dedupe
- [ ] sync buf 持久化
- [ ] context token 持久化
- [ ] `bun run check`
- [ ] 单测覆盖 API 请求构造、ID parse、入站转换、出站路由

### Phase 2：媒体

- [ ] 入站图片下载并转 `attachments`
- [ ] 入站文件下载并转 `attachments`
- [ ] 入站语音转文字/附件
- [ ] 出站图片/文件上传
- [ ] 文件大小限制与错误提示

### Phase 3：可观测与控制面

- [ ] Web config summary 展示微信 account 状态
- [ ] `/config` 或 Web UI 增加微信通道状态只读展示
- [ ] 日志页面能看到 weixin poll 错误
- [ ] 运维文档补排障

### Phase 4：微信群验证（可选）

- [ ] 用测试号真实验证 getUpdates 群消息字段
- [ ] 明确群 chatId/workspace 映射
- [ ] 再决定是否支持微信群

## MessagingRouter 的一个潜在改动

当前 `MessagingRouter.sendMessage(chatId, text)` 总是走 primary client。飞书作为 primary 时，主动发 `weixin:*` chatId 会发错通道。

MVP 可以只支持 `reply(messageId, text)` 回微信，不支持主动推微信。

如果要支持主动推送，建议给 `MessagingClient` 增加可选能力：

```ts
canHandleChatId?(chatId: string): boolean;
canHandleMessageId?(messageId: string): boolean;
```

然后 `MessagingRouter.sendMessage` 改为：

```ts
const client = this.clients.find(c => c.canHandleChatId?.(chatId)) ?? this.primary;
return client.sendMessage(chatId, text);
```

同理附件发送也按 `chatId` 选择 client。

这属于小架构修正，建议和 Phase 1 一起做，但保持向后兼容：飞书不实现该方法也不受影响。

## 测试计划

### 单元测试

- account store：读取 accounts index、读取 account json、缺 token 报错
- ID parse/build：`weixin:<accountId>:<userId>` 往返
- inbound：文本/引用/语音转文字 转 `IncomingMessage`
- context store：保存/读取 `context_token` 和 sync buf
- outbound：sendMessage 请求体包含 `base_info`、`to_user_id`、`context_token`、`message_type=BOT`、`message_state=FINISH`
- router：微信 messageId 的 reply 走微信 client；飞书 messageId 仍走飞书
- QR 登录状态机：覆盖 `wait` / `scaned` / `confirmed` / `expired` / `scaned_but_redirect` / `need_verifycode` / `verify_code_blocked` / `binded_redirect` 的关键分支

### 集成测试（mock fetch）

- getUpdates 返回一条文本消息 → handler 被调用一次
- 同一消息重复返回 → dedupe 后只处理一次
- getUpdates 返回新 `get_updates_buf` → 持久化
- sendMessage API 500 → 抛错并记录 lastError
- `errcode=-14` → account paused/backoff

### 真实 smoke

手动启动测试 Shell，配置测试微信账号：

1. 微信给 bot 发：“ping”
2. p-shell 收到并回复
3. Shell 重启
4. 再发：“ping2”
5. 确认未重复消费旧消息，能继续回复
6. 用 Web UI 看 main session 是否有对应上下文

## 运维注意

- 首次上线必须先只启用一个测试账号。
- 不要和 OpenClaw Gateway 同时消费同一个微信账号。
- 生产 Shell 重启属于高危操作，需要明确确认。
- 如果微信 token 过期，表现通常是 `errcode=-14`，需要重新扫码登录；也要关注 QR 登录中的 `binded_redirect` 等迁移/已绑定状态。
- 如果长轮询无消息但发送正常，先检查 sync buf 是否被其他消费者推进。

## 上游同步策略

落地后建议在 p-shell 代码中记录上游版本，例如：

```ts
// Derived from @tencent-weixin/openclaw-weixin 2.4.x, src/api/types.ts
```

升级流程：

1. `npm view @tencent-weixin/openclaw-weixin version` 查看最新版本。
2. 拉取或更新 `~/github/openclaw-weixin`。
3. 对比 `src/api/*`、`src/messaging/send.ts`、`src/messaging/inbound.ts`、`src/cdn/*`、`src/media/*`。
4. 只同步协议字段、请求头、错误码、媒体加解密等必要变化。
5. 跑微信 mock 测试和真实 smoke。

不要同步 `src/channel.ts` 的 OpenClaw Gateway 外壳。

## 最终验收标准

Phase 1 完成时：

- p-shell 配置 `weixin.enabled=true` 后能启动微信私聊文本通道
- 微信私聊发消息能进入 main session
- Director 回复能回到原微信私聊
- Shell 重启后不重复消费旧消息
- 飞书/Web 原有链路不回归
- `bun run check` 和相关测试通过

Phase 2 完成时：

- 微信图片能作为结构化 attachment 进入 Codex app-server
- p-shell 生成图片/文件能发送回微信
- 文件过大/格式不支持有明确错误提示
