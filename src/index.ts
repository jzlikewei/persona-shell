import { loadConfig } from './config.js';
import { Director } from './director.js';
import { createFeishuClient } from './feishu.js';
import { MessageQueue } from './queue.js';
import { startConsole } from './console.js';

// Prepend ISO timestamp to all console output
for (const method of ['log', 'warn', 'error'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(`[${new Date().toISOString()}]`, ...args);
  };
}

async function main() {
  const config = loadConfig();
  const queue = new MessageQueue(config.logging.queue_log);
  const director = new Director(config.director);
  const feishu = createFeishuClient(config.feishu);
  const startTime = Date.now();

  // 2.3/2.4: Restore queue state from disk
  const restoredQueueCount = queue.restoreFromState();
  if (restoredQueueCount > 0) {
    console.log(`[bridge] Restored ${restoredQueueCount} queued message(s) from state`);
  }

  // 2.2/2.4: Restore director state from disk
  const restoredDirector = director.restoreState();
  if (restoredDirector) {
    const flushAgoSec = Math.floor((Date.now() - restoredDirector.lastFlushAt) / 1000);
    console.log(
      `[bridge] Restored director state: lastFlushAt=${flushAgoSec}s ago, lastInputTokens=${restoredDirector.lastInputTokens}`
    );
  }

  // Start director process
  await director.start();

  // 启动 Web 管理控制台
  startConsole(director, queue, config);

  // 1.2: Auto-flush notification — notify last active chat when context is auto-flushed
  director.on('auto-flush-complete', () => {
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn('[bridge] Failed to send auto-flush notification:', err);
      });
    }
  });

  // 4.1: Alert notification — forward Director and system alerts to feishu
  director.on('alert', (message: string) => {
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, message).catch((err) => {
        console.warn('[bridge] Failed to send alert notification:', err);
      });
    }
  });

  // 4.1: Feishu disconnection alert — sent after reconnection succeeds
  feishu.onAlert((message: string) => {
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      // Delay slightly — reconnection may still be in progress
      setTimeout(() => {
        feishu.sendMessage(lastChatId, message).catch((err) => {
          console.warn('[bridge] Failed to send feishu alert:', err);
        });
      }, 5000);
    }
  });

  // Feishu message → queue → director
  feishu.onMessage(async (text, messageId, chatId, msgType) => {
    // 1.3: Non-text message feedback
    if (msgType !== 'text') {
      console.log(`[bridge] Non-text message type: ${msgType}`);
      await feishu.reply(messageId, `暂不支持 ${msgType} 类型消息，请发送文字消息`);
      return;
    }

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

    // /restart — restart Bridge process (launchd will respawn)
    if (text.trim() === '/restart') {
      await feishu.reply(messageId, 'Bridge 正在重启...');
      console.log('[bridge] /restart: exiting for launchd respawn');
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // 1.4: /status — show Director status summary
    if (text.trim() === '/status') {
      const s = director.getStatus();
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const lastFlushAgo = Math.floor((Date.now() - s.lastFlushAt) / 1000);
      const lines = [
        `🟢 Director: ${s.alive ? 'alive' : 'dead'} (pid: ${s.pid ?? 'N/A'})`,
        `📊 Tokens: ${s.lastInputTokens.toLocaleString()} / ${s.flushContextLimit.toLocaleString()}`,
        `📬 Pending: ${s.pendingCount} | Queue: ${queue.length}`,
        `🔄 Flushing: ${s.flushing ? 'yes' : 'no'} | Last flush: ${lastFlushAgo}s ago`,
        `⏱️ Uptime: ${uptime}s | Session: ${s.sessionId?.slice(0, 8) ?? 'N/A'}`,
      ];
      await feishu.reply(messageId, lines.join('\n'));
      return;
    }

    // 1.5: /help — list all available commands
    if (text.trim() === '/help') {
      const lines = [
        '📖 可用命令:',
        '/status — 查看 Director 状态摘要',
        '/flush — 手动刷新上下文',
        '/esc — 取消队列中最早的消息',
        '/restart — 重启 Bridge 进程',
        '/help — 显示此帮助信息',
      ];
      await feishu.reply(messageId, lines.join('\n'));
      return;
    }

    // 1.1: ACK — add emoji reaction to let user know message is received
    feishu.addReaction(messageId, 'THUMBSUP').catch((err) => {
      console.warn('[bridge] Failed to add reaction:', err);
    });

    console.log(`[bridge] Received message: ${text.slice(0, 50)}...`);
    const correlationId = queue.enqueue({ text, messageId, chatId });
    queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
    try {
      await director.send(text);
    } catch (err) {
      // 3.3: All send errors must clean up queue state to prevent orphaned items
      queue.resolve(correlationId);
      if (String(err).includes('flushing')) {
        await feishu.reply(messageId, '正在刷新上下文，请稍后重试');
      } else {
        console.error(`[bridge] send failed, queue item cleaned:`, err);
        await feishu.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
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

    // 4.3: Calculate message processing elapsed time
    const elapsedMs = Date.now() - item.timestamp;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const replyWithTiming = `${reply}\n\n(耗时 ${elapsedSec}s)`;

    try {
      await feishu.reply(item.messageId, replyWithTiming);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s ${reply.slice(0, 100)}`);
      console.log(`[bridge] Replied to ${item.messageId} (cid=${item.correlationId}, ${elapsedSec}s)`);
    } catch (err) {
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
      console.error(`[bridge] Failed to reply:`, err);
    }
  });

  director.on('close', async () => {
    console.error('[bridge] Director closed unexpectedly');
    // 4.1: Notify before exit
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      try {
        await feishu.sendMessage(lastChatId, '🔴 Director 已关闭，Bridge 即将退出');
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });

  // Start feishu websocket
  feishu.start();

  console.log('[bridge] Persona Bridge started');

  // Notify restart success
  const lastChatId = feishu.getLastChatId();
  if (lastChatId) {
    // Delay to let WS connect first
    setTimeout(async () => {
      try {
        await feishu.sendMessage(lastChatId, 'Bridge 已重启 ✓');
        console.log('[bridge] Restart notification sent');
      } catch (err) {
        console.warn('[bridge] Failed to send restart notification:', err);
      }
    }, 3000);
  }

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
