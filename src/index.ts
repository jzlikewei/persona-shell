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
    // /esc — cancel the oldest pending message
    if (text.trim() === '/esc') {
      const cancelled = queue.cancelOldest();
      if (cancelled) {
        console.log(`[bridge] /esc: cancelling message ${cancelled.messageId} (cid=${cancelled.correlationId})`);
        await director.interrupt();
        await feishu.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`);
      } else {
        await feishu.reply(messageId, '队列为空，没有可取消的消息');
      }
      return;
    }

    // /flush — manually flush Director context
    if (text.trim() === '/flush') {
      await feishu.reply(messageId, '正在执行 FLUSH...');
      const success = await director.flush();
      if (success) {
        await feishu.reply(messageId, 'FLUSH 完成，上下文已刷新');
      } else {
        await feishu.reply(messageId, 'FLUSH 未能完成（超时或正在进行中），请稍后重试');
      }
      return;
    }

    console.log(`[bridge] Received message: ${text.slice(0, 50)}...`);
    const correlationId = queue.enqueue({ text, messageId, chatId });
    queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
    try {
      await director.send(text);
    } catch (err) {
      if (String(err).includes('flushing')) {
        await feishu.reply(messageId, '正在刷新上下文，请稍后重试');
        queue.resolve(correlationId);
      } else {
        throw err;
      }
    }
  });

  // Director response → resolve oldest → reply feishu
  director.on('response', async (reply: string) => {
    const item = queue.resolveOldest();

    if (!item) {
      console.warn('[bridge] Got director response but queue is empty');
      return;
    }

    try {
      await feishu.reply(item.messageId, reply);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} ${reply.slice(0, 100)}`);
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
