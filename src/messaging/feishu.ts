import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, statSync, mkdirSync } from 'fs';
import { extname, basename, join } from 'path';
import type { Config } from '../config.js';
import type { MessagingClient, MessageHandler, IncomingMessage, Attachment } from './messaging.js';
import { getState, setState } from '../task/task-store.js';
import { log } from '../logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

const FILE_TYPE_MAP: Record<string, "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"> = {
  '.opus': 'opus', '.ogg': 'opus',
  '.mp4': 'mp4', '.mov': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc',
  '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
};

type Mention = { id?: { open_id?: string }; name?: string; key?: string; mentioned_type?: string };

/** Extract plain text from feishu post (rich text) message content.
 *  Post format: { title?, content: [[{tag, text?, href?}, ...], ...] }
 *  or nested under locale key: { zh_cn: { title?, content: [...] } }
 *  Supports: text, a (link), at (mention), img (alt text). Paragraphs joined by \n. */
function extractPostText(parsed: Record<string, unknown>, mentions?: Mention[]): string {
  const parts: string[] = [];

  // Content can be nested under a locale key (zh_cn, en_us, etc.) or directly at top level
  let postBody = parsed.content as unknown[][] | undefined;
  let title = parsed.title as string | undefined;
  if (!postBody) {
    for (const key of Object.keys(parsed)) {
      const val = parsed[key] as Record<string, unknown> | undefined;
      if (val && typeof val === 'object' && 'content' in val) {
        postBody = val.content as unknown[][];
        title = title || (val.title as string | undefined);
        break;
      }
    }
  }

  if (title) parts.push(title);
  if (!postBody || !Array.isArray(postBody)) return parts.join('\n');

  // Build a lookup map from user_id → real name via mentions array
  const mentionMap = new Map<string, string>();
  if (mentions) {
    for (const m of mentions) {
      if (m.id?.open_id && m.name) mentionMap.set(m.id.open_id, m.name);
    }
  }

  for (const paragraph of postBody) {
    if (!Array.isArray(paragraph)) continue;
    const line: string[] = [];
    for (const node of paragraph) {
      const n = node as Record<string, unknown>;
      switch (n.tag) {
        case 'text':
          if (n.text) line.push(n.text as string);
          break;
        case 'a':
          if (n.text && n.href) line.push(`${n.text}(${n.href})`);
          else if (n.text) line.push(n.text as string);
          break;
        case 'at': {
          // Resolve real name from mentions; fall back to user_name if available
          const userId = n.user_id as string | undefined;
          const realName = userId ? mentionMap.get(userId) : undefined;
          const displayName = realName || (n.user_name as string | undefined);
          if (displayName) line.push(`@${displayName}`);
          break;
        }
        case 'img':
          line.push(n.alt_text ? `[图片: ${n.alt_text}]` : '[图片]');
          break;
        case 'media':
          line.push('[媒体]');
          break;
        case 'code_block':
          if (n.text) {
            const lang = n.language ? ` ${n.language}` : '';
            line.push(`\`\`\`${lang}\n${(n.text as string).trimEnd()}\n\`\`\``);
          }
          break;
      }
    }
    if (line.length > 0) parts.push(line.join(''));
  }

  return parts.join('\n');
}

/** Fetch a message by ID and extract its plain text (for quote-reply context).
 *  When attachmentDir is provided, image/file/audio messages are downloaded and the path is returned. */
