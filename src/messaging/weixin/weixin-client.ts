import type { MessagingClient, MessageHandler, IncomingMessage, StreamingReplyHandle } from '../messaging.js';
import { WeixinApi } from './weixin-api.js';
import { WeixinAccountStore } from './weixin-account-store.js';
import { WeixinContextStore } from './weixin-context-store.js';
import { WeixinPoller } from './weixin-poller.js';
import type { WeixinAccountCredentials } from './weixin-types.js';
import {
  MESSAGE_TYPE_BOT,
  MESSAGE_STATE_FINISH,
  ITEM_TYPE_TEXT,
} from './weixin-types.js';
import {
  parseChatId,
  parseMessageId,
  isWeixinChatId,
  chunkText,
  stripMarkdown,
  generateClientId,
} from './weixin-text.js';

const MAX_MESSAGE_INDEX = 10_000;

export interface WeixinClientConfig {
  enabled: boolean;
  stateDir: string;
  accounts: string[];
  pollTimeoutMs: number;
  retryDelayMs: number;
  backoffDelayMs: number;
  attachmentDir: string;
  cdnBaseUrl: string;
  botAgent: string;
  appId: string;
  clientVersion: string;
  streamingReplyEnabled: boolean;
}

interface MessageOriginInfo {
  accountId: string;
  userId: string;
  contextToken?: string;
}

export function createWeixinClient(config: WeixinClientConfig): MessagingClient {
  const api = new WeixinApi({
    defaultBaseUrl: 'https://ilinkai.weixin.qq.com',
    botAgent: config.botAgent,
    appId: config.appId,
    clientVersion: config.clientVersion,
  });

  const accountStore = new WeixinAccountStore(config.stateDir);
  const contextStore = new WeixinContextStore(config.stateDir);
  const pollers = new Map<string, WeixinPoller>();
  const messageIndex = new Map<string, MessageOriginInfo>();
  const handlers: MessageHandler[] = [];
  let lastChatId: string | null = null;
  const credentialsMap = new Map<string, WeixinAccountCredentials>();

  function trimMessageIndex(): void {
    if (messageIndex.size > MAX_MESSAGE_INDEX) {
      const first = messageIndex.keys().next().value as string;
      messageIndex.delete(first);
    }
  }

  async function sendTextToUser(accountId: string, userId: string, text: string): Promise<string | null> {
    const creds = credentialsMap.get(accountId);
    if (!creds) throw new Error(`No credentials for weixin account ${accountId}`);

    const poller = pollers.get(accountId);
    if (poller?.isPaused()) throw new Error(`Weixin account ${accountId} is paused (session expired)`);

    const contextToken = contextStore.getContextToken(accountId, userId) ?? '';
    const filtered = stripMarkdown(text);
    const chunks = chunkText(filtered);
    let lastMessageId: string | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const clientId = generateClientId();
      const payload = {
        base_info: { bot_agent: config.botAgent },
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: clientId,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: chunks[i] } }],
          context_token: contextToken,
        },
      };

      const res = await api.sendMessage(creds, payload);
      if (res.errcode && res.errcode !== 0) {
        throw new Error(`sendMessage failed: errcode=${res.errcode} ${res.errmsg ?? ''}`);
      }
      lastMessageId = res.message_id ?? clientId;

      if (i < chunks.length - 1) await sleep(100);
    }

    return lastMessageId;
  }

  const client: MessagingClient = {
    start() {
      const accounts = config.accounts.length > 0
        ? config.accounts.map(id => accountStore.getAccount(id)).filter((a): a is NonNullable<typeof a> => a !== null)
        : accountStore.listAccounts();

      if (accounts.length === 0) {
        console.warn('[weixin] No accounts found. Run `bun scripts/weixin-login.ts` to add one.');
        return;
      }

      for (const account of accounts) {
        const creds: WeixinAccountCredentials = {
          token: account.token,
          userId: account.userId,
          baseUrl: account.baseUrl,
        };
        credentialsMap.set(account.id, creds);

        const poller = new WeixinPoller({
          accountId: account.id,
          credentials: creds,
          api,
          contextStore,
          pollTimeoutMs: config.pollTimeoutMs,
          retryDelayMs: config.retryDelayMs,
          backoffDelayMs: config.backoffDelayMs,
          attachmentDir: config.attachmentDir,
          onMessage: async (msg: IncomingMessage) => {
            const parsed = parseMessageId(msg.messageId);
            if (parsed) {
              const chatParsed = parseChatId(msg.chatId);
              messageIndex.set(msg.messageId, {
                accountId: parsed.accountId,
                userId: chatParsed?.userId ?? '',
                contextToken: contextStore.getContextToken(parsed.accountId, chatParsed?.userId ?? ''),
              });
              trimMessageIndex();
            }
            lastChatId = msg.chatId;
            for (const handler of handlers) {
              await handler(msg);
            }
          },
          onError: (accountId, error) => {
            console.error(`[weixin:${accountId}] Poll error:`, error);
          },
        });

        poller.start();
        pollers.set(account.id, poller);
        api.notifyStart(creds).catch(() => {});
        console.log(`[weixin] Started poller for account ${account.id}`);
      }
    },

    async stop() {
      const stopTasks: Promise<void>[] = [];
      for (const [accountId, poller] of pollers) {
        poller.stop();
        const creds = credentialsMap.get(accountId);
        if (creds) {
          stopTasks.push(
            Promise.race([
              api.notifyStop(creds),
              sleep(2000),
            ]).catch(() => {}),
          );
        }
      }
      await Promise.allSettled(stopTasks);
      pollers.clear();
    },

    onMessage(handler: MessageHandler) {
      handlers.push(handler);
    },

    async reply(messageId: string, text: string) {
      const origin = messageIndex.get(messageId);
      if (!origin) throw new Error(`Unknown weixin messageId: ${messageId}`);
      await sendTextToUser(origin.accountId, origin.userId, text);
    },

    async sendMessage(chatId: string, text: string) {
      const parsed = parseChatId(chatId);
      if (!parsed) throw new Error(`Invalid weixin chatId: ${chatId}`);
      return sendTextToUser(parsed.accountId, parsed.userId, text);
    },

    async addReaction(_messageId: string, _emoji: string) {
      // WeChat has no reaction API — no-op
    },

    async uploadAndReplyImage(messageId: string, filePath: string) {
      const origin = messageIndex.get(messageId);
      if (!origin) return;
      await sendTextToUser(origin.accountId, origin.userId, `[生成了图片: ${filePath}]`);
    },

    async uploadAndReplyFile(messageId: string, filePath: string) {
      const origin = messageIndex.get(messageId);
      if (!origin) return;
      await sendTextToUser(origin.accountId, origin.userId, `[生成了文件: ${filePath}]`);
    },

    async uploadAndSendImage(chatId: string, filePath: string) {
      const parsed = parseChatId(chatId);
      if (!parsed) return null;
      return sendTextToUser(parsed.accountId, parsed.userId, `[生成了图片: ${filePath}]`);
    },

    async uploadAndSendFile(chatId: string, filePath: string) {
      const parsed = parseChatId(chatId);
      if (!parsed) return null;
      return sendTextToUser(parsed.accountId, parsed.userId, `[生成了文件: ${filePath}]`);
    },

    getLastChatId() {
      return lastChatId;
    },

    getConnectionStatus() {
      for (const poller of pollers.values()) {
        if (poller.isRunning() && !poller.isPaused()) return 'connected';
      }
      return 'disconnected';
    },

    canHandleChatId(chatId: string) {
      return isWeixinChatId(chatId);
    },
  };

  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
