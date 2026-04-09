import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import { getState, setState } from './task-store.js';

type MessageHandler = (text: string, messageId: string, chatId: string, msgType: string) => void;

const WATCHDOG_INTERVAL = 60_000;      // 每 60s 检查一次
const MAX_DISCONNECT_TIME = 180_000;   // 断连超过 3 分钟则自杀重启

export function createFeishuClient(config: Config['feishu']) {
  const client = new Lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
  });

  const handlers: MessageHandler[] = [];
  let lastActiveTime = Date.now();
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      lastActiveTime = Date.now();
      const message = data.message;
      if (!message) return;

      const { chat_id, message_id, content } = message;
      if (!chat_id || !message_id || !content) return;

      // Persist chat_id to DB
      setState('lastChatId', chat_id);

      const msgType = ((message as Record<string, unknown>).msg_type as string) ?? 'text';

      if (msgType !== 'text') {
        for (const handler of handlers) {
          try { await handler('', message_id, chat_id, msgType); } catch (err) {
            console.error('[feishu] Handler error:', err);
          }
        }
        return;
      }

      try {
        const parsed = JSON.parse(content);
        const text = parsed.text as string;
        if (!text) return;

        for (const handler of handlers) {
          try { await handler(text, message_id, chat_id, msgType); } catch (err) {
            console.error('[feishu] Handler error:', err);
          }
        }
      } catch {
        console.error('[feishu] Failed to parse message content:', content);
      }
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
      const delays = [1000, 3000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          await client.im.v1.message.reply({
            path: { message_id: messageId },
            data: { content: JSON.stringify({ text }), msg_type: 'text' },
          });
          lastActiveTime = Date.now();
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < delays.length) {
            console.warn(`[feishu] reply attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms...`, err);
            await new Promise((r) => setTimeout(r, delays[attempt]));
          }
        }
      }
      console.error('[feishu] reply failed after all retries:', lastErr);
    },

    async sendMessage(chatId: string, text: string): Promise<string | null> {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
      });
      lastActiveTime = Date.now();
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
  };
}
