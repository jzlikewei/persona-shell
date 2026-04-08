import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';

type MessageHandler = (text: string, messageId: string, chatId: string) => void;

const WATCHDOG_INTERVAL = 60_000;      // 每 60s 检查一次
const MAX_DISCONNECT_TIME = 180_000;   // 断连超过 3 分钟则强制重连

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

      // Only handle text messages for now
      const msgType = (message as Record<string, unknown>).msg_type as string | undefined;
      if (msgType && msgType !== 'text') {
        console.log(`[feishu] Ignoring non-text message type: ${msgType}`);
        return;
      }

      try {
        const parsed = JSON.parse(content);
        const text = parsed.text as string;
        if (!text) return;

        for (const handler of handlers) {
          try {
            await handler(text, message_id, chat_id);
          } catch (err) {
            console.error('[feishu] Handler error:', err);
          }
        }
      } catch {
        console.error('[feishu] Failed to parse message content:', content);
      }
    },
  });

  let wsClient = new Lark.WSClient({
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
        console.warn(`[feishu] Watchdog: connection down for ${Math.round(sinceLastConnect / 1000)}s, SDK gave up. Forcing reconnect...`);
        forceReconnect();
      }
    }, WATCHDOG_INTERVAL);
  }

  async function forceReconnect() {
    try {
      wsClient.close({ force: true });
    } catch { /* ignore */ }

    wsClient = new Lark.WSClient({
      appId: config.app_id,
      appSecret: config.app_secret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    try {
      await wsClient.start({ eventDispatcher });
      lastActiveTime = Date.now();
      console.log('[feishu] Watchdog: reconnected successfully');
    } catch (err) {
      console.error('[feishu] Watchdog: reconnect failed, will retry next cycle', err);
    }
  }

  return {
    client,
    wsClient,

    start() {
      wsClient.start({ eventDispatcher });
      startWatchdog();
      console.log('[feishu] WebSocket client started (watchdog enabled)');
    },

    onMessage(handler: MessageHandler) {
      handlers.push(handler);
    },

    async reply(messageId: string, text: string) {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      lastActiveTime = Date.now();
    },
  };
}
