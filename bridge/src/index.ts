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

  // Feishu message → queue → director (with correlation ID)
  feishu.onMessage(async (text, messageId, chatId) => {
    console.log(`[bridge] Received message: ${text.slice(0, 50)}...`);
    const correlationId = queue.enqueue({ text, messageId, chatId });
    queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
    // Inject correlation ID so Director can echo it back
    const taggedText = `[CID:${correlationId}]\n${text}`;
    await director.send(taggedText);
  });

  // Director response → resolve by correlation ID → reply feishu
  director.on('response', async (reply: string) => {
    // Try to extract correlation ID from Director's reply
    const cidMatch = reply.match(/\[CID:(cid-\d+-[0-9a-f]{4})\]/);
    let item;
    let cleanReply = reply;

    if (cidMatch) {
      const correlationId = cidMatch[1];
      item = queue.resolve(correlationId);
      // Strip the CID tag from the reply before sending to user
      cleanReply = reply.replace(/\[CID:cid-\d+-[0-9a-f]{4}\]\n?/, '').trim();
      if (item) {
        console.log(`[bridge] Matched response by cid=${correlationId}`);
      } else {
        console.warn(`[bridge] CID ${correlationId} not found in queue, falling back to oldest`);
        item = queue.resolveOldest();
      }
    } else {
      // Fallback: Director did not echo CID, resolve oldest message
      console.warn('[bridge] No CID in director response, falling back to oldest');
      item = queue.resolveOldest();
    }

    if (!item) {
      console.warn('[bridge] Got director response but queue is empty');
      return;
    }

    try {
      await feishu.reply(item.messageId, cleanReply);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} ${cleanReply.slice(0, 100)}`);
      console.log(`[bridge] Replied to ${item.messageId} (cid=${item.correlationId})`);
    } catch (err) {
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
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
