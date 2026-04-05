import { loadConfig } from './config.js';
import { Director } from './director.js';
import { createFeishuClient } from './feishu.js';
import { MessageQueue } from './queue.js';

async function main() {
  const config = loadConfig();
  const queue = new MessageQueue(config.logging.queue_log);
  const director = new Director(config.director);
  const feishu = createFeishuClient(config.feishu);

  // Start director process
  await director.start();

  // Feishu message → queue → director
  feishu.onMessage(async (text, messageId, chatId) => {
    console.log(`[bridge] Received message: ${text.slice(0, 50)}...`);
    queue.enqueue({ text, messageId, chatId });
    queue.logAction('SEND_TO_DIRECTOR', messageId, text.slice(0, 100));
    await director.send(text);
  });

  // Director response → dequeue → reply feishu
  director.on('response', async (reply: string) => {
    const item = queue.dequeue();
    if (!item) {
      console.warn('[bridge] Got director response but queue is empty');
      return;
    }

    try {
      await feishu.reply(item.messageId, reply);
      queue.logAction('REPLY_SENT', item.messageId, reply.slice(0, 100));
      console.log(`[bridge] Replied to ${item.messageId}`);
    } catch (err) {
      queue.logAction('ERROR', item.messageId, String(err));
      console.error(`[bridge] Failed to reply:`, err);
    }
  });

  director.on('close', () => {
    console.error('[bridge] Director closed unexpectedly');
    process.exit(1);
  });

  // Start feishu websocket
  feishu.start();

  console.log('[bridge] Persona Bridge started');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[bridge] Shutting down (Director stays alive)...');
    director.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[bridge] Fatal error:', err);
  process.exit(1);
});
