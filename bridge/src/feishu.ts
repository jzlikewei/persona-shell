import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';

type MessageHandler = (text: string, messageId: string, chatId: string) => void;

export function createFeishuClient(config: Config['feishu']) {
  const client = new Lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
  });

  const handlers: MessageHandler[] = [];

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
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
          handler(text, message_id, chat_id);
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

  return {
    client,
    wsClient,

    start() {
      wsClient.start({ eventDispatcher });
      console.log('[feishu] WebSocket client started');
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
    },
  };
}
