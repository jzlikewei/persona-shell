import { loadConfig } from './config.js';
import { Director } from './director.js';
import { createFeishuClient } from './feishu.js';
import { MessageQueue } from './queue.js';
import { startConsole, type MetricsCollector } from './console.js';
import { TaskRunner, type TaskResult } from './task-runner.js';
import { Scheduler } from './scheduler.js';
import { updateTask, listTasks, createTask, getTask, getState, deleteState } from './task-store.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Prepend local timestamp (Asia/Shanghai) to all console output
for (const method of ['log', 'warn', 'error'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(`[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(',', '')}]`, ...args);
  };
}

async function main() {
  const config = loadConfig();
  const queue = new MessageQueue(config.logging.queue_log);
  const director = new Director(config.director);
  const feishu = createFeishuClient(config.feishu);
  const startTime = Date.now();

  // --- In-memory metrics collector ---
  const metrics: MetricsCollector = {
    recentMessages: [],
    recentErrors: [],
    today: { date: '', messagesProcessed: 0, totalResponseMs: 0, totalCostUsd: 0 },

    addMessage(msg) {
      this.recentMessages.push(msg);
      if (this.recentMessages.length > 30) this.recentMessages.shift();
    },

    addError(message: string) {
      this.recentErrors.push({ message, timestamp: Date.now() });
      if (this.recentErrors.length > 20) this.recentErrors.shift();
    },

    getToday() {
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      if (this.today.date !== todayStr) {
        this.today = { date: todayStr, messagesProcessed: 0, totalResponseMs: 0, totalCostUsd: 0 };
      }
      return this.today;
    },
  };

  // 2.3/2.4: Restore queue state from disk
  const restoredQueueCount = queue.restoreFromState();
  if (restoredQueueCount > 0) {
    console.log(`[shell] Restored ${restoredQueueCount} queued message(s) from state`);
  }

  // 2.2/2.4: Restore director state from disk
  const restoredDirector = director.restoreState();
  if (restoredDirector) {
    const flushAgoSec = Math.floor((Date.now() - restoredDirector.lastFlushAt) / 1000);
    console.log(
      `[shell] Restored director state: lastFlushAt=${flushAgoSec}s ago, lastInputTokens=${restoredDirector.lastInputTokens}`
    );
  }

  // 7.0: Write .mcp.json BEFORE director.start() so Claude Code discovers task MCP server on spawn
  const mcpConfig = {
    mcpServers: {
      'persona-tasks': {
        command: 'bun',
        args: ['run', join(import.meta.dirname, 'task-mcp-server.ts')],
        env: { SHELL_PORT: String(config.console.port) },
      },
    },
  };
  writeFileSync(join(config.director.persona_dir, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));

  // Start director process
  await director.start();

  // 7.3: Task runner — subprocess lifecycle management
  const taskRunner = new TaskRunner({
    claudePath: config.director.claude_path,
    personaDir: config.director.persona_dir,
    defaultTimeoutMs: config.task.default_timeout_ms,
  });

  // 7.3.4/7.3.5: Task lifecycle events → db update + Director notification + feishu notification
  taskRunner.on('task-started', (taskId: string, spawnArgs: string[]) => {
    updateTask(taskId, {
      status: 'running',
      started_at: new Date().toISOString(),
      extra: { spawnArgs },
    });
  });

  taskRunner.on('task-completed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
      result_file: result.resultFile ?? null,
    });
    // Send feishu notification first, capture messageId for Director's reply
    const lastChatId = feishu.getLastChatId();
    let notifyMsgId: string | undefined;
    if (lastChatId) {
      notifyMsgId = (await feishu.sendMessage(lastChatId, `✅ 后台任务完成: ${result.taskId}`)) ?? undefined;
    }
    director.notifyTaskDone(result.taskId, true, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task completion:', err);
    });
  });

  taskRunner.on('task-failed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: result.error ?? 'unknown',
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
    });

    // 7.3.3: Retry if under max_retry — retry logic is here (Shell layer)
    const task = getTask(result.taskId);
    if (task && task.retry_count < task.max_retry && result.error !== 'cancelled') {
      updateTask(result.taskId, { retry_count: task.retry_count + 1, status: 'dispatched' });
      console.log(`[shell] Retrying task ${result.taskId} (attempt ${task.retry_count + 1}/${task.max_retry})`);
      taskRunner.runTask({ taskId: result.taskId, role: task.role, prompt: task.prompt });
      return;
    }

    const lastChatId = feishu.getLastChatId();
    let notifyMsgId: string | undefined;
    if (lastChatId) {
      const isCancelled = result.error === 'cancelled';
      const msg = isCancelled
        ? `🚫 后台任务已取消: ${result.taskId}`
        : `❌ 后台任务失败: ${result.taskId} — ${result.error}`;
      notifyMsgId = (await feishu.sendMessage(lastChatId, msg)) ?? undefined;
    }
    director.notifyTaskDone(result.taskId, false, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task failure:', err);
    });
  });

  // 7.3.5: Director's response to task notifications — reply to the feishu notification message
  director.on('system-response', async (reply: string, replyToMessageId: string) => {
    try {
      await feishu.reply(replyToMessageId, reply);
      console.log(`[shell] System response replied to ${replyToMessageId}`);
    } catch (err) {
      console.warn('[shell] Failed to reply system response:', err);
    }
  });

  // 启动 Web 管理控制台（含 Task API）
  startConsole(director, queue, config, taskRunner, feishu, metrics);

  // 7.4: Scheduler — setInterval-driven task automation
  const scheduler = new Scheduler(
    config.scheduler,
    [], // jobs 暂时为空，后续从 config.yaml 读取
    async (job) => {
      const task = createTask({
        type: 'cron',
        role: job.role,
        description: job.description,
        prompt: job.prompt,
      });
      taskRunner.runTask({ taskId: task.id, role: task.role, prompt: task.prompt });
      return task.id;
    },
    (role, type) => {
      const active = listTasks({ role });
      return active.some((t) => t.type === type && (t.status === 'running' || t.status === 'dispatched'));
    },
  );
  scheduler.start();

  // 1.2: Auto-flush notification — notify last active chat when context is auto-flushed
  director.on('auto-flush-complete', () => {
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn('[shell] Failed to send auto-flush notification:', err);
      });
    }
  });

  // 4.1: Alert notification — forward Director and system alerts to feishu
  director.on('alert', (message: string) => {
    metrics.addError(message);
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, message).catch((err) => {
        console.warn('[shell] Failed to send alert notification:', err);
      });
    }
  });

  // Feishu message → queue → director
  feishu.onMessage(async (text, messageId, chatId, msgType) => {
    // 1.3: Non-text message feedback
    if (msgType !== 'text') {
      console.log(`[shell] Non-text message type: ${msgType}`);
      await feishu.reply(messageId, `暂不支持 ${msgType} 类型消息，请发送文字消息`);
      return;
    }

    // /esc — cancel the oldest pending message
    if (text.trim() === '/esc') {
      const cancelled = queue.cancelOldest();
      if (cancelled) {
        console.log(`[shell] /esc: cancelling message ${cancelled.messageId} (cid=${cancelled.correlationId})`);
        await director.interrupt();
        await feishu.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`);
      } else {
        await feishu.reply(messageId, '队列为空，没有可取消的消息');
      }
      return;
    }

    // /flush — manually flush Director context
    if (text.trim() === '/flush') {
      feishu.addReaction(messageId, 'Typing').catch(() => {});
      const success = await director.flush();
      if (success) {
        await feishu.reply(messageId, 'FLUSH 完成，上下文已刷新');
      } else {
        await feishu.reply(messageId, 'FLUSH 未能完成（超时或正在进行中），请稍后重试');
      }
      return;
    }

    // /restart — restart Shell process (launchd will respawn)
    if (text.trim() === '/restart') {
      await feishu.reply(messageId, 'Shell 正在重启...');
      console.log('[shell] /restart: exiting for launchd respawn');
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
        '/restart — 重启 Shell 进程',
        '/help — 显示此帮助信息',
      ];
      await feishu.reply(messageId, lines.join('\n'));
      return;
    }

    // 1.1: ACK — add emoji reaction to let user know message is received
    feishu.addReaction(messageId, 'Typing').catch((err) => {
      console.warn('[shell] Failed to add reaction:', err);
    });

    console.log(`[shell] Received message: ${text.slice(0, 50)}...`);
    metrics.addMessage({ direction: 'in', preview: text.slice(0, 80), timestamp: Date.now() });
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
        console.error(`[shell] send failed, queue item cleaned:`, err);
        metrics.addError(`Send failed: ${String(err).slice(0, 200)}`);
        await feishu.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
      }
    }
  });

  // Director response → resolve oldest → reply feishu
  director.on('response', async (reply: string) => {
    const item = queue.resolveOldest();

    if (!item) {
      console.warn('[shell] Got director response but queue is empty');
      return;
    }

    // 4.3: Calculate message processing elapsed time
    const elapsedMs = Date.now() - item.timestamp;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const replyWithTiming = `${reply}\n\n(耗时 ${elapsedSec}s)`;

    // Track outgoing message and update daily stats
    metrics.addMessage({ direction: 'out', preview: reply.slice(0, 80), timestamp: Date.now(), responseSec: elapsedMs / 1000 });
    // Update the corresponding 'in' message with responseSec
    const inMsg = [...metrics.recentMessages].reverse().find(
      (m) => m.direction === 'in' && !m.responseSec
    );
    if (inMsg) inMsg.responseSec = elapsedMs / 1000;
    // Update daily stats
    const today = metrics.getToday();
    today.messagesProcessed++;
    today.totalResponseMs += elapsedMs;

    try {
      await feishu.reply(item.messageId, replyWithTiming);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s ${reply.slice(0, 100)}`);
      console.log(`[shell] Replied to ${item.messageId} (cid=${item.correlationId}, ${elapsedSec}s)`);
    } catch (err) {
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
      metrics.addError(`Reply failed: ${String(err).slice(0, 200)}`);
      console.error(`[shell] Failed to reply:`, err);
    }
  });

  director.on('close', async () => {
    console.error('[shell] Director closed unexpectedly');
    metrics.addError('Director closed unexpectedly');
    // 4.1: Notify before exit
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      try {
        await feishu.sendMessage(lastChatId, '🔴 Director 已关闭，Shell 即将退出');
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });

  // Start feishu websocket
  feishu.start();

  console.log('[shell] Persona Shell started');

  // Startup notification — check exit reason and send appropriate message
  const lastChatId = feishu.getLastChatId();
  if (lastChatId) {
    const exitReason = getState<{ reason: string; downSeconds?: number; at?: string }>('exitReason');
    deleteState('exitReason');

    let startupMsg = 'Shell 已重启 ✓';
    if (exitReason?.reason === 'feishu_disconnect') {
      startupMsg = `Shell 已重启 ✓（上次因飞书断连 ${exitReason.downSeconds}s 自动重启）`;
    }

    setTimeout(async () => {
      try {
        await feishu.sendMessage(lastChatId, startupMsg);
        console.log('[shell] Startup notification sent');
      } catch (err) {
        console.warn('[shell] Failed to send startup notification:', err);
      }
    }, 3000);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[shell] Shutting down (Director stays alive)...');
    director.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[shell] Fatal error:', err);
  process.exit(1);
});