async function fetchMessageText(client: Lark.Client, messageId: string, attachmentDir?: string): Promise<string> {
  try {
    const res = await client.im.v1.message.get({
      path: { message_id: messageId },
    });
    const items = (res?.data as any)?.items as any[] | undefined;
    if (!items?.length) return '';

    const msg = items[0];
    const msgType = msg.msg_type as string;
    const rawContent = msg.body?.content as string | undefined;
    if (!rawContent) return '';

    const parsed = JSON.parse(rawContent);

    if (msgType === 'text') {
      let text: string = parsed.text || '';
      // Resolve @_user_xxx placeholders using mentions
      const mentions = msg.mentions as Mention[] | undefined;
      if (mentions?.length) {
        for (const m of mentions) {
          if (m.id?.open_id) text = text.replace(`@_user_${m.id.open_id}`, m.name ? `@${m.name}` : '');
        }
      }
      return text.trim();
    }

    if (msgType === 'post') {
      return extractPostText(parsed);
    }

    if (msgType === 'image') {
      if (attachmentDir && parsed.image_key) {
        const savePath = join(attachmentDir, `${messageId}.png`);
        await client.im.v1.image.get({ path: { image_key: parsed.image_key } }).then((r) => r.writeFile(savePath));
        return `[图片，已保存到 ${savePath}]`;
      }
      return '[图片]';
    }
    if (msgType === 'file') {
      if (attachmentDir && parsed.file_key) {
        const fileName = parsed.file_name as string | undefined;
        const savePath = join(attachmentDir, `${messageId}_${fileName ?? 'file'}`);
        await client.im.v1.file.get({ path: { file_key: parsed.file_key } }).then((r) => r.writeFile(savePath));
        return `[文件 ${fileName ?? '未知文件'}，已保存到 ${savePath}]`;
      }
      return '[文件]';
    }
    if (msgType === 'audio') {
      if (attachmentDir && parsed.file_key) {
        const savePath = join(attachmentDir, `${messageId}.opus`);
        await client.im.v1.file.get({ path: { file_key: parsed.file_key } }).then((r) => r.writeFile(savePath));
        return `[语音，已保存到 ${savePath}]`;
      }
      return '[语音]';
    }
    return '';
  } catch (err) {
    console.error(`[feishu] fetchMessageText ${messageId} failed:`, err);
    return '';
  }
}

// LRU message deduplication (200 entries)
const processedMessageIds = new Set<string>();
const MAX_DEDUP_SIZE = 200;

const WATCHDOG_INTERVAL = 30_000;      // 每 30s 检查一次
const MAX_DISCONNECT_TIME = 120_000;   // 断连超过 2 分钟则自杀重启
const SDK_SELF_HEAL_WINDOW = 30_000;   // 给 SDK 30s 自行重连的窗口
const FEISHU_API_CHECK_TIMEOUT = 5_000; // 飞书 API 可达性检查超时

const RETRY_DELAYS = [1000, 3000];

// Chat info cache (name + member count + chat mode) for group chats
const chatInfoCache = new Map<string, { name: string; memberCount: number; chatMode: 'group' | 'topic'; fetchedAt: number }>();
const CHAT_INFO_CACHE_TTL = 30 * 60_000; // 30 minutes

/** 带重试的异步调用，失败后按 delays 间隔重试 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  delays: number[] = RETRY_DELAYS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        console.warn(`[feishu] ${label} attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms...`, err);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  console.error(`[feishu] ${label} failed after all retries:`, lastErr);
  throw lastErr;
}

/** 获取底层 WebSocket 的 readyState（通过访问 SDK 私有属性）
 *  返回值：0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED, -1=无法获取 */
function getWsReadyState(wsClient: Lark.WSClient): number {
  try {
    const wsInstance = (wsClient as any).wsConfig?.getWSInstance?.()
      ?? (wsClient as any).wsConfig?.wsInstance;
    if (wsInstance && typeof wsInstance.readyState === 'number') {
      return wsInstance.readyState;
    }
    return -1;
  } catch {
    return -1;
  }
}

