import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, statSync } from 'fs';
import { extname, basename } from 'path';
import type { Config } from './config.js';
import type { MessagingClient, MessageHandler, IncomingMessage } from './messaging.js';
import { getState, setState } from './task-store.js';
import { log } from './logger.js';

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

/** Fetch a message by ID and extract its plain text (for quote-reply context). */
async function fetchMessageText(client: Lark.Client, messageId: string): Promise<string> {
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

    if (msgType === 'image') return '[图片]';
    if (msgType === 'file') return '[文件]';
    if (msgType === 'audio') return '[语音]';
    return '';
  } catch (err) {
    console.error(`[feishu] fetchMessageText ${messageId} failed:`, err);
    return '';
  }
}

// LRU message deduplication (200 entries)
const processedMessageIds = new Set<string>();
const MAX_DEDUP_SIZE = 200;

const WATCHDOG_INTERVAL = 60_000;      // 每 60s 检查一次
const MAX_DISCONNECT_TIME = 180_000;   // 断连超过 3 分钟则自杀重启

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

export function createFeishuClient(config: Config['feishu'], options?: { skipMentionChatIds?: string[] }) {
  const skipMentionSet = new Set(options?.skipMentionChatIds ?? []);
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
      const memberCount = Number(data?.user_count ?? 0) + Number(data?.bot_count ?? 0);
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

      // Persist chat_id to DB
      setState('lastChatId', chat_id);

      const msgType = ((message as Record<string, unknown>).msg_type as string) ?? 'text';
      const mentions = (message as Record<string, unknown>).mentions as Mention[] | undefined;
      const parentId = (message as Record<string, unknown>).parent_id as string | undefined;
      const chatType = ((message as Record<string, unknown>).chat_type as string) === 'group' ? 'group' : 'p2p';

      // Log raw message for debugging
      log.debug(`[feishu] raw ${msgType} content (${chatType}): ${content}`);
      if (mentions?.length) log.debug(`[feishu] mentions: ${JSON.stringify(mentions)}`);

      // Group chat @mention filter: skip messages that don't mention the bot
      // Exception: chats in skipMentionSet (e.g. parallel/topic groups with long-lived Directors)
      if (chatType === 'group' && !skipMentionSet.has(chat_id)) {
        const hasBotMention = mentions?.some((m) => isBotMention(m)) ?? false;
        if (!hasBotMention) {
          log.debug(`[feishu] Group message without @bot, skipped (chat_id=${chat_id})`);
          return;
        }
      }

      // Build IncomingMessage base (fetch chat info for groups)
      const msg: IncomingMessage = { text: '', messageId: message_id, chatId: chat_id, chatType };
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
        const quoted = await fetchMessageText(client, parentId);
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
    watchdogTimer = setInterval(() => {
      const info = wsClient.getReconnectInfo();
      const now = Date.now();
      const sinceLastConnect = now - info.lastConnectTime;
      const sdkGaveUp = info.nextConnectTime > 0 && info.nextConnectTime < now - WATCHDOG_INTERVAL;

      if (sinceLastConnect > MAX_DISCONNECT_TIME && sdkGaveUp) {
        const downSec = Math.round(sinceLastConnect / 1000);
        console.error(`[feishu] Watchdog: connection down for ${downSec}s. Exiting for launchd restart.`);
        setState('exitReason', { reason: 'feishu_disconnect', downSeconds: downSec, at: new Date().toISOString() });
        process.exit(0);
      }
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
      }).catch(() => { /* withRetry already logged */ });
    },

    async sendMessage(chatId: string, text: string): Promise<string | null> {
      const res = await withRetry('sendMessage', async () => {
        const r = await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
        });
        lastActiveTime = Date.now();
        return r;
      }).catch(() => null);
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
      const now = Date.now();
      // If we received a message within the last 5 minutes, consider connected
      if (now - lastActiveTime < 5 * 60_000) return 'connected';
      // Otherwise check SDK reconnect info
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