/** 检查飞书 API 是否可达（轻量 HTTP 请求） */
async function isFeishuReachable(client: Lark.Client): Promise<boolean> {
  try {
    await Promise.race([
      (client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), FEISHU_API_CHECK_TIMEOUT)
      ),
    ]);
    return true;
  } catch (err) {
    log.debug(`[feishu] Watchdog: feishu API check failed: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

export function createFeishuClient(config: Config['feishu'], options?: { skipMentionChatIds?: string[]; attachmentDir?: string }) {
  // 飞书是国内服务，不走代理（Lark SDK multipart 上传经代理会 ECONNRESET）
  const feishuDomains = 'open.feishu.cn,*.feishu.cn,*.larkoffice.com';
  const existing = process.env.no_proxy ?? '';
  if (!existing.includes('feishu.cn')) {
    process.env.no_proxy = existing ? `${existing},${feishuDomains}` : feishuDomains;
    process.env.NO_PROXY = process.env.no_proxy;
  }

  const skipMentionSet = new Set(options?.skipMentionChatIds ?? []);
  const attachmentDir = options?.attachmentDir;
  if (attachmentDir) mkdirSync(attachmentDir, { recursive: true });
  const client = new Lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
  });

  const handlers: MessageHandler[] = [];
  let lastActiveTime = Date.now();
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let botOpenId: string | null = null;

  /** Fetch bot's open_id via /open-apis/bot/v3/info/ (called once at start). */
  async function fetchBotOpenId(): Promise<void> {
    try {
      const res = await (client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
      const openId = res?.data?.bot?.open_id ?? res?.bot?.open_id;
      if (openId) {
        botOpenId = openId;
        log.debug(`[feishu] Bot open_id resolved: ${openId}`);
      } else {
        console.warn('[feishu] Bot info response missing open_id:', JSON.stringify(res?.data ?? res));
      }
    } catch (err) {
      console.warn('[feishu] Failed to fetch bot info (group @mention filtering may not work):', err);
    }
  }

  /** Check if a mention refers to the bot. */
  function isBotMention(m: Mention): boolean {
    if (m.mentioned_type === 'bot') return true;
    if (botOpenId && m.id?.open_id === botOpenId) return true;
    return false;
  }

  /** Get chat name + member count + chat mode for a group, with caching. */
  async function getChatInfo(chatId: string): Promise<{ name: string; memberCount: number; chatMode: 'group' | 'topic' } | null> {
    const cached = chatInfoCache.get(chatId);
    if (cached && Date.now() - cached.fetchedAt < CHAT_INFO_CACHE_TTL) {
      return { name: cached.name, memberCount: cached.memberCount, chatMode: cached.chatMode };
    }
    try {
      const res = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      const data = res?.data as Record<string, unknown> | undefined;
      log.debug(`[feishu] chat.get response for ${chatId}: ${JSON.stringify(data)}`);
      const name = (data?.name as string) ?? '';
      const memberCount = Number(data?.user_count ?? 0);
      const chatMode = (data?.chat_mode as string) === 'topic' ? 'topic' as const : 'group' as const;
      chatInfoCache.set(chatId, { name, memberCount, chatMode, fetchedAt: Date.now() });
      return { name, memberCount, chatMode };
    } catch (err) {
      console.warn(`[feishu] Failed to get chat info for ${chatId}:`, err);
      return null;
    }
  }

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      lastActiveTime = Date.now();
      const message = data.message;
      const sender = (data as Record<string, unknown>).sender as { sender_id?: { open_id?: string } } | undefined;
      const senderOpenId = sender?.sender_id?.open_id;
      const msgRaw = message as Record<string, unknown> | undefined;
      log.debug(`[feishu] event received: message_id=${message?.message_id ?? 'N/A'} chat_type=${msgRaw?.chat_type ?? 'N/A'} chat_mode=${msgRaw?.chat_mode ?? 'N/A'} thread_id=${msgRaw?.thread_id ?? msgRaw?.root_id ?? 'N/A'}`);
      if (!message) return;

      const { chat_id, message_id, content } = message;
      if (!chat_id || !message_id || !content) return;

      // LRU message deduplication — prevent duplicate processing on WebSocket reconnect
      if (processedMessageIds.has(message_id)) {
        log.debug(`[feishu] duplicate message ${message_id}, skipped`);
        return;
      }
      processedMessageIds.add(message_id);
      if (processedMessageIds.size > MAX_DEDUP_SIZE) {
        const first = processedMessageIds.values().next().value as string;
        processedMessageIds.delete(first);
      }

      const msgType = ((message as Record<string, unknown>).msg_type as string) ?? 'text';
      const mentions = (message as Record<string, unknown>).mentions as Mention[] | undefined;
      const parentId = (message as Record<string, unknown>).parent_id as string | undefined;
      const chatType = ((message as Record<string, unknown>).chat_type as string) === 'group' ? 'group' : 'p2p';

      // Persist p2p chat_id for main Director notifications.
      // Group chats have their own chatId in DirectorPool entries — no need to track globally.
      if (chatType === 'p2p') {
        setState('lastChatId', chat_id);
      }

      // Log raw message for debugging
      log.debug(`[feishu] raw ${msgType} content (${chatType}): ${content}`);
      if (mentions?.length) log.debug(`[feishu] mentions: ${JSON.stringify(mentions)}`);

      // Group chat @mention filter: skip messages that don't mention the bot
      // Exceptions:
      //   1. chats in skipMentionSet (configured parallel groups)
      //   2. small groups with 1 user — treat like p2p
      if (chatType === 'group' && !skipMentionSet.has(chat_id)) {
        const info = await getChatInfo(chat_id);
        const isSmallGroup = info && info.memberCount <= 1;
        if (!isSmallGroup) {
          const hasBotMention = mentions?.some((m) => isBotMention(m)) ?? false;
          if (!hasBotMention) {
            log.debug(`[feishu] Group message without @bot, skipped (chat_id=${chat_id})`);
            return;
          }
        }
      }

      // Build IncomingMessage base (fetch chat info for groups)
      const msg: IncomingMessage = { text: '', messageId: message_id, chatId: chat_id, chatType, senderOpenId };
      if (chatType === 'group') {
        const info = await getChatInfo(chat_id);
        if (info) {
          msg.memberCount = info.memberCount;
          msg.groupName = info.name;
        }
      }

      // Extract thread_id for topic group routing (field: thread_id or root_id)
      const threadId = (msgRaw?.thread_id ?? msgRaw?.root_id) as string | undefined;
      if (threadId) {
        msg.threadId = threadId;
      }
      /** Replace @_user_N placeholders: remove bot mentions, replace user mentions with real names. */
      const stripMentions = (text: string): string => {
        if (!mentions?.length) return text;
        for (const m of mentions) {
          if (!m.key) continue;
          if (isBotMention(m)) {
            // Remove bot mention entirely
            text = text.replace(m.key, '');
          } else if (m.name) {
            text = text.replace(m.key, `@${m.name}`);
          }
        }
        return text.replace(/ {2,}/g, ' ').trim();
      };

      /** Fetch quoted message text and store in meta (if this is a reply).
       *  Formatting and truncation is left to the consumer (routing layer). */
      const fetchQuote = async (): Promise<void> => {
        if (!parentId) return;
        const quoted = await fetchMessageText(client, parentId, attachmentDir);
        if (quoted) {
          msg.quotedText = quoted;
          log.debug(`[feishu] fetched quoted message ${parentId} (${quoted.length} chars)`);
        }
      };

      if (msgType === 'text') {
        try {
          const parsed = JSON.parse(content);
          let text = parsed.text as string;

          // Feishu sometimes sends rich text with msg_type="text" but post-format content
          if (!text && (parsed.content || parsed.title !== undefined)) {
            text = extractPostText(parsed, mentions);
          }
          if (!text) return;

          text = stripMentions(text);
          await fetchQuote();
          if (!text) return;

          msg.text = text;
          for (const handler of handlers) {
            try { await handler(msg); } catch (err) {
              console.error('[feishu] Handler error:', err);
            }
          }
        } catch {
          console.error('[feishu] Failed to parse message content:', content);
        }
        return;
      }

      if (msgType === 'post') {
        try {
          const parsed = JSON.parse(content);
          let text = extractPostText(parsed, mentions);
          if (!text) return;

          text = stripMentions(text);
          await fetchQuote();
          if (!text) return;

          msg.text = text;
          for (const handler of handlers) {
            try { await handler(msg); } catch (err) {
              console.error('[feishu] Handler error:', err);
            }
          }
        } catch {
          console.error('[feishu] Failed to parse post content:', content);
        }
        return;
      }

      // Attachment message types — download and forward path to handlers
      if ((msgType === 'image' || msgType === 'file' || msgType === 'audio') && attachmentDir) {
        try {
          const parsed = JSON.parse(content);
          let savePath: string;
          let fileName: string | undefined;
          let attachType: Attachment['type'];

          if (msgType === 'image') {
            const imageKey = parsed.image_key as string;
            if (!imageKey) return;
            savePath = join(attachmentDir, `${message_id}.png`);
            await withRetry('downloadImage', () =>
              client.im.v1.image.get({ path: { image_key: imageKey } }).then((r) => r.writeFile(savePath)),
            );
            attachType = 'image';
            msg.text = `[用户发送了图片，已保存到 ${savePath}]`;
          } else if (msgType === 'file') {
            const fileKey = parsed.file_key as string;
            fileName = parsed.file_name as string | undefined;
            if (!fileKey) return;
            savePath = join(attachmentDir, `${message_id}_${fileName ?? 'file'}`);
            await withRetry('downloadFile', () =>
              client.im.v1.file.get({ path: { file_key: fileKey } }).then((r) => r.writeFile(savePath)),
            );
            attachType = 'file';
            msg.text = `[用户发送了文件 ${fileName ?? '未知文件'}，已保存到 ${savePath}]`;
          } else {
            // audio
            const fileKey = parsed.file_key as string;
            if (!fileKey) return;
            savePath = join(attachmentDir, `${message_id}.opus`);
            await withRetry('downloadAudio', () =>
              client.im.v1.file.get({ path: { file_key: fileKey } }).then((r) => r.writeFile(savePath)),
            );
            attachType = 'audio';
            msg.text = `[用户发送了语音消息，已保存到 ${savePath}]`;
          }

          msg.attachments = [{ type: attachType, filePath: savePath, fileName }];
          await fetchQuote();

          for (const handler of handlers) {
            try { await handler(msg); } catch (err) {
              console.error('[feishu] Handler error:', err);
            }
          }
        } catch (err) {
          console.error(`[feishu] Failed to process ${msgType} attachment:`, err);
          // 下载失败仍通知 handlers，不丢消息
          msg.text = `[用户发送了${msgType === 'image' ? '图片' : msgType === 'file' ? '文件' : '语音'}，但下载失败]`;
          for (const handler of handlers) {
            try { await handler(msg); } catch (e) {
              console.error('[feishu] Handler error:', e);
            }
          }
        }
        return;
      }

      // Unsupported message types — reject internally
      console.log(`[feishu] Unsupported message type: ${msgType}`);
      await withRetry('reply', async () => {
        await client.im.v1.message.reply({
          path: { message_id },
          data: { content: JSON.stringify({ text: `暂不支持 ${msgType} 类型消息，请发送文字消息` }), msg_type: 'text' },
        });
      }).catch(() => { /* withRetry already logged */ });
    },
  });

  const wsClient = new Lark.WSClient({
    appId: config.app_id,
    appSecret: config.app_secret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);

    let firstDisconnectAt: number | null = null;

    watchdogTimer = setInterval(async () => {
      const now = Date.now();
      const readyState = getWsReadyState(wsClient);
      const info = wsClient.getReconnectInfo();

      // 健康判断：ws OPEN，或无法获取状态时近期有活动
      const isWsOpen = readyState === 1;
      const recentlyActive = (now - lastActiveTime) < MAX_DISCONNECT_TIME;
      const recentlyConnected = info.lastConnectTime > 0 && (now - info.lastConnectTime) < MAX_DISCONNECT_TIME;
      const isHealthy = isWsOpen || (readyState === -1 && (recentlyActive || recentlyConnected));

      if (isHealthy) {
        if (firstDisconnectAt !== null) {
          const recoveredAfter = Math.round((now - firstDisconnectAt) / 1000);
          console.log(`[feishu] Watchdog: connection recovered after ${recoveredAfter}s`);
          firstDisconnectAt = null;
        }
        return;
      }

      // 首次检测到断连，记录时间，给 SDK 自愈窗口
      if (firstDisconnectAt === null) {
        firstDisconnectAt = now;
        const stateLabel = readyState === -1 ? 'null(reconnecting)' : readyState;
        console.warn(`[feishu] Watchdog: disconnect detected (readyState=${stateLabel}), giving SDK ${SDK_SELF_HEAL_WINDOW / 1000}s to self-heal`);
        return;
      }

      const disconnectDuration = now - firstDisconnectAt;

      // SDK 自愈窗口内，等待
      if (disconnectDuration < SDK_SELF_HEAL_WINDOW) {
        log.debug(`[feishu] Watchdog: still in SDK self-heal window (${Math.round(disconnectDuration / 1000)}s/${SDK_SELF_HEAL_WINDOW / 1000}s)`);
        return;
      }

      // 超过自愈窗口但未到最大断连时间
      if (disconnectDuration < MAX_DISCONNECT_TIME) {
        console.warn(`[feishu] Watchdog: disconnect persists for ${Math.round(disconnectDuration / 1000)}s (max=${MAX_DISCONNECT_TIME / 1000}s)`);
        return;
      }

      // 超过最大断连时间，区分网络 vs WS 问题
      const feishuUp = await isFeishuReachable(client);

      if (!feishuUp) {
        console.warn(`[feishu] Watchdog: network unreachable, waiting for recovery (disconnected ${Math.round(disconnectDuration / 1000)}s)`);
        return;
      }

      // 飞书 API 通但 WS 断连 → 重启
      const downSec = Math.round(disconnectDuration / 1000);
      console.error(`[feishu] Watchdog: WS connection down for ${downSec}s while Feishu API is reachable. Exiting for launchd restart.`);
      setState('exitReason', {
        reason: 'feishu_ws_disconnect',
        downSeconds: downSec,
        wsReadyState: readyState,
        feishuApiReachable: true,
        at: new Date().toISOString(),
      });
      // exit(0) is intentional — launchd KeepAlive treats successful exit as restartable.
      process.exit(0);
    }, WATCHDOG_INTERVAL);
  }

  return {
    client,
    wsClient,

    start() {
      // Eagerly fetch bot open_id for group @mention filtering
      fetchBotOpenId();
      wsClient.start({ eventDispatcher }).catch((err) => {
        console.error('[feishu] WebSocket start failed:', err);
      });
      startWatchdog();
      console.log('[feishu] WebSocket client started (watchdog enabled)');
    },

    onMessage(handler: MessageHandler) {
      handlers.push(handler);
    },

    async reply(messageId: string, text: string) {
      await withRetry('reply', async () => {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text }), msg_type: 'text' },
        });
        lastActiveTime = Date.now();
      });
    },

    async sendMessage(chatId: string, text: string): Promise<string | null> {
      const res = await withRetry('sendMessage', async () => {
        const r = await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
        });
        lastActiveTime = Date.now();
        return r;
      });
      return res?.data?.message_id ?? null;
    },

    async addReaction(messageId: string, emojiType: string) {
      await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    },

    getLastChatId(): string | null {
      return getState<string>('lastChatId');
    },

    getConnectionStatus(): 'connected' | 'disconnected' {
      // 优先检查底层 ws readyState
      const readyState = getWsReadyState(wsClient);
      if (readyState === 1) return 'connected'; // WebSocket.OPEN

      const now = Date.now();
      // 退化：近期有消息活动
      if (now - lastActiveTime < 5 * 60_000) return 'connected';
      // 退化：近期有连接记录
      try {
        const info = wsClient.getReconnectInfo();
        if (info.lastConnectTime && now - info.lastConnectTime < 5 * 60_000) return 'connected';
      } catch { /* SDK may not be ready */ }
      return 'disconnected';
    },

    async uploadImage(imageData: Buffer): Promise<string> {
      const res = await client.im.v1.image.create({
        data: { image_type: 'message', image: imageData },
      });
      const imageKey = res?.image_key;
      if (!imageKey) throw new Error('Upload failed: no image_key returned');
      return imageKey;
    },

    async sendImage(chatId: string, imageKey: string): Promise<string | null> {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      lastActiveTime = Date.now();
      return res?.data?.message_id ?? null;
    },

    async replyImage(messageId: string, imageKey: string): Promise<void> {
      await withRetry('replyImage', async () => {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify({ image_key: imageKey }),
            msg_type: 'image',
          },
        });
        lastActiveTime = Date.now();
      });
    },

    async uploadAndSendImage(chatId: string, filePath: string): Promise<string | null> {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported image format: ${ext}`);
      }
      const stat = statSync(filePath);
      if (stat.size > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 10MB)`);
      }
      if (stat.size === 0) {
        throw new Error('Image file is empty');
      }
      const imageData = readFileSync(filePath);
      const imageKey = await this.uploadImage(imageData);
      return this.sendImage(chatId, imageKey);
    },

    async uploadAndReplyImage(messageId: string, filePath: string): Promise<void> {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported image format: ${ext}`);
      }
      const stat = statSync(filePath);
      if (stat.size > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 10MB)`);
      }
      if (stat.size === 0) {
        throw new Error('Image file is empty');
      }
      const imageData = readFileSync(filePath);
      const imageKey = await this.uploadImage(imageData);
      await this.replyImage(messageId, imageKey);
    },

    async uploadFile(filePath: string): Promise<string> {
      const ext = extname(filePath).toLowerCase();
      const fileType = FILE_TYPE_MAP[ext] ?? 'stream';
      const fileName = basename(filePath);
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 30MB)`);
      }
      if (stat.size === 0) {
        throw new Error('File is empty');
      }
      const fileData = readFileSync(filePath);
      const res = await client.im.v1.file.create({
        data: { file_type: fileType, file_name: fileName, file: fileData },
      });
      const fileKey = res?.file_key;
      if (!fileKey) throw new Error('Upload failed: no file_key returned');
      return fileKey;
    },

    async sendFile(chatId: string, fileKey: string, fileName: string): Promise<string | null> {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey, file_name: fileName }),
          msg_type: 'file',
        },
      });
      lastActiveTime = Date.now();
      return res?.data?.message_id ?? null;
    },

    async replyFile(messageId: string, fileKey: string, fileName: string): Promise<void> {
      await withRetry('replyFile', async () => {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify({ file_key: fileKey, file_name: fileName }),
            msg_type: 'file',
          },
        });
        lastActiveTime = Date.now();
      });
    },

    async uploadAndSendFile(chatId: string, filePath: string): Promise<string | null> {
      const fileKey = await this.uploadFile(filePath);
      return this.sendFile(chatId, fileKey, basename(filePath));
    },

    async uploadAndReplyFile(messageId: string, filePath: string): Promise<void> {
      const fileKey = await this.uploadFile(filePath);
      await this.replyFile(messageId, fileKey, basename(filePath));
    },
  };
}
